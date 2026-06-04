import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { blingCredentials } from '../db/schema.js';
import { getRedis } from './queues.js';
import { logger } from './logger.js';

/**
 * Cliente Bling API v3 com OAuth2.
 * Docs: https://developer.bling.com.br
 */

// Authorize fica em www (usuario interage com tela de login Bling)
// Token e API resources ficam em api.bling.com.br (doc oficial Bling v3)
// IMPORTANTE: usar www pro /token causa Cloudflare 1015 rate limit!
const BLING_AUTHORIZE_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE = 'https://api.bling.com.br/Api/v3';

export interface BlingTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number; // segundos
  token_type: string;
}

/**
 * Monta URL de autorização OAuth2.
 *
 * IMPORTANTE: Bling NAO aceita redirect_uri no query string do authorize.
 * Ele compara o request com o redirect_uri cadastrado no app, e qualquer
 * diferenca (incluindo o parametro existir) causa redirect_uri_mismatch.
 * Por isso so passamos response_type, client_id e state.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    state: opts.state,
  });
  return `${BLING_AUTHORIZE_URL}?${params.toString()}`;
}

// Headers obrigatorios pelo Bling OAuth doc:
// - Accept: 1.0 (versionamento exigido pela doc)
// User-Agent realista de Chrome ajuda em algumas rotas com proteção bot
const OAUTH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '1.0',
};

/**
 * Troca authorization code por tokens.
 * Bling exige Basic Auth com clientId:clientSecret.
 */
export async function exchangeCodeForTokens(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<BlingTokens> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
  });

  const res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      ...OAUTH_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    logger.error({ status: res.status, body: text.slice(0, 500) }, '[Bling] token exchange failed');
    throw new Error(`Bling token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as BlingTokens;
}

/**
 * Renova access_token usando refresh_token.
 */
export async function refreshTokens(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<BlingTokens> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });

  const res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      ...OAUTH_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    logger.error({ status: res.status, body: text.slice(0, 500) }, '[Bling] refresh failed');
    throw new Error(`Bling refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as BlingTokens;
}

/**
 * Pega um access_token valido pra uma account. Renova se expirou.
 *
 * Circuit breaker via Redis:
 *  - Se ja teve refresh nos ultimos 60s, retorna o token atual (mesmo se
 *    proximo de expirar) pra evitar cascata
 *  - Se ultimo refresh falhou, espera 5min antes de tentar de novo
 *
 * Retorna null se a conta nao tem credentials/tokens.
 */
const REFRESH_COOLDOWN_OK_S = 60;
const REFRESH_COOLDOWN_FAIL_S = 300;
const REFRESH_COOLDOWN_RATELIMIT_S = 900; // 15min pra Cloudflare 1015 destravar

