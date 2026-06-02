import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { googleCalendarConnections } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Google Calendar OAuth + API client.
 * Sem dependência (googleapis SDK) — usa fetch direto.
 *
 * Docs:
 *  - OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
 *  - Calendar API: https://developers.google.com/calendar/api/v3/reference
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export interface GoogleEvent {
  id?: string;
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: Array<{ email: string }>;
  htmlLink?: string;
}

/** URL de autorização (redireciona user pra Google) */
export function buildAuthUrl(opts: { state: string; redirectUri: string }): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID nao configurado');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Troca code por tokens */
export async function exchangeCodeForTokens(opts: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google credentials nao configuradas');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as GoogleTokens;
}

/** Renova access_token via refresh_token */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google credentials nao configuradas');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as GoogleTokens;
}

/** Pega access_token válido (renova se expirado) */
export async function getValidAccessToken(accountId: string): Promise<string | null> {
  const conn = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.accountId, accountId),
  });
  if (!conn?.accessToken || !conn.refreshToken) return null;

  const expiresAt = conn.expiresAt?.getTime() ?? 0;
  const fiveMinFromNow = Date.now() + 5 * 60 * 1000;
  if (expiresAt > fiveMinFromNow) return conn.accessToken;

  try {
    const tokens = await refreshAccessToken(conn.refreshToken);
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await db
      .update(googleCalendarConnections)
      .set({
        accessToken: tokens.access_token,
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.accountId, accountId));
    return tokens.access_token;
  } catch (err) {
    logger.error({ accountId, err: (err as Error).message }, '[GCal] refresh failed');
    return conn.accessToken;
  }
}

/** Pega info do user (email) */
export async function getUserInfo(accessToken: string): Promise<{ email?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  return (await res.json()) as { email?: string };
}

/** Lista events em um range */
export async function listEvents(opts: {
  accountId: string;
  timeMin: string;
  timeMax: string;
  calendarId?: string;
}): Promise<GoogleEvent[]> {
  const token = await getValidAccessToken(opts.accountId);
  if (!token) return [];
  const calId = opts.calendarId ?? 'primary';
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`);
  url.searchParams.set('timeMin', opts.timeMin);
  url.searchParams.set('timeMax', opts.timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '100');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    logger.warn({ status: res.status }, '[GCal] listEvents failed');
    return [];
  }
  const data = (await res.json()) as { items?: GoogleEvent[] };
  return data.items ?? [];
}

/** Cria event no Google Calendar */
export async function createEvent(opts: {
  accountId: string;
  event: GoogleEvent;
  calendarId?: string;
}): Promise<GoogleEvent | null> {
  const token = await getValidAccessToken(opts.accountId);
  if (!token) return null;
  const calId = opts.calendarId ?? 'primary';
  const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.event),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, body: text.slice(0, 200) }, '[GCal] createEvent failed');
    return null;
  }
  return (await res.json()) as GoogleEvent;
}

/** Salva tokens iniciais */
export async function saveConnection(opts: {
  accountId: string;
  tokens: GoogleTokens;
  email?: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + opts.tokens.expires_in * 1000);
  const existing = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.accountId, opts.accountId),
  });
  if (existing) {
    await db
      .update(googleCalendarConnections)
      .set({
        accessToken: opts.tokens.access_token,
        refreshToken: opts.tokens.refresh_token ?? existing.refreshToken,
        expiresAt,
        scope: opts.tokens.scope,
        email: opts.email ?? existing.email,
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.accountId, opts.accountId));
  } else {
    await db.insert(googleCalendarConnections).values({
      accountId: opts.accountId,
      accessToken: opts.tokens.access_token,
      refreshToken: opts.tokens.refresh_token,
      expiresAt,
      scope: opts.tokens.scope,
      email: opts.email,
    });
  }
}
