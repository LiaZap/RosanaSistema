import {
  SchemaType,
  type FunctionDeclaration,
} from '@google/generative-ai';
import { db } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { buscarProdutos, buscarProdutoDetalhe } from './dani-products.js';
import { logger } from './logger.js';

/**
 * Function declarations das tools que a DANI usa.
 * O Gemini decide quando chamar; o orchestrator executa via handlerByName.
 */

export const DANI_TOOLS: FunctionDeclaration[] = [
  {
    name: 'criar_agendamento',
    description:
      'Agenda uma consultoria/visita pro cliente. Use APENAS quando o cliente JA confirmou data e ' +
      'horario explicitamente (ex: "pode marcar quarta as 14h"). NAO use pra perguntar - use apenas ' +
      'pra REGISTRAR. Tipos validos: smart_baby, estilosa, vip, concierge, premium, visita_loja.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        titulo: {
          type: SchemaType.STRING,
          description: 'Titulo curto, ex: "Consultoria Smart Baby - Maria"',
        },
        data_iso: {
          type: SchemaType.STRING,
          description: 'Data ISO 8601 (YYYY-MM-DD). Ex: "2026-06-15"',
        },
        hora: {
          type: SchemaType.STRING,
          description: 'Hora no formato HH:MM (24h). Ex: "14:00"',
        },
        duracao_min: {
          type: SchemaType.NUMBER,
          description: 'Duracao em minutos. Default 60. Smart Baby=30, Estilosa=150, VIP=120.',
        },
        tipo: {
          type: SchemaType.STRING,
          description: 'smart_baby | estilosa | vip | concierge | premium | visita_loja',
        },
        observacoes: {
          type: SchemaType.STRING,
          description: 'Notas adicionais (interesse, recados).',
        },
      },
      required: ['titulo', 'data_iso', 'hora', 'tipo'],
    },
  },
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos no catalogo da loja por nome. Use SEMPRE que o cliente perguntar preco, ' +
      'disponibilidade, lista de modelos, ou variacoes. Retorna ate 8 produtos com nome, preco, ' +
      'estoque e disponibilidade. NAO escreva mensagens tipo "vou buscar" antes - apenas chame a tool.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        consulta: {
          type: SchemaType.STRING,
          description:
            'Nome ou parte do nome do produto. Ex: "windi", "carrinho ping two", "berco". ' +
            'Use o nome base, sem variacoes de cor/tamanho.',
        },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'buscar_produto_detalhe',
    description:
      'Pega 1 produto especifico com foto, descricao e preco para apresentar ao cliente. ' +
      'Use quando o cliente pediu "foto", "imagem", "ver" um produto especifico, ou apos ' +
      'buscar_produtos quando ele escolheu 1 item da lista.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        consulta: {
          type: SchemaType.STRING,
          description: 'Nome do produto especifico que o cliente quer ver.',
        },
      },
      required: ['consulta'],
    },
  },
];

/**
 * Resultado serializado das tools - vai pro Gemini no functionResponse.
 * Formato pensado pra ser facil pro Gemini interpretar e citar.
 */
export interface BuscarProdutosToolResult {
  status: 'ENCONTRADO' | 'NAO_ENCONTRADO';
  total: number;
  produtos: Array<{
    nome: string;
    preco: number | null;
    preco_promocional: number | null;
    disponivel: boolean;
    estoque: number;
    marca: string | null;
  }>;
}

export interface BuscarProdutoDetalheToolResult {
  status: 'ENCONTRADO' | 'SEM_ESTOQUE' | 'NAO_ENCONTRADO';
  nome?: string;
  preco?: number | null;
  preco_promocional?: number | null;
  disponivel?: boolean;
  estoque?: number;
  marca?: string | null;
  imagem?: string | null;
  descricao_curta?: string | null;
}

export interface ToolContext {
  accountId: string;
  contactId?: string | null;
}

export interface CriarAgendamentoToolResult {
  status: 'AGENDADO' | 'FALHA' | 'SEM_CONTATO';
  appointment_id?: string;
  data?: string;
  hora?: string;
  duracao?: number;
  error?: string;
}

/**
 * Executor das tools. Mapeado por nome — orchestrator chama o handler certo.
 */
