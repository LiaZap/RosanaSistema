import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requireAuth, requireAdmin, getUser } from '../middleware/auth.js';
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

// Todas as rotas /dani sao admin-only (chat de teste, settings, etc).
// Cliente final (Rosana) NAO precisa do chat de teste — esse e pro AX validar.
dani.use('*', requireAuth, requireAdmin);

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
  aiModelMode: z.enum(['flash', 'pro', 'preview', 'lite']).optional(),
  bufferWindowMs: z.number().int().min(1000).max(120_000).optional(),
  bufferMaxMs: z.number().int().min(5_000).max(300_000).optional(),
  pauseAfterHumanMinutes: z.number().int().min(0).max(1440).optional(),
  biaPhone: z.string().max(20).nullable().optional(),
  biaNotifyMessage: z.string().max(1000).nullable().optional(),
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

  // Garante conversation ativa + sabe o contactId
  let resolvedContactId: string | null = null;
  if (!conversationId) {
    const contact = await getOrCreateTestContact({
      accountId,
      userId: user.id,
      userEmail: user.email,
    });
    resolvedContactId = contact.id;
    const conv = await getOrCreateActiveConversation({ accountId, contactId: contact.id });
    conversationId = conv.id;
  } else {
    await assertConversationInAccount(conversationId, accountId);
    // Recupera contactId via conversation
    const convRow = await db
      .select({ contactId: conversations.contactId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    resolvedContactId = convRow[0]?.contactId ?? null;
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

  // Processa via Gemini (passa contactId pras tools de agendamento)
  const result = await processDaniMessage(message, {
    accountId,
    contactId: resolvedContactId,
    history,
  });

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
    shouldReply: result.shouldReply,
    reasoning: result.reasoning,
    conversationId,
    attachments: result.attachments,
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

// ── GET /dani/conversations ─────────────────────────
// Lista as conversas de TESTE do usuario (contato test:<userId>), com
// preview da ultima msg. Alimenta a lateral propria do Teste de chat,
// separada das conversas reais.
dani.get('/conversations', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const contact = await getOrCreateTestContact({
    accountId,
    userId: user.id,
    userEmail: user.email,
  });

  const rows = await db
    .select({
      id: conversations.id,
      createdAt: conversations.createdAt,
      lastMessageAt: conversations.lastMessageAt,
      lastMessage: sql<string | null>`last_msg.content`,
    })
    .from(conversations)
    .leftJoin(
      sql`lateral (
        select content
        from ${messages}
        where conversation_id = ${conversations.id}
        order by created_at desc
        limit 1
      ) as last_msg`,
      sql`true`,
    )
    .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contact.id)))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(50);

  return c.json({ conversations: rows });
});

// ── DELETE /dani/conversations/:id ──────────────────
// Exclui uma conversa de TESTE do proprio usuario (e suas mensagens via
// cascade). Valida que e do contato test:<userId> pra nunca apagar conversa
// real por engano.
dani.delete('/conversations/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  const contact = await getOrCreateTestContact({
    accountId,
    userId: user.id,
    userEmail: user.email,
  });

  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contact.id), // SO conversa de teste do user
      ),
    )
    .limit(1);
  if (!conv) throw new NotFoundError('Conversa de teste nao encontrada');

  // messages.conversationId tem ON DELETE CASCADE -> apaga as mensagens junto
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  logger.info({ conversationId, userId: user.id }, '[DANI] conversa de teste excluida');
  return c.json({ ok: true });
});

// ── POST /dani/conversations/:id/reactivate ─────────
// Devolve a conversa pra DANI (status -> nina). Usado quando humano
// estava atendendo via "modo human" e quer reativar a IA.
dani.post('/conversations/:id/reactivate', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({}));
  const accountId = z.string().uuid().parse(body.accountId);
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  await assertConversationInAccount(conversationId, accountId);

  const { reactivateDani } = await import('../lib/dani-conversations.js');
  await reactivateDani(conversationId);
  return c.json({ ok: true, status: 'nina' });
});

// ── POST /dani/conversations/:id/pause ──────────────
// Pausa a DANI (status -> human ou paused). Quando humano vai
// assumir manualmente.
dani.post('/conversations/:id/pause', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({}));
  const accountId = z.string().uuid().parse(body.accountId);
  const mode = (body.mode as 'human' | 'paused') ?? 'human';
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  await assertConversationInAccount(conversationId, accountId);

  await db
    .update(conversations)
    .set({ status: mode, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  return c.json({ ok: true, status: mode });
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

  // Reuniao 02/06: troca de modelo IA so super-admin pode.
  // Admin de cliente pode editar prompt/nome/etc mas NAO trocar o modelo
  // (evita brincar com pro/lite e bagunçar a operacao).
  if (updates.aiModelMode !== undefined && !user.isSuperAdmin) {
    logger.warn(
      { userId: user.id, accountId, attemptedModel: updates.aiModelMode },
      '[DANI] non-superadmin tentou trocar aiModelMode - removendo do payload',
    );
    delete (updates as { aiModelMode?: string }).aiModelMode;
  }

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