export async function getValidAccessToken(accountId: string): Promise<string | null> {
  const cred = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });

  if (!cred?.accessToken || !cred.refreshToken || !cred.clientId || !cred.clientSecret) {
    return null;
  }

  // Se expira em menos de 5min, tenta renovar
  const expiresAt = cred.expiresAt?.getTime() ?? 0;
  const fiveMinFromNow = Date.now() + 5 * 60 * 1000;

  if (expiresAt > fiveMinFromNow) {
    return cred.accessToken;
  }

  // Circuit breaker: se ja refrescou recentemente, retorna token atual
  const redis = getRedis();
  const okKey = `fce:bling:refresh:ok:${accountId}`;
  const failKey = `fce:bling:refresh:fail:${accountId}`;

  try {
    const [recentOk, recentFail] = await Promise.all([
      redis.get(okKey),
      redis.get(failKey),
    ]);

    if (recentFail) {
      logger.warn(
        { accountId, ttl: await redis.ttl(failKey) },
        '[Bling] refresh in cooldown after failure - returning current token',
      );
      return cred.accessToken;
    }
    if (recentOk) {
      logger.debug({ accountId }, '[Bling] refresh recently done - using current token');
      return cred.accessToken;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Bling] redis check failed - proceeding');
  }

  // Renova
  logger.info({ accountId, expiresAt }, '[Bling] refreshing access_token');

  try {
    const tokens = await refreshTokens({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      refreshToken: cred.refreshToken,
    });

    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await db
      .update(blingCredentials)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(blingCredentials.accountId, accountId));

    // Marca cooldown de sucesso
    redis.set(okKey, '1', 'EX', REFRESH_COOLDOWN_OK_S).catch(() => {});
    return tokens.access_token;
  } catch (err) {
    const msg = (err as Error).message;
    // Detecta Cloudflare 1015 / rate limit -> cooldown maior
    const isRateLimit = /\b(429|1015|rate limit|rate-limit|too many)\b/i.test(msg);
    const cooldown = isRateLimit ? REFRESH_COOLDOWN_RATELIMIT_S : REFRESH_COOLDOWN_FAIL_S;
    logger.error(
      { accountId, err: msg, cooldown, isRateLimit },
      isRateLimit
        ? '[Bling] CLOUDFLARE RATE LIMIT - 15min cooldown'
        : '[Bling] refresh failed - 5min cooldown',
    );
    // Marca cooldown de falha
    redis.set(failKey, msg.slice(0, 200), 'EX', cooldown).catch(() => {});
    // L5: so devolve o token atual se ele AINDA nao expirou (margem 30s).
    // Token expirado nao adianta e mascarava a falha como 401 confuso no
    // sync; com null, o guard `if(!token)` do chamador trata limpo.
    if (cred.expiresAt && new Date(cred.expiresAt).getTime() > Date.now() + 30_000) {
      return cred.accessToken;
    }
    return null;
  }
}

/** Tipo minimo de produto retornado pela Bling API v3 */
export interface BlingProductRaw {
  id: number;
  nome: string;
  codigo?: string;
  preco?: number;
  precoCusto?: number;
  situacao?: string;
  tipo?: string;
  imagemURL?: string;
  marca?: string;
  categoria?: { id?: number; descricao?: string };
  estoque?: {
    saldoVirtualTotal?: number;
    minimo?: number;
  };
  descricaoCurta?: string;
  promocao?: { precoPromocional?: number };
}

/**
 * Pega 1 produto pelo blingId. Retorna URL de imagem ATUAL.
 *
 * Schema oficial da Bling API v3:
 *   data.midia.imagens.externas[].link            - URL externa (CDN da loja)
 *   data.midia.imagens.internas[].linkMiniatura   - URL S3 pre-signed (1mes-1ano)
 *   data.midia.imagens.internas[].validade        - data ISO de expiracao
 *   data.imagemURL                                 - campo legacy V2
 *
 * Ordem de prioridade: externas > internas (linkMiniatura) > imagemURL.
 * Externas sao mais estaveis (CDN proprio do lojista), internas tem validade
 * limitada mas ainda servem pra baixar e cachear no MinIO.
 */
