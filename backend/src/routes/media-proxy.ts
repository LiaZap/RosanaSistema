import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import {
  buildProductImageKey,
  streamProductImage,
} from '../lib/minio-cache.js';
import { logger } from '../lib/logger.js';

const media = new Hono();

/**
 * Proxy de imagens. Resolve o problema de Bling/outros hosts
 * bloquearem hot-link via Referer.
 *
 * Uso no frontend: <img src="/api/media/proxy?url=https://bling..." />
 *
 * Cache 1h via Cache-Control. Limite de tamanho 10MB.
 *
 * Seguranca: so aceita http(s), valida tamanho/content-type, max 10s timeout.
 * Nao eh auth-protected (sao imagens publicas do catalogo).
 */

const ALLOWED_HOSTS = [
  'bling.com.br',
  'res.cloudinary.com',
  'cloudinary.com',
  'storage.googleapis.com',
  'googleusercontent.com',
  'amazonaws.com', // S3 usado pelo Bling
  'imgix.net',
  'fbcdn.net',
  'whatsapp.net',
  'mmg.whatsapp.net',
];

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

media.get('/proxy', async (c) => {
  const urlRaw = c.req.query('url');
  if (!urlRaw) return c.text('missing url', 400);

  let target: URL;
  try {
    target = new URL(urlRaw);
  } catch {
    return c.text('invalid url', 400);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return c.text('protocol not allowed', 400);
  }

  // Valida host (sub.domain.com permite domain.com)
  const hostAllowed = ALLOWED_HOSTS.some(
    (h) => target.host === h || target.host.endsWith('.' + h),
  );
  if (!hostAllowed) {
    logger.warn({ host: target.host }, '[MediaProxy] host blocked');
    return c.text('host not allowed', 403);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      headers: {
        // Alguns hosts (Bling) negam sem User-Agent
        'User-Agent': 'Mozilla/5.0 FCE-Image-Proxy/1.0',
        Accept: 'image/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return c.text(`upstream ${upstream.status}`, 502);
    }

    const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return c.text('upstream not image', 415);
    }

    const contentLength = upstream.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return c.text('image too large', 413);
    }

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return c.text('image too large', 413);
    }

    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=3600, immutable');
    c.header('X-Proxied-From', target.host);
    return c.body(buffer);
  } catch (err) {
    clearTimeout(timeout);
    const msg = (err as Error).message;
    if ((err as Error).name === 'AbortError') {
      logger.warn({ url: urlRaw }, '[MediaProxy] timeout');
      return c.text('upstream timeout', 504);
    }
    logger.warn({ err: msg, url: urlRaw }, '[MediaProxy] failed');
    return c.text('proxy failed', 502);
  }
});

// ── GET /media/file/:productId/:idx? ────────────────
// Serve imagem do MinIO. idx 0 = principal, 1+ = adicionais.
// Se nao tem ainda, faz upload lazy de TODAS as imagens do produto.
media.get('/file/:productId/:idx?', async (c) => {
  const productId = c.req.param('productId');
  const idxParam = c.req.param('idx');
  const idx = idxParam ? Math.max(0, parseInt(idxParam, 10) || 0) : 0;

  try {
    // Tenta servir do MinIO direto (key especifica de idx)
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try {
        const key = buildProductImageKey(productId, ext, idx);
        const obj = await streamProductImage(key);
        if (obj?.body) {
          const buffer = await streamToBuffer(obj.body);
          c.header('Content-Type', obj.contentType ?? 'image/jpeg');
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          return c.body(buffer as unknown as ArrayBuffer);
        }
      } catch (err) {
        logger.warn(
          { ext, productId, idx, err: (err as Error).message },
          '[MediaProxy] error checking MinIO',
        );
      }
    }

    // Nao tem no MinIO ainda - tenta lazy upload do Bling
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });

    if (!product) {
      logger.info({ productId }, '[MediaProxy] product not found');
      return c.text('product not found', 404);
    }

    // Sem MinIO cached pra esse idx? Busca TODAS as imagens do Bling
    // e salva todas (uploadMultipleImages). Resolve idx solicitado.
    if (!product.blingId) {
      return c.text('product has no blingId', 404);
    }

    let allUrls: string[] = [];
    try {
      const { getValidAccessToken, fetchFreshProductImages } = await import(
        '../lib/bling-client.js'
      );
      const token = await getValidAccessToken(product.accountId);
      if (token) {
        allUrls = await fetchFreshProductImages({
          accessToken: token,
          blingId: product.blingId,
        });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[MediaProxy] fetchFreshProductImages failed');
    }

    if (allUrls.length === 0) {
      // Fallback: tenta usar imagemBling salvo (campo legacy)
      if (product.imagemBling) allUrls = [product.imagemBling];
    }

    if (allUrls.length === 0) {
      logger.info({ productId, blingId: product.blingId }, '[MediaProxy] no image URL');
      return c.text('image not found', 404);
    }

    logger.info(
      { productId, blingId: product.blingId, count: allUrls.length, idx },
      '[MediaProxy] lazy uploading all images',
    );

    const { uploadMultipleImages } = await import('../lib/minio-cache.js');
    const results = await uploadMultipleImages({
      productId,
      imageUrls: allUrls,
      accountId: product.accountId,
    });
    const successUrls = results
      .map((r, i) => (r ? `/media/file/${productId}/${i}` : null))
      .filter((u): u is string => !!u);

    // Atualiza imagensMinio (array) + imagemBling (compat)
    await db
      .update(produtosCatalogo)
      .set({
        imagensMinio: successUrls,
        imagemBling: allUrls[0],
        imagemMinio: successUrls[0] ?? null,
        minioUploadedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(produtosCatalogo.id, productId));

    // Stream o idx solicitado
    const result = results[idx] ?? results[0];
    if (!result) {
      logger.warn({ productId, idx }, '[MediaProxy] upload returned null');
      return c.text('source image unavailable', 404);
    }

    // Refetch e stream
    const refetched = await streamProductImage(result.key);
    if (!refetched?.body) {
      logger.warn({ productId, key: result.key }, '[MediaProxy] upload OK but refetch failed');
      return c.text('upload succeeded but read failed', 404);
    }
    const buffer = await streamToBuffer(refetched.body);
    c.header('Content-Type', result.mimetype);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(buffer as unknown as ArrayBuffer);
  } catch (err) {
    const msg = (err as Error).message;
    const stack = (err as Error).stack?.slice(0, 500);
    logger.error({ err: msg, stack, productId }, '[MediaProxy] /file handler crashed');
    // 404 em vez de 500: EasyPanel intercepta 5xx com page HTML.
    return c.text(`handler error: ${msg.slice(0, 200)}`, 404);
  }
});

