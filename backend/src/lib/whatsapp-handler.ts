import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations, whatsappSessions } from '../db/schema.js';
import { loadHistory, saveMessage } from './dani-conversations.js';
import { processDaniMessage } from './dani-orchestrator.js';
import {
  getEvolutionSettings,
  sendMediaMessage,
  sendTextMessage,
  upsertSessionStatus,
} from './evolution-client.js';
import { transformedUrl } from './cloudinary-client.js';
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

  // 3. Salva mensagem do user
  await saveMessage({
    conversationId: conv.id,
    accountId,
    fromType: 'user',
    content: text,
  });

  // Se humano assumiu, nao responde
  if (conv.status !== 'nina') {
    return { skipped: `status=${conv.status}`, contactId: contact.id, conversationId: conv.id };
  }

  // 4. Carrega historico (depois da mensagem nova ja salva)
  // NOTA: salvamos antes pra historia ficar completa em caso de falha do AI
  const history = await loadHistory(conv.id, 30);
  // Remove a ultima mensagem do user (ja vamos enviar via processDaniMessage)
  if (history[history.length - 1]?.role === 'user' && history[history.length - 1]?.text === text) {
    history.pop();
  }

  // 5. Chama DANI
  let daniResult;
  try {
    daniResult = await processDaniMessage(text, { accountId, history });
  } catch (err) {
    logger.error({ accountId, err: (err as Error).message }, '[WhatsApp] DANI failed');
    return {
      skipped: `dani-error: ${(err as Error).message}`,
      contactId: contact.id,
      conversationId: conv.id,
    };
  }

  // 6. Salva resposta da DANI
  await saveMessage({
    conversationId: conv.id,
    accountId,
    fromType: 'nina',
    content: daniResult.reply,
    processedByNina: true,
  });

  // 7. Envia via Evolution (primeiro foto se houver, depois texto)
  try {
    const settings = await getEvolutionSettings(accountId);
    const session = await db.query.whatsappSessions.findFirst({
      where: eq(whatsappSessions.accountId, accountId),
    });
    if (!session) {
      logger.warn({ accountId }, '[WhatsApp] sem session - nao envia reply');
      return {
        contactId: contact.id,
        conversationId: conv.id,
        daniReplied: false,
        skipped: 'no whatsapp session',
      };
    }

    // Phase 5: se ha attachment imagem do Cloudinary, manda foto com caption
    const firstImage = daniResult.attachments.find((a) => a.type === 'image');
    if (firstImage && firstImage.url.includes('res.cloudinary.com')) {
      // Foto com texto da DANI como caption (1 mensagem)
      await sendMediaMessage({
        settings,
        instanceName: session.instanceName,
        phoneNumber: phone,
        mediaUrl: transformedUrl(firstImage.url),
        caption: daniResult.reply,
        mediaType: 'image',
      });
    } else {
      await sendTextMessage({
        settings,
        instanceName: session.instanceName,
        phoneNumber: phone,
        text: daniResult.reply,
      });
    }
  } catch (err) {
    logger.error({ accountId, err: (err as Error).message }, '[WhatsApp] send failed');
  }

  return {
    contactId: contact.id,
    conversationId: conv.id,
    daniReplied: true,
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
