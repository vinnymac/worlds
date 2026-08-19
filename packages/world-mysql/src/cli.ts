import { config } from 'dotenv';
import mysql from 'mysql2/promise';
import { applyMigrations } from './migrate.js';

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/mysql_test';

  console.log('Setting up MySQL database schema...');
  console.log(`Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`);

  try {
    const connection = await mysql.createConnection(connectionString);

    console.log('\nRunning migrations...');
    await applyMigrations(connection, console.log);

    console.log('\nDatabase schema created successfully!');
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
