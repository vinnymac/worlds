import { MySqlContainer } from '@testcontainers/mysql';
import { createTestSuite } from '@workflow/world-testing';
// Not re-exported from the package entry point and not wired into
// createTestSuite (world-testing 4.1.18); opt in via the deep import.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { afterAll, beforeAll, test } from 'vitest';
import mysql from 'mysql2/promise';
import { applyMigrations } from '../src/migrate.js';

// Skip these tests on Windows since it relies on docker containers
const shouldSkipTests = process.platform === 'win32';

if (shouldSkipTests) {
  test.skip('skipped on Windows since it relies on docker containers', () => {});
} else {
  let mysqlContainer: Awaited<ReturnType<MySqlContainer['start']>>;

  beforeAll(async () => {
    // Start MySQL 8.0+ container (required for SKIP LOCKED support)
    mysqlContainer = await new MySqlContainer('mysql:8.0')
      .withDatabase('main')
      .withUsername('testuser')
      .withRootPassword('root')
      .withCommand(['--default-authentication-plugin=mysql_native_password'])
      .start();

    console.log('[test beforeAll] MySQL container started');

    // Get connection URI
    const dbUrl = `mysql://root:root@${mysqlContainer.getHost()}:${mysqlContainer.getPort()}/main`;
    process.env.DATABASE_URL = dbUrl;

    // Apply the real migrations so the test schema matches production setup
    const connection = await mysql.createConnection(dbUrl);
    await applyMigrations(connection);
    await connection.end();

    console.log('[test beforeAll] MySQL schema applied (including queue tables)');
  }, 60_000);

  afterAll(async () => {
    await mysqlContainer?.stop();
  });

  createTestSuite('./dist/index.js');
  eventLimit('./dist/index.js');
}