// ── GET /media/stuck-conversations ───────────────────
// Lista conversas com msgs de cliente nao respondidas pela DANI
media.get('/stuck-conversations', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);

  try {
    const { sql } = await import('drizzle-orm');
    const result = await db.execute(sql`
      WITH last_msg AS (
        SELECT
          c.id AS conv_id,
          c.status,
          c.last_human_at,
          c.last_message_at,
          ct.name AS contact_name,
          ct.phone_number AS phone,
          (SELECT m.from_type FROM messages m WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC LIMIT 1) AS last_from,
          (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC LIMIT 1) AS last_content,
          (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC LIMIT 1) AS last_at
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.account_id = ${accountId}
          AND c.status IN ('nina', 'human')
      )
      SELECT *,
        EXTRACT(EPOCH FROM (NOW() - last_at))/60 AS minutes_idle,
        EXTRACT(EPOCH FROM (NOW() - last_human_at))/60 AS minutes_since_human
      FROM last_msg
      WHERE last_from = 'user'
        AND last_at > NOW() - INTERVAL '7 days'
      ORDER BY last_at DESC
      LIMIT 50
    `);

    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

    return c.json({
      total: rows.length,
      conversations: rows.map((r) => ({
        contact: r.contact_name,
        phone: r.phone,
        status: r.status,
        lastFrom: r.last_from,
        lastContent: (r.last_content as string | null)?.slice(0, 100),
        lastAt: r.last_at,
        minutesIdle: Math.round(Number(r.minutes_idle ?? 0)),
        minutesSinceHuman: r.minutes_since_human
          ? Math.round(Number(r.minutes_since_human))
          : null,
        diagnosis:
          r.status === 'human' && r.minutes_since_human && Number(r.minutes_since_human) > 60
            ? 'SHOULD-AUTOREACTIVATE'
            : r.status === 'human'
              ? 'human-pause-active'
              : 'nina-not-responding',
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── GET /media/conv-status?phone=... ─────────────────
// Diagnostico completo do status de uma conversa pelo telefone
media.get('/conv-status', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  const phone = c.req.query('phone') ?? '';
  if (!accountId || !phone) return c.json({ error: 'missing accountId or phone' }, 400);

  try {
    const { contacts, conversations, messages } = await import('../db/schema.js');
    const { and, desc, sql } = await import('drizzle-orm');

    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.accountId, accountId), eq(contacts.phoneNumber, phone)),
    });
    if (!contact) return c.json({ error: 'contact not found', phone });

    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.contactId, contact.id),
    });
    if (!conv) return c.json({ error: 'conversation not found', contactId: contact.id });

    const lastMsgs = await db
      .select({
        id: messages.id,
        fromType: messages.fromType,
        content: messages.content,
        messageType: messages.messageType,
        createdAt: messages.createdAt,
        processedByNina: messages.processedByNina,
        bufferWindowId: messages.bufferWindowId,
      })
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(15);

    const now = Date.now();
    const minutesSinceHuman = conv.lastHumanAt
      ? Math.round((now - conv.lastHumanAt.getTime()) / 60000)
      : null;
    const minutesSinceLastMsg = conv.lastMessageAt
      ? Math.round((now - conv.lastMessageAt.getTime()) / 60000)
      : null;

    // Buffer pendente no Redis
    let bufferSize = 0;
    let bufferWindowId: string | null = null;
    try {
      const { getRedis } = await import('../lib/queues.js');
      const redis = getRedis();
      const bufKey = `fce:buf:${conv.id}`;
      bufferSize = await redis.llen(bufKey);
      const winKey = `fce:bufwin:${conv.id}`;
      bufferWindowId = await redis.get(winKey);
    } catch {
      // ignore
    }

    return c.json({
      contact: { id: contact.id, name: contact.name, phone: contact.phoneNumber },
      conversation: {
        id: conv.id,
        status: conv.status,
        lastMessageAt: conv.lastMessageAt,
        lastHumanAt: conv.lastHumanAt,
        minutesSinceLastMsg,
        minutesSinceHuman,
      },
      buffer: { size: bufferSize, windowId: bufferWindowId },
      diagnosis: {
        daniWillRespond: conv.status === 'nina',
        humanPaused: conv.status === 'human',
        shouldAutoReactivate:
          conv.status === 'human' && minutesSinceHuman !== null && minutesSinceHuman >= 60,
        unprocessedClientMsgs: lastMsgs.filter(
          (m) => m.fromType === 'user' && !m.processedByNina,
        ).length,
      },
      lastMessages: lastMsgs.map((m) => ({
        from: m.fromType,
        content: m.content?.slice(0, 200) ?? null,
        type: m.messageType,
        at: m.createdAt,
        processed: m.processedByNina,
        winId: m.bufferWindowId?.slice(0, 8),
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, stack: (err as Error).stack?.slice(0, 500) }, 500);
  }
});

// ── GET /media/pipeline-debug ───────────────────────
// Diagnóstico: quantas conversations / contacts / deals / stages
media.get('/pipeline-debug', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  try {
    const { sql } = await import('drizzle-orm');
    const stats = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM conversations WHERE account_id = ${accountId}) AS total_convs,
        (SELECT COUNT(*)::int FROM conversations WHERE account_id = ${accountId} AND status='nina') AS convs_nina,
        (SELECT COUNT(*)::int FROM conversations WHERE account_id = ${accountId} AND status='human') AS convs_human,
        (SELECT COUNT(*)::int FROM conversations WHERE account_id = ${accountId} AND status='closed') AS convs_closed,
        (SELECT COUNT(*)::int FROM contacts WHERE account_id = ${accountId}) AS total_contacts,
        (SELECT COUNT(*)::int FROM deals WHERE account_id = ${accountId}) AS total_deals,
        (SELECT COUNT(*)::int FROM pipeline_stages WHERE account_id = ${accountId}) AS total_stages
    `);
    const row = (stats as unknown as { rows: Array<Record<string, number>> }).rows[0];
    const stages = await db.execute(sql`
      SELECT name, position FROM pipeline_stages WHERE account_id = ${accountId} ORDER BY position
    `);
    return c.json({
      ...row,
      stages: (stages as unknown as { rows: Array<Record<string, unknown>> }).rows,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── GET /media/list-deals ───────────────────────────
// Lista deals direto sem auth pra debug
media.get('/list-deals', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  try {
    const { deals, contacts, pipelineStages } = await import('../db/schema.js');
    const { eq, sql } = await import('drizzle-orm');
    const rows = await db
      .select({
        id: deals.id,
        title: deals.title,
        value: deals.value,
        stageId: deals.stageId,
        stageName: pipelineStages.name,
        contactName: contacts.name,
        createdByAi: deals.createdByAi,
        conversationId: deals.conversationId,
      })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(eq(deals.accountId, accountId));
    void sql;
    return c.json({ total: rows.length, deals: rows });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/backfill-deals ──────────────────────
// Cria deal pra cada conversation que ainda não tem.
// Pra cobrir conversas anteriores ao auto-deal funcionando.
media.post('/backfill-deals', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  try {
    const { conversations, contacts, deals, pipelineStages } = await import('../db/schema.js');
    const { and, eq, sql, isNull } = await import('drizzle-orm');

    // Stage "Novos Leads" (primeira)
    const [stage] = await db
      .select({ id: pipelineStages.id, name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.accountId, accountId))
      .orderBy(pipelineStages.position)
      .limit(1);
    if (!stage) return c.json({ error: 'pipeline stages nao configurado' }, 400);

    // Conversations que NAO tem deal ainda (LEFT JOIN deals IS NULL)
    // Inclui TODOS status (mesmo closed) - se quer fechado, vai pra stage Ganho/Perdido depois
    const convs = await db.execute(sql`
      SELECT c.id AS conv_id, c.contact_id, ct.name AS contact_name, c.status
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN deals d ON d.contact_id = c.contact_id AND d.account_id = c.account_id
      WHERE c.account_id = ${accountId}
        AND d.id IS NULL
    `);
    const rows = (
      convs as unknown as { rows: Array<{ conv_id: string; contact_id: string; contact_name: string | null }> }
    ).rows;

    void and;
    void eq;
    void isNull;

    let created = 0;
    for (const r of rows) {
      const title = r.contact_name ? `Lead: ${r.contact_name}` : 'Lead novo';
      await db.insert(deals).values({
        accountId,
        contactId: r.contact_id,
        stageId: stage.id,
        title,
        notes: 'Backfill automático - conversa pré-existente.',
        createdByAi: true,
        conversationId: r.conv_id,
      });
      created++;
    }
    return c.json({ ok: true, created, stage: stage.name });
  } catch (err) {
    return c.json({ error: (err as Error).message, stack: (err as Error).stack?.slice(0, 500) }, 500);
  }
});

// ── POST /media/force-reactivate-all ────────────────
// Reativa MANUALMENTE todas conversas em status=human (admin emergency)
media.post('/force-reactivate-all', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  try {
    const { conversations } = await import('../db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    const result = await db
      .update(conversations)
      .set({ status: 'nina', updatedAt: new Date() })
      .where(and(eq(conversations.accountId, accountId), eq(conversations.status, 'human')))
      .returning({ id: conversations.id });
    return c.json({ ok: true, reactivated: result.length, ids: result.map((r) => r.id) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── GET /media/find-by-phone?phone=553186583214 ──
// Acha conversa por telefone (sem precisar accountId).
media.get('/find-by-phone', async (c) => {
  const phone = c.req.query('phone') ?? '';
  if (!phone) return c.json({ error: 'missing phone' }, 400);
  try {
    const { contacts, conversations, messages } = await import('../db/schema.js');
    const { eq, desc } = await import('drizzle-orm');
    const ct = await db
      .select({ id: contacts.id, accountId: contacts.accountId, name: contacts.fullName })
      .from(contacts)
      .where(eq(contacts.phoneNumber, phone))
      .limit(1);
    if (!ct[0]) return c.json({ error: 'contact not found', phone });
    const conv = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
        lastHumanAt: conversations.lastHumanAt,
      })
      .from(conversations)
      .where(eq(conversations.contactId, ct[0].id))
      .limit(1);
    if (!conv[0]) return c.json({ error: 'no conversation', contact: ct[0] });
    const lastMsgs = await db
      .select({
        id: messages.id,
        fromType: messages.fromType,
        content: messages.content,
        messageType: messages.messageType,
        createdAt: messages.createdAt,
        bufferWindowId: messages.bufferWindowId,
      })
      .from(messages)
      .where(eq(messages.conversationId, conv[0].id))
      .orderBy(desc(messages.createdAt))
      .limit(5);
    return c.json({
      contact: ct[0],
      conversation: conv[0],
      lastMessages: lastMsgs,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/force-reply ─────────────────────
// Forca DANI a responder uma conversa especifica AGORA.
// Util quando cliente respondeu durante pausa humana e msg ficou orfa.
// Usage: POST /media/force-reply?conversationId=XXX
media.post('/force-reply', async (c) => {
  const conversationId = c.req.query('conversationId') ?? '';
  if (!conversationId) return c.json({ error: 'missing conversationId' }, 400);
  try {
    const { conversations, contacts, messages } = await import('../db/schema.js');
    const { eq, desc, and, isNull } = await import('drizzle-orm');
    const { aiReplyQueue } = await import('../lib/queues.js');
    const { getRedis } = await import('../lib/queues.js');
    const { randomUUID } = await import('crypto');

    const conv = await db
      .select({
        id: conversations.id,
        accountId: conversations.accountId,
        contactId: conversations.contactId,
        status: conversations.status,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv[0]) return c.json({ error: 'conversation not found' }, 404);

    // Garante status nina
    if (conv[0].status !== 'nina') {
      await db
        .update(conversations)
        .set({ status: 'nina', updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    }

    const ct = await db
      .select({ phone: contacts.phoneNumber })
      .from(contacts)
      .where(eq(contacts.id, conv[0].contactId))
      .limit(1);
    if (!ct[0]) return c.json({ error: 'contact not found' }, 404);

    // Pega ultima msg
    const lastMsg = await db
      .select({ id: messages.id, bufferWindowId: messages.bufferWindowId, fromType: messages.fromType })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (!lastMsg[0]) return c.json({ error: 'no messages' }, 400);
    if (lastMsg[0].fromType !== 'user') {
      return c.json({ error: 'ultima msg nao eh do cliente', fromType: lastMsg[0].fromType }, 400);
    }

    let windowId = lastMsg[0].bufferWindowId;
    if (!windowId) {
      windowId = randomUUID();
      await db
        .update(messages)
        .set({ bufferWindowId: windowId })
        .where(
          and(
            eq(messages.conversationId, conversationId),
            isNull(messages.bufferWindowId),
            eq(messages.fromType, 'user'),
          ),
        );
      const redis = getRedis();
      await redis.set(`fce:buf:${conversationId}:win`, windowId, 'EX', 600);
    }

    await aiReplyQueue.add(
      'process',
      {
        accountId: conv[0].accountId,
        conversationId,
        contactId: conv[0].contactId,
        phoneNumber: ct[0].phone,
        bufferWindowId: windowId,
      },
      {
        jobId: `ai_force_${conversationId}_${Date.now()}`,
        delay: 100,
      },
    );

    return c.json({ ok: true, conversationId, windowId, queued: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/apply-migration-0011 ─────────────────
media.post('/apply-migration-0011', async (c) => {
  try {
    const { sql } = await import('drizzle-orm');
    await db.execute(
      sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS created_by_ai boolean NOT NULL DEFAULT false`,
    );
    await db.execute(
      sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL`,
    );
    return c.json({ ok: true, applied: ['deals.created_by_ai', 'deals.conversation_id'] });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/apply-migration-0010 ─────────────────
media.post('/apply-migration-0010', async (c) => {
  try {
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS google_calendar_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        email varchar(255),
        access_token text,
        refresh_token text,
        expires_at timestamp with time zone,
        scope text,
        calendar_id varchar(255) NOT NULL DEFAULT 'primary',
        sync_enabled boolean NOT NULL DEFAULT true,
        last_sync_at timestamp with time zone,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    return c.json({ ok: true, applied: 'google_calendar_connections' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/apply-migration-0009 ─────────────────
media.post('/apply-migration-0009', async (c) => {
  try {
    const { sql } = await import('drizzle-orm');
    await db.execute(
      sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_human_at timestamp with time zone`,
    );
    await db.execute(
      sql`ALTER TABLE nina_settings ADD COLUMN IF NOT EXISTS pause_after_human_minutes integer NOT NULL DEFAULT 60`,
    );
    return c.json({ ok: true, applied: ['conversations.last_human_at', 'nina_settings.pause_after_human_minutes'] });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/apply-migration-0008 ─────────────────
// Aplica ALTER TABLE imagens_minio se ainda nao existe
media.post('/apply-migration-0008', async (c) => {
  try {
    const { sql } = await import('drizzle-orm');
    // Idempotente: usa IF NOT EXISTS
    await db.execute(
      sql`ALTER TABLE produtos_catalogo ADD COLUMN IF NOT EXISTS imagens_minio jsonb DEFAULT '[]'::jsonb`,
    );
    return c.json({ ok: true, applied: 'imagens_minio jsonb column' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/refresh/:productId ───────────────────
// Invalida cache MinIO + imagemBling do produto, forca re-fetch
media.post('/refresh/:productId', async (c) => {
  const productId = c.req.param('productId');
  const out: Record<string, unknown> = { productId };
  try {
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });
    if (!product) {
      out.error = 'product not found';
      return c.json(out, 404);
    }

    // Tenta apagar do MinIO todas extensões + idx 0..4
    const { getS3 } = await import('../lib/minio-cache.js');
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const bucket = process.env.MINIO_BUCKET || 'fce-media';
    const deleted: string[] = [];
    for (let idx = 0; idx < 5; idx++) {
      for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
        const key = buildProductImageKey(productId, ext, idx);
        try {
          await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          deleted.push(key);
        } catch {
          // 404 no MinIO, ignora
        }
      }
    }
    out.minioDeleted = deleted;

    // Zera campos no banco
    await db
      .update(produtosCatalogo)
      .set({
        imagemBling: null,
        imagemMinio: null,
        imagensMinio: [],
        minioUploadedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(produtosCatalogo.id, productId));
    out.dbCleared = true;

    return c.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    return c.json(out, 500);
  }
});

// ── GET /media/webhook-url/:accountId ────────────────
// Retorna a URL exata do webhook que deve ser configurada no Evolution
media.get('/webhook-url/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  try {
    const { whatsappAccountSettings } = await import('../db/schema.js');
    const s = await db.query.whatsappAccountSettings.findFirst({
      where: eq(whatsappAccountSettings.accountId, accountId),
    });
    if (!s?.verifyToken) {
      return c.json({ error: 'verify token nao configurado' }, 404);
    }
    const apiBase = process.env.API_URL || 'https://liamed-fce-api.leyiy3.easypanel.host';
    const webhookUrl = `${apiBase}/whatsapp/webhook/${accountId}?token=${s.verifyToken}`;
    return c.json({
      webhookUrl,
      events: ['messages.upsert', 'messages.update', 'connection.update'],
      webhook_by_events: false,
      instructions: 'Cole essa URL no Evolution Manager > Instance > Webhook',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── POST /media/init-dani/:accountId ─────────────────
// Cria nina_settings com defaults pra DANI ficar ativa
media.post('/init-dani/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  try {
    const { ninaSettings } = await import('../db/schema.js');
    const existing = await db.query.ninaSettings.findFirst({
      where: eq(ninaSettings.accountId, accountId),
    });
    if (existing) {
      // Garante isActive=true se ja existe
      await db
        .update(ninaSettings)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(ninaSettings.accountId, accountId));
      return c.json({ ok: true, action: 'updated', wasActive: existing.isActive });
    }
    // Cria com defaults
    await db.insert(ninaSettings).values({
      accountId,
      sdrName: 'DANI',
      companyName: 'Filhos com Estilo',
      isActive: true,
      aiModelMode: 'flash',
      bufferWindowMs: 15000,
      bufferMaxMs: 60000,
      responseDelayMin: 1,
      responseDelayMax: 3,
      messageBreakingEnabled: false,
      audioResponseEnabled: false,
    });
    return c.json({ ok: true, action: 'created' });
  } catch (err) {
    return c.json({ error: (err as Error).message, stack: (err as Error).stack?.slice(0, 500) }, 500);
  }
});

// ── GET /media/test-pause-flow ───────────────────────
// Simula fluxo: cliente -> DANI -> humano -> cliente -> deve silenciar
media.get('/test-pause-flow', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  const trace: Record<string, unknown> = { accountId };
  try {
    const { contacts, conversations, messages } = await import('../db/schema.js');
    const { saveMessage, isDaniActiveForConversation, reactivateDani } = await import(
      '../lib/dani-conversations.js'
    );
    const { processDaniMessage } = await import('../lib/dani-orchestrator.js');

    // 1. Cria contact + conversation de teste (phone max 20 chars)
    const phone = `tp${Date.now().toString().slice(-12)}`;
    const [contact] = await db
      .insert(contacts)
      .values({ accountId, phoneNumber: phone, name: 'Teste Pausa' })
      .returning({ id: contacts.id });
    const [conv] = await db
      .insert(conversations)
      .values({ accountId, contactId: contact.id, status: 'nina' })
      .returning({ id: conversations.id });
    trace.step1_setup = { contactId: contact.id, conversationId: conv.id };

    // 2. Cliente envia mensagem - DANI deve responder
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: 'oi, tem foto do windi?',
    });
    const active1 = await isDaniActiveForConversation(conv.id);
    trace.step2_clientMsg1 = { daniActive: active1 };

    if (active1) {
      const r1 = await processDaniMessage('oi, tem foto do windi?', {
        accountId,
        contactId: contact.id,
        history: [],
      });
      await saveMessage({
        conversationId: conv.id,
        accountId,
        fromType: 'nina',
        content: r1.reply,
        processedByNina: true,
      });
      trace.step3_daniReply = {
        replied: !!r1.reply,
        reply: r1.reply.slice(0, 100),
        attachments: r1.attachments.length,
      };
    }

    // 4. HUMANO envia mensagem - status deve virar 'human' automaticamente
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'human',
      content: 'Oi! Aqui e a Bia, posso confirmar o pedido?',
    });
    const active2 = await isDaniActiveForConversation(conv.id);
    trace.step4_humanMsg = { daniActiveAfter: active2 };

    // 5. Cliente envia OUTRA mensagem - DANI NAO deve responder
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: 'sim quero confirmar 2 unidades',
    });
    const active3 = await isDaniActiveForConversation(conv.id);
    trace.step5_clientMsg2 = {
      daniActive: active3,
      shouldRespond: false,
      ok: !active3,
    };

    // 6. Reativa DANI
    await reactivateDani(conv.id);
    const active4 = await isDaniActiveForConversation(conv.id);
    trace.step6_reactivate = { daniActive: active4, ok: active4 };

    // 7. Cliente envia mensagem - DANI deve voltar a responder
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: 'oi, sobre o moises portatil',
    });
    const active5 = await isDaniActiveForConversation(conv.id);
    trace.step7_clientMsg3 = { daniActive: active5, ok: active5 };

    // Cleanup: remove teste
    await db.delete(messages).where(eq(messages.conversationId, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    await db.delete(contacts).where(eq(contacts.id, contact.id));

    trace.verdict = {
      step2_initialActive: active1 === true,
      step4_humanPaused: active2 === false,
      step5_silencedAfterHuman: active3 === false,
      step6_reactivated: active4 === true,
      step7_backToNina: active5 === true,
      ALL_OK: active1 && !active2 && !active3 && active4 && active5,
    };

    return c.json(trace);
  } catch (err) {
    trace.error = (err as Error).message;
    trace.stack = (err as Error).stack?.slice(0, 500);
    return c.json(trace, 500);
  }
});

