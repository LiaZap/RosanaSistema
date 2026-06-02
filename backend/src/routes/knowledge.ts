import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, knowledgeBase } from '../db/schema.js';
import { seedDefaultKB } from '../lib/knowledge-base.js';
import { logger } from '../lib/logger.js';

const kb = new Hono();

// Knowledge base (RAG): edicao admin-only.
// A DANI consulta direto no banco no orchestrator (nao passa por aqui).
kb.use('*', requireAuth, requireAdmin);

const createSchema = z.object({
  accountId: z.string().uuid(),
  category: z.string().min(2).max(50),
  title: z.string().min(2).max(255),
  content: z.string().min(10).max(50_000),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  alwaysInclude: z.boolean().optional(),
});

const updateSchema = z.object({
  accountId: z.string().uuid(),
  category: z.string().min(2).max(50).optional(),
  title: z.string().min(2).max(255).optional(),
  content: z.string().min(10).max(50_000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  alwaysInclude: z.boolean().optional(),
});

async function assertOwnerOrAdmin(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found');
  if (member.status !== 'active') throw new ForbiddenError('Membership not active');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Only owners/admins can manage knowledge base');
  }
}

// ── GET /knowledge ──────────────────────────────────
kb.get('/', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  const category = c.req.query('category');
  const conditions = [eq(knowledgeBase.accountId, accountId)];
  if (category) conditions.push(eq(knowledgeBase.category, category));

  const rows = await db
    .select()
    .from(knowledgeBase)
    .where(and(...conditions))
    .orderBy(asc(knowledgeBase.category), desc(knowledgeBase.priority));

  return c.json({ items: rows });
});

// ── POST /knowledge ─────────────────────────────────
kb.post('/', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  await assertOwnerOrAdmin(user.id, parsed.data.accountId);

  const [created] = await db.insert(knowledgeBase).values(parsed.data).returning();
  logger.info({ id: created.id, category: created.category }, '[KB] created');
  return c.json({ item: created });
});

// ── PATCH /knowledge/:id ────────────────────────────
kb.patch('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, ...updates } = parsed.data;
  await assertOwnerOrAdmin(user.id, accountId);

  const existing = await db.query.knowledgeBase.findFirst({
    where: and(eq(knowledgeBase.id, id), eq(knowledgeBase.accountId, accountId)),
  });
  if (!existing) throw new NotFoundError('KB item not found');

  const [updated] = await db
    .update(knowledgeBase)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(knowledgeBase.id, id))
    .returning();
  return c.json({ item: updated });
});

// ── DELETE /knowledge/:id ───────────────────────────
kb.delete('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  await db
    .delete(knowledgeBase)
    .where(and(eq(knowledgeBase.id, id), eq(knowledgeBase.accountId, accountId)));
  return c.json({ ok: true });
});

// ── POST /knowledge/seed ────────────────────────────
// Faz seed dos chunks default (so na 1a vez)
kb.post('/seed', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const accountId = z.string().uuid().parse(body.accountId);
  await assertOwnerOrAdmin(user.id, accountId);

  const result = await seedDefaultKB(accountId);
  return c.json(result);
});

export default kb;
