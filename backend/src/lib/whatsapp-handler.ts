import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations, ninaSettings, whatsappSessions } from '../db/schema.js';
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
      audioMessage?: { mimetype?: string; seconds?: number; ptt?: boolean };
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

function isAudio(data: EvolutionMessageEvent['data']): boolean {
  return !!data?.message?.audioMessage;
}

function getMediaMimetype(data: EvolutionMessageEvent['data']): string | undefined {
  return (
    data?.message?.imageMessage?.mimetype ??
    data?.message?.documentMessage?.mimetype ??
    data?.message?.audioMessage?.mimetype
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

  // Grupos sao ignorados (foco: 1:1)
  if (data.key.remoteJid.endsWith('@g.us')) {
    return { skipped: 'group' };
  }

  // fromMe = mensagem enviada do numero da loja (Bia respondendo no app OU eco do envio da DANI)
  // Precisamos diferenciar pra pausar a DANI quando humano responde.
  const fromMe = data.key.fromMe === true;
  let isDaniEcho = false;
  if (fromMe && data.key.id) {
    try {
      const { getRedis } = await import('./queues.js');
      const redis = getRedis();
      const sentByUs = await redis.get(`fce:wa:sent:${data.key.id}`);
      isDaniEcho = !!sentByUs;
    } catch {
      // Redis off -> assume eh DANI (fallback seguro)
      isDaniEcho = true;
    }
    if (isDaniEcho) {
      return { skipped: 'dani-echo' };
    }
  }

  const rawText = extractText(data);
  const hasImage = isImage(data);
  const hasPdf = isPdfDocument(data);
  const hasAudio = isAudio(data);
  const hasMedia = hasImage || hasPdf || hasAudio;

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
    // H5: cliente novo manda 2 msgs juntas (texto+foto) -> 2 webhooks
    // concorrentes, ambos veem null e inserem; o 2o violava o unique
    // (contacts_account_phone_uniq) e estourava -> mensagem perdida.
    // onConflictDoNothing + re-select torna idempotente.
    const [created] = await db
      .insert(contacts)
      .values({
        accountId,
        phoneNumber: phone,
        name: pushName ?? null,
      })
      .onConflictDoNothing({ target: [contacts.accountId, contacts.phoneNumber] })
      .returning({ id: contacts.id });
    if (created) {
      contact = created;
      logger.info({ accountId, phone }, '[WhatsApp] new contact');
    } else {
      contact = await db.query.contacts.findFirst({
        where: and(eq(contacts.accountId, accountId), eq(contacts.phoneNumber, phone)),
        columns: { id: true },
      });
    }
  }
  if (!contact) {
    logger.error({ accountId, phone }, '[WhatsApp] contato nao resolvido apos conflict');
    return { skipped: 'contact-unresolved' };
  }

  // 2. Pega conversation ativa
  let conv = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      lastHumanAt: conversations.lastHumanAt,
      lastMessageAt: conversations.lastMessageAt,
    })
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
      .returning({
        id: conversations.id,
        status: conversations.status,
        lastHumanAt: conversations.lastHumanAt,
        lastMessageAt: conversations.lastMessageAt,
      });
    conv = created;
  }

  // fromMe + nao-eco = Bia respondendo no app do WhatsApp da loja.
  // Salva como mensagem do humano, pausa DANI (status=human), nao processa via IA.
  if (fromMe) {
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'human',
      content: rawText ?? (hasMedia ? '[Bia enviou mídia]' : ''),
    });
    logger.info(
      { conversationId: conv.id, msgId: data.key.id },
      '[WhatsApp] Bia respondeu no app - DANI pausada',
    );
    // saveMessage ja atualiza conversation.status=human quando fromType=human
    return { skipped: 'human-from-whatsapp', contactId: contact.id, conversationId: conv.id };
  }

  // Cliente respondeu - reseta follow-up state (text bruto pra decidir substantivo)
  await resetFollowupOnUserReply(conv.id, rawText ?? '').catch((err) =>
    logger.warn({ err: (err as Error).message }, '[WhatsApp] resetFollowup failed'),
  );

  // H6: conversa FECHADA pelo follow-up (cliente sumiu e foi encerrada).
  // Se o cliente volta a escrever, ele re-engajou -> REABRE e processa.
  // Sem isso, ficava presa em 'closed' pra sempre (nenhum caminho reativava):
  // handleMessageUpsert pegava a conversa fechada, via status!=='nina' e so
  // salvava sem enfileirar -> cliente nunca mais respondido.
  if (conv.status === 'closed') {
    await db
      .update(conversations)
      .set({ status: 'nina', followupState: 'idle', updatedAt: new Date() })
      .where(eq(conversations.id, conv.id));
    conv.status = 'nina';
    logger.info({ conversationId: conv.id }, '[WhatsApp] conversa fechada reaberta pelo cliente');
  }

  // Cliente voltou DEPOIS que o cooldown pos-humano venceu -> DANI retoma.
  // BUG corrigido: msg de cliente em conversa 'human' era salva mas NUNCA
  // enfileirada, entao a reativacao do ai-reply nunca rodava — a unica
  // reativacao era o cron (e o cron so roda 9h-18h). Resultado: um humano
  // tocava a conversa e a DANI nao voltava mais, mesmo o cliente respondendo
  // horas depois. Agora reativamos aqui, no retorno do cliente, e a mensagem
  // segue pro fluxo normal (enfileira + responde).
  if (conv.status === 'human') {
    const settings = await db.query.ninaSettings.findFirst({
      where: eq(ninaSettings.accountId, accountId),
      columns: { pauseAfterHumanMinutes: true },
    });
    const pauseMinutes = settings?.pauseAfterHumanMinutes ?? 60;
    const ref = conv.lastHumanAt?.getTime() ?? conv.lastMessageAt?.getTime() ?? null;
    const minutesIdle = ref ? (Date.now() - ref) / 60_000 : Infinity;
    if (minutesIdle >= pauseMinutes) {
      await db
        .update(conversations)
        .set({ status: 'nina', updatedAt: new Date() })
        .where(eq(conversations.id, conv.id));
      conv.status = 'nina';
      logger.info(
        { conversationId: conv.id, minutesIdle: Math.round(minutesIdle), pauseMinutes },
        '[WhatsApp] cooldown pos-humano venceu - DANI reativada pelo retorno do cliente',
      );
    }
  }

  // Se ainda humano (dentro do cooldown) ou pausado, salva mas nao processa
  if (conv.status !== 'nina') {
    await saveMessage({
      conversationId: conv.id,
      accountId,
      fromType: 'user',
      content: rawText ?? (hasMedia ? '[Cliente enviou mídia]' : ''),
    });
    return { skipped: `status=${conv.status}`, contactId: contact.id, conversationId: conv.id };
  }

  // Audio do cliente: salva placeholder pra DANI processar como texto
  // (transcricao via Gemini multimodal vem em sprint futuro)
  if (hasAudio && !rawText) {
    logger.info({ conversationId: conv.id }, '[WhatsApp] audio recebido - placeholder');
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

  // Audio: worker vai transcrever via Gemini multimodal e usar como text.
  // Aqui passamos texto vazio - worker enriquece via mediaPayload.
  const finalText = rawText ?? '';

  // Enfileira: worker faz Vision (se mediaPayload) + persist + buffer push.
  await inboundQueue.add(
    'persist',
    {
      accountId,
      conversationId: conv.id,
      contactId: contact.id,
      phoneNumber: phone,
      text: finalText, // worker enriquece se houver mediaPayload
      whatsappMessageId: data.key.id,
      mediaPayload,
    },
    {
      // BullMQ proibe ':' em custom job IDs - sanitizamos
      jobId: data.key.id ? `inbound_${data.key.id.replace(/:/g, '_')}` : undefined,
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
