import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  conversations,
  contacts,
  deals,
  messages,
  produtosCatalogo,
} from '../db/schema.js';
import {
  inboundQueue,
  aiReplyQueue,
  outboundQueue,
} from '../lib/queues.js';

const metrics = new Hono();

/**
 * Sprint 11 - /metrics endpoint estilo Prometheus.
 *
 * Acessivel sem auth pra scraping externo (mas so retorna agregados,
 * sem dados sensíveis). Em production atras de IP whitelist via nginx.
 */

metrics.get('/metrics', async (c) => {
  const lines: string[] = [];

  try {
    // ── Database aggregates ──
    const [convStats] = await db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        nina: sql<number>`cast(count(*) filter (where status = 'nina') as int)`,
        human: sql<number>`cast(count(*) filter (where status = 'human') as int)`,
        paused: sql<number>`cast(count(*) filter (where status = 'paused') as int)`,
        closed: sql<number>`cast(count(*) filter (where status = 'closed') as int)`,
      })
      .from(conversations);

    lines.push(`# HELP fce_conversations_total Total de conversas`);
    lines.push(`# TYPE fce_conversations_total gauge`);
    lines.push(`fce_conversations_total{status="all"} ${convStats?.total ?? 0}`);
    lines.push(`fce_conversations_total{status="nina"} ${convStats?.nina ?? 0}`);
    lines.push(`fce_conversations_total{status="human"} ${convStats?.human ?? 0}`);
    lines.push(`fce_conversations_total{status="paused"} ${convStats?.paused ?? 0}`);
    lines.push(`fce_conversations_total{status="closed"} ${convStats?.closed ?? 0}`);

    const [msgStats] = await db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        today: sql<number>`cast(count(*) filter (where created_at >= current_date) as int)`,
      })
      .from(messages);
    lines.push(`# HELP fce_messages_total Total de mensagens`);
    lines.push(`# TYPE fce_messages_total counter`);
    lines.push(`fce_messages_total ${msgStats?.total ?? 0}`);
    lines.push(`fce_messages_today ${msgStats?.today ?? 0}`);

    const [contactStats] = await db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(contacts);
    lines.push(`fce_contacts_total ${contactStats?.total ?? 0}`);

    const [dealStats] = await db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        value: sql<string>`cast(coalesce(sum(value), 0) as text)`,
      })
      .from(deals);
    lines.push(`fce_deals_total ${dealStats?.total ?? 0}`);
    lines.push(`fce_deals_value_brl ${Number(dealStats?.value ?? 0)}`);

    const [prodStats] = await db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        available: sql<number>`cast(count(*) filter (where disponivel = true) as int)`,
      })
      .from(produtosCatalogo);
    lines.push(`fce_products_total ${prodStats?.total ?? 0}`);
    lines.push(`fce_products_available ${prodStats?.available ?? 0}`);

    // ── BullMQ queues ──
    const [inbound, aiReply, outbound] = await Promise.all([
      inboundQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      aiReplyQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      outboundQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ]);

    lines.push(`# HELP fce_queue_jobs BullMQ job counts`);
    lines.push(`# TYPE fce_queue_jobs gauge`);
    for (const [queueName, counts] of Object.entries({ inbound, 'ai-reply': aiReply, outbound })) {
      for (const [state, count] of Object.entries(counts)) {
        lines.push(`fce_queue_jobs{queue="${queueName}",state="${state}"} ${count}`);
      }
    }

    // ── Process ──
    const mem = process.memoryUsage();
    lines.push(`# HELP fce_process_memory_bytes Memory usage`);
    lines.push(`# TYPE fce_process_memory_bytes gauge`);
    lines.push(`fce_process_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`fce_process_memory_bytes{type="heapUsed"} ${mem.heapUsed}`);
    lines.push(`fce_process_memory_bytes{type="heapTotal"} ${mem.heapTotal}`);
    lines.push(`fce_process_uptime_seconds ${Math.floor(process.uptime())}`);
  } catch (err) {
    lines.push(`# Error collecting metrics: ${(err as Error).message}`);
  }

  c.header('Content-Type', 'text/plain; version=0.0.4');
  return c.body(lines.join('\n') + '\n');
});

export default metrics;
