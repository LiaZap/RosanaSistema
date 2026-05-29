import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { rawQuery, closePool } from './db/client.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import daniRoutes from './routes/dani.js';
import blingRoutes from './routes/bling.js';
import whatsappRoutes from './routes/whatsapp.js';

const app = new Hono();

// ── Middleware ────────────────────────────────────────

app.use(
  '*',
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);

app.onError(errorHandler);

// ── Routes ───────────────────────────────────────────

app.route('/auth', authRoutes);
app.route('/dani', daniRoutes);
app.route('/bling', blingRoutes);
app.route('/whatsapp', whatsappRoutes);
app.route('', healthRoutes);

// ── Bootstrap ────────────────────────────────────────

const port = Number(process.env.API_PORT) || 3001;

async function main() {
  try {
    await rawQuery('SELECT 1');
    logger.info('[API] Postgres connected');
  } catch (err) {
    logger.error({ err }, '[API] Postgres unreachable — aborting');
    process.exit(1);
  }

  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info(`[API] FCE Backend v0.1.0 on http://localhost:${port}`);
    logger.info('[API] Routes: /health /auth/* /dani/* /bling/* /whatsapp/*');
  });

  // ── Graceful shutdown ──

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
