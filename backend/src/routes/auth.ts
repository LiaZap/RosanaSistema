import { Hono } from 'hono';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { lucia } from '../lib/auth.js';
import { db } from '../db/client.js';
import { users, profiles, accounts, accountMembers } from '../db/schema.js';
import { requireAuth, getUser, getSession } from '../middleware/auth.js';
import { ValidationError, ConflictError, UnauthorizedError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const signupSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  fullName: z.string().min(1).max(255).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
});

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

const auth = new Hono();

// ── POST /auth/signup ────────────────────────────────

auth.post('/signup', async (c) => {
  const body = await c.req.json();
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { email, password, fullName } = parsed.data;
  const emailLower = email.toLowerCase().trim();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  if (existing) throw new ConflictError('Email already registered');

  const hashedPassword = await hash(password, ARGON_OPTS);

  // Check if first user → auto-bootstrap as owner
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  const isFirstUser = !anyUser;

  const [newUser] = await db
    .insert(users)
    .values({
      email: emailLower,
      hashedPassword,
      isSuperAdmin: isFirstUser,
    })
    .returning();

  await db.insert(profiles).values({
    userId: newUser.id,
    fullName: fullName ?? null,
  });

  // Bootstrap: first user → create FCE account + owner membership
  if (isFirstUser) {
    let [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.slug, 'fce'))
      .limit(1);

    if (!account) {
      [account] = await db
        .insert(accounts)
        .values({ name: 'FCE - Filhos com Estilo', slug: 'fce', plan: 'pro' })
        .returning();
    }

    await db.insert(accountMembers).values({
      accountId: account.id,
      userId: newUser.id,
      role: 'owner',
      status: 'active',
    });

    logger.info(
      { userId: newUser.id, accountId: account.id },
      'Bootstrap: first user created as owner',
    );
  }

  const session = await lucia.createSession(newUser.id, {});
  c.header('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

  return c.json(
    {
      user: { id: newUser.id, email: newUser.email, isSuperAdmin: newUser.isSuperAdmin },
      isFirstUser,
    },
    201,
  );
});

// ── POST /auth/login ─────────────────────────────────

auth.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user) throw new UnauthorizedError('Invalid email or password');

  const valid = await verify(user.hashedPassword, password, ARGON_OPTS);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  const session = await lucia.createSession(user.id, {});
  c.header('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

  return c.json({
    user: { id: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin },
  });
});

// ── POST /auth/logout ────────────────────────────────

auth.post('/logout', requireAuth, async (c) => {
  const session = getSession(c);
  await lucia.invalidateSession(session.id);
  c.header('Set-Cookie', lucia.createBlankSessionCookie().serialize());
  return c.json({ success: true });
});

// ── GET /auth/me ─────────────────────────────────────

auth.get('/me', requireAuth, async (c) => {
  const user = getUser(c);

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const memberships = await db
    .select({
      accountId: accountMembers.accountId,
      role: accountMembers.role,
      accountName: accounts.name,
      accountSlug: accounts.slug,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(eq(accountMembers.userId, user.id));

  return c.json({
    user: { id: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin },
    profile: profile ?? null,
    accounts: memberships,
  });
});

export default auth;
