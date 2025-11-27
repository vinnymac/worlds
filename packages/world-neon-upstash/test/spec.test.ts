import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '@workflow/world-testing';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
// Also skip if running locally since Neon HTTP driver requires Neon proxy
const shouldSkipTests =
  process.platform === 'win32' || process.env.CI !== 'true';

if (shouldSkipTests) {
  test.skip('skipped: Neon HTTP driver requires Neon proxy, not available in local tests', () => {});
} else {
  let postgresContainer: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let qstashContainer: StartedTestContainer;

  beforeAll(async () => {
    // Start PostgreSQL container for Neon database simulation
    postgresContainer = await new PostgreSqlContainer(
      'postgres:15-alpine'
    ).start();
    const dbUrl = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    // Apply schema
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // Start QStash dev server container
    qstashContainer = await new GenericContainer(
      'public.ecr.aws/upstash/qstash:latest'
    )
      .withCommand(['qstash', 'dev'])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const qstashHost = qstashContainer.getHost();
    const qstashPort = qstashContainer.getMappedPort(8080);
    const qstashUrl = `http://${qstashHost}:${qstashPort}`;
    process.env.QSTASH_URL = qstashUrl;
    process.env.QSTASH_TOKEN = 'local-dev-token';
    console.log('[test beforeAll] QStash container started');
    console.log('[test beforeAll] qstashUrl=', qstashUrl);
  }, 120_000);

  afterAll(async () => {
    if (postgresContainer) {
      await postgresContainer.stop();
    }
    if (qstashContainer) {
      await qstashContainer.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('./dist/index.js');
}
