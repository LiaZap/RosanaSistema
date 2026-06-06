import { Worker } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  contacts,
  conversations,
  messages,
  ninaSettings,
  whatsappSessions,
} from '../db/schema.js';
import {
  queueConnection,
  inboundQueue,
  aiReplyQueue,
  outboundQueue,
  type InboundJobData,
  type AiReplyJobData,
  type OutboundJobData,
} from './queues.js';
import {
  pushToBuffer,
  drainBuffer,
  restoreBuffer,
  shouldFlush,
} from './inbound-buffer.js';
import { loadHistory, saveMessage } from './dani-conversations.js';
import { processDaniMessage } from './dani-orchestrator.js';
import {
  getEvolutionSettings,
  sendMediaMessage,
  sendTextMessage,
} from './evolution-client.js';
import { transformedUrl } from './cloudinary-client.js';
import { classifyConversation } from './intent-classifier.js';
import { fetchMessageMediaBase64 } from './evolution-media.js';
import { classifyImage } from './gemini-vision.js';
import { transcribeAudio } from './gemini-audio.js';
import { updateContactMemory } from './contact-memory.js';
import { visionPerContact, outboundPerContact } from './rate-limit.js';
import { logger } from './logger.js';

/** Corrobora comprovante via keywords no caption */
function captionSuggestsPayment(caption?: string): boolean {
  if (!caption) return false;
  return /\b(pix|comprovante|transferencia|transferência|deposito|depósito|pagamento|recibo|boleto)\b/i.test(
    caption,
  );
}

/**
 * Sprint 1: BullMQ workers rodando dentro do processo backend.
 * Sprint 9+: mover pro container worker dedicado.
 *
 * Pipeline:
 *   inbound  -> persiste msg no banco + buffer push + schedule ai-reply
 *   ai-reply -> drena buffer + processa via Gemini + enfileira outbound
 *   outbound -> envia via Evolution API
 */

let inboundWorker: Worker | null = null;
let aiReplyWorker: Worker | null = null;
let outboundWorker: Worker | null = null;
let started = false;

/**
 * INBOUND - persiste a mensagem do cliente e adiciona ao buffer.
 * Agenda um ai-reply delayed pra processar quando o silencio acabar.
 */
