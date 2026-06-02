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
  appointments,
  contacts,
  conversations,
  deals,
  messages,
  produtosCatalogo,
  whatsappSessions,
} from '../db/schema.js';
import { saveMessage } from '../lib/dani-conversations.js';
import { getEvolutionSettings, sendTextMessage } from '../lib/evolution-client.js';
import { analyzeConversation } from '../lib/dani-analysis.js';
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

  const statusRaw = c.req.query('status'); // optional filter
  const statusParse = z.enum(['nina', 'human', 'paused', 'closed']).safeParse(statusRaw);
  const status = statusParse.success ? statusParse.data : null;
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
    whereClauses.push(eq(conversations.status, status));
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
      intentLabel: conversations.intentLabel,
      sentiment: conversations.sentiment,
      leadScore: conversations.leadScore,
      followupState: conversations.followupState,
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

  // Pega info extra de follow-up
  const [convFull] = await db
    .select({
      followupState: conversations.followupState,
      followupAttempts: conversations.followupAttempts,
      followupLastAttemptAt: conversations.followupLastAttemptAt,
      assignedToAt: conversations.assignedToAt,
      leadScore: conversations.leadScore,
      intentLabel: conversations.intentLabel,
      sentiment: conversations.sentiment,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

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
      followup: convFull
        ? {
            state: convFull.followupState,
            attempts: convFull.followupAttempts,
            lastAttemptAt: convFull.followupLastAttemptAt,
          }
        : null,
      assignedToAt: convFull?.assignedToAt ?? null,
      leadScore: convFull?.leadScore ?? 0,
      intentLabel: convFull?.intentLabel ?? null,
      sentiment: convFull?.sentiment ?? null,
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
      assignedToAt: parsed.data.status === 'human' ? new Date() : null,
      // Reset follow-up state quando volta pra nina
      followupState: parsed.data.status === 'nina' ? 'idle' : undefined,
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

// ── POST /crm/conversations/:id/analyze ─────────────
// Roda analise IA da conversa via Gemini com JSON estruturado
crm.post('/conversations/:id/analyze', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const conversationId = c.req.param('id');
  await assertConversationInAccount(conversationId, accountId);

  try {
    const analysis = await analyzeConversation(conversationId);
    return c.json({ analysis });
  } catch (err) {
    logger.error({ conversationId, err: (err as Error).message }, '[CRM] analyze failed');
    throw new AppError(`Analise falhou: ${(err as Error).message}`, 500);
  }
});

// ── GET /crm/dashboard ──────────────────────────────
// KPIs agregados pra Dashboard
crm.get('/dashboard', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Run all queries in parallel
  const [
    msgsToday,
    msgsBy7d,
    convStats,
    contactCount,
    apptThisWeek,
    dealsThisMonth,
    produtosTotal,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), sql`${messages.createdAt} >= ${startOfDay}`))
      .then((r) => r[0]?.count ?? 0),

    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${messages.createdAt}), 'YYYY-MM-DD')`.as('day'),
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), sql`${messages.createdAt} >= ${sevenDaysAgo}`))
      .groupBy(sql`date_trunc('day', ${messages.createdAt})`)
      .orderBy(sql`date_trunc('day', ${messages.createdAt}) asc`),

    db
      .select({ status: conversations.status, count: sql<number>`cast(count(*) as int)` })
      .from(conversations)
      .where(eq(conversations.accountId, accountId))
      .groupBy(conversations.status),

    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(contacts)
      .where(eq(contacts.accountId, accountId))
      .then((r) => r[0]?.count ?? 0),

    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(appointments)
      .where(
        and(
          eq(appointments.accountId, accountId),
          sql`${appointments.date} >= ${startOfWeek}`,
          sql`${appointments.date} < ${endOfWeek}`,
        ),
      )
      .then((r) => r[0]?.count ?? 0),

    db
      .select({ count: sql<number>`cast(count(*) as int)`, value: sql<string>`cast(coalesce(sum(${deals.value}), 0) as text)` })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), sql`${deals.createdAt} >= ${startOfMonth}`))
      .then((r) => ({ count: r[0]?.count ?? 0, value: Number(r[0]?.value ?? 0) })),

    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(produtosCatalogo)
      .where(eq(produtosCatalogo.accountId, accountId))
      .then((r) => r[0]?.count ?? 0),
  ]);

  const convByStatus = { nina: 0, human: 0, paused: 0, closed: 0 };
  for (const row of convStats) convByStatus[row.status] = row.count;

  // Métricas avançadas (Sprint UI)
  const yesterdayStart = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);

  const [msgsYesterday, aiPerformance, avgResponseMs, topProducts] = await Promise.all([
    // Mensagens ontem (pra delta)
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          sql`${messages.createdAt} >= ${yesterdayStart}`,
          sql`${messages.createdAt} < ${startOfDay}`,
        ),
      )
      .then((r) => r[0]?.count ?? 0),

    // AI performance: % de conversas em modo nina vs human (autonomia)
    db
      .select({
        nina: sql<number>`cast(count(*) filter (where status = 'nina') as int)`,
        human: sql<number>`cast(count(*) filter (where status = 'human') as int)`,
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          sql`${conversations.lastMessageAt} >= ${sevenDaysAgo}`,
        ),
      )
      .then((r) => {
        const row = r[0];
        if (!row || !row.total) return { nina: 0, human: 0, total: 0, autonomyPct: 0 };
        return {
          nina: row.nina,
          human: row.human,
          total: row.total,
          autonomyPct: Math.round((row.nina / row.total) * 100),
        };
      }),

    // Tempo médio de resposta DANI (ms entre msg user e próxima msg nina)
    db
      .execute(
        sql`
          SELECT AVG(EXTRACT(EPOCH FROM (n.created_at - u.created_at)) * 1000)::int AS avg_ms
          FROM messages u
          JOIN LATERAL (
            SELECT created_at FROM messages
            WHERE conversation_id = u.conversation_id
              AND from_type = 'nina'
              AND created_at > u.created_at
            ORDER BY created_at ASC LIMIT 1
          ) n ON true
          WHERE u.account_id = ${accountId}
            AND u.from_type = 'user'
            AND u.created_at >= ${sevenDaysAgo}
        `,
      )
      .then((r) => {
        const row = (r as unknown as { rows: Array<{ avg_ms: number | null }> }).rows[0];
        return row?.avg_ms ?? 0;
      }),

    // Top 5 produtos: maior estoque (proxy de mais vendidos)
    // Sem filtro `disponivel` (sync nao popula corretamente esse flag)
    db
      .execute(
        sql`
          SELECT nome, estoque
          FROM produtos_catalogo
          WHERE account_id = ${accountId}
            AND estoque IS NOT NULL
            AND estoque > 0
          ORDER BY estoque DESC
          LIMIT 5
        `,
      )
      .then((r) => {
        const rows = (r as unknown as { rows: Array<{ nome: string; estoque: number }> }).rows;
        return rows.map((row) => ({ name: row.nome, count: row.estoque }));
      })
      .catch(() => []),
  ]);

  // Funil de conversão (últimos 30 dias)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [funnel] = await Promise.all([
    Promise.all([
      // Total de contatos novos (clientes que escreveram)
      db
        .execute(sql`
          SELECT COUNT(DISTINCT contact_id)::int AS n
          FROM conversations
          WHERE account_id = ${accountId} AND created_at >= ${thirtyDaysAgo}
        `)
        .then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0),
      // Conversas qualificadas (lead_score >= 50)
      db
        .execute(sql`
          SELECT COUNT(*)::int AS n
          FROM conversations
          WHERE account_id = ${accountId}
            AND created_at >= ${thirtyDaysAgo}
            AND lead_score >= 50
        `)
        .then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0),
      // Deals criados
      db
        .execute(sql`
          SELECT COUNT(*)::int AS n
          FROM deals
          WHERE account_id = ${accountId} AND created_at >= ${thirtyDaysAgo}
        `)
        .then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0),
      // Deals na stage Ganho
      db
        .execute(sql`
          SELECT COUNT(*)::int AS n, COALESCE(SUM(value), 0) AS val
          FROM deals d
          JOIN pipeline_stages s ON s.id = d.stage_id
          WHERE d.account_id = ${accountId}
            AND d.created_at >= ${thirtyDaysAgo}
            AND LOWER(s.name) LIKE '%ganho%'
        `)
        .then((r) => {
          const row = (r as unknown as { rows: Array<{ n: number; val: string }> }).rows[0];
          return { count: row?.n ?? 0, value: Number(row?.val ?? 0) };
        }),
    ]),
  ]);

  const [novosContatos, qualificados, dealsCriados, ganhos] = funnel;

  // Delta percentual de mensagens
  const messagesDelta =
    msgsYesterday > 0
      ? Math.round(((msgsToday - msgsYesterday) / msgsYesterday) * 100)
      : msgsToday > 0
        ? 100
        : 0;

  return c.json({
    messagesToday: msgsToday,
    messagesYesterday: msgsYesterday,
    messagesDelta,
    messagesLast7Days: msgsBy7d.map((r) => ({ day: r.day, count: r.count })),
    conversations: convByStatus,
    contactsTotal: contactCount,
    appointmentsThisWeek: apptThisWeek,
    dealsThisMonth: dealsThisMonth,
    produtosTotal,
    aiPerformance,
    avgResponseMs,
    topProducts,
    funnel: {
      contatos: novosContatos,
      qualificados,
      dealsCriados,
      ganhos: ganhos.count,
      valorGanho: ganhos.value,
    },
  });
});

export default crm;
