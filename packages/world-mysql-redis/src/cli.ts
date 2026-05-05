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

    // Read migration files in order
    const migrationFiles = ['0000_initial.sql'];

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
