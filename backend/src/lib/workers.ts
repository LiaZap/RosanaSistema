import { Worker } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
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
    try {
      const media = await fetchMessageMediaBase64({
        accountId,
        instanceName: mediaPayload.instanceName,
        messageKey: mediaPayload.messageKey,
      });
      if (media) {
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
      } else {
        // Media fetch falhou
        if (!text) text = '[Cliente mandou uma imagem]';
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversationId },
        '[Inbound] Vision processing failed',
      );
      if (!text) text = '[Cliente mandou uma imagem]';
    }
  }

  // 1. Persiste user message
  const [saved] = await db
    .insert(messages)
    .values({
      conversationId,
      accountId,
      fromType: 'user',
      messageType,
      content: text,
      whatsappMessageId,
    })
    .returning({ id: messages.id });

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
  // Se nao for nova janela, ele ja foi agendado por uma msg anterior - a logica
  // no ai-reply vai detectar que ainda tem msg recente e reagendar sozinho.
  // Mas pra garantir, agendamos sempre (jobId determinístico previne duplicação).
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
      jobId: `ai:${buf.windowId}`, // mesmo windowId = mesmo job (idempotente)
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
    .select({ status: conversations.status, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conv) {
    logger.warn({ conversationId }, '[AiReply] conversation not found');
    return;
  }

  if (conv.status !== 'nina') {
    logger.info(
      { conversationId, status: conv.status },
      '[AiReply] conversation nao esta em modo nina - skip',
    );
    // Limpa o buffer pra nao acumular
    await drainBuffer(conversationId);
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
        jobId: `ai:${bufferWindowId}:retry:${Date.now()}`,
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
      history,
    });
  } catch (err) {
    logger.error({ conversationId, err: (err as Error).message }, '[AiReply] DANI failed');
    return;
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

  // 11. Enfileira outbound (text ou media)
  const firstImage = result.attachments.find((a) => a.type === 'image');
  if (firstImage && firstImage.url.includes('res.cloudinary.com')) {
    await outboundQueue.add('send', {
      accountId,
      phoneNumber,
      imageUrl: transformedUrl(firstImage.url),
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

  // 12. Classifica intent + lead_score async (NAO bloqueia o ai-reply).
  // Sprint 7. Erros sao swallowed - classificacao eh nice-to-have, mas
  // logamos warn pra ter visibilidade em producao.
  classifyConversation(conversationId).catch((err) =>
    logger.warn({ err: (err as Error).message, conversationId }, '[AiReply] background classification failed'),
  );
}

/**
 * OUTBOUND - envia via Evolution API.
 */
async function processOutbound(data: OutboundJobData): Promise<void> {
  const { accountId, phoneNumber, text, imageUrl, caption } = data;

  const settings = await getEvolutionSettings(accountId);
  const session = await db.query.whatsappSessions.findFirst({
    where: eq(whatsappSessions.accountId, accountId),
  });
  if (!session) {
    throw new Error('No WhatsApp session');
  }

  if (imageUrl) {
    await sendMediaMessage({
      settings,
      instanceName: session.instanceName,
      phoneNumber,
      mediaUrl: imageUrl,
      caption: caption ?? '',
      mediaType: 'image',
    });
  } else if (text) {
    await sendTextMessage({
      settings,
      instanceName: session.instanceName,
      phoneNumber,
      text,
    });
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
    async (job) => processOutbound(job.data),
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
