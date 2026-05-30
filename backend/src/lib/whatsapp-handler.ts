import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations } from '../db/schema.js';
import { saveMessage } from './dani-conversations.js';
import { upsertSessionStatus } from './evolution-client.js';
import { inboundQueue } from './queues.js';
import { logger } from './logger.js';

/**
 * Pipeline de mensagem recebida via Evolution webhook:
 *  1. Identifica/cria contact por phoneNumber
 *  2. Pega/cria conversation ativa (status='nina')
 *  3. Salva mensagem do user
 *  4. Carrega historico (ate 30)
 *  5. Chama DANI orchestrator
 *  6. Salva resposta da DANI
 *  7. Envia resposta via Evolution
 *
 * Se conversa estiver 'human' ou 'paused', NAO responde (humano assumiu).
 */

export interface EvolutionMessageEvent {
  event?: string;
  instance?: string;
  data?: {
    key?: {
      remoteJid?: string; // ex: 5531999999999@s.whatsapp.net
      fromMe?: boolean;
      id?: string;
    };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string };
    };
    pushName?: string;
    messageType?: string;
  };
}

export interface ConnectionUpdateEvent {
  event?: string;
  instance?: string;
  data?: {
    state?: string;
  };
}

/** Extrai phoneNumber sem sufixo de um JID */
function jidToPhone(jid: string): string {
  return jid.replace(/@.*/, '').replace(/[^0-9]/g, '');
}

/** Extrai texto de uma mensagem Evolution (suporta varios tipos) */
function extractText(msg: EvolutionMessageEvent['data']): string | null {
  if (!msg?.message) return null;
  return (
    msg.message.conversation ??
    msg.message.extendedTextMessage?.text ??
    msg.message.imageMessage?.caption ??
    null
  );
}

/**
 * Processa um evento 'messages.upsert' do webhook Evolution.
 * Retorna info do que foi feito (pra logs).
 */
export async function handleMessageUpsert(
  accountId: string,
  payload: EvolutionMessageEvent,
): Promise<{
  skipped?: string;
  contactId?: string;
  conversationId?: string;
  daniReplied?: boolean;
}> {
  const data = payload.data;
  if (!data?.key?.remoteJid) {
    return { skipped: 'no remoteJid' };
  }

  // Mensagem enviada por nos mesmos? Ignora pra nao loop.
  if (data.key.fromMe) {
    return { skipped: 'fromMe' };
  }

  // Grupos sao ignorados em Phase 4 (foco: 1:1)
  if (data.key.remoteJid.endsWith('@g.us')) {
    return { skipped: 'group' };
  }

  const text = extractText(data);
  if (!text || text.trim().length === 0) {
    return { skipped: 'no text content' };
  }

  const phone = jidToPhone(data.key.remoteJid);
  const pushName = data.pushName;

  // 1. Identifica/cria contato
  let contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.accountId, accountId), eq(contacts.phoneNumber, phone)),
    columns: { id: true },
  });
  if (!contact) {
    const [created] = await db
      .insert(contacts)
      .values({
        accountId,
        phoneNumber: phone,
        name: pushName ?? null,
      })
      .returning({ id: contacts.id });
    contact = created;
    logger.info({ accountId, phone }, '[WhatsApp] new contact');
  }

  // 2. Pega conversation ativa
  let conv = await db
    .select({ id: conversations.id, status: conversations.status })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contact.id),
      ),
    )
    .orderBy(conversations.createdAt)
    .limit(1)
    .then((rows) => rows[0]);

  if (!conv) {
    const [created] = await db
      .insert(conversations)
      .values({
        accountId,
        contactId: contact.id,
        status: 'nina',
      })
      .returning({ id: conversations.id, status: conversations.status });
    conv = created;
  }

  // Se humano assumiu, salva mas nao processa
  if (conv.status !== 'nina') {
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: text,
    });
    return { skipped: `status=${conv.status}`, contactId: contact.id, conversationId: conv.id };
  }

  // Sprint 1: enfileira em vez de processar inline.
  // Worker INBOUND persiste msg + buffer push + schedule ai-reply.
  await inboundQueue.add(
    'persist',
    {
      accountId,
      conversationId: conv.id,
      contactId: contact.id,
      phoneNumber: phone,
      text,
      whatsappMessageId: data.key.id,
    },
    {
      jobId: data.key.id ? `inbound:${data.key.id}` : undefined, // idempotente
      removeOnComplete: { age: 3600 },
    },
  );

  logger.info(
    { accountId, conversationId: conv.id, phone, msgId: data.key.id },
    '[WhatsApp] enqueued inbound',
  );

  return {
    contactId: contact.id,
    conversationId: conv.id,
    daniReplied: false, // ai-reply roda async, retorno aqui eh imediato
  };
}

/** Processa connection.update do webhook (atualiza session status) */
export async function handleConnectionUpdate(
  accountId: string,
  instanceName: string,
  payload: ConnectionUpdateEvent,
): Promise<void> {
  const state = payload.data?.state ?? 'close';
  const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
  await upsertSessionStatus({ accountId, instanceName, status });
  logger.info({ accountId, instanceName, state }, '[WhatsApp] connection update');
}
