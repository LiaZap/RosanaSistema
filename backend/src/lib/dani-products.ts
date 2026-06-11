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
  // Termico: cadastro mistura "Termica", "Termico" e "Thermo Dry" (ingles).
  // Sem isso, o cliente que pede "termico" nao acha a "Blusa Termica Thermo Dry".
  ['termico', 'termica', 'thermo'],
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

  // Tokeniza em palavras significativas. CRITICO: a busca antiga exigia a FRASE
  // INTEIRA como substring, entao "conjunto termico infantil" NAO casava com
  // "conjunto termico preto" -> DANI dizia "nao temos" pra produto que EXISTE.
  // Agora casamos por TOKEN e ranqueamos por quantos tokens batem. Palavras
  // genericas (infantil, etc.) sao ignoradas no ranking.
  const STOP = new Set([
    'infantil', 'para', 'com', 'dos', 'das', 'uma', 'tem', 'voce', 'quero',
    'pronta', 'entrega', 'que', 'por', 'meu', 'minha', 'seu', 'sua', 'esse',
    'essa', 'esta', 'tipo', 'aquele', 'aquela', 'preciso', 'queria', 'tamanho',
  ]);
  const tokens = q.split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));

  // WHERE: casa se o nome contem a frase inteira OU qualquer token OU sinonimo
  const matchTerms = Array.from(new Set([q, ...tokens, ...synTerms])).filter(Boolean);
  const whereMatch = matchTerms
    .map((t) => sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${t}%`}`)
    .reduce((a, b) => sql`${a} OR ${b}`);

  // Match por sinonimo (pra dar score quando casa so via sinonimo)
  const synMatch = synTerms.length
    ? synTerms
        .map((t) => sql`${produtosCatalogo.nomeNormalizado} ilike ${`%${t}%`}`)
        .reduce((a, b) => sql`${a} OR ${b}`)
    : sql`false`;

  // tokenScore: 20 por TOKEN da consulta que o nome cobre. E a relevancia por
  // COBERTURA — PRIMARIO na ordenacao. Assim "conjunto termico" traz o CONJUNTO
  // (2 tokens) ANTES do "Pote Termico" (1 token + sinonimo). Era o bug do copo
  // termico ranqueando na frente da roupa termica.
  const tokenScore = tokens.length
    ? tokens
        .map(
          (t) =>
            sql`(case when ${produtosCatalogo.nomeNormalizado} ilike ${`%${t}%`} then 20 else 0 end)`,
        )
        .reduce((a, b) => sql`${a} + ${b}`)
    : sql`0`;

  // Desempate: frase exata/prefix/contains + sinonimo. Peso BAIXO pra nao superar
  // a cobertura de tokens — o sinonimo so ajuda a ACHAR, nao a ranquear na frente.
  const phraseBonus = sql<number>`(
    case
      when ${produtosCatalogo.nomeNormalizado} = ${q} then 1000
      when ${produtosCatalogo.nomeNormalizado} ilike ${`${q}%`} then 500
      when ${produtosCatalogo.nomeNormalizado} ilike ${`%${q}%`} then 300
      else 0
    end
    + case when (${synMatch}) then 30 else 0 end
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
    .orderBy(desc(tokenScore), desc(phraseBonus), desc(produtosCatalogo.disponivel))
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
