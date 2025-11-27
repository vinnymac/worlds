import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let postgresContainer: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let redisContainer: Awaited<ReturnType<RedisContainer['start']>>;

  beforeAll(async () => {
    // Start PostgreSQL container
    postgresContainer = await new PostgreSqlContainer(
      'postgres:15-alpine'
    ).start();
    const dbUrl = postgresContainer.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    // Start Redis container
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getFirstMappedPort();
    const redisUrl = `redis://${redisHost}:${redisPort}`;
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  afterAll(async () => {
    if (postgresContainer) {
      await postgresContainer.stop();
    }
    if (redisContainer) {
      await redisContainer.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-postgres-redis');
}
