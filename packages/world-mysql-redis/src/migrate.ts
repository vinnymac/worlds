import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Migration files in application order. Append-only: 0001 shipped in
 * published releases, so it stays even though 0003 drops the (always-empty)
 * outbox table it created.
 */
export const MIGRATION_FILES = [
  '0000_initial.sql',
  '0001_outbox.sql',
  '0002_events_occurred_at.sql',
  '0003_drop_outbox.sql',
  '0004_steps_status_cancelled.sql',
  '0005_stream_chunks_run_id.sql',
  '0006_runs_state_updated_at.sql',
  '0007_events_entity_creation_unique.sql',
];

/**
 * MySQL errnos that prove the statement's effect is already present. DDL is
 * atomic per statement in MySQL 8, so one of these on a re-run means the
 * whole statement applied in a previous run. This is how databases
 * provisioned before the ledger existed (and runs interrupted mid-file,
 * which the ledger cannot cover because MySQL DDL auto-commits) converge.
 */
const ALREADY_APPLIED_ERRNOS = new Set([
  1050, // ER_TABLE_EXISTS_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
]);

function isAlreadyAppliedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    typeof error.errno === 'number' &&
    ALREADY_APPLIED_ERRNOS.has(error.errno)
  );
}

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

/**
 * Apply every migration exactly once, tracked in `workflow`.`__migrations`
 * so setup is safe to re-run against a live database.
 */
export async function applyMigrations(
  connection: Connection,
  log: (line: string) => void = () => {},
): Promise<void> {
  // Refuse to run against a migrations directory this list has drifted from:
  // silently skipping an unknown file would ship a half-migrated schema.
  const onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
  const unknown = onDisk.filter((f) => !MIGRATION_FILES.includes(f));
  if (unknown.length > 0) {
    throw new Error(`Migration files not in MIGRATION_FILES: ${unknown.join(', ')}`);
  }

  await connection.query('CREATE SCHEMA IF NOT EXISTS `workflow`');
  await connection.query(
    'CREATE TABLE IF NOT EXISTS `workflow`.`__migrations` (' +
      '`tag` VARCHAR(255) NOT NULL PRIMARY KEY, ' +
      '`applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
      ') ROW_FORMAT=DYNAMIC',
  );
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT `tag` FROM `workflow`.`__migrations`',
  );
  const applied = new Set(rows.map((row) => String(row.tag)));

  for (const file of MIGRATION_FILES) {
    const tag = file.replace(/\.sql$/, '');
    if (applied.has(tag)) {
      log(`  Skipped (already applied): ${file}`);
      continue;
    }
    const migrationSQL = await readFile(join(migrationsDir, file), 'utf-8');
    for (const statement of splitStatements(migrationSQL)) {
      try {
        // query() (text protocol); some DDL is not supported by the
        // prepared statement protocol that execute() uses.
        await connection.query(statement);
      } catch (error) {
        if (isAlreadyAppliedError(error)) {
          log(`  Skipped statement (already applied): ${statement.split('\n')[0]}`);
          continue;
        }
        throw error;
      }
    }
    // Recording cannot be atomic with the DDL above (MySQL DDL
    // auto-commits); the errno tolerance makes the gap safe to replay.
    await connection.query('INSERT INTO `workflow`.`__migrations` (`tag`) VALUES (?)', [tag]);
    log(`  Applied: ${file}`);
  }
}