async function processInbound(data: InboundJobData): Promise<void> {
  const { accountId, conversationId, contactId, phoneNumber, whatsappMessageId, mediaPayload } = data;
  let { text } = data;
  void contactId; // available for future use
  void phoneNumber;

  // Sprint 3: se veio mediaPayload, faz Vision aqui (no worker, async).
  // Anti-race: como o worker processa jobs sequencialmente por conversation
  // (idempotency jobId 'inbound:{messageId}'), a ordem das mensagens eh preservada.
  let messageType: 'text' | 'image' | 'document' = 'text';
  let skipBuffer = false;

  if (mediaPayload) {
    // Sprint 11: rate-limit vision por contato (max 5/min)
    const rl = await visionPerContact(contactId);
    if (!rl.allowed) {
      logger.warn(
        { contactId, current: rl.current, limit: rl.limit },
        '[Inbound] vision rate-limited - skipping classification',
      );
      // Vai pro buffer como texto generico
      if (!text) text = '[Cliente mandou uma imagem]';
    } else {
    try {
      const media = await fetchMessageMediaBase64({
        accountId,
        instanceName: mediaPayload.instanceName,
        messageKey: mediaPayload.messageKey,
      });
      if (media) {
        // AUDIO -> transcrever via Gemini
        if (media.mimetype.startsWith('audio/')) {
          const transcript = await transcribeAudio({
            accountId,
            base64: media.base64,
            mimetype: media.mimetype,
          });
          if (transcript && transcript !== '[audio sem fala]') {
            text = transcript;
            messageType = 'text'; // tratado como texto pra DANI processar normal
            logger.info(
              { conversationId, chars: transcript.length },
              '[Inbound] audio transcrito',
            );
          } else if (!text) {
            text = '[Cliente enviou áudio sem fala clara - peça pra escrever]';
          }
        } else {
        // IMAGE / PDF -> Vision classifier
        const vision = await classifyImage({
          accountId,
          base64: media.base64,
          mimetype: media.mimetype,
          caption: mediaPayload.caption,
        });

        messageType = media.mimetype.startsWith('image/') ? 'image' : 'document';

        if (vision) {
          // Threshold rigoroso: 80% + corroborante por keyword no caption
          const isComprovante =
            vision.intent === 'comprovante' &&
            (vision.confianca >= 80 ||
              (vision.confianca >= 60 && captionSuggestsPayment(mediaPayload.caption)));

          if (isComprovante) {
            text = mediaPayload.caption
              ? `[Comprovante de pagamento] ${mediaPayload.caption}`
              : '[Comprovante de pagamento]';
            skipBuffer = true; // SILENCIO absoluto - nao vai pro buffer
            logger.info(
              { conversationId, confianca: vision.confianca },
              '[Inbound] comprovante detectado - silencio absoluto',
            );
          } else if (vision.intent === 'produto' && vision.termos_busca.length > 0) {
            const termos = vision.termos_busca.join(', ');
            text = text
              ? `${text}\n\n[Cliente mandou foto. Descricao: ${vision.descricao}. Termos pra busca: ${termos}]`
              : `[Cliente mandou foto de produto. Descricao: ${vision.descricao}. Termos pra busca: ${termos}]`;
          } else {
            text = text
              ? `${text}\n\n[Cliente mandou imagem: ${vision.descricao}]`
              : `[Cliente mandou imagem (${vision.intent}): ${vision.descricao}]`;
          }
        } else if (!text) {
          // Vision retornou null + sem caption = vai uma msg generica
          text = '[Cliente mandou uma imagem - nao foi possivel classificar]';
        }
        } // end else (audio/image branch)
      } else {
        // Media fetch falhou
        if (!text) text = '[Cliente mandou uma midia]';
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversationId },
        '[Inbound] Vision processing failed',
      );
      if (!text) text = '[Cliente mandou uma imagem]';
    }
    } // end else (allowed)
  }

  // 1. Persiste user message (M7: dedupe no retry via unique parcial
  // (account_id, whatsapp_message_id). Se o job re-roda apos um await pos-insert
  // falhar, a mesma msg nao duplica no banco nem no buffer).
  const insertedMsg = await db
    .insert(messages)
    .values({
      conversationId,
      accountId,
      fromType: 'user',
      messageType,
      content: text,
      whatsappMessageId,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (insertedMsg.length === 0) {
    logger.info({ whatsappMessageId, conversationId }, '[Inbound] msg duplicada (retry) - skip');
    return;
  }
  const saved = insertedMsg[0]!;

  // 2. Atualiza lastMessageAt na conversation
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // Vision detectou comprovante: skip buffer (silencio absoluto)
  if (skipBuffer) {
    return;
  }

  // 3. Carrega settings da DANI (pra pegar windowMs)
  const settings = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, accountId),
  });
  const windowMs = settings?.bufferWindowMs ?? 15_000;

  // 4. Adiciona ao buffer
  const buf = await pushToBuffer({
    conversationId,
    messageId: saved.id,
  });

  // 5. Marca a message com bufferWindowId
  await db
    .update(messages)
    .set({ bufferWindowId: buf.windowId })
    .where(eq(messages.id, saved.id));

  logger.info(
    { conversationId, msgId: saved.id, windowId: buf.windowId, total: buf.total, isNew: buf.isNewWindow },
    '[Inbound] message persisted + buffered',
  );

  // 6. Agenda ai-reply delayed.
  // jobId deterministico (ai_<windowId>) = dedup: varias msgs na mesma janela
  // compartilham 1 job, em vez de 1 job por mensagem.
  //
  // ARMADILHA: se esse job terminou em 'failed' ou 'completed' (ex: Gemini caiu
  // e esgotou os attempts), ele vira um "tombstone". O BullMQ IGNORA qualquer
  // add() com um jobId ja existente — inclusive jobs failed/completed — entao a
  // janela nunca mais e reagendada e o buffer cresce pra sempre. Por isso
  // removemos o job terminal antes de re-adicionar (mantendo o dedup pros que
  // ainda estao delayed/active/waiting). Assim a janela se recupera sozinha na
  // proxima mensagem que chegar.
  const aiJobId = `ai_${buf.windowId}`;
  try {
    const existing = await aiReplyQueue.getJob(aiJobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        await existing.remove();
        logger.warn(
          { conversationId, windowId: buf.windowId, state },
          '[Inbound] job ai-reply estava em estado terminal (tombstone) - removido pra reagendar',
        );
      }
    }
  } catch (e) {
    logger.warn(
      { conversationId, windowId: buf.windowId, err: (e as Error).message },
      '[Inbound] falha ao checar job ai-reply existente (segue pro add)',
    );
  }

  await aiReplyQueue.add(
    'process',
    {
      accountId,
      conversationId,
      contactId,
      phoneNumber,
      bufferWindowId: buf.windowId,
    } satisfies AiReplyJobData,
    {
      delay: windowMs,
      jobId: aiJobId, // mesmo windowId = mesmo job (idempotente, exceto tombstone limpo acima)
      removeOnComplete: { age: 3600, count: 200 },
    },
  );
}