export const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
> = {
  async criar_agendamento(args, ctx) {
    if (!ctx.contactId) {
      logger.warn({ accountId: ctx.accountId }, '[DANI Tool] criar_agendamento sem contactId');
      return {
        status: 'SEM_CONTATO',
        error: 'Sem contato vinculado a essa conversa',
      } satisfies CriarAgendamentoToolResult;
    }

    const titulo = String(args.titulo ?? '').trim();
    const dataIso = String(args.data_iso ?? '').trim();
    const hora = String(args.hora ?? '').trim();
    const tipo = String(args.tipo ?? 'consultation').trim();
    const duracaoMin =
      typeof args.duracao_min === 'number' && args.duracao_min > 0 ? args.duracao_min : 60;
    const observacoes = args.observacoes ? String(args.observacoes) : null;

    if (!titulo || !dataIso || !hora) {
      return {
        status: 'FALHA',
        error: 'Titulo, data e hora sao obrigatorios',
      } satisfies CriarAgendamentoToolResult;
    }

    // Combina data + hora em ISO completo (assume timezone do servidor)
    const [hh, mm] = hora.split(':').map(Number);
    const dt = new Date(dataIso);
    if (isNaN(dt.getTime())) {
      return {
        status: 'FALHA',
        error: `Data invalida: ${dataIso}`,
      } satisfies CriarAgendamentoToolResult;
    }
    dt.setHours(hh, mm, 0, 0);

    try {
      const [created] = await db
        .insert(appointments)
        .values({
          accountId: ctx.accountId,
          contactId: ctx.contactId,
          title: titulo.slice(0, 255),
          date: dt,
          time: hora,
          duration: duracaoMin,
          type: tipo.slice(0, 50),
          description: observacoes?.slice(0, 5000),
        })
        .returning({ id: appointments.id });

      logger.info(
        { accountId: ctx.accountId, apptId: created.id, dt },
        '[DANI Tool] appointment created',
      );

      return {
        status: 'AGENDADO',
        appointment_id: created.id,
        data: dataIso,
        hora,
        duracao: duracaoMin,
      } satisfies CriarAgendamentoToolResult;
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[DANI Tool] criar_agendamento failed');
      return {
        status: 'FALHA',
        error: (err as Error).message.slice(0, 150),
      } satisfies CriarAgendamentoToolResult;
    }
  },

  async buscar_produtos(args, ctx) {
    const consulta = String(args.consulta ?? '').trim();
    if (!consulta) {
      return { status: 'NAO_ENCONTRADO', total: 0, produtos: [] } satisfies BuscarProdutosToolResult;
    }

    const results = await buscarProdutos({ accountId: ctx.accountId, consulta, limit: 8 });
    logger.info(
      { accountId: ctx.accountId, consulta, found: results.length },
      '[DANI Tool] buscar_produtos',
    );

    if (results.length === 0) {
      return { status: 'NAO_ENCONTRADO', total: 0, produtos: [] } satisfies BuscarProdutosToolResult;
    }

    return {
      status: 'ENCONTRADO',
      total: results.length,
      produtos: results.map((p) => ({
        nome: p.nome,
        preco: p.preco,
        preco_promocional: p.precoPromocional,
        disponivel: p.disponivel,
        estoque: p.estoque,
        marca: p.marca,
      })),
    } satisfies BuscarProdutosToolResult;
  },

  async buscar_produto_detalhe(args, ctx) {
    const consulta = String(args.consulta ?? '').trim();
    if (!consulta) {
      return { status: 'NAO_ENCONTRADO' } satisfies BuscarProdutoDetalheToolResult;
    }

    const result = await buscarProdutoDetalhe({ accountId: ctx.accountId, consulta });
    logger.info(
      { accountId: ctx.accountId, consulta, found: !!result },
      '[DANI Tool] buscar_produto_detalhe',
    );

    if (!result) {
      return { status: 'NAO_ENCONTRADO' } satisfies BuscarProdutoDetalheToolResult;
    }

    return {
      status: result.disponivel ? 'ENCONTRADO' : 'SEM_ESTOQUE',
      nome: result.nome,
      preco: result.preco,
      preco_promocional: result.precoPromocional,
      disponivel: result.disponivel,
      estoque: result.estoque,
      marca: result.marca,
      imagem: result.imagem,
      descricao_curta: result.descricaoCurta,
    } satisfies BuscarProdutoDetalheToolResult;
  },
};
