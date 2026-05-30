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

    if (!product?.imagemBling) {
      logger.info({ productId, found: !!product }, '[MediaProxy] product or imagemBling missing');
      return c.text('image not found', 404);
    }

    logger.info(
      { productId, blingId: product.blingId, accountId: product.accountId },
      '[MediaProxy] lazy uploading to MinIO',
    );

    const result = await uploadImageFromUrl({
      productId,
      imageUrl: product.imagemBling,
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
