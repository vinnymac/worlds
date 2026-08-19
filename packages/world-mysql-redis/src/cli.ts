import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString = process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/world';

  console.log('Setting up MySQL database schema...');
  console.log(`Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`);

  try {
    const connection = await mysql.createConnection(connectionString);

    // Read all migration SQL files
    const migrationsDir = join(__dirname, '..', 'migrations');

    // Read migration files in order. Migration history is append-only: 0001
    // shipped in published releases, so it stays even though 0003 drops the
    // (always-empty) outbox table it created.
    const migrationFiles = [
      '0000_initial.sql',
      '0001_outbox.sql',
      '0002_events_occurred_at.sql',
      '0003_drop_outbox.sql',
      '0004_steps_status_cancelled.sql',
      '0005_stream_chunks_run_id.sql',
      '0006_runs_state_updated_at.sql',
      '0007_events_entity_creation_unique.sql',
    ];

    for (const file of migrationFiles) {
      const migrationPath = join(migrationsDir, file);
      const migrationSQL = await readFile(migrationPath, 'utf-8');

      // MySQL doesn't support multi-statement by default, split on semicolons
      const statements = migrationSQL
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        await connection.execute(statement);
      }
    }

    console.log('Database schema created successfully!');
    console.log('\nCreated tables:');
    console.log('  - workflow.workflow_runs');
    console.log('  - workflow.workflow_events');
    console.log('  - workflow.workflow_steps');
    console.log('  - workflow.workflow_hooks');
    console.log('  - workflow.workflow_stream_chunks');

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
