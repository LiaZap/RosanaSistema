import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, mediaLibrary } from '../db/schema.js';
import { normalizeForSearch } from '../lib/media-library.js';
import { logger } from '../lib/logger.js';

const media = new Hono();

const createSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  fileUrl: z.string().url().max(2000),
  fileType: z.string().min(1).max(50),
  fileSize: z.number().int().min(0).optional(),
  tags: z.array(z.string().min(1).max(50)).max(15).optional(),
});

const updateSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  fileUrl: z.string().url().max(2000).optional(),
  fileType: z.string().min(1).max(50).optional(),
  tags: z.array(z.string().min(1).max(50)).max(15).optional(),
});

async function assertOwnerOrAdmin(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found');
  if (member.status !== 'active') throw new ForbiddenError('Membership not active');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Only owners/admins can manage media library');
  }
}

// ── GET /media ──────────────────────────────────────
media.get('/', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  const rows = await db
    .select()
    .from(mediaLibrary)
    .where(eq(mediaLibrary.accountId, accountId))
    .orderBy(desc(mediaLibrary.useCount), desc(mediaLibrary.createdAt));

  return c.json({ items: rows });
});

// ── POST /media ─────────────────────────────────────
media.post('/', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  await assertOwnerOrAdmin(user.id, parsed.data.accountId);

  const [created] = await db
    .insert(mediaLibrary)
    .values({
      ...parsed.data,
      nameNormalized: normalizeForSearch(parsed.data.name),
      uploadedBy: user.id,
    })
    .returning();
  logger.info({ id: created.id, name: created.name }, '[Media] created');
  return c.json({ item: created });
});

// ── PATCH /media/:id ────────────────────────────────
media.patch('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, ...updates } = parsed.data;
  await assertOwnerOrAdmin(user.id, accountId);

  const existing = await db.query.mediaLibrary.findFirst({
    where: and(eq(mediaLibrary.id, id), eq(mediaLibrary.accountId, accountId)),
  });
  if (!existing) throw new NotFoundError('Media not found');

  const setData: Record<string, unknown> = { ...updates };
  if (updates.name) {
    setData.nameNormalized = normalizeForSearch(updates.name);
  }

  const [updated] = await db
    .update(mediaLibrary)
    .set(setData)
    .where(eq(mediaLibrary.id, id))
    .returning();
  return c.json({ item: updated });
});

// ── DELETE /media/:id ───────────────────────────────
media.delete('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertOwnerOrAdmin(user.id, accountId);

  await db
    .delete(mediaLibrary)
    .where(and(eq(mediaLibrary.id, id), eq(mediaLibrary.accountId, accountId)));
  return c.json({ ok: true });
});

export default media;
