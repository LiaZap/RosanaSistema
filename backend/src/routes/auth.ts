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
  workspaceName: z.string().min(2).max(255).optional(),
});

// Slug-ify simples (lowercase, sem acento, hifen)
function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

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

  const { email, password, fullName, workspaceName } = parsed.data;
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

  // M11: tudo numa transacao. Antes, um crash entre os inserts deixava o
  // user SEM membership e isFirstUser=false pra sempre (bootstrap travado,
  // /auth/me retornando accounts:[]). Atomico = ou cria tudo, ou nada.
  const newUser = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: emailLower, hashedPassword, isSuperAdmin: isFirstUser })
      .returning();

    await tx.insert(profiles).values({ userId: u.id, fullName: fullName ?? null });

    // Bootstrap: first user → create FCE account + owner membership
    if (isFirstUser) {
      let [account] = await tx.select().from(accounts).where(eq(accounts.slug, 'fce')).limit(1);
      if (!account) {
        [account] = await tx
          .insert(accounts)
          .values({ name: 'FCE - Filhos com Estilo', slug: 'fce', plan: 'pro' })
          .returning();
      }
      await tx.insert(accountMembers).values({
        accountId: account.id,
        userId: u.id,
        role: 'owner',
        status: 'active',
      });
      logger.info({ userId: u.id, accountId: account.id }, 'Bootstrap: first user created as owner');
    } else if (workspaceName) {
      // Multi-tenant self-service: cria workspace novo + owner
      const baseSlug = slugify(workspaceName);
      let slug = baseSlug;
      let attempt = 0;
      while (attempt < 10) {
        const [existsSlug] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.slug, slug))
          .limit(1);
        if (!existsSlug) break;
        attempt++;
        slug = `${baseSlug}-${attempt + 1}`;
      }
      const [account] = await tx
        .insert(accounts)
        .values({ name: workspaceName.slice(0, 255), slug, plan: 'pro' })
        .returning();
      await tx.insert(accountMembers).values({
        accountId: account.id,
        userId: u.id,
        role: 'owner',
        status: 'active',
      });
      logger.info({ userId: u.id, accountId: account.id, slug }, 'Self-service: new workspace created');
    }

    return u;
  });

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

// ── POST /auth/avatar ────────────────────────────────
// Upload de foto de perfil direto pro MinIO. Substitui o input de URL.
auth.post('/avatar', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!file || typeof file === 'string') throw new ValidationError('file required');

  const f = file as File;
  if (!f.type.startsWith('image/')) throw new ValidationError('Apenas imagens');
  if (f.size > 5 * 1024 * 1024) throw new ValidationError('Imagem maior que 5MB');

  const { uploadAssetBuffer } = await import('../lib/minio-cache.js');
  const buffer = Buffer.from(await f.arrayBuffer());
  const ext = f.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const key = `avatar/${user.id}/${Date.now()}.${ext}`;

  const url = await uploadAssetBuffer({ key, buffer, contentType: f.type });

  // Atualiza profile
  const [existing] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, user.id)).limit(1);
  if (existing) {
    await db.update(profiles).set({ avatarUrl: url, updatedAt: new Date() }).where(eq(profiles.userId, user.id));
  } else {
    await db.insert(profiles).values({ userId: user.id, avatarUrl: url });
  }

  logger.info({ userId: user.id, key }, '[Auth] avatar enviado');
  return c.json({ ok: true, avatarUrl: url });
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
