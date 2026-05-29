import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireAuth, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import { accountMembers } from '../db/schema.js';
import { runJobManually } from '../lib/cron-scheduler.js';
import { logger } from '../lib/logger.js';

const cronRoutes = new Hono();

const triggerSchema = z.object({
  accountId: z.string().uuid(),
  job: z.enum(['bling', 'cloudinary']),
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
    throw new ForbiddenError('Only owners/admins can trigger cron jobs');
  }
}

// ── GET /cron/schedule ──────────────────────────────
// Mostra o agendamento atual (pra UI)
cronRoutes.get('/schedule', requireAuth, async (c) => {
  return c.json({
    timezone: 'America/Sao_Paulo',
    jobs: [
      {
        id: 'bling-sync',
        name: 'Bling sync',
        description: 'Atualiza catalogo de produtos do Bling',
        cron: '0 */5 * * *',
        humanReadable: 'A cada 5 horas',
        enabled: process.env.DISABLE_CRON !== 'true',
      },
      {
        id: 'cloudinary-upload',
        name: 'Cloudinary upload',
        description: 'Sobe imagens pendentes pro Cloudinary (lote de 50)',
        cron: '0 * * * *',
        humanReadable: 'A cada 1 hora',
        enabled: process.env.DISABLE_CRON !== 'true',
      },
    ],
  });
});

// ── POST /cron/run ──────────────────────────────────
// Dispara manualmente (sem esperar o cron)
cronRoutes.post('/run', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = triggerSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, job } = parsed.data;
  await assertOwnerOrAdmin(user.id, accountId);

  logger.info({ accountId, job, triggeredBy: user.id }, '[Cron] manual trigger');
  const result = await runJobManually(job, accountId);
  return c.json({ ok: true, job, result });
});

export default cronRoutes;
