import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, getUser } from '../middleware/auth.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  AppError,
} from '../lib/errors.js';
import { db } from '../db/client.js';
import {
  accountMembers,
  whatsappAccountSettings,
  whatsappSessions,
} from '../db/schema.js';
import {
  connectInstance,
  createInstance,
  fetchInstances,
  getConnectionState,
  getEvolutionSettings,
  logoutInstance,
  sendTextMessage,
  setWebhook,
  upsertSessionStatus,
} from '../lib/evolution-client.js';
import {
  handleConnectionUpdate,
  handleMessageUpsert,
  type ConnectionUpdateEvent,
  type EvolutionMessageEvent,
} from '../lib/whatsapp-handler.js';
import { logger } from '../lib/logger.js';

const whatsapp = new Hono();

// WhatsApp: config/instancias sao admin-only.
// Excecao: POST /webhook/:accountId — webhook publico do Evolution
// (validado por verifyToken no body, nao usa session cookie).
whatsapp.use('*', async (c, next) => {
  if (c.req.path.startsWith('/whatsapp/webhook/')) {
    await next();
    return;
  }
  await requireAuth(c, async () => {
    await requireAdmin(c, next);
  });
});

const settingsSchema = z.object({
  accountId: z.string().uuid(),
  apiUrl: z.string().url(),
  apiKey: z.string().min(8).max(500),
});

const sessionSchema = z.object({
  accountId: z.string().uuid(),
  instanceName: z.string().min(2).max(80).optional(),
});

const sendSchema = z.object({
  accountId: z.string().uuid(),
  phoneNumber: z.string().min(10).max(20),
  text: z.string().min(1).max(4000),
});

const API_BASE_URL = process.env.API_URL || '';

async function assertAccountOwnerOrAdmin(userId: string, accountId: string): Promise<void> {
  const [member] = await db
    .select({ role: accountMembers.role, status: accountMembers.status })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);

  if (!member) throw new NotFoundError('Account not found or you are not a member');
  if (member.status !== 'active') throw new ForbiddenError('Membership is not active');
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ForbiddenError('Only owners/admins can manage WhatsApp integration');
  }
}

/** Constroi instanceName padrao por account: fce-<accountId> */
function defaultInstanceName(accountId: string): string {
  return `fce-${accountId.slice(0, 8)}`;
}

/** Constroi webhook URL pro Evolution chamar de volta */
function buildWebhookUrl(accountId: string, verifyToken: string): string {
  return `${API_BASE_URL}/whatsapp/webhook/${accountId}?token=${verifyToken}`;
}

// ── GET /whatsapp/settings ───────────────────────────
whatsapp.get('/settings', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const settings = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });

  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });

  return c.json({
    configured: !!settings?.apiUrl && !!settings?.apiKey,
    apiUrl: settings?.apiUrl ?? null,
    verifyToken: settings?.verifyToken ?? null,
    webhookUrl: settings?.verifyToken
      ? buildWebhookUrl(accountId, settings.verifyToken)
      : null,
    session: session
      ? {
          instanceName: session.instanceName,
          status: session.status,
          phoneNumber: session.phoneNumber,
          qrCode: session.qrCode,
        }
      : null,
  });
});

// ── PUT /whatsapp/settings ───────────────────────────
whatsapp.put('/settings', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, apiUrl, apiKey } = parsed.data;
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const verifyToken = `fce-${randomBytes(12).toString('hex')}`;

  const existing = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });

  if (existing) {
    await db
      .update(whatsappAccountSettings)
      .set({
        apiUrl: apiUrl.replace(/\/$/, ''),
        apiKey,
        verifyToken: existing.verifyToken ?? verifyToken,
        updatedAt: new Date(),
      })
      .where(eq(whatsappAccountSettings.accountId, accountId));
  } else {
    await db.insert(whatsappAccountSettings).values({
      accountId,
      apiUrl: apiUrl.replace(/\/$/, ''),
      apiKey,
      verifyToken,
    });
  }

  return c.json({ ok: true });
});

// ── GET /whatsapp/instances ──────────────────────────
// Lista TODAS as instancias ja criadas no Evolution
whatsapp.get('/instances', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const settings = await getEvolutionSettings(accountId);
  try {
    const instances = await fetchInstances({ settings });
    return c.json({ instances });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[WhatsApp] fetchInstances failed');
    throw new AppError((err as Error).message, 502);
  }
});

// ── POST /whatsapp/instance/select ───────────────────
// Seleciona uma instancia EXISTENTE (nao cria). Vincula ao account
// e configura webhook na instancia escolhida.
whatsapp.post('/instance/select', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const schema = z.object({
    accountId: z.string().uuid(),
    instanceName: z.string().min(2).max(80),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, instanceName } = parsed.data;
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const settings = await getEvolutionSettings(accountId);
  const settingsRow = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });

  // Configura webhook na instancia escolhida pra FCE receber msgs
  const webhookUrl = settingsRow?.verifyToken
    ? buildWebhookUrl(accountId, settingsRow.verifyToken)
    : undefined;
  if (webhookUrl) {
    try {
      await setWebhook({ settings, instanceName, webhookUrl });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[WhatsApp] setWebhook on select failed');
    }
  }

  // Pega o estado atual da instancia
  let state: string = 'unknown';
  try {
    const conn = await getConnectionState({ settings, instanceName });
    state = conn.state;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[WhatsApp] getConnectionState on select failed');
  }

  await upsertSessionStatus({
    accountId,
    instanceName,
    status: state === 'open' ? 'connected' : 'connecting',
  });

  return c.json({ ok: true, instanceName, state, webhookUrl });
});

