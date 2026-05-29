import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

const adapter = new DrizzlePostgreSQLAdapter(db, sessions, users);

/**
 * Cookie SameSite policy.
 * - 'lax' (default): same-origin or top-level navigations. Use when frontend
 *   reaches the backend via same-origin proxy (e.g. nginx /api -> backend).
 * - 'none': cross-site requests. REQUIRED when the frontend calls the backend
 *   on a different host (e.g. fce-app.example.com -> fce-api.example.com).
 *   Browsers ignore the cookie on cross-site fetch unless SameSite=None+Secure.
 */
const sameSite = (process.env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none') || 'lax';
const isProd = process.env.NODE_ENV === 'production';

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    name: 'fce_session',
    attributes: {
      // SameSite=None implies Secure (browsers reject otherwise)
      secure: isProd || sameSite === 'none',
      sameSite,
      domain: process.env.COOKIE_DOMAIN || undefined,
    },
  },
  getUserAttributes: (attributes) => ({
    email: attributes.email,
    emailVerified: attributes.emailVerified,
    isSuperAdmin: attributes.isSuperAdmin,
  }),
});

declare module 'lucia' {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: {
      email: string;
      hashedPassword: string;
      emailVerified: boolean;
      isSuperAdmin: boolean;
      createdAt: Date;
      updatedAt: Date;
    };
  }
}
