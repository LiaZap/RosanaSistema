import { getValidAccessToken } from './bling-client.js';
import { getRedis } from './queues.js';
import { logger } from './logger.js';

/**
 * Sprint 2 — Stock real-time do Bling com cache Redis.
 *
 * Problema: produtos_catalogo.estoque sincroniza a cada 5h.
 * Cliente pergunta "tem windi?" -> resposta pode estar errada.
 *
 * Solucao: antes de DANI responder, chama Bling /estoques/saldos
 * pra ate 100 bling_ids. Cache Redis 5s pra amortizar picos.
 *
 * Timeout 1500ms - se Bling lento/down, fallback ao cache do banco
 * sem bloquear o LLM.
 */

const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';
const CACHE_TTL_SECONDS = 5;
const FETCH_TIMEOUT_MS = 1500;

interface StockMap {
  [blingId: string]: {
    saldo: number;
    disponivel: boolean;
  };
}

function cacheKey(accountId: string, blingId: string): string {
  return `fce:stock:${accountId}:${blingId}`;
}

/**
 * Pega saldos em batch do Bling. Sequencia:
 *  1. Tenta servir do cache Redis
 *  2. Pra IDs nao cacheados, chama Bling /estoques/saldos?idsProdutos[]=
 *  3. Salva no cache + retorna mapa
 */
export async function fetchStockBatch(opts: {
  accountId: string;
  blingIds: string[];
}): Promise<StockMap> {
  if (opts.blingIds.length === 0) return {};

  const redis = getRedis();
  const out: StockMap = {};
  const idsToFetch: string[] = [];

  // Try cache first
  const cacheKeys = opts.blingIds.map((id) => cacheKey(opts.accountId, id));
  try {
    const cached = await redis.mget(...cacheKeys);
    for (let i = 0; i < opts.blingIds.length; i++) {
      const v = cached[i];
      if (v !== null && v !== undefined) {
        try {
          out[opts.blingIds[i]] = JSON.parse(v);
        } catch {
          idsToFetch.push(opts.blingIds[i]);
        }
      } else {
        idsToFetch.push(opts.blingIds[i]);
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Stock] cache read failed - going direct');
    idsToFetch.push(...opts.blingIds);
  }

  if (idsToFetch.length === 0) {
    return out;
  }

  // Fetch from Bling
  const token = await getValidAccessToken(opts.accountId);
  if (!token) {
    logger.warn({ accountId: opts.accountId }, '[Stock] no Bling token - skip realtime');
    return out;
  }

  const url = new URL(`${BLING_API_BASE}/estoques/saldos`);
  for (const id of idsToFetch.slice(0, 100)) {
    url.searchParams.append('idsProdutos[]', id);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let fetched = 0;
  const start = Date.now();

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      logger.warn(
        { status: res.status, ids: idsToFetch.length },
        '[Stock] Bling returned non-200',
      );
      return out;
    }

    const json = (await res.json()) as {
      data?: Array<{
        produto?: { id: number };
        saldoVirtualTotal?: number;
        saldoFisicoTotal?: number;
      }>;
    };

    if (!json.data) return out;

    const toCache: Record<string, string> = {};
    for (const item of json.data) {
      const id = item.produto?.id != null ? String(item.produto.id) : null;
      if (!id) continue;
      // saldoVirtualTotal = fisico - reservados
      const saldo = item.saldoVirtualTotal ?? item.saldoFisicoTotal ?? 0;
      const entry = { saldo, disponivel: saldo > 0 };
      out[id] = entry;
      toCache[cacheKey(opts.accountId, id)] = JSON.stringify(entry);
      fetched++;
    }

    // Cache em paralelo (best-effort)
    if (Object.keys(toCache).length > 0) {
      const pipeline = redis.pipeline();
      for (const [k, v] of Object.entries(toCache)) {
        pipeline.set(k, v, 'EX', CACHE_TTL_SECONDS);
      }
      pipeline.exec().catch((err) => logger.warn({ err: err.message }, '[Stock] cache write failed'));
    }

    logger.info(
      {
        accountId: opts.accountId,
        requested: idsToFetch.length,
        fetched,
        cached: opts.blingIds.length - idsToFetch.length,
        ms: Date.now() - start,
      },
      '[Stock] batch complete',
    );
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = (err as Error).message;
    if ((err as Error).name === 'AbortError') {
      logger.warn(
        { accountId: opts.accountId, ms: Date.now() - start, ids: idsToFetch.length },
        '[Stock] Bling timeout - using cache fallback',
      );
    } else {
      logger.warn({ err: msg }, '[Stock] Bling fetch error - using cache fallback');
    }
  }

  return out;
}
