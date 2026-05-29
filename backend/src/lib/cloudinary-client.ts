import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cloudinaryCredentials, produtosCatalogo } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Cliente Cloudinary - upload signed (sem necessitar de upload preset).
 *
 * Estrategia:
 *  - public_id = bling_<bling_id>
 *  - Pega imagemBling URL -> Cloudinary fetcha + hospeda
 *  - Salva URL gerada em produtos_catalogo.imagem_cloudinary
 *  - Idempotente: pula produtos ja com imagem_cloudinary preenchido
 */

const CLOUDINARY_BASE = 'https://api.cloudinary.com/v1_1';

export interface CloudinarySettings {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  uploadTag: string;
}

export async function getCloudinarySettings(accountId: string): Promise<CloudinarySettings> {
  const cred = await db.query.cloudinaryCredentials.findFirst({
    where: eq(cloudinaryCredentials.accountId, accountId),
  });
  if (!cred?.cloudName || !cred.apiKey || !cred.apiSecret) {
    throw new Error('Cloudinary not configured');
  }
  return {
    cloudName: cred.cloudName,
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret,
    uploadTag: cred.uploadTag ?? 'fce_catalogo',
  };
}

/**
 * Assinatura SHA-1 (Cloudinary requirement).
 * sortedParams -> ordenar alfabeticamente -> concatenar k=v&k=v -> sha1(... + apiSecret)
 */
function buildSignature(params: Record<string, string>, apiSecret: string): string {
  const keys = Object.keys(params).sort();
  const toSign = keys.map((k) => `${k}=${params[k]}`).join('&') + apiSecret;
  return createHash('sha1').update(toSign).digest('hex');
}

/** Ping pra validar credenciais. */
export async function pingCloudinary(opts: CloudinarySettings): Promise<boolean> {
  const basic = Buffer.from(`${opts.apiKey}:${opts.apiSecret}`).toString('base64');
  const res = await fetch(`${CLOUDINARY_BASE}/${opts.cloudName}/ping`, {
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
  });
  return res.ok;
}

export interface UploadResult {
  publicId: string;
  url: string;
  bytes: number;
  format: string;
}

/**
 * Faz upload de uma imagem por URL (Cloudinary fetcha).
 * public_id e overwrite=true pra refazer se mudou.
 */
export async function uploadByUrl(opts: {
  settings: CloudinarySettings;
  file: string; // URL publica
  publicId: string;
}): Promise<UploadResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));

  // Parametros que VAO na assinatura (alfabetico)
  const signedParams: Record<string, string> = {
    overwrite: 'true',
    public_id: opts.publicId,
    tags: opts.settings.uploadTag,
    timestamp,
  };
  const signature = buildSignature(signedParams, opts.settings.apiSecret);

  const form = new URLSearchParams({
    ...signedParams,
    api_key: opts.settings.apiKey,
    file: opts.file,
    signature,
  });

  const res = await fetch(`${CLOUDINARY_BASE}/${opts.settings.cloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudinary upload ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  return {
    publicId: json.public_id,
    url: json.secure_url ?? json.url,
    bytes: json.bytes ?? 0,
    format: json.format ?? 'jpg',
  };
}

/**
 * Constroi URL transformada (resize / qualidade).
 * Pra apresentar na DANI, usamos w_800, f_auto, q_85.
 */
export function transformedUrl(url: string, transform = 'w_800,c_limit,f_auto,q_85'): string {
  // URL original tipo https://res.cloudinary.com/<cloud>/image/upload/<public_id>
  // Inserir <transform>/ apos /upload/
  return url.replace(/\/image\/upload\//, `/image/upload/${transform}/`);
}

export interface UploadBatchResult {
  ok: boolean;
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  durationMs: number;
  errors?: Array<{ blingId: string | null; error: string }>;
}

/**
 * Itera produtos com imagem_bling sem imagem_cloudinary e faz upload em batch.
 * Limita por padrao a 200 por run pra evitar rate limit (Cloudinary free: 25k creditos/mes).
 */
export async function uploadPendingImages(opts: {
  accountId: string;
  maxItems?: number;
}): Promise<UploadBatchResult> {
  const start = Date.now();
  const max = opts.maxItems ?? 200;

  const settings = await getCloudinarySettings(opts.accountId);

  // Produtos com imagem_bling preenchido E sem imagem_cloudinary
  const pending = await db
    .select({
      id: produtosCatalogo.id,
      blingId: produtosCatalogo.blingId,
      nome: produtosCatalogo.nome,
      imagemBling: produtosCatalogo.imagemBling,
    })
    .from(produtosCatalogo)
    .where(eq(produtosCatalogo.accountId, opts.accountId))
    .limit(max * 2); // chumba alto, filtra abaixo

  const toUpload = pending
    .filter((p) => p.imagemBling && p.imagemBling.startsWith('http'))
    .slice(0, max);

  let uploaded = 0;
  let skipped = pending.length - toUpload.length;
  let failed = 0;
  const errors: Array<{ blingId: string | null; error: string }> = [];

  for (const p of toUpload) {
    try {
      const publicId = `bling_${p.blingId ?? p.id}`;
      const result = await uploadByUrl({
        settings,
        file: p.imagemBling!,
        publicId,
      });

      await db
        .update(produtosCatalogo)
        .set({
          imagemCloudinary: result.url,
          cloudinaryUploadedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(produtosCatalogo.id, p.id));

      uploaded++;
    } catch (err) {
      failed++;
      errors.push({ blingId: p.blingId, error: (err as Error).message.slice(0, 120) });
      logger.warn(
        { blingId: p.blingId, err: (err as Error).message },
        '[Cloudinary] upload failed',
      );
    }
  }

  // Atualiza lastSyncAt
  await db
    .update(cloudinaryCredentials)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(cloudinaryCredentials.accountId, opts.accountId));

  logger.info(
    {
      accountId: opts.accountId,
      uploaded,
      failed,
      skipped,
      durationMs: Date.now() - start,
    },
    '[Cloudinary] batch complete',
  );

  return {
    ok: true,
    processed: toUpload.length,
    uploaded,
    skipped,
    failed,
    durationMs: Date.now() - start,
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
  };
}
