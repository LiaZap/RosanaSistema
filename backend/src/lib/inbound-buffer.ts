import { randomUUID } from 'crypto';
import { getRedis } from './queues.js';
import { logger } from './logger.js';

/**
 * Buffer Redis para agrupamento de mensagens entrantes.
 *
 * Estrategia: por conversation, mantemos um LIST com IDs de messages
 * persistidas no banco + uma string `last_at` com timestamp da ultima.
 *
 * O flusher (job ai-reply delayed) le todos os IDs do LIST quando dispara,
 * limpa o buffer, e processa de uma vez.
 *
 * Tambem mantemos um `window_id` UUID por janela aberta - util pra
 * marcar messages com bufferWindowId no banco.
 */

// TTL alto pra cobrir casos onde DANI esta pausada (cooldown humano de 60min).
// Quando a pausa expira, o job ai-reply re-roda e precisa do windowId ainda valido.
const TTL_SECONDS = 5400; // 90 minutos

function keyBuf(cid: string): string {
  return `fce:buf:${cid}`;
}
function keyLast(cid: string): string {
  return `fce:buf:${cid}:last`;
}
function keyWindow(cid: string): string {
  return `fce:buf:${cid}:win`;
}

/**
 * Adiciona uma mensagem ao buffer da conversation.
 * Retorna:
 *  - windowId atual (UUID) - cria novo se nao existia
 *  - totalNoBuffer
 *  - shouldScheduleFlush (true se foi a primeira da janela)
 */
export async function pushToBuffer(opts: {
  conversationId: string;
  messageId: string;
}): Promise<{ windowId: string; total: number; isNewWindow: boolean }> {
  const redis = getRedis();
  const now = Date.now();

  const [existingWindow, currentLen] = await Promise.all([
    redis.get(keyWindow(opts.conversationId)),
    redis.llen(keyBuf(opts.conversationId)),
  ]);

  let windowId = existingWindow;
  let isNewWindow = false;
  if (!windowId) {
    windowId = randomUUID();
    isNewWindow = true;
    await redis.set(keyWindow(opts.conversationId), windowId, 'EX', TTL_SECONDS);
  }

  // Adiciona ao LIST
  await redis.rpush(keyBuf(opts.conversationId), opts.messageId);
  await redis.expire(keyBuf(opts.conversationId), TTL_SECONDS);
  await redis.set(keyLast(opts.conversationId), String(now), 'EX', TTL_SECONDS);

  return {
    windowId,
    total: currentLen + 1,
    isNewWindow,
  };
}

/**
 * Retorna timestamp da ultima mensagem (ms epoch).
 * Usado pra decidir se devemos flushar ainda.
 */
export async function getLastAt(conversationId: string): Promise<number | null> {
  const redis = getRedis();
  const v = await redis.get(keyLast(conversationId));
  return v ? Number(v) : null;
}

/**
 * Drena tudo do buffer atomicamente.
 * Retorna a lista de messageIds e o windowId que foi usado.
 * Apos drain, novas mensagens criam nova janela.
 */
export async function drainBuffer(conversationId: string): Promise<{
  messageIds: string[];
  windowId: string | null;
}> {
  const redis = getRedis();

  // Lua atomico: pega tudo + limpa + retorna windowId
  const script = `
    local buf = redis.call('LRANGE', KEYS[1], 0, -1)
    local win = redis.call('GET', KEYS[2])
    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[2])
    redis.call('DEL', KEYS[3])
    return { buf, win }
  `;

  const result = (await redis.eval(
    script,
    3,
    keyBuf(conversationId),
    keyWindow(conversationId),
    keyLast(conversationId),
  )) as [string[], string | null];

  return {
    messageIds: result[0] ?? [],
    windowId: result[1] ?? null,
  };
}

/**
 * Restaura um buffer drenado (H2). Usado quando o processamento da DANI
 * FALHA depois do drain destrutivo: re-cria a janela + a lista de IDs pra
 * que o retry (BullMQ attempts) reprocesse, em vez de perder a mensagem.
 * lastAt antigo (default agora-2min) forca flush imediato no retry.
 */
export async function restoreBuffer(opts: {
  conversationId: string;
  windowId: string;
  messageIds: string[];
  lastAtMs?: number;
}): Promise<void> {
  if (opts.messageIds.length === 0) return;
  const redis = getRedis();
  const bufKey = keyBuf(opts.conversationId);
  await redis.del(bufKey);
  for (const id of opts.messageIds) {
    await redis.rpush(bufKey, id);
  }
  await redis.set(keyWindow(opts.conversationId), opts.windowId, 'EX', TTL_SECONDS);
  await redis.set(keyLast(opts.conversationId), String(opts.lastAtMs ?? Date.now() - 120_000), 'EX', TTL_SECONDS);
  await redis.expire(bufKey, TTL_SECONDS);
}

/**
 * Decide se eh hora de flushar ou nao com base no tempo desde a ultima msg.
 *
 * windowMs: tempo de silencio que dispara flush (default 15000ms = 15s)
 * maxMs: tempo maximo desde a primeira msg (cap pra nao esperar pra sempre)
 */
export async function shouldFlush(opts: {
  conversationId: string;
  windowMs: number;
  maxMs: number;
  firstAt: number;
}): Promise<{ flush: boolean; remainingMs: number }> {
  const lastAt = await getLastAt(opts.conversationId);
  if (!lastAt) {
    // Nada no buffer - flush trivial
    return { flush: true, remainingMs: 0 };
  }

  const now = Date.now();
  const sinceLast = now - lastAt;
  const sinceFirst = now - opts.firstAt;

  // Se ja passou do limite max OU silencio suficiente desde a ultima
  if (sinceFirst >= opts.maxMs) {
    return { flush: true, remainingMs: 0 };
  }
  if (sinceLast >= opts.windowMs) {
    return { flush: true, remainingMs: 0 };
  }

  // Reagendar - aguardar mais um pouco
  const remainingMs = Math.min(opts.windowMs - sinceLast, opts.maxMs - sinceFirst);
  return { flush: false, remainingMs: Math.max(remainingMs, 500) };
}

export async function logBufferState(conversationId: string): Promise<void> {
  const redis = getRedis();
  const [len, win, last] = await Promise.all([
    redis.llen(keyBuf(conversationId)),
    redis.get(keyWindow(conversationId)),
    redis.get(keyLast(conversationId)),
  ]);
  logger.debug(
    { conversationId, len, windowId: win, lastAt: last },
    '[Buffer] state',
  );
}