// ── GET /media/whatsapp-pipeline-test ────────────────
// Diagnostico completo do pipeline WhatsApp pra producao
media.get('/whatsapp-pipeline-test', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);
  const out: Record<string, unknown> = { accountId };

  try {
    // 1. Settings Evolution configurados?
    const { whatsappAccountSettings, whatsappSessions, ninaSettings } = await import(
      '../db/schema.js'
    );
    const evoSettings = await db.query.whatsappAccountSettings.findFirst({
      where: eq(whatsappAccountSettings.accountId, accountId),
    });
    out.evolutionConfig = {
      apiUrlSet: !!evoSettings?.apiUrl,
      apiKeySet: !!evoSettings?.apiKey,
      verifyTokenSet: !!evoSettings?.verifyToken,
      apiUrl: evoSettings?.apiUrl,
    };

    // 2. Sessao salva
    const session = await db.query.whatsappSessions.findFirst({
      where: eq(whatsappSessions.accountId, accountId),
    });
    out.session = session
      ? {
          instanceName: session.instanceName,
          status: session.status,
          provider: session.provider,
          phoneNumber: session.phoneNumber,
          updatedAt: session.updatedAt,
        }
      : null;

    // 3. DANI settings ativos?
    const dani = await db.query.ninaSettings.findFirst({
      where: eq(ninaSettings.accountId, accountId),
    });
    out.daniConfig = dani
      ? {
          isActive: dani.isActive,
          hasPromptOverride: !!dani.systemPromptOverride,
          promptOverrideChars: dani.systemPromptOverride?.length ?? 0,
          model: dani.aiModelMode,
          bufferWindowMs: dani.bufferWindowMs,
          sdrName: dani.sdrName,
          companyName: dani.companyName,
        }
      : { error: 'nina_settings missing' };

    // 4. Testa conexao Evolution (live)
    if (evoSettings?.apiUrl && evoSettings?.apiKey) {
      try {
        const { fetchInstances } = await import('../lib/evolution-client.js');
        const instances = await fetchInstances({
          settings: {
            apiUrl: evoSettings.apiUrl,
            apiKey: evoSettings.apiKey,
            verifyToken: evoSettings.verifyToken,
          },
        });
        out.evolutionLive = {
          ok: true,
          instanceCount: instances.length,
          instances: instances.map((i) => ({
            name: i.name,
            state: i.state,
            number: i.number,
            profileName: i.profileName,
          })),
        };
      } catch (err) {
        out.evolutionLive = { ok: false, error: (err as Error).message };
      }
    }

    // 5. Estado das filas
    const { getRedis } = await import('../lib/queues.js');
    const redis = getRedis();
    try {
      const [inbound, aireply, outbound] = await Promise.all([
        redis.llen('bull:inbound:wait'),
        redis.llen('bull:ai-reply:wait'),
        redis.llen('bull:outbound:wait'),
      ]);
      out.queues = { inbound, aireply, outbound };
    } catch (err) {
      out.queues = { error: (err as Error).message };
    }

    // 6. Conta mensagens recentes
    const { messages, conversations, contacts } = await import('../db/schema.js');
    const { sql } = await import('drizzle-orm');
    const [msgCount, convCount, contactCount] = await Promise.all([
      db.execute(
        sql`SELECT COUNT(*)::int AS n FROM ${messages} WHERE account_id = ${accountId}`,
      ),
      db.execute(
        sql`SELECT COUNT(*)::int AS n FROM ${conversations} WHERE account_id = ${accountId}`,
      ),
      db.execute(
        sql`SELECT COUNT(*)::int AS n FROM ${contacts} WHERE account_id = ${accountId}`,
      ),
    ]);
    out.dataCount = {
      messages: (msgCount as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
      conversations: (convCount as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
      contacts: (contactCount as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
    };

    // 7. Verifica produtos sincronizados
    const { produtosCatalogo } = await import('../db/schema.js');
    const prodCount = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM ${produtosCatalogo} WHERE account_id = ${accountId}`,
    );
    out.products = {
      total: (prodCount as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
    };

    // 8. Diagnostico geral
    const checks = {
      evolutionConfigured:
        out.evolutionConfig &&
        (out.evolutionConfig as Record<string, unknown>).apiUrlSet &&
        (out.evolutionConfig as Record<string, unknown>).apiKeySet,
      evolutionReachable:
        out.evolutionLive && (out.evolutionLive as Record<string, unknown>).ok,
      sessionLinked: !!session,
      daniActive: dani?.isActive ?? false,
      hasProducts: ((out.products as Record<string, unknown>).total as number) > 0,
      webhookConfigured: !!evoSettings?.verifyToken,
    };
    out.checks = checks;
    out.productionReady = Object.values(checks).every((v) => v === true);

    return c.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    return c.json(out, 500);
  }
});

// ── GET /media/dani-test ─────────────────────────────
// Debug: simula uma msg pra DANI (sem auth, sem persistir)
media.get('/dani-test', async (c) => {
  const message = c.req.query('msg') ?? 'tem foto do windi?';
  const accountId = c.req.query('accountId') ?? '';
  if (!accountId) return c.json({ error: 'missing accountId' }, 400);

  const { processDaniMessage } = await import('../lib/dani-orchestrator.js');
  try {
    const result = await processDaniMessage(message, {
      accountId,
      contactId: null,
      history: [],
    });
    return c.json({
      input: message,
      reply: result.reply,
      shouldReply: result.shouldReply,
      attachments: result.attachments,
      toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
      durationMs: result.durationMs,
      iterations: result.iterations,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, stack: (err as Error).stack?.slice(0, 500) }, 500);
  }
});

// ── GET /media/search-test ───────────────────────────
// Debug: testa a busca de produtos (rota da DANI)
media.get('/search-test', async (c) => {
  const q = c.req.query('q') ?? '';
  const accountId = c.req.query('accountId') ?? '';
  if (!q || !accountId) return c.json({ error: 'missing q or accountId' }, 400);

  const { buscarProdutos } = await import('../lib/dani-products.js');
  const results = await buscarProdutos({ accountId, consulta: q, limit: 5 });
  return c.json({
    query: q,
    count: results.length,
    products: results.map((r) => ({
      nome: r.nome,
      preco: r.preco,
      estoque: r.estoque,
      disponivel: r.disponivel,
      imagem: r.imagem,
      blingId: r.blingId,
      codigo: r.codigo,
      marca: r.marca,
      stockSource: r.stockSource,
    })),
  });
});

// ── GET /media/upload-debug/:productId ───────────────
// Debug: chama uploadImageFromUrl manualmente e mostra TUDO
media.get('/upload-debug/:productId', async (c) => {
  const productId = c.req.param('productId');
  const out: Record<string, unknown> = { productId };
  try {
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });
    out.product = product
      ? {
          id: product.id,
          blingId: product.blingId,
          accountId: product.accountId,
          imagemBling: product.imagemBling?.slice(0, 120),
        }
      : null;
    if (!product?.blingId || !product.accountId) {
      out.error = 'product missing';
      return c.json(out, 404);
    }

    // Pega URL fresca
    const { getValidAccessToken, fetchFreshProductImageUrl } = await import(
      '../lib/bling-client.js'
    );
    const token = await getValidAccessToken(product.accountId);
    out.hasToken = !!token;
    if (!token) {
      out.error = 'no token';
      return c.json(out, 404);
    }
    const fresh = await fetchFreshProductImageUrl({
      accessToken: token,
      blingId: product.blingId,
    });
    out.freshUrl = fresh?.slice(0, 200);
    if (!fresh) {
      out.error = 'no fresh URL';
      return c.json(out, 404);
    }

    // Tenta baixar do servidor
    const dlRes = await fetch(fresh, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*',
      },
      redirect: 'follow',
    });
    out.downloadStatus = dlRes.status;
    out.downloadContentType = dlRes.headers.get('content-type');
    out.downloadContentLength = dlRes.headers.get('content-length');

    if (!dlRes.ok) {
      const errBody = await dlRes.text();
      out.downloadErrorBody = errBody.slice(0, 500);
      return c.json(out);
    }

    const buffer = Buffer.from(await dlRes.arrayBuffer());
    out.bufferBytes = buffer.length;

    // Testa MinIO upload
    try {
      const { getS3, buildProductImageKey } = await import('../lib/minio-cache.js');
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const mimetype = dlRes.headers.get('content-type') ?? 'image/jpeg';
      const ext = mimetype.split('/')[1]?.split(';')[0] ?? 'jpg';
      const key = buildProductImageKey(productId, ext === 'jpeg' ? 'jpg' : ext);
      const bucket = process.env.MINIO_BUCKET || 'fce-media';
      out.minioKey = key;
      out.minioBucket = bucket;
      await getS3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      out.minioUploadOk = true;
    } catch (err) {
      out.minioUploadErr = (err as Error).message;
      out.minioUploadStack = (err as Error).stack?.slice(0, 500);
    }

    return c.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    out.stack = (err as Error).stack?.slice(0, 500);
    return c.json(out, 404);
  }
});

// ── GET /media/bling-token-test ──────────────────────
// Testa POST direto ao /oauth/token (espera 400/401, NAO 429)
media.get('/bling-token-test', async (c) => {
  const out: Record<string, unknown> = {};
  const HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '1.0',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ZmFrZTpmYWtl', // fake:fake
  };
  for (const host of ['api.bling.com.br', 'www.bling.com.br']) {
    try {
      const r = await fetch(`https://${host}/Api/v3/oauth/token`, {
        method: 'POST',
        headers: HEADERS,
        body: 'grant_type=refresh_token&refresh_token=fake',
      });
      const text = await r.text();
      out[host] = {
        status: r.status,
        body: text.slice(0, 200),
        cfRay: r.headers.get('cf-ray'),
        server: r.headers.get('server'),
      };
    } catch (err) {
      out[host] = { err: (err as Error).message };
    }
  }
  return c.json(out);
});

