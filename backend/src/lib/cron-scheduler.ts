import cron from 'node-cron';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, blingCredentials, cloudinaryCredentials } from '../db/schema.js';
import { syncBlingCatalog } from './bling-sync.js';
import { uploadPendingImages } from './cloudinary-client.js';
import { cachePendingProductImages } from './minio-cache.js';
import { runFollowupTick } from './followup-agent.js';
import { logger } from './logger.js';

/**
 * Cron scheduler que roda jobs periodicos.
 *
 * Jobs:
 *  - Bling sync       a cada 5h (toda conta com refresh_token)
 *  - Cloudinary       a cada 1h (toda conta com credentials)
 *
 * Limitacao atual: se houver multiplas instancias do fce-api,
 * cada uma roda o cron. Pra producao multi-instancia precisa de
 * lock no Redis (futuro - usar bullmq scheduled jobs).
 */

const TZ = 'America/Sao_Paulo';

let started = false;

export function startCronJobs(): void {
  if (started) {
    logger.warn('[Cron] already started, skipping');
    return;
  }
  started = true;

  // ── Bling sync: a cada 5h ────────────────────────
  cron.schedule(
    '0 */5 * * *', // minuto 0 a cada 5 horas
    async () => {
      logger.info('[Cron] Bling sync job tick');
      try {
        const accounts = await db
          .select({ accountId: blingCredentials.accountId })
          .from(blingCredentials)
          .where(isNotNull(blingCredentials.refreshToken));

        for (const acc of accounts) {
          try {
            const result = await syncBlingCatalog({ accountId: acc.accountId });
            logger.info(
              {
                accountId: acc.accountId,
                inserted: result.productsInserted,
                updated: result.productsUpdated,
                ok: result.ok,
              },
              '[Cron] Bling sync done for account',
            );
          } catch (err) {
            logger.error(
              { accountId: acc.accountId, err: (err as Error).message },
              '[Cron] Bling sync FAILED for account',
            );
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, '[Cron] Bling sync job error');
      }
    },
    { timezone: TZ },
  );

  // ── Cloudinary upload: a cada 1h ─────────────────
  cron.schedule(
    '0 * * * *', // minuto 0 toda hora
    async () => {
      logger.info('[Cron] Cloudinary upload job tick');
      try {
        const accounts = await db
          .select({ accountId: cloudinaryCredentials.accountId })
          .from(cloudinaryCredentials)
          .where(isNotNull(cloudinaryCredentials.apiSecret));

        for (const acc of accounts) {
          try {
            const result = await uploadPendingImages({
              accountId: acc.accountId,
              maxItems: 50, // menor em cron pra nao consumir todos os creditos
            });
            if (result.processed > 0) {
              logger.info(
                {
                  accountId: acc.accountId,
                  uploaded: result.uploaded,
                  failed: result.failed,
                },
                '[Cron] Cloudinary batch done',
              );
            }
          } catch (err) {
            logger.error(
              { accountId: acc.accountId, err: (err as Error).message },
              '[Cron] Cloudinary FAILED for account',
            );
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, '[Cron] Cloudinary job error');
      }
    },
    { timezone: TZ },
  );

  // ── MinIO product image cache: a cada 30min ─────
  cron.schedule(
    '*/30 * * * *',
    async () => {
      logger.info('[Cron] MinIO image cache tick');
      try {
        const allAccounts = await db.select({ id: accounts.id }).from(accounts);
        for (const acc of allAccounts) {
          try {
            const result = await cachePendingProductImages({
              accountId: acc.id,
              maxItems: 100,
            });
            if (result.uploaded > 0) {
              logger.info(
                { accountId: acc.id, uploaded: result.uploaded, failed: result.failed },
                '[Cron] MinIO cache done for account',
              );
            }
          } catch (err) {
            logger.error(
              { accountId: acc.id, err: (err as Error).message },
              '[Cron] MinIO cache FAILED for account',
            );
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, '[Cron] MinIO cache job error');
      }
    },
    { timezone: TZ },
  );

  // ── Follow-up tick: a cada 5 min ─────────────────
  cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        await runFollowupTick();
      } catch (err) {
        logger.error({ err: (err as Error).message }, '[Cron] Followup tick error');
      }
    },
    { timezone: TZ },
  );

  // ── Auto-reativar DANI após X min: a cada 5 min ─────
  // Reativa quando:
  //  - status='human' E lastHumanAt < NOW - pauseMin
  //  OU
  //  - status='human' E lastHumanAt IS NULL E lastMessageAt < NOW - pauseMin
  //    (conversas antigas que ficaram com status=human mas sem timestamp)
  // Apos reativar, dispara ai-reply pra drenar mensagens pendentes
  // do cliente que chegaram durante a pausa.
  cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        const { db } = await import('../db/client.js');
        const { conversations, ninaSettings, contacts, messages } = await import('../db/schema.js');
        const { sql, eq, and, isNull, desc, inArray } = await import('drizzle-orm');
        const { aiReplyQueue } = await import('./queues.js');
        const { getRedis } = await import('./queues.js');
        const { restoreBuffer } = await import('./inbound-buffer.js');

        const settings = await db
          .select({
            accountId: ninaSettings.accountId,
            pauseMin: ninaSettings.pauseAfterHumanMinutes,
          })
          .from(ninaSettings);
        let total = 0;
        let triggered = 0;
        const redis = getRedis();

        for (const s of settings) {
          const pauseMinInt = Number.isFinite(s.pauseMin) ? s.pauseMin : 60;
          const reactivated = await db
            .update(conversations)
            .set({ status: 'nina', updatedAt: new Date() })
            .where(
              sql`${conversations.accountId} = ${s.accountId}
                AND ${conversations.status} = 'human'
                AND (
                  ${conversations.lastHumanAt} < NOW() - INTERVAL '${sql.raw(String(pauseMinInt))} minutes'
                  OR (
                    ${conversations.lastHumanAt} IS NULL
                    AND ${conversations.lastMessageAt} < NOW() - INTERVAL '${sql.raw(String(pauseMinInt))} minutes'
                  )
                )`,
            )
            .returning({
              id: conversations.id,
              accountId: conversations.accountId,
              contactId: conversations.contactId,
            });
          total += reactivated.length;

          if (reactivated.length > 0) {
            logger.info(
              { accountId: s.accountId, pauseMin: pauseMinInt, reactivated: reactivated.length },
              '[Cron] auto-reativou conversas',
            );

            // Para cada conversa reativada: se tem ultima msg do CLIENTE pendente
            // (que veio apos a ultima msg do humano), dispara ai-reply.
            for (const conv of reactivated) {
              try {
                // Pega ultima msg da conversa
                const lastMsg = await db
                  .select({
                    id: messages.id,
                    fromType: messages.fromType,
                    bufferWindowId: messages.bufferWindowId,
                  })
                  .from(messages)
                  .where(eq(messages.conversationId, conv.id))
                  .orderBy(desc(messages.createdAt))
                  .limit(1);

                if (!lastMsg[0] || lastMsg[0].fromType !== 'user') continue;

                // Pega phone do contato
                const ct = await db
                  .select({ phone: contacts.phoneNumber })
                  .from(contacts)
                  .where(eq(contacts.id, conv.contactId))
                  .limit(1);
                if (!ct[0]) continue;

                // M4: pega as msgs do user pendentes (sem bufferWindowId) e
                // popula o buffer COMPLETO via restoreBuffer (LIST + win + last).
                // Antes so gravava ':win' -> drainBuffer lia LIST vazia -> a
                // mensagem ficava orfa e a DANI nao respondia pos-cooldown.
                const { randomUUID } = await import('crypto');
                const windowId = lastMsg[0].bufferWindowId ?? randomUUID();
                const pendingUser = await db
                  .select({ id: messages.id })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.conversationId, conv.id),
                      eq(messages.fromType, 'user'),
                      isNull(messages.bufferWindowId),
                    ),
                  )
                  .orderBy(messages.createdAt);
                const ids = pendingUser.length > 0 ? pendingUser.map((m) => m.id) : [lastMsg[0].id];
                await db
                  .update(messages)
                  .set({ bufferWindowId: windowId })
                  .where(inArray(messages.id, ids));
                await restoreBuffer({ conversationId: conv.id, windowId, messageIds: ids });

                await aiReplyQueue.add(
                  'process',
                  {
                    accountId: conv.accountId,
                    conversationId: conv.id,
                    contactId: conv.contactId,
                    phoneNumber: ct[0].phone,
                    bufferWindowId: windowId,
                  },
                  {
                    jobId: `ai_reactivate_${conv.id}_${Date.now()}`,
                    delay: 1500, // pequena margem
                  },
                );
                triggered++;
              } catch (err) {
                logger.warn(
                  { conversationId: conv.id, err: (err as Error).message },
                  '[Cron] falha ao disparar ai-reply pos reativacao',
                );
              }
            }
          }
        }
        if (total > 0) {
          logger.info({ total, triggered }, '[Cron] auto-reactivate done');
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, '[Cron] auto-reactivate error');
      }
    },
    { timezone: TZ },
  );

  logger.info(
    {
      jobs: [
        'bling-sync (0 */5 * * *)',
        'cloudinary-upload (0 * * * *)',
        'minio-image-cache (*/30 * * * *)',
        'followup-tick (*/5 * * * *)',
        'auto-reactivate (*/10 * * * *)',
      ],
      tz: TZ,
    },
    '[Cron] Scheduler started',
  );
}

/**
 * Rodar um job manualmente (acionado por endpoint /cron/trigger).
 * Util pra testar sem esperar.
 */
export async function runJobManually(job: 'bling' | 'cloudinary', accountId: string): Promise<unknown> {
  if (job === 'bling') {
    return await syncBlingCatalog({ accountId });
  }
  if (job === 'cloudinary') {
    return await uploadPendingImages({ accountId, maxItems: 50 });
  }
  throw new Error('Unknown job');
}
