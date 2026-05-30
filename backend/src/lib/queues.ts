import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from './logger.js';

/**
 * BullMQ queues centralizadas. Workers registram processors em workers.ts.
 *
 * Sprint 1: 3 filas - inbound, ai-reply, outbound.
 * Sprint 3+: vision, followup, etc.
 */

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

// Connection pra BullMQ (separada do ioredis usado em health check)
// maxRetriesPerRequest: null eh obrigatorio pra BullMQ
export const queueConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

/** Conexao raw pra primitives Redis (buffer ZSET) */
let redisClient: Redis | null = null;
export function getRedis(): Redis {
  if (redisClient) return redisClient;
  redisClient = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redisClient.on('error', (err: Error) => logger.error({ err: err.message }, '[Redis] error'));
  return redisClient;
}

/** Job payloads tipados */

export interface InboundJobData {
  accountId: string;
  conversationId: string;
  contactId: string;
  phoneNumber: string;
  text: string;
  whatsappMessageId?: string;
  // Sprint 3: mediaPayload pra worker processar Vision (preserva ordem do buffer)
  mediaPayload?: {
    messageKey: { id: string; remoteJid: string; fromMe: boolean };
    instanceName: string;
    mimetype?: string;
    caption?: string;
  };
}

export interface AiReplyJobData {
  accountId: string;
  conversationId: string;
  contactId: string;
  phoneNumber: string;
  bufferWindowId: string; // UUID gerado quando o buffer abriu
}

export interface OutboundJobData {
  accountId: string;
  phoneNumber: string;
  text?: string;
  imageUrl?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document' | 'audio';
  fileName?: string;
  caption?: string;
  conversationId?: string;
}

/** Filas instanciadas */
export const inboundQueue = new Queue<InboundJobData>('fce-inbound', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 86400 },
  },
});

export const aiReplyQueue = new Queue<AiReplyJobData>('fce-ai-reply', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 86400 },
  },
});

export const outboundQueue = new Queue<OutboundJobData>('fce-outbound', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 86400 },
  },
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    inboundQueue.close(),
    aiReplyQueue.close(),
    outboundQueue.close(),
  ]);
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
