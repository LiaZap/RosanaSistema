import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import {
  buildProductImageKey,
  streamProductImage,
} from '../lib/minio-cache.js';
import { logger } from '../lib/logger.js';
import { verifyMediaSig } from '../lib/media-signing.js';

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

// L2 (SSRF): bloqueia hosts internos / IPs privados / metadata cloud.
// Um host da allowlist (ex: bucket S3 do atacante em amazonaws.com) pode
// responder 302 -> http://169.254.169.254 (metadata). Por isso revalidamos
// CADA hop e bloqueamos ranges privados.
function isPrivateHost(hostRaw: string): boolean {
  const h = hostRaw.toLowerCase().replace(/:\d+$/, '');
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;        // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;                        // multicast / reservado
  }
  if (h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function hostAllowed(host: string): boolean {
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// Segue redirects manualmente, revalidando host + IP privado a cada hop.
async function safeFetch(initialUrl: string, init: RequestInit): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (isPrivateHost(u.host)) throw new Error('blocked private host');
    if (!hostAllowed(u.host)) throw new Error('host not allowed');
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

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

  // Valida host inicial (safeFetch revalida cada redirect + bloqueia IP privado)
  if (isPrivateHost(target.host) || !hostAllowed(target.host)) {
    logger.warn({ host: target.host }, '[MediaProxy] host blocked');
    return c.text('host not allowed', 403);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await safeFetch(target.toString(), {
      signal: controller.signal,
      headers: {
        // Alguns hosts (Bling) negam sem User-Agent
        'User-Agent': 'Mozilla/5.0 FCE-Image-Proxy/1.0',
        Accept: 'image/*',
      },
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
// ── GET /media/asset/:key — serve assets do MinIO (chat, avatar, library) ──
// key vem URL-encoded: ex. chat/accountId/convId/123.jpg, avatar/userId/123.jpg
async function serveMinioAsset(c: Context, key: string, allowedPrefixes: string[]) {
  if (!allowedPrefixes.some((p) => key.startsWith(p))) return c.notFound();
  // Gating: a URL precisa estar assinada (HMAC ?sig=). Impede que alguem que
  // descubra a key baixe midia por-conta. 404 (nao 403) pra nao confirmar a key.
  if (!verifyMediaSig(key, c.req.query('sig'))) return c.notFound();
  try {
    const { getS3 } = await import('../lib/minio-cache.js');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const bucket = process.env.MINIO_BUCKET || 'fce-media';
    const obj = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!obj.Body) return c.notFound();
    const chunks: Buffer[] = [];
    for await (const chunk of obj.Body as unknown as AsyncIterable<Buffer>) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    c.header('Content-Type', obj.ContentType ?? 'application/octet-stream');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(buf as unknown as ArrayBuffer);
  } catch {
    return c.notFound();
  }
}

media.get('/chat/:key{.+}', async (c) =>
  serveMinioAsset(c, decodeURIComponent(c.req.param('key')), ['chat/']),
);

media.get('/asset/:key{.+}', async (c) =>
  serveMinioAsset(c, decodeURIComponent(c.req.param('key')), ['avatar/', 'library/', 'chat/']),
);

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
