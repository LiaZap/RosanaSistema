import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { whatsappAccountSettings, whatsappSessions } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Cliente Evolution API (WhatsApp self-hosted).
 * Docs: https://doc.evolution-api.com
 *
 * Endpoints usados:
 *  - POST /instance/create
 *  - GET  /instance/connect/{instance}      -> QR code
 *  - GET  /instance/connectionState/{instance}
 *  - POST /message/sendText/{instance}      -> envia mensagem
 *  - DELETE /instance/logout/{instance}
 *  - POST /webhook/set/{instance}           -> configura webhook
 */

export interface EvolutionSettings {
  apiUrl: string;
  apiKey: string;
  verifyToken: string | null;
}

/** Carrega settings da Evolution pra uma account. Lanca erro se nao configurado. */
export async function getEvolutionSettings(accountId: string): Promise<EvolutionSettings> {
  const settings = await db.query.whatsappAccountSettings.findFirst({
    where: eq(whatsappAccountSettings.accountId, accountId),
  });
  if (!settings?.apiUrl || !settings?.apiKey) {
    throw new Error('Evolution API not configured for this account');
  }
  return {
    apiUrl: settings.apiUrl.replace(/\/$/, ''),
    apiKey: settings.apiKey,
    verifyToken: settings.verifyToken,
  };
}

/** Headers padroes da Evolution */
function headers(apiKey: string) {
  return {
    apikey: apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export interface EvolutionConnectionState {
  state: 'open' | 'connecting' | 'close' | string;
  instance?: string;
}

/** Cria uma instancia (se nao existir). Idempotente: retorna OK se ja existe */
export async function createInstance(opts: {
  settings: EvolutionSettings;
  instanceName: string;
  webhookUrl?: string;
}): Promise<{ created: boolean; existing: boolean }> {
  const body = {
    instanceName: opts.instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
    ...(opts.webhookUrl
      ? {
          webhook: opts.webhookUrl,
          webhook_by_events: false,
          events: ['messages.upsert', 'messages.update', 'connection.update'],
        }
      : {}),
  };

  const res = await fetch(`${opts.settings.apiUrl}/instance/create`, {
    method: 'POST',
    headers: headers(opts.settings.apiKey),
    body: JSON.stringify(body),
  });

  // 403 / "already exists" e considerado sucesso
  if (res.ok) return { created: true, existing: false };
  const text = await res.text();
  if (text.toLowerCase().includes('already in use') || res.status === 403 || res.status === 409) {
    return { created: false, existing: true };
  }
  throw new Error(`Evolution createInstance ${res.status}: ${text.slice(0, 200)}`);
}

/** Pega QR code (ou estado de connection) */
export async function connectInstance(opts: {
  settings: EvolutionSettings;
  instanceName: string;
}): Promise<{ qrCode?: string; pairingCode?: string; state?: string }> {
  const res = await fetch(`${opts.settings.apiUrl}/instance/connect/${opts.instanceName}`, {
    method: 'GET',
    headers: headers(opts.settings.apiKey),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Evolution connect ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  return {
    qrCode: json.base64 ?? json.qrcode?.base64,
    pairingCode: json.pairingCode,
    state: json.state ?? json.instance?.state,
  };
}

/** Pega estado de conexao da instancia */
export async function getConnectionState(opts: {
  settings: EvolutionSettings;
  instanceName: string;
}): Promise<EvolutionConnectionState> {
  const res = await fetch(
    `${opts.settings.apiUrl}/instance/connectionState/${opts.instanceName}`,
    {
      method: 'GET',
      headers: headers(opts.settings.apiKey),
    },
  );
  if (!res.ok) {
    return { state: 'close' };
  }
  const json = (await res.json()) as { instance?: { state?: string }; state?: string };
  return {
    state: (json.instance?.state ?? json.state ?? 'close') as EvolutionConnectionState['state'],
    instance: opts.instanceName,
  };
}

/**
 * Envia uma mensagem de texto via Evolution API.
 * phoneNumber deve estar SEM @s.whatsapp.net - format internacional (5531...)
 */
export async function sendTextMessage(opts: {
  settings: EvolutionSettings;
  instanceName: string;
  phoneNumber: string; // 5531999999999
  text: string;
}): Promise<{ messageId: string | null }> {
  const number = opts.phoneNumber.replace(/[^0-9]/g, '');

  const res = await fetch(`${opts.settings.apiUrl}/message/sendText/${opts.instanceName}`, {
    method: 'POST',
    headers: headers(opts.settings.apiKey),
    body: JSON.stringify({
      number,
      text: opts.text,
      delay: 100,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Evolution sendText ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  const messageId = json?.key?.id ?? null;
  logger.info(
    { instance: opts.instanceName, to: number, messageId },
    '[Evolution] message sent',
  );
  return { messageId };
}

/** Configura webhook na instancia (idempotente) */
export async function setWebhook(opts: {
  settings: EvolutionSettings;
  instanceName: string;
  webhookUrl: string;
}): Promise<void> {
  const res = await fetch(`${opts.settings.apiUrl}/webhook/set/${opts.instanceName}`, {
    method: 'POST',
    headers: headers(opts.settings.apiKey),
    body: JSON.stringify({
      url: opts.webhookUrl,
      webhook_by_events: false,
      events: ['messages.upsert', 'messages.update', 'connection.update'],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Evolution setWebhook ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Logout (desconecta sem deletar) */
export async function logoutInstance(opts: {
  settings: EvolutionSettings;
  instanceName: string;
}): Promise<void> {
  await fetch(`${opts.settings.apiUrl}/instance/logout/${opts.instanceName}`, {
    method: 'DELETE',
    headers: headers(opts.settings.apiKey),
  });
}

/** Atualiza linha em whatsapp_sessions com status + qr */
export async function upsertSessionStatus(opts: {
  accountId: string;
  instanceName: string;
  status: 'connected' | 'disconnected' | 'connecting';
  qrCode?: string | null;
  phoneNumber?: string | null;
}): Promise<void> {
  const existing = await db
    .select({ id: whatsappSessions.id })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.accountId, opts.accountId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(whatsappSessions)
      .set({
        instanceName: opts.instanceName,
        status: opts.status,
        qrCode: opts.qrCode ?? null,
        phoneNumber: opts.phoneNumber ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(whatsappSessions.id, existing[0].id));
  } else {
    await db.insert(whatsappSessions).values({
      accountId: opts.accountId,
      instanceName: opts.instanceName,
      provider: 'evolution',
      status: opts.status,
      qrCode: opts.qrCode ?? null,
      phoneNumber: opts.phoneNumber ?? undefined,
    });
  }
}
