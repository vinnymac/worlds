import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type mysql from 'mysql2/promise';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Apply every migration in migrations/ in numbered order, so the test schema
 * is always exactly what `world-mysql-setup` provisions. Keeps test DDL
 * coherent with schema.ts by construction instead of by copy-paste.
 */
export async function applyMigrations(connection: mysql.Connection): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const migrationSQL = await readFile(join(migrationsDir, file), 'utf-8');

    // MySQL doesn't support multi-statement by default, split on semicolons.
    // Skip chunks that contain only `--` comments (e.g. a trailing comment).
    const statements = migrationSQL
      .split(';')
      .map((s) => s.trim())
      .filter((s) =>
        s.split('\n').some((line) => line.trim().length > 0 && !line.trim().startsWith('--')),
      );

    for (const statement of statements) {
      // query() (text protocol) — some DDL is not supported by the
      // prepared statement protocol that execute() uses.
      await connection.query(statement);
    }
  }
}
