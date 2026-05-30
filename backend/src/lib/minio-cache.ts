import { eq, and, isNotNull, isNull } from 'drizzle-orm';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { db } from '../db/client.js';
import { produtosCatalogo } from '../db/schema.js';
import { fetchFreshProductImageUrl, getValidAccessToken } from './bling-client.js';
import { logger } from './logger.js';

/**
 * Cache local de imagens de produto no MinIO.
 *
 * Estrategia: ao inves de depender de Cloudinary ou hot-link Bling
 * (que falha por User-Agent / hot-link block), baixamos a imagem do
 * Bling 1 vez e guardamos no MinIO bucket. DANI usa URL nossa propria.
 *
 * Beneficios:
 * - Funciona sem Cloudinary configurado
 * - Resilient: Bling pode mudar URL/CDN, nossa copia continua
 * - Mais rapido: MinIO local na mesma rede do EasyPanel
 *
 * URLs publicas geradas via endpoint /media/file/:productId no fce-api.
 */

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_USER = process.env.MINIO_ROOT_USER || 'minioadmin';
const MINIO_PASSWORD = process.env.MINIO_ROOT_PASSWORD || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'fce-media';

let _s3: S3Client | null = null;
export function getS3(): S3Client {
  if (_s3) return _s3;
  _s3 = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
    forcePathStyle: true,
  });
  return _s3;
}

/** Constroi a chave (path) no bucket pra produto */
export function buildProductImageKey(productId: string, ext: string = 'jpg'): string {
  return `products/${productId}.${ext}`;
}

/**
 * Tenta baixar imagem com User-Agent comum. Retorna Response ou null.
 */
async function tryDownload(imageUrl: string): Promise<Response | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*',
      },
      redirect: 'follow',
    });
    return res;
  } catch {
    return null;
  }
}

/**
 * Baixa imagem da URL externa e salva no MinIO.
 *
 * Estrategia anti-S3-expirado:
 *  1. Tenta baixar URL atual
 *  2. Se 403/401/410: pega URL fresca do Bling via API (URLs S3 do
 *     Bling sao pre-signed e expiram), atualiza no banco, tenta de novo
 *  3. Sucesso: sobe pro MinIO
 *
 * Retorna a key salva ou null em caso de falha definitiva.
 */
export async function uploadImageFromUrl(opts: {
  productId: string;
  imageUrl: string;
  accountId?: string;
  blingId?: string | null;
}): Promise<{ key: string; bytes: number; mimetype: string } | null> {
  try {
    let res = await tryDownload(opts.imageUrl);

    // S3 do Bling expirou? Tenta pegar URL fresca via API
    if (
      (!res || res.status === 403 || res.status === 401 || res.status === 410) &&
      opts.accountId &&
      opts.blingId
    ) {
      logger.info(
        { productId: opts.productId, oldStatus: res?.status },
        '[MinIOCache] URL expired, refreshing from Bling',
      );

      const token = await getValidAccessToken(opts.accountId);
      if (token) {
        const fresh = await fetchFreshProductImageUrl({
          accessToken: token,
          blingId: opts.blingId,
        });
        if (fresh && fresh !== opts.imageUrl) {
          // Atualiza no banco pra proxima vez nao precisar refresh
          await db
            .update(produtosCatalogo)
            .set({ imagemBling: fresh, updatedAt: new Date() })
            .where(eq(produtosCatalogo.id, opts.productId));

          res = await tryDownload(fresh);
        }
      }
    }

    if (!res || !res.ok) {
      logger.warn(
        {
          productId: opts.productId,
          status: res?.status,
          url: opts.imageUrl.slice(0, 100),
        },
        '[MinIOCache] download failed (after refresh attempt)',
      );
      return null;
    }

    const mimetype = res.headers.get('content-type') ?? 'image/jpeg';
    if (!mimetype.startsWith('image/')) {
      logger.warn(
        { productId: opts.productId, mimetype },
        '[MinIOCache] upstream not an image',
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 10 * 1024 * 1024) {
      logger.warn(
        { productId: opts.productId, bytes: buffer.length },
        '[MinIOCache] image too large (>10MB)',
      );
      return null;
    }

    // Determina extensao pelo mimetype
    const ext = mimetype.split('/')[1]?.split(';')[0] ?? 'jpg';
    const key = buildProductImageKey(opts.productId, ext === 'jpeg' ? 'jpg' : ext);

    await getS3().send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { key, bytes: buffer.length, mimetype };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, productId: opts.productId },
      '[MinIOCache] upload failed',
    );
    return null;
  }
}

/**
 * Stream do objeto do MinIO. Usado pelo endpoint /media/file/:productId.
 */
export async function streamProductImage(key: string): Promise<{
  body: Readable | null;
  contentType?: string;
  contentLength?: number;
} | null> {
  try {
    const result = await getS3().send(
      new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key }),
    );
    return {
      body: result.Body as Readable | null,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
    };
  } catch (err) {
    logger.debug({ err: (err as Error).message, key }, '[MinIOCache] get failed');
    return null;
  }
}

export interface MinioCacheBatchResult {
  ok: boolean;
  processed: number;
  uploaded: number;
  failed: number;
  durationMs: number;
}

/**
 * Processa produtos com imagem_bling sem imagem_minio.
 * Salva URL final (do nosso proprio endpoint) em produtos_catalogo.imagem_minio.
 * Roda em batch (default 100) — usado pelo cron horario.
 */
export async function cachePendingProductImages(opts: {
  accountId: string;
  maxItems?: number;
}): Promise<MinioCacheBatchResult> {
  const start = Date.now();
  const max = opts.maxItems ?? 100;

  const pending = await db
    .select({
      id: produtosCatalogo.id,
      blingId: produtosCatalogo.blingId,
      imagemBling: produtosCatalogo.imagemBling,
    })
    .from(produtosCatalogo)
    .where(
      and(
        eq(produtosCatalogo.accountId, opts.accountId),
        isNotNull(produtosCatalogo.imagemBling),
        isNull(produtosCatalogo.imagemMinio),
      ),
    )
    .limit(max);

  let uploaded = 0;
  let failed = 0;

  for (const p of pending) {
    if (!p.imagemBling) continue;
    const result = await uploadImageFromUrl({
      productId: p.id,
      imageUrl: p.imagemBling,
      accountId: opts.accountId,
      blingId: p.blingId,
    });
    if (!result) {
      failed++;
      continue;
    }
    // URL publica via nosso endpoint (fce-api -> stream MinIO)
    const publicUrl = `/media/file/${p.id}`;
    await db
      .update(produtosCatalogo)
      .set({
        imagemMinio: publicUrl,
        minioUploadedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(produtosCatalogo.id, p.id));
    uploaded++;
  }

  const durationMs = Date.now() - start;
  logger.info(
    {
      accountId: opts.accountId,
      processed: pending.length,
      uploaded,
      failed,
      durationMs,
    },
    '[MinIOCache] batch complete',
  );

  return {
    ok: true,
    processed: pending.length,
    uploaded,
    failed,
    durationMs,
  };
}
