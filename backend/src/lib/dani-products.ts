import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';

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

export interface ProductSearchResult {
  id: string;
  nome: string;
  codigo: string | null;
  preco: number | null;
  precoPromocional: number | null;
  estoque: number;
  disponivel: boolean;
  marca: string | null;
  categoria: string | null;
  imagem: string | null; // cloudinary OR bling fallback
  descricaoCurta: string | null;
}

function mapRow(row: typeof produtosCatalogo.$inferSelect): ProductSearchResult {
  return {
    id: row.id,
    nome: row.nome,
    codigo: row.codigo,
    preco: row.preco ? Number(row.preco) : null,
    precoPromocional: row.precoPromocional ? Number(row.precoPromocional) : null,
    estoque: row.estoque ?? 0,
    disponivel: row.disponivel,
    marca: row.marca,
    categoria: row.categoria,
    imagem: row.imagemCloudinary ?? row.imagemBling,
    descricaoCurta: row.descricaoCurta,
  };
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

  // Score: 100 exato | 50 prefix | 30 contains | +40 se disponivel
  const score = sql<number>`(
    case
      when ${produtosCatalogo.nomeNormalizado} = ${q} then 100
      when ${produtosCatalogo.nomeNormalizado} ilike ${`${q}%`} then 50
      when ${produtosCatalogo.nomeNormalizado} ilike ${`%${q}%`} then 30
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
        sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${q}%`}`,
      ),
    )
    .orderBy(desc(score), desc(produtosCatalogo.disponivel))
    .limit(limit);

  return rows.map(mapRow);
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
