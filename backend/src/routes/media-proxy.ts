import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import {
  buildProductImageKey,
  streamProductImage,
  uploadImageFromUrl,
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

// ── GET /media/file/:productId ──────────────────────
// Serve imagem do MinIO. Se nao tem ainda, faz upload lazy.
// Try/catch global pra ter mensagem clara em vez de 502 generico.
media.get('/file/:productId', async (c) => {
  const productId = c.req.param('productId');

  try {
    // Tenta servir do MinIO direto
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try {
        const key = buildProductImageKey(productId, ext);
        const obj = await streamProductImage(key);
        if (obj?.body) {
          const buffer = await streamToBuffer(obj.body);
          c.header('Content-Type', obj.contentType ?? 'image/jpeg');
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          return c.body(buffer as unknown as ArrayBuffer);
        }
      } catch (err) {
        logger.warn(
          { ext, productId, err: (err as Error).message },
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

    // Sem imagemBling salvo? Tenta resolver via GET detail no Bling.
    let imageUrl = product.imagemBling;
    if (!imageUrl && product.blingId) {
      try {
        const { getValidAccessToken, fetchFreshProductImageUrl } = await import(
          '../lib/bling-client.js'
        );
        const token = await getValidAccessToken(product.accountId);
        if (token) {
          imageUrl = await fetchFreshProductImageUrl({
            accessToken: token,
            blingId: product.blingId,
          });
          if (imageUrl) {
            // Atualiza no banco pra proxima vez
            await db
              .update(produtosCatalogo)
              .set({ imagemBling: imageUrl, updatedAt: new Date() })
              .where(eq(produtosCatalogo.id, productId));
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[MediaProxy] fresh resolve failed');
      }
    }

    if (!imageUrl) {
      logger.info({ productId, blingId: product.blingId }, '[MediaProxy] no image URL');
      return c.text('image not found', 404);
    }

    logger.info(
      { productId, blingId: product.blingId, accountId: product.accountId },
      '[MediaProxy] lazy uploading to MinIO',
    );

    const result = await uploadImageFromUrl({
      productId,
      imageUrl,
      accountId: product.accountId,
      blingId: product.blingId,
    });
    if (!result) {
      logger.warn({ productId }, '[MediaProxy] upload returned null - redirecting to source');
      // Fallback: busca URL fresca do Bling e redirect 302
      try {
        const { getValidAccessToken, fetchFreshProductImageUrl } = await import('../lib/bling-client.js');
        if (product.blingId) {
          const token = await getValidAccessToken(product.accountId);
          if (token) {
            const fresh = await fetchFreshProductImageUrl({
              accessToken: token,
              blingId: product.blingId,
            });
            if (fresh) {
              return c.redirect(fresh, 302);
            }
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[MediaProxy] fresh URL fetch failed');
      }
      // 404 em vez de 502: EasyPanel/Traefik intercepta 5xx com page HTML.
      return c.text('source image unavailable', 404);
    }

    // Atualiza row
    await db
      .update(produtosCatalogo)
      .set({
        imagemMinio: `/media/file/${productId}`,
        minioUploadedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(produtosCatalogo.id, productId));

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

    // Tenta apagar do MinIO todas extensões possíveis
    const { getS3 } = await import('../lib/minio-cache.js');
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const bucket = process.env.MINIO_BUCKET || 'fce-media';
    const deleted: string[] = [];
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const key = buildProductImageKey(productId, ext);
      try {
        await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        deleted.push(key);
      } catch {
        // 404 no MinIO, ignora
      }
    }
    out.minioDeleted = deleted;

    // Zera imagemBling + imagemMinio no banco
    await db
      .update(produtosCatalogo)
      .set({
        imagemBling: null,
        imagemMinio: null,
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
