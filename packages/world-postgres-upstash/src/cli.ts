import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://localhost:5432/postgres_upstash_test';

  console.log('🔧 Setting up database schema...');
  console.log(
    `📍 Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`
  );

  try {
    const sql = postgres(connectionString);

    // Read the migration SQL file
    // The migrations are in ../migrations, and this CLI is in dist/
    // So we need to go up one level from dist/ to reach migrations/
    const migrationPath = join(
      __dirname,
      '..',
      'migrations',
      '0000_tired_cyclops.sql'
    );
    const migrationSQL = await readFile(migrationPath, 'utf-8');

    // Execute the migration
    await sql.unsafe(migrationSQL);

    console.log('✅ Database schema created successfully!');
    console.log('\nCreated tables:');
    console.log('  - workflow_runs');
    console.log('  - workflow_events');
    console.log('  - workflow_steps');
    console.log('  - workflow_hooks');
    console.log('  - workflow_stream_chunks');

    await sql.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to setup database:', error);
    process.exit(1);
  }
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}

export { setupDatabase };
