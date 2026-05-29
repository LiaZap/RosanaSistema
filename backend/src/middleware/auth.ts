import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { lucia } from '../lib/auth.js';
import { UnauthorizedError } from '../lib/errors.js';

export type AuthUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  isSuperAdmin: boolean;
};

export type AuthSession = {
  id: string;
  userId: string;
  expiresAt: Date;
  fresh: boolean;
};

export const requireAuth = createMiddleware(async (c, next) => {
  const sessionId = getCookie(c, 'fce_session');
  if (!sessionId) {
    throw new UnauthorizedError('No session cookie');
  }

  const { session, user } = await lucia.validateSession(sessionId);

  if (!session || !user) {
    const blankCookie = lucia.createBlankSessionCookie();
    c.header('Set-Cookie', blankCookie.serialize());
    throw new UnauthorizedError('Invalid or expired session');
  }

  if (session.fresh) {
    const freshCookie = lucia.createSessionCookie(session.id);
    c.header('Set-Cookie', freshCookie.serialize());
  }

  c.set('user', user as unknown as AuthUser);
  c.set('session', session as unknown as AuthSession);

  await next();
});

/** Helper to get typed user from context after requireAuth */
export function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get('user') as AuthUser;
}

/** Helper to get typed session from context after requireAuth */
export function getSession(c: { get: (key: string) => unknown }): AuthSession {
  return c.get('session') as AuthSession;
}
