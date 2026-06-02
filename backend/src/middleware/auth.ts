import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { lucia } from '../lib/auth.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers } from '../db/schema.js';

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

/**
 * Bloqueia o request se o usuario nao for admin.
 *
 * Admin = isSuperAdmin OU possui role 'owner'/'admin' em ALGUM account.
 *
 * Importante: rode SEMPRE depois de requireAuth.
 *   admin.use('*', requireAuth, requireAdmin)
 */
export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) {
    throw new UnauthorizedError('Auth required before admin check');
  }

  if (user.isSuperAdmin) {
    await next();
    return;
  }

  // Check se eh owner/admin em algum account
  const memberships = await db
    .select({ role: accountMembers.role })
    .from(accountMembers)
    .where(eq(accountMembers.userId, user.id));

  const hasAdminRole = memberships.some(
    (m) => m.role === 'owner' || m.role === 'admin',
  );

  if (!hasAdminRole) {
    throw new ForbiddenError('Apenas administradores podem acessar este recurso');
  }

  await next();
});

/**
 * Variante: exige role 'owner'/'admin' em UM account especifico (vindo de query/body).
 * Usar quando o endpoint opera num accountId — verifica membership real.
 */
export function requireAdminOfAccount(getAccountId: (c: { req: { query: (k: string) => string | undefined } }) => string | undefined) {
  return createMiddleware(async (c, next) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) throw new UnauthorizedError('Auth required');

    if (user.isSuperAdmin) {
      await next();
      return;
    }

    const accountId = getAccountId(c as never);
    if (!accountId) {
      throw new ForbiddenError('accountId obrigatorio');
    }

    const [membership] = await db
      .select({ role: accountMembers.role })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.userId, user.id),
          eq(accountMembers.accountId, accountId),
        ),
      )
      .limit(1);

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw new ForbiddenError('Sem permissao admin neste account');
    }

    await next();
  });
}
