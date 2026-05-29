import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  AppError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import {
  accountMembers,
  cloudinaryCredentials,
  produtosCatalogo,
} from '../db/schema.js';
import {
  pingCloudinary,
  uploadPendingImages,
} from '../lib/cloudinary-client.js';
import { logger } from '../lib/logger.js';

const cloud = new Hono();

const credentialsSchema = z.object({
  accountId: z.string().uuid(),
  cloudName: z.string().min(2).max(255),
  apiKey: z.string().min(8).max(255),
  apiSecret: z.string().min(8).max(500),
  uploadTag: z.string().min(1).max(100).optional(),
});

const uploadSchema = z.object({
  accountId: z.string().uuid(),
  maxItems: z.number().int().min(1).max(2000).optional(),
});

async function assertOwnerOrAdmin(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found or you are not a member');
  if (member.status !== 'active') throw new ForbiddenError('Membership is not active');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Only owners/admins can manage Cloudinary');
  }
}

// ── GET /cloudinary/credentials ──────────────────────
cloud.get('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  const cred = await db.query.cloudinaryCredentials.findFirst({
    where: eq(cloudinaryCredentials.accountId, accountId),
  });

  // Contadores de produtos com/sem imagem
  const [counts] = await db
    .select({
      withImage: sql<number>`cast(count(*) filter (where ${produtosCatalogo.imagemBling} is not null) as int)`,
      uploaded: sql<number>`cast(count(*) filter (where ${produtosCatalogo.imagemCloudinary} is not null) as int)`,
    })
    .from(produtosCatalogo)
    .where(eq(produtosCatalogo.accountId, accountId));

  return c.json({
    configured: !!cred?.cloudName,
    cloudName: cred?.cloudName ?? null,
    uploadTag: cred?.uploadTag ?? null,
    lastSyncAt: cred?.lastSyncAt ?? null,
    productCount: {
      withImage: counts?.withImage ?? 0,
      uploaded: counts?.uploaded ?? 0,
      pending: (counts?.withImage ?? 0) - (counts?.uploaded ?? 0),
    },
  });
});

// ── PUT /cloudinary/credentials ──────────────────────
// Valida com ping antes de salvar
cloud.put('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, cloudName, apiKey, apiSecret, uploadTag } = parsed.data;
  await assertOwnerOrAdmin(user.id, accountId);

  // Ping pra validar
  const isValid = await pingCloudinary({
    cloudName,
    apiKey,
    apiSecret,
    uploadTag: uploadTag ?? 'fce_catalogo',
  }).catch(() => false);

  if (!isValid) {
    throw new AppError('Cloudinary credentials invalid (ping failed)', 400);
  }

  const existing = await db.query.cloudinaryCredentials.findFirst({
    where: eq(cloudinaryCredentials.accountId, accountId),
  });

  if (existing) {
    await db
      .update(cloudinaryCredentials)
      .set({
        cloudName,
        apiKey,
        apiSecret,
        uploadTag: uploadTag ?? existing.uploadTag ?? 'fce_catalogo',
        updatedAt: new Date(),
      })
      .where(eq(cloudinaryCredentials.accountId, accountId));
  } else {
    await db.insert(cloudinaryCredentials).values({
      accountId,
      cloudName,
      apiKey,
      apiSecret,
      uploadTag: uploadTag ?? 'fce_catalogo',
    });
  }

  return c.json({ ok: true });
});

// ── POST /cloudinary/upload-pending ──────────────────
// Faz upload em batch dos produtos sem imagem_cloudinary
cloud.post('/upload-pending', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, maxItems } = parsed.data;
  await assertOwnerOrAdmin(user.id, accountId);

  logger.info({ accountId, maxItems }, '[Cloudinary] upload-pending requested');
  const result = await uploadPendingImages({ accountId, maxItems });
  return c.json(result);
});

// ── DELETE /cloudinary/credentials ───────────────────
cloud.delete('/credentials', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  await db.delete(cloudinaryCredentials).where(eq(cloudinaryCredentials.accountId, accountId));
  return c.json({ ok: true });
});

export default cloud;
