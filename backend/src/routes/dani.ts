import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import {
  accountMembers,
  conversations,
  messages,
  ninaSettings,
} from '../db/schema.js';
import { processDaniMessage } from '../lib/dani-orchestrator.js';
import {
  createConversation,
  getOrCreateActiveConversation,
  getOrCreateTestContact,
  loadHistory,
  saveMessage,
} from '../lib/dani-conversations.js';
import { logger } from '../lib/logger.js';

const dani = new Hono();

const chatSchema = z.object({
  message: z.string().min(1, 'message required').max(4000),
  accountId: z.string().uuid('valid accountId required'),
  conversationId: z.string().uuid().optional(),
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

/** Confirma que uma conversation pertence a uma account */
async function assertConversationInAccount(conversationId: string, accountId: string): Promise<void> {
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);
  if (!conv) throw new NotFoundError('Conversation not found in this account');
}

// ── POST /dani/chat ──────────────────────────────────
// Envia mensagem pra DANI. Persiste user + nina messages no banco.
// Se conversationId nao for passado, usa/cria a conversa ativa pro user.
dani.post('/chat', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { message, accountId } = parsed.data;
  let { conversationId } = parsed.data;
  await assertAccountMember(user.id, accountId);

  // Garante conversation ativa
  if (!conversationId) {
    const contact = await getOrCreateTestContact({
      accountId,
      userId: user.id,
      userEmail: user.email,
    });
    const conv = await getOrCreateActiveConversation({ accountId, contactId: contact.id });
    conversationId = conv.id;
  } else {
    await assertConversationInAccount(conversationId, accountId);
  }

  // Carrega historico ANTES de salvar a nova mensagem
  const history = await loadHistory(conversationId, 30);

  logger.info(
    {
      userId: user.id,
      accountId,
      conversationId,
      messageLength: message.length,
      historyTurns: history.length,
    },
    '[DANI] /chat request',
  );

  // Salva mensagem do user
  await saveMessage({
    conversationId,
    accountId,
    fromType: 'user',
    content: message,
  });

  // Processa via Gemini
  const result = await processDaniMessage(message, { accountId, history });

  // Salva resposta da DANI
  await saveMessage({
    conversationId,
    accountId,
    fromType: 'nina',
    content: result.reply,
    processedByNina: true,
  });

  return c.json({
    reply: result.reply,
    conversationId,
    meta: {
      modelMode: result.modelUsed,
      durationMs: result.durationMs,
      fillerStripped: result.fillerStripped,
      historyTurns: history.length,
      iterations: result.iterations,
      toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
    },
  });
});

// ── POST /dani/conversations ────────────────────────
// Cria uma nova conversa (descarta a anterior se houver)
dani.post('/conversations', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const accountId = z.string().uuid().parse(body.accountId);
  await assertAccountMember(user.id, accountId);

  const contact = await getOrCreateTestContact({
    accountId,
    userId: user.id,
    userEmail: user.email,
  });
  const conv = await createConversation({ accountId, contactId: contact.id });

  return c.json({ conversationId: conv.id });
});

// ── GET /dani/conversations/:id/messages ────────────
dani.get('/conversations/:id/messages', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId query param required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  await assertConversationInAccount(conversationId, accountId);

  const rows = await db
    .select({
      id: messages.id,
      fromType: messages.fromType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(100);

  return c.json({
    messages: rows.reverse().map((m) => ({
      id: m.id,
      role: m.fromType === 'user' ? 'user' : 'model',
      text: m.content,
      createdAt: m.createdAt,
    })),
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

  const [created] = await db.insert(ninaSettings).values({ accountId, ...updates }).returning();
  return c.json({ settings: created });
});

export default dani;
