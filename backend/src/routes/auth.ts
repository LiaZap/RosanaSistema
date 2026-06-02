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

// ── PUT /auth/profile ────────────────────────────────
const profileSchema = z.object({
  fullName: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
});

auth.put('/profile', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const updates: {
    fullName?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (parsed.data.fullName !== undefined) updates.fullName = parsed.data.fullName?.trim() || null;
  if (parsed.data.phone !== undefined) updates.phone = parsed.data.phone?.trim() || null;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl || null;

  const [existing] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  if (existing) {
    await db.update(profiles).set(updates).where(eq(profiles.userId, user.id));
  } else {
    await db.insert(profiles).values({
      userId: user.id,
      fullName: updates.fullName ?? null,
      phone: updates.phone ?? null,
      avatarUrl: updates.avatarUrl ?? null,
    });
  }
  return c.json({ ok: true });
});

// ── PUT /auth/password ───────────────────────────────
const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Senha atual obrigatória'),
  newPassword: z
    .string()
    .min(8, 'Nova senha precisa ter no mínimo 8 caracteres')
    .max(128, 'Senha muito longa'),
});

auth.put('/password', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = passwordSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { currentPassword, newPassword } = parsed.data;

  if (currentPassword === newPassword) {
    throw new ValidationError('A nova senha precisa ser diferente da atual');
  }

  // Busca user com hash
  const [row] = await db
    .select({ hashedPassword: users.hashedPassword })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row?.hashedPassword) {
    throw new ValidationError('Conta sem senha definida');
  }

  // Verifica senha atual
  const valid = await verify(row.hashedPassword, currentPassword, ARGON_OPTS);
  if (!valid) {
    throw new ValidationError('Senha atual incorreta');
  }

  // Hash nova senha
  const newHash = await hash(newPassword, ARGON_OPTS);
  await db
    .update(users)
    .set({ hashedPassword: newHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Invalida sessões antigas (mantém a atual)
  // (Lucia: pra invalidar tudo menos atual precisaria de logica adicional)

  logger.info({ userId: user.id }, '[Auth] password changed');
  return c.json({ ok: true });
});

export default auth;
