import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL || 'postgresql://fce:changeme@localhost:5432/fce';

const pool = new Pool({ connectionString, max: 1 });
const db = drizzle(pool);

async function main() {
  console.log('[Migrate] Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[Migrate] Migrations applied successfully');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Migrate] Error:', err);
  process.exit(1);
});
