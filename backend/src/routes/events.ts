import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import { ValidationError, ForbiddenError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers } from '../db/schema.js';
import { subscribe, type FceEvent } from '../lib/events-stream.js';
import { logger } from '../lib/logger.js';

const events = new Hono();

// ── GET /events/stream?accountId=X ───────────────────
// Server-Sent Events - cliente conecta e recebe eventos em real-time
events.get('/stream', requireAuth, async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');

  // H9: valida que o usuario e membro do account (ou super-admin).
  // Sem isso, qualquer usuario logado recebia o feed real-time de QUALQUER
  // account so passando o accountId na query (vazamento cross-tenant).
  const user = getUser(c);
  if (!user.isSuperAdmin) {
    const [member] = await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, user.id), eq(accountMembers.accountId, accountId)))
      .limit(1);
    if (!member) throw new ForbiddenError('Sem acesso a este account');
  }

  return streamSSE(c, async (stream) => {
    logger.info({ accountId }, '[SSE] client connected');
    const queue: FceEvent[] = [];
    let resolveWait: (() => void) | null = null;

    const unsub = subscribe(accountId, (ev) => {
      queue.push(ev);
      resolveWait?.();
      resolveWait = null;
    });

    // Heartbeat a cada 25s pra browser não fechar conexão
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
    }, 25_000);

    try {
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ accountId }) });

      // Loop infinito até stream fechar
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
            setTimeout(resolve, 30_000); // timeout pra checar abort
          });
          continue;
        }
        const ev = queue.shift()!;
        await stream.writeSSE({
          event: ev.type,
          data: JSON.stringify(ev),
        });
      }
    } finally {
      clearInterval(heartbeat);
      unsub();
      logger.info({ accountId }, '[SSE] client disconnected');
    }
  });
});

export default events;
