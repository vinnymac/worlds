import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPECTED_TABLES = [
  'workflow_runs',
  'workflow_events',
  'workflow_steps',
  'workflow_hooks',
  'workflow_stream_chunks',
  'workflow_outbox',
];

const MIGRATION_FILES = [
  '0000_cheerful_kylun.sql',
  '0001_sudden_wilson_fisk.sql',
  '0002_outbox_and_notify.sql',
];

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.WORKFLOW_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://world:world@localhost:5432/world';

  console.log('Setting up database schema...');
  console.log(`Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`);

  try {
    const sql = postgres(connectionString);

    // ---- Step 1: Run migrations ----
    console.log('\n[1/3] Running migrations...');
    const migrationsDir = join(__dirname, '..', 'src', 'drizzle', 'migrations');

    for (const file of MIGRATION_FILES) {
      const migrationPath = join(migrationsDir, file);
      const migrationSQL = await readFile(migrationPath, 'utf-8');
      await sql.unsafe(migrationSQL);
      console.log(`  Applied: ${file}`);
    }

    // ---- Step 2: Verify LISTEN/NOTIFY trigger ----
    console.log('\n[2/3] Verifying triggers...');
    const triggers = await sql`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'workflow'
        AND event_object_table = 'workflow_runs'
        AND trigger_name = 'runs_notify_update'
    `;
    if (triggers.length > 0) {
      console.log('  LISTEN/NOTIFY trigger: OK (runs_notify_update)');
    } else {
      console.warn('  WARNING: LISTEN/NOTIFY trigger not found. Real-time updates will not work.');
    }

    // ---- Step 3: Verify schema ----
    console.log('\n[3/3] Verifying schema...');
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'workflow'
      ORDER BY table_name
    `;
    const tableNames = tables.map((t) => t.table_name);
    let allPresent = true;
    for (const expected of EXPECTED_TABLES) {
      if (tableNames.includes(expected)) {
        console.log(`  ${expected}: OK`);
      } else {
        console.error(`  ${expected}: MISSING`);
        allPresent = false;
      }
    }

    if (!allPresent) {
      console.error('\nSetup completed with warnings: some expected tables are missing.');
    } else {
      console.log('\nSetup complete. All tables and triggers verified.');
    }

    await sql.end();
    process.exit(allPresent ? 0 : 1);
  } catch (error) {
    console.error('Failed to setup database:', error);
    process.exit(1);
  }
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}

export { setupDatabase };
