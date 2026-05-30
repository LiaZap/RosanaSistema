import { Hono } from 'hono';
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
  'imagens.bling.com.br',
  'produtos.ninja.bling.com.br',
  'storage.googleapis.com',
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

export default media;
