import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/mysql_test';

  console.log('Setting up MySQL database schema...');
  console.log(`Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`);

  try {
    const connection = await mysql.createConnection(connectionString);

    // Read all migration SQL files
    const migrationsDir = join(__dirname, '..', 'migrations');

    // Read migration files in order
    const migrationFiles = [
      '0000_initial.sql',
      '0001_events_occurred_at.sql',
      '0002_spec_current_queue_streams.sql',
      '0003_runs_state_updated_at.sql',
    ];

    for (const file of migrationFiles) {
      const migrationPath = join(migrationsDir, file);
      const migrationSQL = await readFile(migrationPath, 'utf-8');

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

    console.log('Database schema created successfully!');
    console.log('\nCreated tables:');
    console.log('  - workflow.workflow_runs');
    console.log('  - workflow.workflow_events');
    console.log('  - workflow.workflow_steps');
    console.log('  - workflow.workflow_hooks');
    console.log('  - workflow.workflow_stream_chunks');
    console.log('  - workflow.workflow_jobs');
    console.log('  - workflow.workflow_job_idempotency');

    await connection.end();
    process.exit(0);
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
