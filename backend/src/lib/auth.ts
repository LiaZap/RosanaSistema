import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

const adapter = new DrizzlePostgreSQLAdapter(db, sessions, users);

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    name: 'fce_session',
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
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
