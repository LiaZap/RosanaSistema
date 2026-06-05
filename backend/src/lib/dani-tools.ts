import {
  SchemaType,
  type FunctionDeclaration,
} from '@google/generative-ai';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appointments } from '../db/schema.js';
import { buscarProdutos, buscarProdutoDetalhe } from './dani-products.js';
import { buscarMidia, trackUse } from './media-library.js';
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
    name: 'enviar_arquivo',
    description:
      'Envia um arquivo da biblioteca (catalogo PDF, video de produto, audio explicativo) ' +
      'pelo WhatsApp. Use quando o cliente pedir "catalogo", "tabela", "video", "PDF", etc. ' +
      'Busca no acervo da loja, NAO no catalogo Bling.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        busca: {
          type: SchemaType.STRING,
          description:
            'Termo de busca curto. Ex: "catalogo enxoval", "tabela aluguel", "video carrinho ping two".',
        },
        motivo: {
          type: SchemaType.STRING,
          description: 'Por que esta enviando esse arquivo (interno, ajuda o sistema).',
        },
      },
      required: ['busca'],
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
    // escassez: poucas unidades em estoque. Serve pra DANI criar urgencia
    // ("ultimas unidades") SEM nunca revelar a quantidade exata (pedido Rosana).
    escassez: boolean;
    marca: string | null;
    estoque_realtime?: boolean; // true se top-3 conferido agora
  }>;
}

export interface BuscarProdutoDetalheToolResult {
  status: 'ENCONTRADO' | 'SEM_ESTOQUE' | 'NAO_ENCONTRADO';
  nome?: string;
  preco?: number | null;
  preco_promocional?: number | null;
  disponivel?: boolean;
  // escassez: poucas unidades. Cria urgencia SEM revelar a quantidade exata.
  escassez?: boolean;
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
export interface EnviarArquivoToolResult {
  status: 'ENVIADO' | 'NAO_ENCONTRADO';
  arquivos?: Array<{
    nome: string;
    descricao: string | null;
    tipo: string;
    url: string;
  }>;
}

export const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
> = {
  async enviar_arquivo(args, ctx) {
    const busca = String(args.busca ?? '').trim();
    if (!busca) {
      return { status: 'NAO_ENCONTRADO' } satisfies EnviarArquivoToolResult;
    }
    const results = await buscarMidia({ accountId: ctx.accountId, consulta: busca, limit: 3 });
    if (results.length === 0) {
      logger.info({ busca }, '[DANI Tool] enviar_arquivo - sem matches');
      return { status: 'NAO_ENCONTRADO' } satisfies EnviarArquivoToolResult;
    }
    // Track use do primeiro (mais relevante)
    void trackUse(results[0].id);
    logger.info(
      { busca, found: results.length, top: results[0].name },
      '[DANI Tool] enviar_arquivo',
    );
    return {
      status: 'ENVIADO',
      arquivos: results.map((r) => ({
        nome: r.name,
        descricao: r.description,
        tipo: r.fileType,
        url: r.fileUrl,
      })),
    } satisfies EnviarArquivoToolResult;
  },
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

    // L4: valida o formato da hora ANTES de usar (Gemini as vezes manda
    // '14', '2 da tarde', '14:00h' -> NaN -> Invalid Date).
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return {
        status: 'FALHA',
        error: `Hora invalida: ${hora} (use HH:MM)`,
      } satisfies CriarAgendamentoToolResult;
    }

    // H7: monta o instante com offset BRT (-03:00) EXPLICITO. Sem isso, o
    // servidor (containers em UTC) interpretava a hora como UTC e o
    // agendamento/convite GCal saiam 3h deslocados em TODO agendamento.
    const [hRaw, mRaw] = hora.split(':');
    const hhmm = `${hRaw.padStart(2, '0')}:${mRaw.padStart(2, '0')}`;
    const dataOnly = dataIso.slice(0, 10); // YYYY-MM-DD
    const dt = new Date(`${dataOnly}T${hhmm}:00-03:00`);
    if (isNaN(dt.getTime())) {
      return {
        status: 'FALHA',
        error: `Data/hora invalida: ${dataIso} ${hora}`,
      } satisfies CriarAgendamentoToolResult;
    }

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

      // Tenta sync com Google Calendar (se conectado, async fire-and-forget)
      (async () => {
        try {
          const { createEvent } = await import('./google-calendar.js');
          const endDt = new Date(dt.getTime() + duracaoMin * 60_000);
          const tz = 'America/Sao_Paulo';
          const gEvent = await createEvent({
            accountId: ctx.accountId,
            event: {
              summary: titulo,
              description: observacoes ?? `Tipo: ${tipo}\nCriado pela DANI`,
              start: { dateTime: dt.toISOString(), timeZone: tz },
              end: { dateTime: endDt.toISOString(), timeZone: tz },
            },
          });
          if (gEvent?.id) {
            await db
              .update(appointments)
              .set({ googleEventId: gEvent.id })
              .where(eq(appointments.id, created.id));
            logger.info(
              { apptId: created.id, gEventId: gEvent.id },
              '[DANI Tool] appointment synced to Google Calendar',
            );
          }
        } catch (err) {
          logger.debug(
            { err: (err as Error).message },
            '[DANI Tool] GCal sync skipped (not connected or error)',
          );
        }
      })();

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
        escassez: p.disponivel && p.estoque > 0 && p.estoque <= 3,
        marca: p.marca,
        estoque_realtime: p.stockSource === 'realtime',
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
      escassez: !!result.disponivel && (result.estoque ?? 0) > 0 && (result.estoque ?? 0) <= 3,
      marca: result.marca,
      imagem: result.imagem,
      descricao_curta: result.descricaoCurta,
    } satisfies BuscarProdutoDetalheToolResult;
  },
};
