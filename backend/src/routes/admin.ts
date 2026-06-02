import { Hono } from 'hono';
import { z } from 'zod';
import { hash } from '@node-rs/argon2';
import { and, eq, desc, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  users,
  profiles,
  accounts,
  accountMembers,
} from '../db/schema.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const ARGON_OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

const admin = new Hono();

// Todas as rotas /admin exigem auth + isSuperAdmin
admin.use('*', requireAuth, async (c, next) => {
  const user = getUser(c);
  if (!user.isSuperAdmin) {
    throw new ForbiddenError('Apenas super-admins podem acessar esta área');
  }
  await next();
});

// ── GET /admin/accounts ──────────────────────────────
// Lista todos os accounts com contagem de membros
admin.get('/accounts', async (c) => {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      slug: accounts.slug,
      plan: accounts.plan,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .orderBy(desc(accounts.createdAt));

  // Para cada account, busca membros
  const result = await Promise.all(
    rows.map(async (acc) => {
      const members = await db
        .select({
          id: accountMembers.id,
          role: accountMembers.role,
          status: accountMembers.status,
          userId: accountMembers.userId,
          email: users.email,
          fullName: profiles.fullName,
          createdAt: accountMembers.createdAt,
        })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .leftJoin(profiles, eq(profiles.userId, accountMembers.userId))
        .where(eq(accountMembers.accountId, acc.id))
        .orderBy(accountMembers.createdAt);

      return { ...acc, members };
    }),
  );

  return c.json({ accounts: result });
});

// ── GET /admin/accounts/:accountId/members ───────────
admin.get('/accounts/:accountId/members', async (c) => {
  const { accountId } = c.req.param();

  const [account] = await db
    .select({ id: accounts.id, name: accounts.name, slug: accounts.slug })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) throw new NotFoundError('Account not found');

  const members = await db
    .select({
      memberId: accountMembers.id,
      role: accountMembers.role,
      status: accountMembers.status,
      userId: users.id,
      email: users.email,
      isSuperAdmin: users.isSuperAdmin,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
      joinedAt: accountMembers.createdAt,
    })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .leftJoin(profiles, eq(profiles.userId, accountMembers.userId))
    .where(eq(accountMembers.accountId, accountId))
    .orderBy(accountMembers.createdAt);

  return c.json({ account, members });
});

// ── POST /admin/accounts/:accountId/members ──────────
// Cria usuario novo E vincula ao account com um role.
// Se o email ja existir, apenas vincula (ou atualiza role se ja membro).
const createMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Senha minima 8 caracteres'),
  fullName: z.string().min(1).max(255).optional(),
  role: z.enum(['owner', 'admin', 'manager', 'sdr']),
});

admin.post('/accounts/:accountId/members', async (c) => {
  const { accountId } = c.req.param();
  const body = await c.req.json();
  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { email, password, fullName, role } = parsed.data;
  const emailLower = email.toLowerCase().trim();

  // Verifica account
  const [account] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new NotFoundError('Account not found');

  // Checa se usuario ja existe
  let [existingUser] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, emailLower))
    .limit(1);

  let userId: string;

  if (existingUser) {
    userId = existingUser.id;
    logger.info({ email: emailLower, accountId }, '[Admin] usuario ja existe, vinculando ao account');
  } else {
    // Cria usuario novo
    const hashedPassword = await hash(password, ARGON_OPTS);
    const [newUser] = await db
      .insert(users)
      .values({
        email: emailLower,
        hashedPassword,
        isSuperAdmin: false,
        emailVerified: true, // admin criou, considera verificado
      })
      .returning();

    await db.insert(profiles).values({
      userId: newUser.id,
      fullName: fullName ?? null,
    });

    userId = newUser.id;
    logger.info({ email: emailLower, userId, accountId, role }, '[Admin] novo usuario criado');
  }

  // Checa membership existente
  const [existingMember] = await db
    .select({ id: accountMembers.id, role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (existingMember) {
    // Ja membro — atualiza role
    await db
      .update(accountMembers)
      .set({ role, status: 'active' })
      .where(eq(accountMembers.id, existingMember.id));
    logger.info({ userId, accountId, role }, '[Admin] role de membro atualizado');
    return c.json({ ok: true, action: 'role_updated', userId, role });
  }

  // Vincula ao account
  await db.insert(accountMembers).values({
    accountId,
    userId,
    role,
    status: 'active',
  });

  logger.info({ userId, accountId, role }, '[Admin] membro adicionado ao account');
  return c.json({ ok: true, action: 'member_added', userId, role }, 201);
});

// ── PATCH /admin/accounts/:accountId/members/:memberId ─
// Altera role ou status de um membro existente
const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'manager', 'sdr']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

admin.patch('/accounts/:accountId/members/:memberId', async (c) => {
  const { accountId, memberId } = c.req.param();
  const body = await c.req.json();
  const parsed = updateMemberSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const updates = parsed.data;
  if (!updates.role && !updates.status) {
    throw new ValidationError('Informe role ou status pra atualizar');
  }

  const [member] = await db
    .select({ id: accountMembers.id, role: accountMembers.role, userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.id, memberId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Membro não encontrado');

  await db
    .update(accountMembers)
    .set({ ...updates })
    .where(eq(accountMembers.id, memberId));

  logger.info({ memberId, accountId, updates }, '[Admin] membro atualizado');
  return c.json({ ok: true, memberId, updates });
});

// ── DELETE /admin/accounts/:accountId/members/:memberId ─
// Remove membro do account (nao apaga o usuario)
admin.delete('/accounts/:accountId/members/:memberId', async (c) => {
  const { accountId, memberId } = c.req.param();

  const [member] = await db
    .select({ id: accountMembers.id, userId: accountMembers.userId, role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.id, memberId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Membro não encontrado');

  // Nao pode remover o ultimo owner
  if (member.role === 'owner') {
    const [otherOwner] = await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.role, 'owner'),
          ne(accountMembers.id, memberId),
        ),
      )
      .limit(1);

    if (!otherOwner) {
      throw new ForbiddenError('Nao e possivel remover o unico owner do account');
    }
  }

  await db.delete(accountMembers).where(eq(accountMembers.id, memberId));
  logger.info({ memberId, accountId }, '[Admin] membro removido do account');
  return c.json({ ok: true });
});

// ── PATCH /admin/users/:userId/password ──────────────
// Reset de senha por super-admin (sem precisar da senha atual)
const resetPasswordSchema = z.object({
  newPassword: z.string().min(8),
});

admin.patch('/users/:userId/password', async (c) => {
  const { userId } = c.req.param();
  const body = await c.req.json();
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('Usuario nao encontrado');

  const hashedPassword = await hash(parsed.data.newPassword, ARGON_OPTS);
  await db.update(users).set({ hashedPassword }).where(eq(users.id, userId));

  logger.info({ userId }, '[Admin] senha resetada por super-admin');
  return c.json({ ok: true });
});

export default admin;
