import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers, appointments, contacts } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const appt = new Hono();

const createSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  contactName: z.string().min(1).max(255).optional(),
  contactPhone: z.string().min(8).max(20).optional(),
  title: z.string().min(1).max(255),
  date: z.string().datetime(), // ISO
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(), // HH:MM
  duration: z.number().int().min(15).max(480).optional(),
  type: z.string().min(1).max(50).optional(),
  description: z.string().max(5000).optional(),
});

const updateSchema = z.object({
  accountId: z.string().uuid(),
  title: z.string().min(1).max(255).optional(),
  date: z.string().datetime().optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  duration: z.number().int().min(15).max(480).optional(),
  type: z.string().min(1).max(50).optional(),
  description: z.string().max(5000).nullable().optional(),
});

async function assertAccountMember(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found');
  if (member.status !== 'active') throw new ForbiddenError('Membership not active');
}

// ── GET /appointments ───────────────────────────────
// Lista por intervalo (default: hoje + 30 dias)
appt.get('/', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  const now = new Date();
  const from = fromStr ? new Date(fromStr) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = toStr ? new Date(toStr) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: appointments.id,
      title: appointments.title,
      date: appointments.date,
      time: appointments.time,
      duration: appointments.duration,
      type: appointments.type,
      description: appointments.description,
      contactId: appointments.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phoneNumber,
      googleEventId: appointments.googleEventId,
      meetingUrl: appointments.meetingUrl,
      createdAt: appointments.createdAt,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .where(
      and(
        eq(appointments.accountId, accountId),
        gte(appointments.date, from),
        lte(appointments.date, to),
      ),
    )
    .orderBy(asc(appointments.date));

  return c.json({ appointments: rows });
});

// ── POST /appointments ──────────────────────────────
appt.post('/', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const {
    accountId,
    contactId,
    contactName,
    contactPhone,
    title,
    date,
    time,
    duration,
    type,
    description,
  } = parsed.data;
  await assertAccountMember(user.id, accountId);

  // Resolve contact
  let resolvedContactId = contactId ?? null;
  if (!resolvedContactId && contactPhone) {
    const existing = await db.query.contacts.findFirst({
      where: and(eq(contacts.accountId, accountId), eq(contacts.phoneNumber, contactPhone)),
    });
    if (existing) {
      resolvedContactId = existing.id;
    } else {
      const [created] = await db
        .insert(contacts)
        .values({ accountId, phoneNumber: contactPhone, name: contactName ?? null })
        .returning({ id: contacts.id });
      resolvedContactId = created.id;
    }
  }

  const [created] = await db
    .insert(appointments)
    .values({
      accountId,
      contactId: resolvedContactId,
      title,
      date: new Date(date),
      time: time ?? null,
      duration: duration ?? 60,
      type: type ?? 'consultation',
      description: description ?? null,
    })
    .returning();

  logger.info({ accountId, apptId: created.id, date }, '[Appointments] created');
  return c.json({ appointment: created });
});

// ── PATCH /appointments/:id ─────────────────────────
appt.patch('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, ...updates } = parsed.data;
  await assertAccountMember(user.id, accountId);

  const existing = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.accountId, accountId)),
  });
  if (!existing) throw new NotFoundError('Appointment not found');

  const setData: Partial<typeof appointments.$inferInsert> = { updatedAt: new Date() };
  if (updates.title !== undefined) setData.title = updates.title;
  if (updates.date !== undefined) setData.date = new Date(updates.date);
  if (updates.time !== undefined) setData.time = updates.time;
  if (updates.duration !== undefined) setData.duration = updates.duration;
  if (updates.type !== undefined) setData.type = updates.type;
  if (updates.description !== undefined) setData.description = updates.description;

  const [updated] = await db.update(appointments).set(setData).where(eq(appointments.id, id)).returning();
  return c.json({ appointment: updated });
});

// ── DELETE /appointments/:id ────────────────────────
appt.delete('/:id', requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountMember(user.id, accountId);

  const result = await db
    .delete(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.accountId, accountId)))
    .returning({ id: appointments.id });
  if (result.length === 0) throw new NotFoundError('Appointment not found');
  return c.json({ ok: true });
});

export default appt;
