import {
  SchemaType,
  type FunctionDeclaration,
} from '@google/generative-ai';
import { buscarProdutos, buscarProdutoDetalhe } from './dani-products.js';
import { logger } from './logger.js';

/**
 * Function declarations das tools que a DANI usa.
 * O Gemini decide quando chamar; o orchestrator executa via handlerByName.
 */

export const DANI_TOOLS: FunctionDeclaration[] = [
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

/**
 * Executor das tools. Mapeado por nome — orchestrator chama o handler certo.
 */
export const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, ctx: { accountId: string }) => Promise<unknown>
> = {
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
