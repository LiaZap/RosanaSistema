import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
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
  conversations,
  messages,
  whatsappSessions,
} from '../db/schema.js';
import { saveMessage } from '../lib/dani-conversations.js';
import { getEvolutionSettings, sendTextMessage } from '../lib/evolution-client.js';
import { logger } from '../lib/logger.js';

const crm = new Hono();

const statusSchema = z.object({
  status: z.enum(['nina', 'human', 'paused', 'closed']),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
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

/** Confirma que conversation pertence a account */
async function assertConversationInAccount(conversationId: string, accountId: string) {
  const [conv] = await db
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      status: conversations.status,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);
  if (!conv) throw new NotFoundError('Conversation not found in this account');
  return conv;
}

// ── GET /crm/conversations ──────────────────────────
// Lista conversas com preview da ultima mensagem + contact info
crm.get('/conversations', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const status = c.req.query('status'); // optional filter
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  // Subquery pra ultima mensagem
  const lastMessageSub = db
    .select({
      conversationId: messages.conversationId,
      content: messages.content,
      fromType: messages.fromType,
      createdAt: messages.createdAt,
      rowNum: sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc)`.as(
        'row_num',
      ),
    })
    .from(messages)
    .as('last_msg');

  const whereClauses = [eq(conversations.accountId, accountId)];
  if (status) {
    whereClauses.push(eq(conversations.status, status as 'nina' | 'human' | 'paused' | 'closed'));
  }

  const rows = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phoneNumber,
      lastMessage: lastMessageSub.content,
      lastMessageFrom: lastMessageSub.fromType,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(
      lastMessageSub,
      and(
        eq(lastMessageSub.conversationId, conversations.id),
        eq(lastMessageSub.rowNum, 1),
      ),
    )
    .where(and(...whereClauses))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(limit);

  return c.json({ conversations: rows });
});

// ── GET /crm/conversations/:id ──────────────────────
// Detalhes + ate 100 mensagens
crm.get('/conversations/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  const conv = await assertConversationInAccount(conversationId, accountId);

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, conv.contactId),
  });

  const rows = await db
    .select({
      id: messages.id,
      fromType: messages.fromType,
      content: messages.content,
      messageType: messages.messageType,
      createdAt: messages.createdAt,
      processedByNina: messages.processedByNina,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(100);

  return c.json({
    conversation: {
      id: conv.id,
      status: conv.status,
      contact: contact
        ? {
            id: contact.id,
            name: contact.name,
            phoneNumber: contact.phoneNumber,
            tags: contact.tags,
          }
        : null,
    },
    messages: rows.reverse(),
  });
});

// ── PATCH /crm/conversations/:id ────────────────────
// Muda status (assumir/devolver/pausar/fechar)
crm.patch('/conversations/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  await assertConversationInAccount(conversationId, accountId);

  const body = await c.req.json();
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  await db
    .update(conversations)
    .set({
      status: parsed.data.status,
      assignedTo: parsed.data.status === 'human' ? user.id : null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  logger.info(
    { conversationId, newStatus: parsed.data.status, userId: user.id },
    '[CRM] conversation status changed',
  );

  return c.json({ ok: true, status: parsed.data.status });
});

// ── POST /crm/conversations/:id/messages ────────────
// Humano envia mensagem - salva + envia via Evolution
crm.post('/conversations/:id/messages', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  const conv = await assertConversationInAccount(conversationId, accountId);

  const body = await c.req.json();
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  // Carrega contato pra pegar phone
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, conv.contactId),
  });
  if (!contact) throw new NotFoundError('Contact not found');

  // Phone "test:..." nao manda via WhatsApp (eh do /dani/chat)
  const isTestPhone = contact.phoneNumber.startsWith('test:');

  // Salva mensagem do humano
  await saveMessage({
    conversationId,
    accountId,
    fromType: 'human',
    content: parsed.data.content,
  });

  // Envia via Evolution se nao for test contact
  if (!isTestPhone) {
    try {
      const settings = await getEvolutionSettings(accountId);
      const session = await db.query.whatsappSessions.findFirst({
        where: eq(whatsappSessions.accountId, accountId),
      });
      if (!session) {
        throw new AppError('No WhatsApp instance', 400);
      }
      await sendTextMessage({
        settings,
        instanceName: session.instanceName,
        phoneNumber: contact.phoneNumber,
        text: parsed.data.content,
      });
    } catch (err) {
      logger.error(
        { conversationId, err: (err as Error).message },
        '[CRM] failed to send via WhatsApp',
      );
      throw new AppError(`Salvou mas falhou ao enviar: ${(err as Error).message}`, 500);
    }
  }

  return c.json({ ok: true });
});

// ── GET /crm/stats ──────────────────────────────────
// Contadores rapidos por status pra navbar
crm.get('/stats', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const rows = await db
    .select({
      status: conversations.status,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(conversations)
    .where(eq(conversations.accountId, accountId))
    .groupBy(conversations.status);

  const stats = { nina: 0, human: 0, paused: 0, closed: 0, total: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }

  return c.json(stats);
});

export default crm;
