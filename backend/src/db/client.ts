import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL || 'postgresql://fce:changeme@localhost:5432/fce';

export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

/** Raw query helper for health checks */
export async function rawQuery(text: string) {
  const res = await pool.query(text);
  return res.rows;
}

/**
 * Backwards-compat alias for raw SQL (used by dani-orchestrator, products).
 * Usage: const rows = await sql`SELECT ...`  — NOT supported with pg.
 * Use rawQuery() or db.execute() instead. This export exists only to
 * prevent import errors in Phase 2+ files during Phase 1 builds.
 */
export const sql = pool;

/** Graceful pool shutdown */
export async function closePool() {
  await pool.end();
}