/**
 * AI-REPLY - drena buffer, processa via Gemini, enfileira outbound.
 */
async function processAiReply(data: AiReplyJobData): Promise<void> {
  const { accountId, conversationId, contactId, phoneNumber, bufferWindowId } = data;
  void contactId; // para uso futuro de tools de agendamento

  // 1. Carrega settings da conta
  const settings = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, accountId),
  });

  if (settings && !settings.isActive) {
    logger.info({ conversationId }, '[AiReply] DANI desativada - skip');
    return;
  }

  const windowMs = settings?.bufferWindowMs ?? 15_000;
  const maxMs = settings?.bufferMaxMs ?? 60_000;

  // 2. Verifica status da conversation (humano assumiu?)
  const [conv] = await db
    .select({
      status: conversations.status,
      lastHumanAt: conversations.lastHumanAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conv) {
    logger.warn({ conversationId }, '[AiReply] conversation not found');
    return;
  }

  // Auto-reativa DANI apos X minutos sem resposta do humano
  // (configuracao: nina_settings.pauseAfterHumanMinutes, default 60min)
  // Tambem reativa conversas antigas (lastHumanAt NULL) cuja ultima msg
  // foi ha > pauseMin
  const pauseMinutes = settings?.pauseAfterHumanMinutes ?? 60;
  if (conv.status === 'human') {
    const ref =
      conv.lastHumanAt?.getTime() ??
      (await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
      )[0]?.lastMessageAt?.getTime() ??
      null;

    if (ref) {
      const minutesIdle = (Date.now() - ref) / 60_000;
      if (minutesIdle >= pauseMinutes) {
        logger.info(
          { conversationId, minutesIdle, pauseMinutes, fromHuman: !!conv.lastHumanAt },
          '[AiReply] auto-reativando DANI apos timeout humano',
        );
        await db
          .update(conversations)
          .set({ status: 'nina', updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        conv.status = 'nina';
      }
    }
  }

  if (conv.status !== 'nina') {
    // Calcula quanto falta pro cooldown vencer (pra reagendar)
    const ref =
      conv.lastHumanAt?.getTime() ??
      (await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
      )[0]?.lastMessageAt?.getTime() ??
      null;

    const remainingMs = ref
      ? Math.max(60_000, pauseMinutes * 60_000 - (Date.now() - ref) + 5_000)
      : pauseMinutes * 60_000;

    logger.info(
      {
        conversationId,
        status: conv.status,
        retryInMin: Math.round(remainingMs / 60_000),
      },
      '[AiReply] conversation nao esta em modo nina - reagenda pos cooldown',
    );

    // NAO drena buffer - mantem mensagens pra processar quando cron reativar.
    // Reagenda este job pra quando o cooldown vencer (com 5s margem).
    await aiReplyQueue.add(
      'process',
      data,
      {
        delay: remainingMs,
        jobId: `ai_${bufferWindowId}_pause_${Date.now()}`,
      },
    );
    return;
  }

  // 3. Pega timestamp da primeira msg da janela atual (do banco)
  const firstMsg = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.bufferWindowId, bufferWindowId))
    .orderBy(messages.createdAt)
    .limit(1);

  const firstAt = firstMsg[0]?.createdAt.getTime() ?? Date.now();

  // 4. Decide se ja eh hora de flushar
  const decision = await shouldFlush({
    conversationId,
    windowMs,
    maxMs,
    firstAt,
  });

  if (!decision.flush) {
    // Ainda chegando msgs - reagenda
    logger.debug(
      { conversationId, remainingMs: decision.remainingMs },
      '[AiReply] not yet - rescheduling',
    );
    await aiReplyQueue.add(
      'process',
      data,
      {
        delay: decision.remainingMs,
        jobId: `ai_${bufferWindowId}_retry_${Date.now()}`,
      },
    );
    return;
  }

  // 5. FLUSH - drena buffer
  const { messageIds } = await drainBuffer(conversationId);

  if (messageIds.length === 0) {
    logger.warn({ conversationId, bufferWindowId }, '[AiReply] buffer vazio - nada pra processar');
    return;
  }

  // 6. Carrega as mensagens reais do banco
  const bufferedMsgs = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(inArray(messages.id, messageIds))
    .orderBy(messages.createdAt);

  // Concatena msgs do buffer em um único contexto
  const combinedText = bufferedMsgs
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n');

  if (!combinedText.trim()) {
    logger.warn({ conversationId }, '[AiReply] msgs sem content - skip');
    return;
  }

  logger.info(
    { conversationId, buffered: bufferedMsgs.length, charsTotal: combinedText.length },
    '[AiReply] flushing buffer',
  );

  // 7. Carrega historico (ate 30, EXCLUINDO as msgs do buffer atual que ja foram salvas)
  const fullHistory = await loadHistory(conversationId, 30 + bufferedMsgs.length);
  // Remove as msgs que estao na janela atual (sao as ultimas)
  const history = fullHistory.slice(0, Math.max(0, fullHistory.length - bufferedMsgs.length));

  // 8. Processa via DANI
  let result;
  try {
    result = await processDaniMessage(combinedText, {
      accountId,
      contactId,
      conversationId,
      history,
    });
  } catch (err) {
    // H2: o buffer ja foi drenado (destrutivo). Se a DANI falhou (Gemini
    // timeout/429/500), restauramos o buffer e damos THROW pra o BullMQ
    // retentar (attempts). Sem isso, a msg ficava no banco mas SEM resposta
    // pra sempre (job marcado completo, buffer apagado).
    logger.error({ conversationId, err: (err as Error).message }, '[AiReply] DANI failed - restaurando buffer pra retry');
    await restoreBuffer({ conversationId, windowId: bufferWindowId, messageIds }).catch((e) =>
      logger.warn({ conversationId, err: (e as Error).message }, '[AiReply] falha ao restaurar buffer'),
    );
    throw err;
  }

  // 9. Se DANI decidiu nao responder (silencio absoluto: comprovante,
  // despedida, etc), so loga o reasoning e NAO envia nem salva.
  if (!result.shouldReply) {
    logger.info(
      { conversationId, reasoning: result.reasoning, modelMode: result.modelUsed },
      '[AiReply] silencio absoluto (should_reply=false)',
    );
    return;
  }

  // 10. Salva resposta da DANI no banco
  await saveMessage({
    conversationId,
    accountId,
    fromType: 'nina',
    content: result.reply,
    processedByNina: true,
  });

  // 11. Enfileira outbound. Prioridade:
  //  - Imagens: cada uma vira mensagem propria, caption so na PRIMEIRA
  //  - Documento/video/audio: media+caption
  //  - Texto puro
  // Helper pra tornar URL absoluta (Evolution precisa de URL publica)
  const API_BASE = (process.env.API_URL || 'https://liamed-fce-api.leyiy3.easypanel.host').replace(/\/$/, '');
  const toAbsolute = (url: string): string =>
    url.startsWith('http')
      ? (url.includes('res.cloudinary.com') ? transformedUrl(url) : url)
      : `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;

  const imageAttachments = result.attachments.filter((a) => a.type === 'image');
  const firstDoc = result.attachments.find(
    (a) => a.type === 'document' || a.type === 'video' || a.type === 'audio',
  );

  if (imageAttachments.length > 0) {
    // PRIMEIRA imagem leva o texto como caption
    await outboundQueue.add('send', {
      accountId,
      phoneNumber,
      imageUrl: toAbsolute(imageAttachments[0].url),
      caption: result.reply,
      conversationId,
    } satisfies OutboundJobData);
    // Imagens adicionais sem caption (max 5)
    for (let i = 1; i < Math.min(imageAttachments.length, 5); i++) {
      await outboundQueue.add('send', {
        accountId,
        phoneNumber,
        imageUrl: toAbsolute(imageAttachments[i].url),
        conversationId,
      } satisfies OutboundJobData);
    }
  } else if (firstDoc) {
    await outboundQueue.add('send', {
      accountId,
      phoneNumber,
      mediaUrl: toAbsolute(firstDoc.url),
      mediaType: firstDoc.type,
      fileName: firstDoc.fileName,
      caption: result.reply,
      conversationId,
    } satisfies OutboundJobData);
  } else {
    await outboundQueue.add('send', {
      accountId,
      phoneNumber,
      text: result.reply,
      conversationId,
    } satisfies OutboundJobData);
  }

  // 11b. Notifica Bia se DANI escalou pra humano (detecta frase de transferencia).
  // Usa o biaPhone configurado em nina_settings. Fire-and-forget.
  (async () => {
    try {
      const ESCALATION_PATTERN = /vou transferir.*atendimento.*bia|transferindo.*bia|passar.*bia/i;
      if (!ESCALATION_PATTERN.test(result.reply)) return;

      const settingsRow = await db.query.ninaSettings.findFirst({
        where: eq(ninaSettings.accountId, accountId),
        columns: { biaPhone: true, biaNotifyMessage: true, sdrName: true },
      });
      if (!settingsRow?.biaPhone) return;

      const contactRow = await db.query.contacts.findFirst({
        where: eq(contacts.id, contactId),
        columns: { name: true, phoneNumber: true },
      });

      const waSettings = await getEvolutionSettings(accountId);
      const session = await db.query.whatsappSessions.findFirst({
        where: eq(whatsappSessions.accountId, accountId),
        columns: { instanceName: true },
      });
      if (!session) return;

      const clientLabel = contactRow?.name
        ? `*${contactRow.name}* (+${contactRow.phoneNumber})`
        : `+${contactRow?.phoneNumber ?? phoneNumber}`;

      const msg = settingsRow.biaNotifyMessage?.trim()
        || `⚡ *Nova transferência — ${settingsRow.sdrName ?? 'DANI'}*\n\nCliente ${clientLabel} foi transferido para você. Responda assim que puder! 🙏`;

      await sendTextMessage({
        settings: waSettings,
        instanceName: session.instanceName,
        phoneNumber: settingsRow.biaPhone,
        text: msg,
      });

      logger.info(
        { conversationId, biaPhone: settingsRow.biaPhone, contactId },
        '[AiReply] notificacao Bia enviada',
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversationId },
        '[AiReply] falha ao notificar Bia',
      );
    }
  })();

  // 12. Classifica intent + lead_score async (NAO bloqueia o ai-reply).
  // Sprint 7. Erros sao swallowed - classificacao eh nice-to-have, mas
  // logamos warn pra ter visibilidade em producao.
  classifyConversation(conversationId).catch((err) =>
    logger.warn({ err: (err as Error).message, conversationId }, '[AiReply] background classification failed'),
  );

  // 13. Sprint 8: atualiza memoria do contato async
  updateContactMemory({ conversationId, contactId }).catch((err) =>
    logger.warn(
      { err: (err as Error).message, conversationId, contactId },
      '[AiReply] background memory update failed',
    ),
  );

  // 14. Auto-create deal: se cliente expressou intencao de compra,
  // cria deal automaticamente em "Em Qualificacao"
  (async () => {
    try {
      const { createDealIfBuyIntent } = await import('./auto-deal.js');
      const contactRow = await db.query.contacts.findFirst({
        where: eq(contacts.id, contactId),
        columns: { name: true },
      });
      const r = await createDealIfBuyIntent({
        accountId,
        conversationId,
        contactId,
        contactName: contactRow?.name ?? null,
        userMessage: combinedText,
        daniReply: result.reply,
      });
      if (r.created) {
        logger.info(
          { conversationId, dealId: r.dealId },
          '[AiReply] deal auto-criado pela DANI',
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversationId },
        '[AiReply] auto-deal failed',
      );
    }
  })();
}

/**
 * OUTBOUND - envia via Evolution API.
 */
async function processOutbound(data: OutboundJobData, isLastAttempt = false): Promise<void> {
  const { accountId, phoneNumber, text, imageUrl, mediaUrl, mediaType, caption, conversationId } = data;

  // Sprint 11: rate-limit outbound por contato (max 30/min)
  const rl = await outboundPerContact(phoneNumber);
  if (!rl.allowed) {
    // M1: NAO descartar (return marcava o job completo e a msg sumia).
    // Throw -> BullMQ retenta (attempts:5 com backoff), o envio acontece
    // quando a janela de rate-limit abrir.
    logger.warn(
      { phoneNumber, current: rl.current, limit: rl.limit },
      '[Outbound] rate-limited - reenfileirando (retry)',
    );
    throw new Error(`rate-limited (${rl.current}/${rl.limit}) - retry`);
  }

  const settings = await getEvolutionSettings(accountId);
  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) {
    throw new Error('No WhatsApp session');
  }

  // H4: se a midia falhar DEFINITIVAMENTE (ultima tentativa), enfileira o
  // caption como TEXTO separado. Senao o cliente perdia preco/fechamento
  // junto com a foto que nao chegou (mas o painel marcava "DANI respondeu").
  const mediaFallbackText = async () => {
    if (isLastAttempt && caption && caption.trim()) {
      await outboundQueue.add(
        'send',
        { accountId, phoneNumber, text: caption, conversationId } satisfies OutboundJobData,
        { jobId: `out_mediafallback_${conversationId ?? phoneNumber}_${Date.now()}` },
      );
      logger.warn({ phoneNumber, conversationId }, '[Outbound] midia falhou - caption reenviado como texto');
    }
  };

  let sentId: string | null = null;
  if (imageUrl) {
    try {
      const r = await sendMediaMessage({
        settings,
        instanceName: session.instanceName,
        phoneNumber,
        mediaUrl: imageUrl,
        caption: caption ?? '',
        mediaType: 'image',
      });
      sentId = r.messageId;
    } catch (err) {
      await mediaFallbackText();
      throw err;
    }
  } else if (mediaUrl && mediaType && mediaType !== 'audio') {
    try {
      const r = await sendMediaMessage({
        settings,
        instanceName: session.instanceName,
        phoneNumber,
        mediaUrl,
        caption: caption ?? '',
        mediaType: mediaType as 'image' | 'video' | 'document',
      });
      sentId = r.messageId;
    } catch (err) {
      await mediaFallbackText();
      throw err;
    }
  } else if (text) {
    const r = await sendTextMessage({
      settings,
      instanceName: session.instanceName,
      phoneNumber,
      text,
    });
    sentId = r.messageId;
  }

  // Marca msgId no Redis pra webhook distinguir eco-da-DANI de humano-respondendo
  if (sentId) {
    try {
      const { getRedis } = await import('./queues.js');
      const redis = getRedis();
      await redis.set(`fce:wa:sent:${sentId}`, '1', 'EX', 300); // 5min TTL
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[Outbound] redis cache failed');
    }
  }
}

/**
 * Recuperacao de jobs ai-reply presos em 'failed'. Roda no BOOT do worker E
 * PERIODICAMENTE (cron a cada 5min) — destrava conversas que ficaram mudas
 * porque o ai-reply falhou (Gemini blip, timeout, erro pontual) SEM depender de
 * nova msg do cliente nem de reset manual. Foi exatamente o caso do "16".
 *
 * Cap por job (AIREPLY_RETRY_CAP) evita storm: um job 'poison' que sempre falha
 * para de ser retentado depois de N vezes (conta no Redis, TTL = vida do job).
 * Jobs cujo buffer ja foi drenado viram no-op. Seguro e idempotente.
 */
const AIREPLY_RETRY_CAP = 5;
export async function recoverStuckAiReplies(): Promise<void> {
  try {
    const failed = await aiReplyQueue.getFailed(0, 500);
    if (failed.length === 0) return;
    const { getRedis } = await import('./queues.js');
    const redis = getRedis();
    let retried = 0;
    let capped = 0;
    for (const job of failed) {
      if (!job?.id) continue;
      // Cap por job: no maximo AIREPLY_RETRY_CAP retentativas na vida do job
      // (removeOnFail = 24h). Assim um job que SEMPRE falha nao vira storm de
      // chamadas ao Gemini — para apos N tentativas e fica visivel no debug.
      const key = `fce:airetry:${job.id}`;
      const n = Number((await redis.get(key)) ?? 0);
      if (n >= AIREPLY_RETRY_CAP) {
        capped++;
        continue;
      }
      try {
        await job.retry();
        await redis.set(key, String(n + 1), 'EX', 86400);
        retried++;
      } catch (e) {
        logger.warn(
          { jobId: job.id, err: (e as Error).message },
          '[Workers] falha ao retentar ai-reply preso',
        );
      }
    }
    if (retried > 0 || capped > 0) {
      logger.info({ retried, capped, total: failed.length }, '[Workers] sweep de recuperacao ai-reply');
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, '[Workers] sweep de recuperacao ai-reply falhou');
  }
}

/**
 * Inicia todos os workers BullMQ. Idempotente.
 */
export function startWorkers(): void {
  if (started) {
    logger.warn('[Workers] already started');
    return;
  }
  started = true;

  inboundWorker = new Worker<InboundJobData>(
    'fce-inbound',
    async (job) => processInbound(job.data),
    { connection: queueConnection, concurrency: 8 },
  );

  aiReplyWorker = new Worker<AiReplyJobData>(
    'fce-ai-reply',
    async (job) => processAiReply(job.data),
    { connection: queueConnection, concurrency: 4 },
  );

  outboundWorker = new Worker<OutboundJobData>(
    'fce-outbound',
    async (job) => {
      const maxAttempts = job.opts.attempts ?? 5;
      const isLast = (job.attemptsMade ?? 0) >= maxAttempts - 1;
      return processOutbound(job.data, isLast);
    },
    { connection: queueConnection, concurrency: 6 },
  );

  for (const [name, worker] of Object.entries({
    inbound: inboundWorker,
    aiReply: aiReplyWorker,
    outbound: outboundWorker,
  })) {
    worker.on('failed', (job, err) =>
      logger.error(
        { queue: name, jobId: job?.id, err: err.message, attemptsMade: job?.attemptsMade },
        '[Workers] job failed',
      ),
    );
    worker.on('completed', (job) =>
      logger.debug({ queue: name, jobId: job.id }, '[Workers] job completed'),
    );
  }

  logger.info({ queues: ['inbound', 'ai-reply', 'outbound'] }, '[Workers] started');

  // Recuperacao pos-boot (fire-and-forget): destrava conversas cujo ai-reply
  // ficou em 'failed' durante uma queda do Gemini. Roda 1x por subida do worker.
  void recoverStuckAiReplies();
}

export async function stopWorkers(): Promise<void> {
  await Promise.all([
    inboundWorker?.close(),
    aiReplyWorker?.close(),
    outboundWorker?.close(),
  ]);
  started = false;
}

// Re-export pra facilitar uso
export { inboundQueue, aiReplyQueue, outboundQueue };

// Silence eslint for unused
void and;
void desc;
