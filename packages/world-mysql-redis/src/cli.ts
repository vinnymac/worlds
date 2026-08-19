import { loadOptionalEnvFile } from '@fantasticfour/shared';
import mysql from 'mysql2/promise';
import { applyMigrations } from './migrate.js';

async function setupDatabase() {
  // Load .env file if it exists.
  loadOptionalEnvFile();

  const connectionString = process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/world';

  console.log('Setting up MySQL database schema...');
  console.log(`Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`);

  let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  let exitCode = 0;

  try {
    connection = await mysql.createConnection(connectionString);

    console.log('\nRunning migrations...');
    await applyMigrations(connection, console.log);

    console.log('\nDatabase schema created successfully!');
    console.log('\nCreated tables:');
    console.log('  - workflow.workflow_runs');
    console.log('  - workflow.workflow_events');
    console.log('  - workflow.workflow_steps');
    console.log('  - workflow.workflow_hooks');
    console.log('  - workflow.workflow_stream_chunks');
  } catch (error) {
    exitCode = 1;
    console.error('Failed to setup database:', error);
  } finally {
    await connection?.end().catch(() => {});
  }

  process.exit(exitCode);
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}

export { setupDatabase };
