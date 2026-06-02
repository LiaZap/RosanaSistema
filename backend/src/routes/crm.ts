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
  accounts,
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

// ── GET /crm/report/html ─────────────────────────────
// Gera relatorio HTML formatado para impressao/PDF via window.print().
// Parametros: accountId, dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD)
// Retorna text/html puro (sem JSON) — frontend abre em nova aba e dispara print.
crm.get('/report/html', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  const dateFrom = c.req.query('dateFrom');
  const dateTo   = c.req.query('dateTo');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const from = dateFrom ? new Date(`${dateFrom}T00:00:00`) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to   = dateTo   ? new Date(`${dateTo}T23:59:59`)   : new Date();

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtNum = (n: number) => n.toLocaleString('pt-BR');
  const fmtBRL = (n: number) =>
    n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // ── Queries ───────────────────────────────────────
  const [account] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, accountId)).limit(1);

  const [msgCount, convStats, newContacts, dealsStats, topProds, convList] = await Promise.all([
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), sql`${messages.createdAt} >= ${from}`, sql`${messages.createdAt} <= ${to}`))
      .then(r => r[0]?.count ?? 0),

    db.select({ status: conversations.status, count: sql<number>`cast(count(*) as int)` })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), sql`${conversations.createdAt} >= ${from}`, sql`${conversations.createdAt} <= ${to}`))
      .groupBy(conversations.status),

    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), sql`${contacts.createdAt} >= ${from}`, sql`${contacts.createdAt} <= ${to}`))
      .then(r => r[0]?.count ?? 0),

    db.execute(sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(value),0) AS val,
             COUNT(*) FILTER (WHERE LOWER(s.name) LIKE '%ganho%')::int AS won
      FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
      WHERE d.account_id = ${accountId} AND d.created_at >= ${from} AND d.created_at <= ${to}
    `).then(r => {
      const row = (r as unknown as { rows: Array<{ n: number; val: string; won: number }> }).rows[0];
      return { total: row?.n ?? 0, value: Number(row?.val ?? 0), won: row?.won ?? 0 };
    }),

    db.execute(sql`
      SELECT nome, estoque FROM produtos_catalogo
      WHERE account_id = ${accountId} AND estoque > 0
      ORDER BY estoque DESC LIMIT 8
    `).then(r => (r as unknown as { rows: Array<{ nome: string; estoque: number }> }).rows),

    db.select({
        status: conversations.status,
        contactName: contacts.name,
        phone: contacts.phoneNumber,
        lastMsgAt: conversations.lastMessageAt,
        leadScore: conversations.leadScore,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(conversations.accountId, accountId), sql`${conversations.createdAt} >= ${from}`, sql`${conversations.createdAt} <= ${to}`))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(30),
  ]);

  const convByStatus: Record<string, number> = {};
  for (const row of convStats) convByStatus[row.status] = row.count;
  const totalConvs = Object.values(convByStatus).reduce((a,b) => a+b, 0);
  const ninavPct = totalConvs > 0 ? Math.round(((convByStatus['nina'] ?? 0) / totalConvs) * 100) : 0;

  const statusLabel: Record<string, string> = { nina: 'Dani', human: 'Humano', paused: 'Pausada', closed: 'Fechada' };

  // ── HTML ──────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatorio FCE — ${fmtDate(from)} a ${fmtDate(to)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a1a;background:#fff;padding:28px 36px}
  h1{font-size:22px;font-weight:700;color:#222;margin-bottom:4px}
  .subtitle{color:#666;font-size:13px;margin-bottom:28px}
  .badge{display:inline-block;background:#e50789;color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:.04em;margin-bottom:20px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
  .kpi{border:1px solid #e4e4e4;border-radius:10px;padding:14px 16px;background:#fafafa}
  .kpi .val{font-size:26px;font-weight:700;color:#111;line-height:1}
  .kpi .lbl{font-size:11px;color:#777;margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
  section{margin-bottom:28px}
  section h2{font-size:14px;font-weight:700;color:#333;border-bottom:2px solid #f0f0f0;padding-bottom:6px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;padding:7px 10px;background:#f4f4f4;color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e0e0e0}
  td{padding:7px 10px;border-bottom:1px solid #f2f2f2;color:#333}
  tr:last-child td{border-bottom:none}
  .tag{display:inline-block;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600}
  .tag-nina{background:#ede9fe;color:#6d28d9}
  .tag-human{background:#dcfce7;color:#166534}
  .tag-paused{background:#fef9c3;color:#854d0e}
  .tag-closed{background:#f3f4f6;color:#6b7280}
  .prog-bar{height:8px;border-radius:4px;background:#f0f0f0;overflow:hidden;width:120px;display:inline-block;vertical-align:middle}
  .prog-fill{height:100%;background:#e50789;border-radius:4px}
  footer{margin-top:36px;border-top:1px solid #e8e8e8;padding-top:12px;font-size:11px;color:#aaa;display:flex;justify-content:space-between}
  @media print{body{padding:18px 24px}footer{position:fixed;bottom:0;left:0;right:0;padding:8px 24px;background:#fff}}
</style>
</head>
<body>
<span class="badge">FCE Studio — Relatório Automático</span>
<h1>${account?.name ?? 'Filhos com Estilo'}</h1>
<p class="subtitle">Período: <strong>${fmtDate(from)}</strong> a <strong>${fmtDate(to)}</strong> · Gerado em ${fmtDate(new Date())}</p>

<div class="kpis">
  <div class="kpi"><div class="val">${fmtNum(msgCount)}</div><div class="lbl">Mensagens</div></div>
  <div class="kpi"><div class="val">${fmtNum(totalConvs)}</div><div class="lbl">Conversas</div></div>
  <div class="kpi"><div class="val">${fmtNum(newContacts)}</div><div class="lbl">Novos contatos</div></div>
  <div class="kpi"><div class="val">${ninavPct}%</div><div class="lbl">Autonomia DANI</div></div>
</div>

<section>
  <h2>Pipeline do período</h2>
  <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
    <div class="kpi"><div class="val">${fmtNum(dealsStats.total)}</div><div class="lbl">Leads criados</div></div>
    <div class="kpi"><div class="val">${fmtNum(dealsStats.won)}</div><div class="lbl">Negócios ganhos</div></div>
    <div class="kpi"><div class="val">${fmtBRL(dealsStats.value)}</div><div class="lbl">Valor total pipeline</div></div>
  </div>
</section>

<section>
  <h2>Status das conversas</h2>
  <table>
    <tr><th>Status</th><th>Qtd.</th><th>Participação</th></tr>
    ${Object.entries(convByStatus).map(([s, n]) => `
    <tr>
      <td><span class="tag tag-${s}">${statusLabel[s] ?? s}</span></td>
      <td>${fmtNum(n)}</td>
      <td>
        <div class="prog-bar"><div class="prog-fill" style="width:${totalConvs > 0 ? Math.round((n/totalConvs)*100) : 0}%"></div></div>
        &nbsp;${totalConvs > 0 ? Math.round((n/totalConvs)*100) : 0}%
      </td>
    </tr>`).join('')}
  </table>
</section>

${topProds.length > 0 ? `
<section>
  <h2>Top produtos em estoque</h2>
  <table>
    <tr><th>Produto</th><th>Estoque</th></tr>
    ${topProds.map(p => `<tr><td>${p.nome}</td><td>${fmtNum(p.estoque)}</td></tr>`).join('')}
  </table>
</section>` : ''}

<section>
  <h2>Últimas conversas (até 30)</h2>
  <table>
    <tr><th>Contato</th><th>Telefone</th><th>Status</th><th>Lead Score</th><th>Última msg</th></tr>
    ${convList.map(c => `
    <tr>
      <td>${c.contactName ?? '—'}</td>
      <td>${c.phone}</td>
      <td><span class="tag tag-${c.status}">${statusLabel[c.status] ?? c.status}</span></td>
      <td>${c.leadScore ?? 0}</td>
      <td>${c.lastMsgAt ? new Date(c.lastMsgAt).toLocaleDateString('pt-BR') : '—'}</td>
    </tr>`).join('')}
  </table>
</section>

<footer>
  <span>FCE Studio — Sistema de Atendimento DANI</span>
  <span>Relatório gerado automaticamente · ${fmtDate(new Date())}</span>
</footer>

<script>
  // Auto-abre dialogo de impressao quando carregado em nova aba
  window.addEventListener('load', () => {
    setTimeout(() => window.print(), 400);
  });
</script>
</body>
</html>`;

  return c.html(html);
});

export default crm;
