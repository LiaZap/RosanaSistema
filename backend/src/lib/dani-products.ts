import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import { fetchStockBatch } from './bling-stock.js';
import { logger } from './logger.js';

/**
 * Helpers de busca de produtos usados pelas tools da DANI.
 *
 * Phase 2B: implementacao simples com ILIKE + ranking manual.
 * Suficiente pra catalogo ate ~10k produtos. Otimizacao com pg_trgm
 * + unaccent fica como melhoria futura (precisaria de funcao SQL).
 */

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Grupos de SINONIMOS de busca. Quando a consulta menciona qualquer termo
 * de um grupo, a busca tambem procura os outros termos do mesmo grupo.
 *
 * Caso da loja: o tecido macio/quentinho esta cadastrado no Bling como
 * "Microsoft" (marca de tecido plush/fleece). Cliente que pede "soft",
 * "fleece" ou "plush" precisa achar os produtos "Microsoft".
 *
 * Pra adicionar novos sinonimos no futuro: e so incluir um array aqui.
 */
const SYNONYM_GROUPS: string[][] = [
  ['soft', 'microsoft', 'fleece', 'plush', 'pelucia', 'peluciado', 'peludinho'],
];

/**
 * Dada a consulta normalizada, retorna os termos EXTRAS (sinonimos) que devem
 * entrar na busca. Nao inclui o que ja esta na consulta.
 */
function expandSynonyms(q: string): string[] {
  const extras = new Set<string>();
  for (const group of SYNONYM_GROUPS) {
    // O grupo "dispara" se a consulta contem qualquer termo dele
    if (group.some((term) => q.includes(term))) {
      for (const term of group) {
        if (!q.includes(term)) extras.add(term);
      }
    }
  }
  return [...extras];
}

export interface ProductSearchResult {
  id: string;
  blingId: string | null;
  nome: string;
  codigo: string | null;
  preco: number | null;
  precoPromocional: number | null;
  estoque: number;
  disponivel: boolean;
  marca: string | null;
  categoria: string | null;
  imagem: string | null; // primeira imagem - retro-compat
  imagens: string[]; // todas as imagens FULL do Bling (max 5)
  descricaoCurta: string | null;
  stockSource?: 'realtime' | 'cache';
}

function mapRow(row: typeof produtosCatalogo.$inferSelect): ProductSearchResult {
  // Prioridade da imagem: Cloudinary (CDN externo) > MinIO local > Bling fallback
  // MinIO retorna URL relativa /media/file/:id - frontend monta absoluta.
  // Sempre que o produto tem imagemBling, o endpoint /media/file/:id funciona
  // (faz lazy upload se MinIO ainda nao tem cache).
  // Monta lista de URLs (preferindo cache, fallback Bling lazy)
  let imagens: string[] = [];
  if (Array.isArray(row.imagensMinio) && row.imagensMinio.length > 0) {
    imagens = row.imagensMinio;
  } else if (row.imagemCloudinary) {
    imagens = [row.imagemCloudinary];
  } else if (row.imagemMinio) {
    imagens = [row.imagemMinio];
  } else if (row.imagemBling || row.blingId) {
    // Lazy: /media/file/:id baixa todas e popula imagensMinio
    imagens = [`/media/file/${row.id}`];
  }
  const imagem: string | null = imagens[0] ?? null;

  return {
    id: row.id,
    blingId: row.blingId,
    nome: row.nome,
    codigo: row.codigo,
    preco: row.preco ? Number(row.preco) : null,
    precoPromocional: row.precoPromocional ? Number(row.precoPromocional) : null,
    estoque: row.estoque ?? 0,
    disponivel: row.disponivel,
    marca: row.marca,
    categoria: row.categoria,
    imagem,
    imagens,
    descricaoCurta: row.descricaoCurta,
    stockSource: 'cache',
  };
}

