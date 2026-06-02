import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, googleCalendarConnections } from '../db/schema.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
  listEvents,
  saveConnection,
} from '../lib/google-calendar.js';
import { logger } from '../lib/logger.js';

const gcal = new Hono();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_URL = process.env.API_URL || 'http://localhost:4000';
const STATE_COOKIE = 'gcal_oauth_state';
const ACCOUNT_COOKIE = 'gcal_oauth_account';

async function assertOwnerOrAdmin(userId: string, accountId: string) {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  if (!member) throw new NotFoundError('Conta não encontrada');
  if (member.status !== 'active') throw new ForbiddenError('Membership inativo');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Apenas owner/admin pode gerenciar Google Calendar');
  }
}

// ── GET /google-calendar/status ─────────────────────
gcal.get('/status', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  const conn = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.accountId, accountId),
  });
  return c.json({
    connected: !!conn?.accessToken,
    email: conn?.email ?? null,
    expiresAt: conn?.expiresAt ?? null,
    syncEnabled: conn?.syncEnabled ?? false,
    configured: !!process.env.GOOGLE_CLIENT_ID,
  });
});

// ── GET /google-calendar/auth/start ─────────────────
gcal.get('/auth/start', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  if (!process.env.GOOGLE_CLIENT_ID) {
    return c.json(
      { error: 'GOOGLE_CLIENT_ID nao configurado nos secrets do backend' },
      503,
    );
  }

  const state = randomBytes(16).toString('hex');
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });
  setCookie(c, ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });

  const redirectUri = `${API_URL}/google-calendar/auth/callback`;
  const url = buildAuthUrl({ state, redirectUri });
  logger.info({ accountId, redirectUri }, '[GCal] OAuth start');
  return c.redirect(url, 302);
});

// ── GET /google-calendar/auth/callback ──────────────
gcal.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');

  const cookieState = getCookie(c, STATE_COOKIE);
  const accountId = getCookie(c, ACCOUNT_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/' });
  deleteCookie(c, ACCOUNT_COOKIE, { path: '/' });

  const errRedirect = (msg: string) =>
    c.redirect(`${FRONTEND_URL}/appointments?gcal_error=${encodeURIComponent(msg)}`, 302);

  if (errorParam) return errRedirect(`Google: ${errorParam}`);
  if (!code || !state) return errRedirect('missing code or state');
  if (!cookieState || cookieState !== state) return errRedirect('state mismatch (CSRF)');
  if (!accountId) return errRedirect('account session expirou');

  try {
    const redirectUri = `${API_URL}/google-calendar/auth/callback`;
    const tokens = await exchangeCodeForTokens({ code, redirectUri });
    const userInfo = await getUserInfo(tokens.access_token);
    await saveConnection({ accountId, tokens, email: userInfo.email });
    logger.info({ accountId, email: userInfo.email }, '[GCal] OAuth complete');
    return c.redirect(`${FRONTEND_URL}/appointments?gcal_connected=1`, 302);
  } catch (err) {
    return errRedirect((err as Error).message);
  }
});

// ── DELETE /google-calendar/connection ──────────────
gcal.delete('/connection', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);
  await db
    .delete(googleCalendarConnections)
    .where(eq(googleCalendarConnections.accountId, accountId));
  return c.json({ ok: true });
});

// ── GET /google-calendar/events ─────────────────────
const eventsSchema = z.object({
  accountId: z.string().uuid(),
  timeMin: z.string(),
  timeMax: z.string(),
});

gcal.get('/events', requireAuth, async (c) => {
  const user = getUser(c);
  const parsed = eventsSchema.safeParse({
    accountId: c.req.query('accountId'),
    timeMin: c.req.query('timeMin'),
    timeMax: c.req.query('timeMax'),
  });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  await assertOwnerOrAdmin(user.id, parsed.data.accountId);

  const events = await listEvents(parsed.data);
  return c.json({
    events: events.map((e) => ({
      id: e.id,
      title: e.summary,
      description: e.description,
      start: e.start?.dateTime,
      end: e.end?.dateTime,
      link: e.htmlLink,
      source: 'google' as const,
    })),
  });
});

export default gcal;