// ── POST /whatsapp/instance ──────────────────────────
// Cria instancia no Evolution + configura webhook
whatsapp.post('/instance', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = sessionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId } = parsed.data;
  const instanceName = parsed.data.instanceName ?? defaultInstanceName(accountId);
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const settings = await getEvolutionSettings(accountId);
  const settingsRow = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });

  const webhookUrl = settingsRow?.verifyToken
    ? buildWebhookUrl(accountId, settingsRow.verifyToken)
    : undefined;

  const result = await createInstance({ settings, instanceName, webhookUrl });

  // Tenta configurar webhook explicitamente (caso instancia ja existisse)
  if (webhookUrl && result.existing) {
    try {
      await setWebhook({ settings, instanceName, webhookUrl });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[WhatsApp] setWebhook on existing failed');
    }
  }

  await upsertSessionStatus({
    accountId,
    instanceName,
    status: 'connecting',
  });

  return c.json({
    ok: true,
    instanceName,
    created: result.created,
    existing: result.existing,
    webhookUrl,
  });
});

// ── GET /whatsapp/qr ────────────────────────────────
// Pega QR code (ou pairing code) pra conectar
whatsapp.get('/qr', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) throw new NotFoundError('No instance created yet');

  const settings = await getEvolutionSettings(accountId);
  const { qrCode, pairingCode, state } = await connectInstance({
    settings,
    instanceName: session.instanceName,
  });

  if (qrCode) {
    await upsertSessionStatus({
      accountId,
      instanceName: session.instanceName,
      status: 'connecting',
      qrCode,
    });
  }

  return c.json({ qrCode: qrCode ?? null, pairingCode: pairingCode ?? null, state });
});

// ── GET /whatsapp/status ────────────────────────────
// Atualiza status conferindo no Evolution + retorna
whatsapp.get('/status', requireAuth, async (c) => {
  const user = getUser(c);
  const accountId = c.req.query('accountId');
  if (!accountId) throw new ValidationError('accountId required');
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) return c.json({ status: 'no-instance' });

  try {
    const settings = await getEvolutionSettings(accountId);
    const conn = await getConnectionState({ settings, instanceName: session.instanceName });
    const status =
      conn.state === 'open' ? 'connected' : conn.state === 'connecting' ? 'connecting' : 'disconnected';
    await upsertSessionStatus({
      accountId,
      instanceName: session.instanceName,
      status,
      qrCode: status === 'connected' ? null : session.qrCode,
    });
    return c.json({ status, state: conn.state, instanceName: session.instanceName });
  } catch (err) {
    return c.json({ status: 'error', error: (err as Error).message });
  }
});

// ── POST /whatsapp/logout ───────────────────────────
whatsapp.post('/logout', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const accountId = z.string().uuid().parse(body.accountId);
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) throw new NotFoundError('No instance');

  const settings = await getEvolutionSettings(accountId);
  await logoutInstance({ settings, instanceName: session.instanceName });
  await upsertSessionStatus({
    accountId,
    instanceName: session.instanceName,
    status: 'disconnected',
    qrCode: null,
  });
  return c.json({ ok: true });
});

// ── POST /whatsapp/send ─────────────────────────────
// Pra teste manual - manda mensagem direto
whatsapp.post('/send', requireAuth, async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join(', '));
  }
  const { accountId, phoneNumber, text } = parsed.data;
  await assertAccountOwnerOrAdmin(user.id, accountId);

  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) throw new NotFoundError('No instance');
  if (session.status !== 'connected') {
    throw new AppError('Instance not connected', 400);
  }

  const settings = await getEvolutionSettings(accountId);
  const result = await sendTextMessage({
    settings,
    instanceName: session.instanceName,
    phoneNumber,
    text,
  });
  return c.json(result);
});

// ── POST /whatsapp/webhook/:accountId ───────────────
// Evolution chama aqui quando chegam mensagens (nao precisa de auth - usa verifyToken)
whatsapp.post('/webhook/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  const token = c.req.query('token');

  const settings = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });
  if (!settings) {
    return c.json({ error: 'unknown account' }, 404);
  }
  if (!settings.verifyToken || settings.verifyToken !== token) {
    logger.warn({ accountId, gotToken: token }, '[WhatsApp] webhook unauthorized');
    return c.json({ error: 'invalid token' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const event = body.event ?? '';

  logger.info({ accountId, event }, '[WhatsApp] webhook received');

  // Processa async - retorna 200 pra Evolution nao retransmitir
  if (event === 'messages.upsert') {
    handleMessageUpsert(accountId, body as EvolutionMessageEvent).catch((err) =>
      logger.error({ err: err.message }, '[WhatsApp] handleMessageUpsert failed'),
    );
  } else if (event === 'connection.update') {
    const instance = body.instance ?? '';
    handleConnectionUpdate(accountId, instance, body as ConnectionUpdateEvent).catch((err) =>
      logger.error({ err: err.message }, '[WhatsApp] handleConnectionUpdate failed'),
    );
  }

  return c.json({ ok: true });
});

export default whatsapp;
