import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, ninaSettings } from '../db/schema.js';
import { processDaniMessage } from '../lib/dani-orchestrator.js';
import { logger } from '../lib/logger.js';

const dani = new Hono();

const chatSchema = z.object({
  message: z.string().min(1, 'message required').max(4000),
  accountId: z.string().uuid('valid accountId required'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        text: z.string().min(1).max(8000),
      }),
    )
    .max(40)
    .optional(),
});

const settingsUpdateSchema = z.object({
  accountId: z.string().uuid(),
  isActive: z.boolean().optional(),
  sdrName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(255).optional(),
  systemPromptOverride: z.string().max(50_000).nullable().optional(),
  aiModelMode: z.enum(['flash', 'pro', 'preview']).optional(),
});

/** Garante que o user logado e membro ativo da account */
async function assertAccountMember(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found or you are not a member');
  if (member.status !== 'active') throw new ForbiddenError('Membership is not active');
}

// ── POST /dani/chat ──────────────────────────────────
// Endpoint de teste: envia mensagem direto pra DANI, retorna resposta.
// Sem WhatsApp, sem fila, sem persistencia ainda (Phase 2A).
dani.post('/chat', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { message, accountId, history } = parsed.data;
  await assertAccountMember(user.id, accountId);

  logger.info(
    { userId: user.id, accountId, messageLength: message.length, historyTurns: history?.length ?? 0 },
    '[DANI] /chat request',
  );

  const result = await processDaniMessage(message, { accountId, history });

  return c.json({
    reply: result.reply,
    meta: {
      modelMode: result.modelUsed,
      durationMs: result.durationMs,
      fillerStripped: result.fillerStripped,
    },
  });
});

// ── GET /dani/settings ───────────────────────────────
dani.get('/settings', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId query param required');
  await assertAccountMember(user.id, accountId);

  const settings = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, accountId),
  });

  return c.json({ settings: settings ?? null });
});

// ── PUT /dani/settings ───────────────────────────────
dani.put('/settings', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { accountId, ...updates } = parsed.data;
  await assertAccountMember(user.id, accountId);

  // Upsert
  const existing = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, accountId),
  });

  if (existing) {
    const [updated] = await db
      .update(ninaSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(ninaSettings.accountId, accountId))
      .returning();
    return c.json({ settings: updated });
  }

  const [created] = await db
    .insert(ninaSettings)
    .values({
      accountId,
      ...updates,
    })
    .returning();
  return c.json({ settings: created });
});

export default dani;