// ── GET /media/outbound-ip ───────────────────────────
// Debug: descobre IP de saida do servidor pra Cloudflare
media.get('/outbound-ip', async (c) => {
  const out: Record<string, unknown> = {};
  try {
    const r = await fetch('https://ifconfig.me/all.json', {
      headers: { Accept: 'application/json' },
    });
    out.ifconfig = await r.json();
  } catch (err) {
    out.ifconfigErr = (err as Error).message;
  }
  try {
    const r2 = await fetch('https://api.bling.com.br/Api/v3/produtos', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '1.0',
      },
    });
    out.blingApiStatus = r2.status;
    out.blingApiHeaders = Object.fromEntries(r2.headers.entries());
  } catch (err) {
    out.blingApiErr = (err as Error).message;
  }
  return c.json(out);
});

// ── GET /media/bling-health/:productId ──────────────
// Debug: forca refresh do token limpando cooldown e mostra resultado.
// NAO expoe tokens completos - so booleans e status codes.
media.get('/bling-health/:productId', async (c) => {
  const productId = c.req.param('productId');
  const out: Record<string, unknown> = { productId };
  try {
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });
    if (!product?.blingId || !product.accountId) {
      out.error = 'product missing';
      return c.json(out, 404);
    }

    const { blingCredentials } = await import('../db/schema.js');
    const { getRedis } = await import('../lib/queues.js');
    const { refreshTokens } = await import('../lib/bling-client.js');

    // Limpa cooldowns
    const redis = getRedis();
    const okKey = `fce:bling:refresh:ok:${product.accountId}`;
    const failKey = `fce:bling:refresh:fail:${product.accountId}`;
    await Promise.all([redis.del(okKey), redis.del(failKey)]);
    out.cooldownsCleared = true;

    // Pega credentials
    const cred = await db.query.blingCredentials.findFirst({
      where: eq(blingCredentials.accountId, product.accountId),
    });
    out.hasCredentials = !!cred;
    out.hasClientId = !!cred?.clientId;
    out.hasRefreshToken = !!cred?.refreshToken;
    out.tokenExpiresAt = cred?.expiresAt;
    out.expired = cred?.expiresAt ? cred.expiresAt.getTime() < Date.now() : null;

    if (!cred?.clientId || !cred.clientSecret || !cred.refreshToken) {
      out.error = 'incomplete credentials - need reconnect';
      return c.json(out);
    }

    // Tenta refresh forcado
    try {
      const tokens = await refreshTokens({
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
        refreshToken: cred.refreshToken,
      });
      const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      await db
        .update(blingCredentials)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: newExpiresAt,
          updatedAt: new Date(),
        })
        .where(eq(blingCredentials.accountId, product.accountId));
      out.refreshOk = true;
      out.newExpiresAt = newExpiresAt;
    } catch (err) {
      out.refreshOk = false;
      out.refreshError = (err as Error).message.slice(0, 300);
    }

    return c.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    return c.json(out, 404);
  }
});

