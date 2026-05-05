import { MySqlContainer } from '@testcontainers/mysql';
import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, test } from 'vitest';
import mysql from 'mysql2/promise';

// Skip these tests on Windows since it relies on docker containers
const shouldSkipTests = process.platform === 'win32';

if (shouldSkipTests) {
  test.skip('skipped on Windows since it relies on docker containers', () => {});
} else {
  let mysqlContainer: Awaited<ReturnType<MySqlContainer['start']>>;
  let redisContainer: Awaited<ReturnType<RedisContainer['start']>>;

  beforeAll(async () => {
    // Start MySQL container
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
    process.env.WORKFLOW_MYSQL_URL = dbUrl;

    // Apply schema directly using mysql2
    const connection = await mysql.createConnection(dbUrl);

    // Create the workflow schema and tables
    const setupStatements = [
      'CREATE SCHEMA IF NOT EXISTS `workflow`',

      `CREATE TABLE \`workflow\`.\`workflow_runs\` (
        \`id\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`output\` JSON,
        \`output_cbor\` BLOB,
        \`deployment_id\` VARCHAR(255) NOT NULL,
        \`status\` ENUM('pending','running','completed','failed','cancelled') NOT NULL,
        \`name\` VARCHAR(255) NOT NULL,
        \`execution_context\` JSON,
        \`execution_context_cbor\` BLOB,
        \`input\` JSON,
        \`input_cbor\` BLOB,
        \`error\` TEXT,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`completed_at\` TIMESTAMP NULL,
        \`started_at\` TIMESTAMP NULL,
        \`spec_version\` INT,
        \`expired_at\` TIMESTAMP NULL,
        INDEX \`idx_workflow_runs_name\` (\`name\`),
        INDEX \`idx_workflow_runs_status\` (\`status\`)
      )`,

      `CREATE TABLE \`workflow\`.\`workflow_events\` (
        \`id\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`type\` VARCHAR(255) NOT NULL,
        \`correlation_id\` VARCHAR(255),
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`run_id\` VARCHAR(255) NOT NULL,
        \`payload\` JSON,
        \`payload_cbor\` BLOB,
        \`spec_version\` INT,
        INDEX \`idx_workflow_events_run_id\` (\`run_id\`),
        INDEX \`idx_workflow_events_correlation_id\` (\`correlation_id\`)
      )`,

      `CREATE TABLE \`workflow\`.\`workflow_steps\` (
        \`run_id\` VARCHAR(255) NOT NULL,
        \`step_id\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`step_name\` VARCHAR(255) NOT NULL,
        \`status\` ENUM('pending','running','completed','failed') NOT NULL,
        \`input\` JSON,
        \`input_cbor\` BLOB,
        \`output\` JSON,
        \`output_cbor\` BLOB,
        \`error\` TEXT,
        \`attempt\` INT NOT NULL,
        \`started_at\` TIMESTAMP NULL,
        \`completed_at\` TIMESTAMP NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`retry_after\` TIMESTAMP NULL,
        \`spec_version\` INT,
        INDEX \`idx_workflow_steps_run_id\` (\`run_id\`),
        INDEX \`idx_workflow_steps_status\` (\`status\`)
      )`,

      `CREATE TABLE \`workflow\`.\`workflow_hooks\` (
        \`run_id\` VARCHAR(255) NOT NULL,
        \`hook_id\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`token\` VARCHAR(255) NOT NULL,
        \`owner_id\` VARCHAR(255) NOT NULL,
        \`project_id\` VARCHAR(255) NOT NULL,
        \`environment\` VARCHAR(255) NOT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`metadata\` JSON,
        \`metadata_cbor\` BLOB,
        \`spec_version\` INT,
        \`is_webhook\` BOOLEAN,
        INDEX \`idx_workflow_hooks_run_id\` (\`run_id\`),
        INDEX \`idx_workflow_hooks_token\` (\`token\`)
      )`,

      `CREATE TABLE \`workflow\`.\`workflow_stream_chunks\` (
        \`id\` VARCHAR(255) NOT NULL,
        \`stream_id\` VARCHAR(255) NOT NULL,
        \`data\` BLOB NOT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`eof\` BOOLEAN NOT NULL,
        \`sequence\` BIGINT NOT NULL,
        PRIMARY KEY (\`stream_id\`, \`id\`),
        INDEX \`idx_stream_chunks_sequence\` (\`stream_id\`, \`sequence\`)
      )`,
    ];

    for (const stmt of setupStatements) {
      await connection.execute(stmt);
    }

    await connection.end();

    console.log('[test beforeAll] MySQL schema applied');

    // Start Redis container
    redisContainer = await new RedisContainer(
      'public.ecr.aws/docker/library/redis:7-alpine',
    ).start();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getFirstMappedPort();
    const redisUrl = `redis://${redisHost}:${redisPort}`;
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;

    console.log('[test beforeAll] Redis container started');
  }, 120_000);

  afterAll(async () => {
    await mysqlContainer?.stop();
    await redisContainer?.stop();
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-mysql-redis');
}
