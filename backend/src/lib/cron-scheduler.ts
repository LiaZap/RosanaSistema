import cron from 'node-cron';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { blingCredentials, cloudinaryCredentials } from '../db/schema.js';
import { syncBlingCatalog } from './bling-sync.js';
import { uploadPendingImages } from './cloudinary-client.js';
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

  logger.info(
    { jobs: ['bling-sync (0 */5 * * *)', 'cloudinary-upload (0 * * * *)'], tz: TZ },
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
