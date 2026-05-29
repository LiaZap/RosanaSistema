import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import { getValidAccessToken, listProducts, type BlingProductRaw } from './bling-client.js';
import { logger } from './logger.js';

/**
 * Sincronizacao Bling -> produtos_catalogo.
 *
 * Paginacao: 100 produtos/pagina. Roda ate Bling retornar pagina vazia
 * ou ate o maxProducts configurado (default 5000 - seguranca).
 *
 * Estrategia: upsert por (account_id, bling_id). Mantem produtos existentes
 * atualizados sem deletar nada.
 */

const MAX_PRODUCTS_DEFAULT = 5000;
const PAGE_LIMIT = 100;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapBlingProduct(p: BlingProductRaw, accountId: string) {
  const preco = p.preco ?? 0;
  const precoPromocional = p.promocao?.precoPromocional ?? null;
  const estoque = p.estoque?.saldoVirtualTotal ?? 0;
  // disponivel = situacao 'A' (ativo) e tem estoque
  const disponivel = (p.situacao === 'A' || p.situacao === undefined) && estoque > 0;

  return {
    accountId,
    blingId: String(p.id),
    nome: p.nome.slice(0, 500),
    nomeNormalizado: normalizeName(p.nome).slice(0, 500),
    codigo: p.codigo?.slice(0, 100),
    preco: preco.toFixed(2),
    precoPromocional: precoPromocional != null ? precoPromocional.toFixed(2) : null,
    estoque,
    disponivel,
    descricaoCurta: p.descricaoCurta?.slice(0, 5000),
    imagemBling: p.imagemURL ?? null,
    marca: p.marca?.slice(0, 255),
    categoria: p.categoria?.descricao?.slice(0, 255),
    situacao: p.situacao?.slice(0, 50),
  };
}

export interface SyncResult {
  ok: boolean;
  pagesProcessed: number;
  productsInserted: number;
  productsUpdated: number;
  durationMs: number;
  error?: string;
}

/**
 * Roda sync completo. Pode ser chamado inline (request HTTP) ou de worker.
 *
 * Phase 3: inline no HTTP. Phase 2C/4 vamos mover pra fila.
 */
export async function syncBlingCatalog(opts: {
  accountId: string;
  maxProducts?: number;
}): Promise<SyncResult> {
  const start = Date.now();
  const max = opts.maxProducts ?? MAX_PRODUCTS_DEFAULT;

  const token = await getValidAccessToken(opts.accountId);
  if (!token) {
    return {
      ok: false,
      pagesProcessed: 0,
      productsInserted: 0,
      productsUpdated: 0,
      durationMs: Date.now() - start,
      error: 'No valid Bling access token. Connect via OAuth first.',
    };
  }

  let pagina = 1;
  let inserted = 0;
  let updated = 0;
  let total = 0;

  try {
    while (total < max) {
      const items = await listProducts({ accessToken: token, pagina, limite: PAGE_LIMIT });
      if (items.length === 0) break;

      for (const raw of items) {
        if (total >= max) break;
        const mapped = mapBlingProduct(raw, opts.accountId);

        // Upsert: tenta update por (accountId, blingId)
        const existing = await db
          .select({ id: produtosCatalogo.id })
          .from(produtosCatalogo)
          .where(
            and(
              eq(produtosCatalogo.accountId, opts.accountId),
              eq(produtosCatalogo.blingId, mapped.blingId),
            ),
          )
          .limit(1);

        if (existing[0]) {
          await db
            .update(produtosCatalogo)
            .set({ ...mapped, updatedAt: new Date() })
            .where(eq(produtosCatalogo.id, existing[0].id));
          updated++;
        } else {
          await db.insert(produtosCatalogo).values(mapped);
          inserted++;
        }
        total++;
      }

      logger.info(
        {
          accountId: opts.accountId,
          pagina,
          itemsInPage: items.length,
          totalProcessed: total,
        },
        '[BlingSync] page complete',
      );

      pagina++;
      if (items.length < PAGE_LIMIT) break; // ultima pagina
    }

    const durationMs = Date.now() - start;
    logger.info(
      {
        accountId: opts.accountId,
        pagesProcessed: pagina - 1,
        inserted,
        updated,
        durationMs,
      },
      '[BlingSync] complete',
    );

    return {
      ok: true,
      pagesProcessed: pagina - 1,
      productsInserted: inserted,
      productsUpdated: updated,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = (err as Error).message;
    logger.error({ err: msg, accountId: opts.accountId, durationMs }, '[BlingSync] failed');
    return {
      ok: false,
      pagesProcessed: pagina - 1,
      productsInserted: inserted,
      productsUpdated: updated,
      durationMs,
      error: msg,
    };
  }
}

/** Conta produtos no banco pra uma account */
export async function countProducts(accountId: string): Promise<{
  total: number;
  available: number;
}> {
  const [row] = await db
    .select({
      total: sql<number>`cast(count(*) as int)`,
      available: sql<number>`cast(count(*) filter (where ${produtosCatalogo.disponivel} = true) as int)`,
    })
    .from(produtosCatalogo)
    .where(eq(produtosCatalogo.accountId, accountId));
  return { total: row?.total ?? 0, available: row?.available ?? 0 };
}
