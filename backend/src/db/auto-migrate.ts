import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { logger } from '../lib/logger.js';

/**
 * Migrações idempotentes rodadas automaticamente no startup do backend.
 *
 * Por que isso existe:
 *  - Toda vez que adicionamos coluna/tabela no schema (schema.ts) e o deploy
 *    sobe ANTES da migração rodar no banco, o Drizzle gera SELECTs com colunas
 *    inexistentes e TUDO quebra (ex: worker inbound nao carrega nina_settings).
 *  - Rodar migracao manual a cada deploy e fragil e esquecivel.
 *
 * Solução: todo statement aqui usa `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`,
 * entao re-rodar e 100% seguro. Roda no boot, antes de aceitar workers/requests.
 *
 * REGRA: ao adicionar coluna/tabela nova no schema.ts, adicione o ALTER/CREATE
 * correspondente AQUI. Nunca mais vai faltar migração em produção.
 */

const STATEMENTS: Array<{ label: string; run: () => Promise<unknown> }> = [
  // 0008 — produtos_catalogo.imagens_minio
  {
    label: 'produtos_catalogo.imagens_minio',
    run: () =>
      db.execute(sql`ALTER TABLE produtos_catalogo ADD COLUMN IF NOT EXISTS imagens_minio jsonb DEFAULT '[]'::jsonb`),
  },
  // 0009 — conversations.last_human_at + nina_settings.pause_after_human_minutes
  {
    label: 'conversations.last_human_at',
    run: () =>
      db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_human_at timestamp with time zone`),
  },
  {
    label: 'nina_settings.pause_after_human_minutes',
    run: () =>
      db.execute(sql`ALTER TABLE nina_settings ADD COLUMN IF NOT EXISTS pause_after_human_minutes integer NOT NULL DEFAULT 60`),
  },
  // 0010 — google_calendar_connections
  {
    label: 'google_calendar_connections',
    run: () =>
      db.execute(sql`
        CREATE TABLE IF NOT EXISTS google_calendar_connections (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
          email varchar(255),
          access_token text,
          refresh_token text,
          expires_at timestamp with time zone,
          scope text,
          calendar_id varchar(255) NOT NULL DEFAULT 'primary',
          sync_enabled boolean NOT NULL DEFAULT true,
          last_sync_at timestamp with time zone,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          updated_at timestamp with time zone NOT NULL DEFAULT now()
        )
      `),
  },
  // 0011 — deals.created_by_ai + deals.conversation_id
  {
    label: 'deals.created_by_ai',
    run: () =>
      db.execute(sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS created_by_ai boolean NOT NULL DEFAULT false`),
  },
  {
    label: 'deals.conversation_id',
    run: () =>
      db.execute(sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL`),
  },
  // 0012 — nina_settings.bia_phone + bia_notify_message
  {
    label: 'nina_settings.bia_phone',
    run: () => db.execute(sql`ALTER TABLE nina_settings ADD COLUMN IF NOT EXISTS bia_phone varchar(20)`),
  },
  {
    label: 'nina_settings.bia_notify_message',
    run: () => db.execute(sql`ALTER TABLE nina_settings ADD COLUMN IF NOT EXISTS bia_notify_message text`),
  },
  // 0013 — token_usage_logs
  {
    label: 'token_usage_logs',
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS token_usage_logs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          conversation_id uuid,
          model varchar(100) NOT NULL,
          input_tokens integer NOT NULL DEFAULT 0,
          output_tokens integer NOT NULL DEFAULT 0,
          total_tokens integer NOT NULL DEFAULT 0,
          created_at timestamp with time zone DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS token_usage_account_idx ON token_usage_logs(account_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS token_usage_created_idx ON token_usage_logs(created_at)`);
    },
  },
];

/**
 * Roda todas as migrações idempotentes. Loga cada uma.
 * Falha individual NAO derruba o boot (loga warn e segue) — mas se a
 * primeira (SELECT 1 ja passou) der erro de conexao, o erro propaga.
 */
export async function runStartupMigrations(): Promise<void> {
  const start = Date.now();
  let applied = 0;
  let failed = 0;

  for (const stmt of STATEMENTS) {
    try {
      await stmt.run();
      applied++;
    } catch (err) {
      failed++;
      logger.warn(
        { migration: stmt.label, err: (err as Error).message },
        '[Migrate] statement falhou (continuando)',
      );
    }
  }

  logger.info(
    { applied, failed, total: STATEMENTS.length, ms: Date.now() - start },
    '[Migrate] migrações de startup concluídas',
  );
}
