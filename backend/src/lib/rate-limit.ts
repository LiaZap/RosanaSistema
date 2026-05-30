import { getRedis } from './queues.js';
import { logger } from './logger.js';

/**
 * Rate-limiting via Redis sliding window.
 *
 * Casos cobertos (Sprint 11):
 *  - Vision por contato: max 5 / min
 *  - Outbound por contato: max 30 / min
 *  - LLM por conta: max 100 / min
 *
 * Usa INCR + EXPIRE pra implementacao simples.
 */

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterSeconds?: number;
}

async function checkLimit(opts: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const redis = getRedis();
  try {
    const current = await redis.incr(opts.key);
    if (current === 1) {
      await redis.expire(opts.key, opts.windowSeconds);
    }
    if (current > opts.limit) {
      const ttl = await redis.ttl(opts.key);
      return {
        allowed: false,
        current,
        limit: opts.limit,
        retryAfterSeconds: Math.max(1, ttl),
      };
    }
    return { allowed: true, current, limit: opts.limit };
  } catch (err) {
    // Em caso de falha do Redis: fail-open (allowed) e loga
    logger.warn({ err: (err as Error).message, key: opts.key }, '[RateLimit] failed, allowing');
    return { allowed: true, current: 0, limit: opts.limit };
  }
}

export function visionPerContact(contactId: string): Promise<RateLimitResult> {
  return checkLimit({
    key: `fce:rl:vision:${contactId}`,
    limit: 5,
    windowSeconds: 60,
  });
}

export function outboundPerContact(contactId: string): Promise<RateLimitResult> {
  return checkLimit({
    key: `fce:rl:out:${contactId}`,
    limit: 30,
    windowSeconds: 60,
  });
}

export function llmPerAccount(accountId: string): Promise<RateLimitResult> {
  return checkLimit({
    key: `fce:rl:llm:${accountId}`,
    limit: 100,
    windowSeconds: 60,
  });
}
