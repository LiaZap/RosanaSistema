import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  AppError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, blingCredentials } from '../db/schema.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from '../lib/bling-client.js';
import { syncBlingCatalog, countProducts } from '../lib/bling-sync.js';
import { logger } from '../lib/logger.js';

const bling = new Hono();

const credentialsSchema = z.object({
  accountId: z.string().uuid(),
  clientId: z.string().min(5).max(255),
  clientSecret: z.string().min(5).max(500),
});

const syncSchema = z.object({
  accountId: z.string().uuid(),
  maxProducts: z.number().int().min(1).max(50_000).optional(),
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_BASE_URL = process.env.API_URL || ''; // ex: https://liamed-fce-api.leyiy3.easypanel.host
const STATE_COOKIE = 'bling_oauth_state';
const ACCOUNT_COOKIE = 'bling_oauth_account';

async function assertAccountOwnerOrAdmin(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found or you are not a member');
  if (member.status !== 'active') throw new ForbiddenError('Membership is not active');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Only owners/admins can manage Bling integration');
  }
}

// ── GET /bling/credentials ───────────────────────────
// Status: tem credentials? esta conectado? (nao expoe secrets)
bling.get('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const cred = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });

  const productCount = await countProducts(accountId);

  return c.json({
    hasCredentials: !!cred?.clientId,
    connected: !!cred?.accessToken,
    expiresAt: cred?.expiresAt ?? null,
    productCount,
  });
});

// ── PUT /bling/credentials ───────────────────────────
// Cadastra/atualiza Client ID + Client Secret
bling.put('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { accountId, clientId, clientSecret } = parsed.data;
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const existing = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });

  if (existing) {
    await db
      .update(blingCredentials)
      .set({ clientId, clientSecret, updatedAt: new Date() })
      .where(eq(blingCredentials.accountId, accountId));
  } else {
    await db.insert(blingCredentials).values({ accountId, clientId, clientSecret });
  }

  return c.json({ ok: true });
});

// ── DELETE /bling/credentials ────────────────────────
bling.delete('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  await db.delete(blingCredentials).where(eq(blingCredentials.accountId, accountId));
  return c.json({ ok: true });
});

// ── GET /bling/auth/start ────────────────────────────
// Redireciona pro authorize do Bling com state CSRF
bling.get('/auth/start', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const cred = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });
  if (!cred?.clientId) {
    throw new ValidationError('Cadastre Client ID e Client Secret antes de conectar');
  }

  const state = randomBytes(16).toString('hex');

  // Salva state e accountId em cookies httpOnly pra validar no callback
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 600, // 10 min
    path: '/',
  });
  setCookie(c, ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });

  const redirectUri = `${API_BASE_URL}/bling/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    clientId: cred.clientId,
    redirectUri,
    state,
  });

  return c.redirect(authorizeUrl, 302);
});

// ── GET /bling/auth/callback ─────────────────────────
// Bling redireciona aqui com ?code=...&state=...
bling.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  const cookieState = getCookie(c, STATE_COOKIE);
  const accountId = getCookie(c, ACCOUNT_COOKIE);

  // Limpa cookies imediatamente
  deleteCookie(c, STATE_COOKIE, { path: '/' });
  deleteCookie(c, ACCOUNT_COOKIE, { path: '/' });

  const errorRedirect = (msg: string) =>
    c.redirect(`${FRONTEND_URL}/bling?error=${encodeURIComponent(msg)}`, 302);

  if (error) {
    return errorRedirect(`Bling returned error: ${error}`);
  }
  if (!code || !state) {
    return errorRedirect('missing code or state');
  }
  if (!cookieState || cookieState !== state) {
    return errorRedirect('state mismatch (CSRF check failed)');
  }
  if (!accountId) {
    return errorRedirect('account session expired - try again');
  }

  const cred = await db.query.blingCredentials.findFirst({
    where: eq(blingCredentials.accountId, accountId),
  });
  if (!cred?.clientId || !cred.clientSecret) {
    return errorRedirect('credentials missing');
  }

  try {
    const tokens = await exchangeCodeForTokens({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      code,
    });

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await db
      .update(blingCredentials)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(blingCredentials.accountId, accountId));

    logger.info({ accountId, expiresAt }, '[Bling] OAuth complete');
    return c.redirect(`${FRONTEND_URL}/bling?connected=1`, 302);
  } catch (err) {
    return errorRedirect((err as Error).message);
  }
});

// ── POST /bling/sync ─────────────────────────────────
// Dispara sync paginado inline. Pode demorar 30s-2min.
bling.post('/sync', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, maxProducts } = parsed.data;
  await assertAccountOwnerOrAdmin(user.id, accountId);

  logger.info({ accountId, maxProducts }, '[Bling] sync requested');
  const result = await syncBlingCatalog({ accountId, maxProducts });

  if (!result.ok) {
    throw new AppError(result.error ?? 'Sync failed', 500);
  }
  return c.json(result);
});

export default bling;