export async function fetchFreshProductImageUrl(opts: {
  accessToken: string;
  blingId: string;
}): Promise<string | null> {
  const url = `${BLING_API_BASE}/produtos/${opts.blingId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    logger.warn({ blingId: opts.blingId, status: res.status }, '[Bling] fetchProductImage failed');
    return null;
  }

  const json = (await res.json()) as {
    data?: {
      imagemURL?: string;
      midia?: {
        imagens?: {
          externas?: Array<{ link?: string; ordem?: number }>;
          internas?: Array<{
            link?: string;
            linkMiniatura?: string;
            validade?: string;
            ordem?: number;
          }>;
        };
      };
    };
  };

  const now = Date.now();
  const validadeOk = (validade?: string) => {
    if (!validade) return true;
    const expira = Date.parse(validade);
    return Number.isFinite(expira) ? expira > now : true;
  };
  // Sort por ordem ASC pra pegar a IMAGEM PRINCIPAL (ordem=1) do Bling.
  // Ordem ausente vai pro final.
  const byOrdem = (a: { ordem?: number }, b: { ordem?: number }) =>
    (a.ordem ?? 999) - (b.ordem ?? 999);

  void byOrdem; // mantido pra retro-compat com fetchFreshProductImages

  // 1. Externas - imagem principal por ordem
  const externas = (json.data?.midia?.imagens?.externas ?? [])
    .filter((e) => e.link)
    .sort((a, b) => (a.ordem ?? 999) - (b.ordem ?? 999));
  if (externas[0]?.link) {
    logger.debug(
      { blingId: opts.blingId, source: 'externa', ordem: externas[0].ordem },
      '[Bling] image URL resolved',
    );
    return externas[0].link;
  }

  // 2. Internas - REGRA: sempre FULL (link), nunca miniatura.
  // Schema: { link (FULL), linkMiniatura (thumb /t/), validade, ordem }
  // Procura a primeira imagem por ordem que tenha link FULL.
  // Miniatura so se NENHUMA imagem tiver link (caso raro, avisamos).
  const internas = (json.data?.midia?.imagens?.internas ?? [])
    .filter((i) => (i.link || i.linkMiniatura) && validadeOk(i.validade))
    .sort(byOrdem);

  // PASS 1: procura por imagem com link FULL (qualquer ordem)
  const fullSize = internas.find((i) => i.link);
  if (fullSize?.link) {
    logger.debug(
      { blingId: opts.blingId, source: 'interna.link', ordem: fullSize.ordem },
      '[Bling] image URL resolved (FULL size)',
    );
    return fullSize.link;
  }

  // PASS 2: ultimo recurso - linkMiniatura (so se ZERO imagens tem link)
  const thumb = internas.find((i) => i.linkMiniatura);
  if (thumb?.linkMiniatura) {
    logger.warn(
      { blingId: opts.blingId, ordem: thumb.ordem, totalInternas: internas.length },
      '[Bling] WARNING: only miniatures available, no full-size image',
    );
    return thumb.linkMiniatura;
  }

  // 3. Campo legacy V2
  if (json.data?.imagemURL) {
    logger.debug({ blingId: opts.blingId, source: 'imagemURL' }, '[Bling] image URL resolved (legacy)');
    return json.data.imagemURL;
  }

  logger.info({ blingId: opts.blingId }, '[Bling] no image URL found in product');
  return null;
}

/**
 * Pega TODAS as URLs FULL de um produto do Bling, ordenadas pela ordem
 * que o lojista cadastrou. Filtra miniaturas. Limite 5 imagens.
 *
 * Retorna array vazio se nao tiver imagens.
 */
export async function fetchFreshProductImages(opts: {
  accessToken: string;
  blingId: string;
}): Promise<string[]> {
  const url = `${BLING_API_BASE}/produtos/${opts.blingId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    data?: {
      imagemURL?: string;
      midia?: {
        imagens?: {
          externas?: Array<{ link?: string; ordem?: number }>;
          internas?: Array<{
            link?: string;
            linkMiniatura?: string;
            validade?: string;
            ordem?: number;
          }>;
        };
      };
    };
  };

  const now = Date.now();
  const validadeOk = (validade?: string) => {
    if (!validade) return true;
    const expira = Date.parse(validade);
    return Number.isFinite(expira) ? expira > now : true;
  };
  const byOrdem = (a: { ordem?: number }, b: { ordem?: number }) =>
    (a.ordem ?? 999) - (b.ordem ?? 999);

  const urls: string[] = [];

  // Externas FULL
  for (const e of (json.data?.midia?.imagens?.externas ?? []).sort(byOrdem)) {
    if (e.link) urls.push(e.link);
  }

  // Internas FULL (filtra por validade)
  for (const i of (json.data?.midia?.imagens?.internas ?? []).sort(byOrdem)) {
    if (i.link && validadeOk(i.validade)) urls.push(i.link);
  }

  // Legacy fallback
  if (urls.length === 0 && json.data?.imagemURL) {
    urls.push(json.data.imagemURL);
  }

  return urls.slice(0, 5); // max 5
}

/**
 * Lista produtos com paginacao. Retorna ate 100 por pagina.
 */
export async function listProducts(opts: {
  accessToken: string;
  pagina: number;
  limite?: number;
}): Promise<BlingProductRaw[]> {
  const url = new URL(`${BLING_API_BASE}/produtos`);
  url.searchParams.set('pagina', String(opts.pagina));
  url.searchParams.set('limite', String(opts.limite ?? 100));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bling listProducts ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: BlingProductRaw[] };
  return json.data ?? [];
}
