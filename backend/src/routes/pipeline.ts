import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  AppError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import {
  accountMembers,
  contacts,
  deals,
  pipelineStages,
} from '../db/schema.js';
import { logger } from '../lib/logger.js';

const pipeline = new Hono();

const DEFAULT_STAGES: Array<{ name: string; position: number; color: string }> = [
  { name: 'Novos Leads', position: 0, color: '#9ca3af' },
  { name: 'Em Qualificacao', position: 1, color: '#f59e0b' },
  { name: 'Oportunidade', position: 2, color: '#3b82f6' },
  { name: 'Fechamento', position: 3, color: '#8b5cf6' },
  { name: 'Ganho', position: 4, color: '#a3c928' },
  { name: 'Perdido', position: 5, color: '#f44633' },
];

const dealCreateSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  contactName: z.string().min(1).max(255).optional(),
  contactPhone: z.string().min(8).max(20).optional(),
  title: z.string().min(1).max(255),
  value: z.number().positive().optional(),
  expectedCloseDate: z.string().datetime().optional(),
  notes: z.string().max(5000).optional(),
  stageId: z.string().uuid().optional(),
});

const dealUpdateSchema = z.object({
  accountId: z.string().uuid(),
  stageId: z.string().uuid().optional(),
  title: z.string().min(1).max(255).optional(),
  value: z.number().positive().nullable().optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

async function assertAccountMember(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found or you are not a member');
  if (member.status !== 'active') throw new ForbiddenError('Membership is not active');
}

/**
 * Pega ou cria os estagios padrao do pipeline pra uma account.
 * Idempotente: so cria os que faltam.
 */
async function ensureDefaultStages(accountId: string): Promise<void> {
  const existing = await db
    .select({ name: pipelineStages.name })
    .from(pipelineStages)
    .where(eq(pipelineStages.accountId, accountId));

  const existingNames = new Set(existing.map((s) => s.name));
  const toCreate = DEFAULT_STAGES.filter((s) => !existingNames.has(s.name));

  if (toCreate.length > 0) {
    await db.insert(pipelineStages).values(
      toCreate.map((s) => ({
        accountId,
        name: s.name,
        position: s.position,
        color: s.color,
      })),
    );
    logger.info({ accountId, count: toCreate.length }, '[Pipeline] seeded stages');
  }
}

// ── GET /pipeline/stages ────────────────────────────
pipeline.get('/stages', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  await ensureDefaultStages(accountId);

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.accountId, accountId))
    .orderBy(asc(pipelineStages.position));

  return c.json({ stages });
});

// ── GET /pipeline/deals ─────────────────────────────
// Lista com contact info embutida, group by stage
pipeline.get('/deals', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const rows = await db
    .select({
      id: deals.id,
      stageId: deals.stageId,
      title: deals.title,
      value: deals.value,
      expectedCloseDate: deals.expectedCloseDate,
      notes: deals.notes,
      contactId: deals.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phoneNumber,
      createdByAi: deals.createdByAi,
      conversationId: deals.conversationId,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
    })
    .from(deals)
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .where(eq(deals.accountId, accountId))
    .orderBy(asc(deals.updatedAt));

  return c.json({ deals: rows });
});

// ── POST /pipeline/deals ────────────────────────────
// Cria deal (com contato existente ou criando novo por nome/phone)
pipeline.post('/deals', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = dealCreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, contactId, contactName, contactPhone, title, value, expectedCloseDate, notes, stageId } = parsed.data;
  await assertAccountMember(user.id, accountId);

  await ensureDefaultStages(accountId);

  // Resolve contact
  let resolvedContactId = contactId;
  if (!resolvedContactId) {
    if (!contactPhone) {
      throw new ValidationError('contactId ou contactPhone obrigatorio');
    }
    const existing = await db.query.contacts.findFirst({
      where: and(eq(contacts.accountId, accountId), eq(contacts.phoneNumber, contactPhone)),
    });
    if (existing) {
      resolvedContactId = existing.id;
    } else {
      const [created] = await db
        .insert(contacts)
        .values({ accountId, phoneNumber: contactPhone, name: contactName ?? null })
        .returning({ id: contacts.id });
      resolvedContactId = created.id;
    }
  }

  // Resolve stage
  let resolvedStageId = stageId;
  if (!resolvedStageId) {
    const firstStage = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(eq(pipelineStages.accountId, accountId))
      .orderBy(asc(pipelineStages.position))
      .limit(1);
    if (!firstStage[0]) throw new AppError('No pipeline stage found', 500);
    resolvedStageId = firstStage[0].id;
  }

  const [created] = await db
    .insert(deals)
    .values({
      accountId,
      contactId: resolvedContactId,
      stageId: resolvedStageId,
      title,
      value: value != null ? value.toString() : null,
      expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null,
      notes,
    })
    .returning();

  logger.info({ accountId, dealId: created.id, stageId: resolvedStageId }, '[Pipeline] deal created');
  return c.json({ deal: created });
});

// ── PATCH /pipeline/deals/:id ───────────────────────
// Atualiza deal (mover entre stages, editar valor/titulo)
pipeline.patch('/deals/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const dealId = c.req.param('id');
  const body = await c.req.json();
  const parsed = dealUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, ...updates } = parsed.data;
  await assertAccountMember(user.id, accountId);

  // Confirma que deal pertence a account
  const existing = await db.query.deals.findFirst({
    where: and(eq(deals.id, dealId), eq(deals.accountId, accountId)),
  });
  if (!existing) throw new NotFoundError('Deal not found in this account');

  const setData: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
  if (updates.stageId !== undefined) setData.stageId = updates.stageId;
  if (updates.title !== undefined) setData.title = updates.title;
  if (updates.value !== undefined) {
    setData.value = updates.value != null ? updates.value.toString() : null;
  }
  if (updates.expectedCloseDate !== undefined) {
    setData.expectedCloseDate = updates.expectedCloseDate
      ? new Date(updates.expectedCloseDate)
      : null;
  }
  if (updates.notes !== undefined) setData.notes = updates.notes;

  const [updated] = await db.update(deals).set(setData).where(eq(deals.id, dealId)).returning();
  return c.json({ deal: updated });
});

// ── DELETE /pipeline/deals/:id ──────────────────────
pipeline.delete('/deals/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const dealId = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const result = await db
    .delete(deals)
    .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
    .returning({ id: deals.id });

  if (result.length === 0) throw new NotFoundError('Deal not found');
  return c.json({ ok: true });
});

// ── GET /pipeline/summary ───────────────────────────
// Soma de valor + count por stage (pra header do Kanban)
pipeline.get('/summary', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const rows = await db
    .select({
      stageId: deals.stageId,
      count: sql<number>`cast(count(*) as int)`,
      totalValue: sql<string>`cast(coalesce(sum(${deals.value}), 0) as text)`,
    })
    .from(deals)
    .where(eq(deals.accountId, accountId))
    .groupBy(deals.stageId);

  return c.json({
    summary: rows.map((r) => ({
      stageId: r.stageId,
      count: r.count,
      totalValue: Number(r.totalValue ?? 0),
    })),
  });
});

export default pipeline;
