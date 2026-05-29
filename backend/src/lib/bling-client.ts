import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { blingCredentials } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Cliente Bling API v3 com OAuth2.
 * Docs: https://developer.bling.com.br
 */

const BLING_AUTHORIZE_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';

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
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
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
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
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
 * Retorna null se a conta nao tem credentials/tokens.
 */
export async function getValidAccessToken(accountId: string): Promise<string | null> {
  const cred = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });

  if (!cred?.accessToken || !cred.refreshToken || !cred.clientId || !cred.clientSecret) {
    return null;
  }

  // Se expira em menos de 5min, renova
  const expiresAt = cred.expiresAt?.getTime() ?? 0;
  const fiveMinFromNow = Date.now() + 5 * 60 * 1000;

  if (expiresAt > fiveMinFromNow) {
    return cred.accessToken;
  }

  // Renova
  logger.info({ accountId, expiresAt }, '[Bling] refreshing access_token');
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

  return tokens.access_token;
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