/**
 * Sprint 2: para top-3 produtos retornados, consulta Bling /estoques/saldos
 * e SOBRESCREVE disponivel/estoque com o valor real. Cache Redis 5s evita
 * spam quando varias mensagens pedem o mesmo produto.
 *
 * Falhas (timeout, Bling down) sao silenciosas: produto fica com stockSource='cache'.
 */
async function enrichWithRealtimeStock(
  accountId: string,
  results: ProductSearchResult[],
): Promise<ProductSearchResult[]> {
  if (results.length === 0) return results;

  const top = results.slice(0, 3);
  const blingIds = top.map((p) => p.blingId).filter((id): id is string => !!id);

  if (blingIds.length === 0) return results;

  try {
    const stockMap = await fetchStockBatch({ accountId, blingIds });

    return results.map((p) => {
      if (!p.blingId) return p;
      const real = stockMap[p.blingId];
      if (!real) return p;
      const changed = p.estoque !== real.saldo || p.disponivel !== real.disponivel;
      if (changed) {
        logger.info(
          {
            blingId: p.blingId,
            nome: p.nome,
            cache: { estoque: p.estoque, disponivel: p.disponivel },
            real: real,
          },
          '[Stock] real-time disagrees with cache',
        );
      }
      return {
        ...p,
        estoque: real.saldo,
        disponivel: real.disponivel,
        stockSource: 'realtime' as const,
      };
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, accountId },
      '[Stock] enrichment failed - using cache values',
    );
    return results;
  }
}

/**
 * Busca produtos por nome. Estrategia:
 *  1. Match exato no nome normalizado (preferido)
 *  2. Match por prefixo (LIKE 'query%')
 *  3. Match por conteudo (LIKE '%query%')
 *  4. Ordena: disponivel > preco > comprimento do nome
 *
 * Retorna ate `limit` resultados, default 8.
 */
export async function buscarProdutos(opts: {
  accountId: string;
  consulta: string;
  limit?: number;
}): Promise<ProductSearchResult[]> {
  const limit = opts.limit ?? 8;
  const q = normalize(opts.consulta);
  if (!q) return [];

  // Sinonimos de tecido (ex: soft/fleece -> "microsoft" no cadastro)
  const synTerms = expandSynonyms(q);

  // WHERE: match na consulta OU em qualquer sinonimo
  const matchClauses = [
    sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${q}%`}`,
    ...synTerms.map((t) => sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${t}%`}`),
  ];
  const whereMatch = matchClauses.reduce((a, b) => sql`${a} OR ${b}`);

  // Match por sinonimo (pra dar score quando casa so via sinonimo)
  const synMatch = synTerms.length
    ? synTerms
        .map((t) => sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${t}%`}`)
        .reduce((a, b) => sql`${a} OR ${b}`)
    : sql`false`;

  // Score: 100 exato | 50 prefix | 30 contains | 25 via sinonimo | +40 disponivel
  const score = sql<number>`(
    case
      when ${produtosCatalogo.nomeNormalizado} = ${q} then 100
      when ${produtosCatalogo.nomeNormalizado} ilike ${`${q}%`} then 50
      when ${produtosCatalogo.nomeNormalizado} ilike ${`%${q}%`} then 30
      when (${synMatch}) then 25
      else 0
    end +
    case when ${produtosCatalogo.disponivel} = true then 40 else 0 end
  )`;

  const rows = await db
    .select()
    .from(produtosCatalogo)
    .where(
      and(
        eq(produtosCatalogo.accountId, opts.accountId),
        sql`(${whereMatch})`,
      ),
    )
    .orderBy(desc(score), desc(produtosCatalogo.disponivel))
    .limit(limit);

  const mapped = rows.map(mapRow);
  return await enrichWithRealtimeStock(opts.accountId, mapped);
}

/**
 * Pega 1 produto detalhado (foto, descricao). Usa mesma logica de busca,
 * mas sempre retorna o melhor match (ou null).
 */
export async function buscarProdutoDetalhe(opts: {
  accountId: string;
  consulta: string;
}): Promise<ProductSearchResult | null> {
  const results = await buscarProdutos({ ...opts, limit: 1 });
  return results[0] ?? null;
}
