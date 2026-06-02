import { logger } from './logger.js';

/**
 * Sistema simples de eventos in-process via EventEmitter pattern.
 * Endpoint SSE subscreve, lib emite via emitEvent.
 *
 * Não persiste — se cliente desconecta perde eventos antigos.
 * Pra produção em escala, usar Redis Pub/Sub.
 */

export type FceEvent =
  | { type: 'deal:created'; accountId: string; dealId: string; title: string; byAi: boolean }
  | { type: 'lead:new'; accountId: string; contactName: string | null; phone: string; conversationId: string }
  | { type: 'appointment:created'; accountId: string; title: string; when: string }
  | { type: 'message:received'; accountId: string; contactName: string | null; preview: string };

type Listener = (ev: FceEvent) => void;

// Map<accountId, Set<Listener>>
const listeners = new Map<string, Set<Listener>>();

export function subscribe(accountId: string, listener: Listener): () => void {
  if (!listeners.has(accountId)) listeners.set(accountId, new Set());
  listeners.get(accountId)!.add(listener);
  return () => {
    listeners.get(accountId)?.delete(listener);
  };
}

export function emitEvent(ev: FceEvent): void {
  const set = listeners.get(ev.accountId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(ev);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[Events] listener error');
    }
  }
}
