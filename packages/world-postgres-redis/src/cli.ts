import { readdir, readFile } from 'node:fs/promises';
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
  '0003_events_occurred_at.sql',
  '0004_hooks_token_unique_stream_run_id.sql',
  '0005_runs_state_updated_at.sql',
  '0006_events_entity_creation_unique.sql',
];

// Files that must run OUTSIDE a transaction, statement by statement: 0006
// builds its unique index CONCURRENTLY, which refuses to run inside a
// transaction block, and a multi-statement sql.unsafe() string counts as
// one (the simple query protocol wraps it in an implicit transaction).
const NON_TRANSACTIONAL_MIGRATIONS = new Set(['0006_events_entity_creation_unique.sql']);

/**
 * Split a migration file into statements. Comment lines are dropped first: a
 * semicolon inside a `--` comment would otherwise shear the statement in two
 * (this runner has no SQL lexer, and migration comments are prose).
 */
function splitStatements(migrationSQL: string): string[] {
  return migrationSQL
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

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

    // Refuse to run against a migrations directory this list has drifted
    // from: silently skipping an unknown file would ship a half-migrated
    // schema.
    const onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
    const unknown = onDisk.filter((f) => !MIGRATION_FILES.includes(f));
    if (unknown.length > 0) {
      throw new Error(`Migration files not in MIGRATION_FILES: ${unknown.join(', ')}`);
    }

    // Track applied migrations so each file runs exactly once. Databases
    // provisioned before tracking existed have an empty table; that is safe
    // because every shipped migration is idempotent.
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS "workflow"');
    await sql.unsafe(
      'CREATE TABLE IF NOT EXISTS "workflow"."__migrations" ("tag" text PRIMARY KEY, "applied_at" timestamp DEFAULT now() NOT NULL)',
    );
    const appliedRows = await sql`SELECT tag FROM "workflow"."__migrations"`;
    const applied = new Set(appliedRows.map((row) => String(row.tag)));

    // An INVALID index is the residue of a failed CREATE INDEX CONCURRENTLY
    // (it is never used by queries but still taxes every write). Dropping it
    // here is what makes a failed concurrent build recoverable by simply
    // re-running setup: the IF NOT EXISTS in the migration would otherwise
    // see the broken index and skip the rebuild.
    const invalidIndexes = await sql`
      SELECT c.relname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'workflow' AND NOT i.indisvalid
    `;
    for (const index of invalidIndexes) {
      const name = String(index.name);
      console.warn(`  Dropping INVALID index left by a failed concurrent build: ${name}`);
      await sql.unsafe(`DROP INDEX "workflow"."${name}"`);
    }

    for (const file of MIGRATION_FILES) {
      const tag = file.replace(/\.sql$/, '');
      if (applied.has(tag)) {
        console.log(`  Skipped (already applied): ${file}`);
        continue;
      }
      const migrationPath = join(migrationsDir, file);
      const migrationSQL = await readFile(migrationPath, 'utf-8');
      if (NON_TRANSACTIONAL_MIGRATIONS.has(file)) {
        // Statement by statement, outside a transaction (see the set's
        // comment). Not atomic, but every statement in such a file is
        // individually idempotent, so a crash mid-file (index built, tag
        // not yet recorded) heals on the next run.
        for (const statement of splitStatements(migrationSQL)) {
          await sql.unsafe(statement);
        }
        await sql`INSERT INTO "workflow"."__migrations" ("tag") VALUES (${tag})`;
      } else {
        // Apply the migration and record it atomically.
        await sql.begin(async (tx) => {
          await tx.unsafe(migrationSQL);
          await tx`INSERT INTO "workflow"."__migrations" ("tag") VALUES (${tag})`;
        });
      }
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
