import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '@workflow/world-testing';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on docker containers
const shouldSkipTests = process.platform === 'win32';

if (shouldSkipTests) {
  test.skip('skipped on Windows since it relies on docker containers', () => {});
} else {
  let postgresContainer: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let qstashContainer: StartedTestContainer;

  beforeAll(async () => {
    // Start PostgreSQL container with explicit wait for database readiness
    postgresContainer = await new PostgreSqlContainer(
      'public.ecr.aws/docker/library/postgres:15-alpine'
    )
      .withDatabase('main')
      .withUsername('postgres')
      .withPassword('postgres')
      .withWaitStrategy(
        Wait.forLogMessage('database system is ready to accept connections', 2)
      )
      .start();

    console.log('[test beforeAll] PostgreSQL container started');

    // Get direct connection URI
    const dbUrl = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    // Apply schema using direct PostgreSQL connection
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    // Start QStash dev server container
    qstashContainer = await new GenericContainer(
      'public.ecr.aws/upstash/qstash:latest'
    )
      .withCommand(['qstash', 'dev'])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const qstashPort = qstashContainer.getMappedPort(8080);
    const qstashUrl = `http://localhost:${qstashPort}`;

    console.log('[test beforeAll] QStash container started');
    console.log('[test beforeAll] qstashUrl=', qstashUrl);

    // Set QStash environment variables for tests
    process.env.QSTASH_URL = qstashUrl;
    process.env.QSTASH_TOKEN =
      'eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0='; // Default dev token
  }, 60_000);

  afterAll(async () => {
    await qstashContainer?.stop();
    await postgresContainer?.stop();
  });

  createTestSuite('@fantasticfour/world-postgres-upstash');
}