// ── GET /media/file/:productId/bling-raw ────────────
// Pega resposta crua do Bling pra debug
media.get('/file/:productId/bling-raw', async (c) => {
  const productId = c.req.param('productId');
  const out: Record<string, unknown> = { productId };
  try {
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });
    if (!product?.blingId || !product.accountId) {
      out.error = 'product or blingId missing';
      return c.json(out, 404);
    }
    out.blingId = product.blingId;

    const { getValidAccessToken } = await import('../lib/bling-client.js');
    const token = await getValidAccessToken(product.accountId);
    out.hasToken = !!token;
    if (!token) {
      out.error = 'no Bling token';
      return c.json(out, 404);
    }

    const r = await fetch(`https://api.bling.com.br/Api/v3/produtos/${product.blingId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    out.blingStatus = r.status;
    const text = await r.text();
    try {
      out.blingJson = JSON.parse(text);
    } catch {
      out.blingTextSample = text.slice(0, 1000);
    }
    return c.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    return c.json(out, 404);
  }
});

// ── GET /media/file/:productId/debug ────────────────
// Endpoint debug que retorna JSON com estado de cada etapa
media.get('/file/:productId/debug', async (c) => {
  const productId = c.req.param('productId');
  const result: Record<string, unknown> = { productId };
  try {
    const product = await db.query.produtosCatalogo.findFirst({
      where: eq(produtosCatalogo.id, productId),
    });
    result.product = product
      ? {
          id: product.id,
          blingId: product.blingId,
          accountId: product.accountId,
          imagemBling: product.imagemBling?.slice(0, 100),
          imagemMinio: product.imagemMinio,
          imagemCloudinary: product.imagemCloudinary,
        }
      : null;

    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const key = buildProductImageKey(productId, ext);
      try {
        const obj = await streamProductImage(key);
        result[`minio_${ext}`] = obj?.body ? `found (${obj.contentLength ?? '?'} bytes)` : 'not found';
      } catch (err) {
        result[`minio_${ext}`] = `error: ${(err as Error).message.slice(0, 100)}`;
      }
    }

    return c.json(result);
  } catch (err) {
    result.error = (err as Error).message;
    return c.json(result, 500);
  }
});

// Helper pra stream -> buffer
async function streamToBuffer(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default media;
