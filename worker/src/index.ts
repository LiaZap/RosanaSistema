import { Worker, Queue } from 'bullmq';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  username: process.env.REDIS_USERNAME || undefined,
  maxRetriesPerRequest: null,
};

async function main() {
  // Verify Redis
  try {
    const healthQueue = new Queue('_worker-health', { connection });
    await healthQueue.close();
    logger.info('[Worker] Redis connected');
  } catch (err) {
    logger.error({ err }, '[Worker] Redis unreachable — aborting');
    process.exit(1);
  }

  // Placeholder worker — processes 'dani-queue' jobs
  const daniWorker = new Worker(
    'dani-queue',
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, '[Worker] Received job (placeholder)');
      // Real DANI orchestrator will be added in Phase 2
    },
    { connection, concurrency: 5 },
  );

  daniWorker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, '[Worker] Job completed');
  });

  daniWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, '[Worker] Job failed');
  });

  logger.info('[Worker] FCE Worker v0.1.0 ready (placeholder mode)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`[Worker] ${signal} received — shutting down`);
    await daniWorker.close();
    logger.info('[Worker] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
