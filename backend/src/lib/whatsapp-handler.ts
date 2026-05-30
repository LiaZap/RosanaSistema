import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations, whatsappSessions } from '../db/schema.js';
import { saveMessage } from './dani-conversations.js';
import { upsertSessionStatus } from './evolution-client.js';
import { resetFollowupOnUserReply } from './followup-agent.js';
import { inboundQueue, type InboundJobData } from './queues.js';
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
      imageMessage?: { caption?: string; mimetype?: string };
      documentMessage?: { caption?: string; mimetype?: string };
    };
    pushName?: string;
    messageType?: string;
  };
}

function isImage(data: EvolutionMessageEvent['data']): boolean {
  return !!data?.message?.imageMessage;
}

function isPdfDocument(data: EvolutionMessageEvent['data']): boolean {
  const mt = data?.message?.documentMessage?.mimetype ?? '';
  return mt === 'application/pdf';
}

function getMediaMimetype(data: EvolutionMessageEvent['data']): string | undefined {
  return (
    data?.message?.imageMessage?.mimetype ??
    data?.message?.documentMessage?.mimetype
  );
}

function getMediaCaption(data: EvolutionMessageEvent['data']): string | undefined {
  return data?.message?.imageMessage?.caption ?? data?.message?.documentMessage?.caption;
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

  const rawText = extractText(data);
  const hasImage = isImage(data);
  const hasPdf = isPdfDocument(data);
  const hasMedia = hasImage || hasPdf;

  // Sem texto e sem media -> nada pra processar
  if (!hasMedia && (!rawText || rawText.trim().length === 0)) {
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

  // Cliente respondeu - reseta follow-up state (text bruto pra decidir substantivo)
  await resetFollowupOnUserReply(conv.id, rawText ?? '').catch((err) =>
    logger.warn({ err: (err as Error).message }, '[WhatsApp] resetFollowup failed'),
  );

  // Se humano assumiu, salva mas nao processa
  if (conv.status !== 'nina') {
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: rawText ?? (hasMedia ? '[Cliente enviou mídia]' : ''),
    });
    return { skipped: `status=${conv.status}`, contactId: contact.id, conversationId: conv.id };
  }

  // Sprint 3: se veio mídia, prepara payload pro worker fazer Vision async.
  // ISSO preserva a ordem do buffer: worker processa sequencialmente.
  // Tambem evita estourar timeout do Evolution webhook (que tem ~30s).
  let mediaPayload: InboundJobData['mediaPayload'] | undefined;
  if (hasMedia && data.key.id && data.key.remoteJid) {
    try {
      const session = await db.query.whatsappSessions.findFirst({
        where: eq(whatsappSessions.accountId, accountId),
      });
      if (session) {
        mediaPayload = {
          messageKey: {
            id: data.key.id,
            remoteJid: data.key.remoteJid,
            fromMe: data.key.fromMe ?? false,
          },
          instanceName: session.instanceName,
          mimetype: getMediaMimetype(data),
          caption: getMediaCaption(data) ?? rawText ?? undefined,
        };
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[WhatsApp] failed to attach mediaPayload');
    }
  }

  // Enfileira: worker faz Vision (se mediaPayload) + persist + buffer push.
  await inboundQueue.add(
    'persist',
    {
      accountId,
      conversationId: conv.id,
      contactId: contact.id,
      phoneNumber: phone,
      text: rawText ?? '', // worker enriquece se houver mediaPayload
      whatsappMessageId: data.key.id,
      mediaPayload,
    },
    {
      jobId: data.key.id ? `inbound:${data.key.id}` : undefined,
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
