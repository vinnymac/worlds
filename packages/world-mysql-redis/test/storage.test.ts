import { MySqlContainer } from '@testcontainers/mysql';
import { RedisContainer } from '@testcontainers/redis';
import type { Step, WorkflowRun } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

describe('Storage (MySQL + Redis integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on docker containers', () => {});
    return;
  }

  let mysqlContainer: Awaited<ReturnType<MySqlContainer['start']>>;
  let redisContainer: Awaited<ReturnType<RedisContainer['start']>>;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;
  let redisClient: Redis;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;
  let events: ReturnType<typeof createEventsStorage>;

  async function truncateTables() {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_events`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_steps`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_hooks`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_runs`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_stream_chunks`');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    // Flush Redis
    await redisClient.flushdb();
  }

  /**
   * Helper: create a run via run_created event and return the run entity.
   */
  async function createRun(opts?: {
    deploymentId?: string;
    workflowName?: string;
    input?: any;
    executionContext?: Record<string, any>;
  }): Promise<WorkflowRun> {
    const result = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: opts?.deploymentId ?? 'deployment-123',
        workflowName: opts?.workflowName ?? 'test-workflow',
        input: opts?.input ?? [],
        executionContext: opts?.executionContext,
      },
    });
    if (!result.run) {
      throw new Error('Expected run to be created');
    }
    return result.run;
  }

  /**
   * Helper: create a step via step_created event and return the step entity.
   */
  async function createStep(
    runId: string,
    opts?: { stepId?: string; stepName?: string; input?: any },
  ): Promise<Step> {
    const stepId = opts?.stepId ?? 'step-123';
    const result = await events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: {
        stepName: opts?.stepName ?? 'test-step',
        input: opts?.input ?? ['input1'],
      },
    });
    if (!result.step) {
      throw new Error('Expected step to be created');
    }
    return result.step;
  }

  beforeAll(async () => {
    // Start MySQL container
    mysqlContainer = await new MySqlContainer('mysql:8.0')
      .withDatabase('main')
      .withUsername('testuser')
      .withRootPassword('root')
      .withCommand(['--default-authentication-plugin=mysql_native_password'])
      .start();

    const dbUrl = `mysql://root:root@${mysqlContainer.getHost()}:${mysqlContainer.getPort()}/main`;
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_MYSQL_URL = dbUrl;

    // Apply schema
    connection = await mysql.createConnection(dbUrl);

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
      await connection.query(stmt);
    }

    // Start Redis container
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getFirstMappedPort();
    const redisUrl = `redis://${redisHost}:${redisPort}`;
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;

    // Initialize Redis client
    redisClient = new Redis(redisUrl);

    // Initialize Drizzle and storage
    db = drizzle(connection, { schema, mode: 'default' });
    runs = createRunsStorage(db, redisClient);
    steps = createStepsStorage(db, redisClient);
    hooks = createHooksStorage(db, redisClient);
    events = createEventsStorage(db, redisClient);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await redisClient?.disconnect();
    await connection?.end();
    await mysqlContainer?.stop();
    await redisContainer?.stop();
  });

  describe('Event idempotency', () => {
    it('should handle duplicate step_created events', async () => {
      const run = await createRun();
      const stepId = 'step-idempotent-test';

      // First step_created event
      const result1 = await events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      // Duplicate step_created event (replay scenario)
      const result2 = await events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(result2.step).toBeDefined();
      expect(result2.step!.stepId).toBe(stepId);

      // Verify step appears in list query (critical!)
      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);
    });

    it('should handle duplicate run_created events', async () => {
      // First run_created event
      const result1 = await events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-idempotent',
          input: [],
        },
      });
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // Duplicate run_created event (replay scenario)
      const result2 = await events.create(runId, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-idempotent',
          input: [],
        },
      });
      expect(result2.run).toBeDefined();
      expect(result2.run!.runId).toBe(runId);

      const listResult = await runs.list({ workflowName: 'test-workflow-idempotent' });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should handle duplicate hook_created events with different tokens', async () => {
      const run = await createRun();
      const hookId1 = 'hook-idempotent-test-1';
      const hookId2 = 'hook-idempotent-test-2';

      // Test idempotency by creating two separate hooks
      const result1 = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId1,
        eventData: { token: 'test-token-1' },
      });
      expect(result1.hook).toBeDefined();

      const result2 = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId2,
        eventData: { token: 'test-token-2' },
      });
      expect(result2.hook).toBeDefined();

      // Both hooks should be in the index
      const listResult = await hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });
  });

  describe('Basic functionality', () => {
    it('should create and retrieve a run', async () => {
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
      });

      expect(run).toBeDefined();
      expect(run.runId).toBeDefined();
      expect(run.workflowName).toBe('test-workflow');
      expect(run.deploymentId).toBe('test-deployment');
      expect(run.status).toBe('pending');

      const retrieved = await runs.get(run.runId);
      expect(retrieved).toBeDefined();
      expect(retrieved.runId).toBe(run.runId);
    });

    it('should create and retrieve a step', async () => {
      const run = await createRun();
      const step = await createStep(run.runId, {
        stepId: 'test-step-1',
        stepName: 'test-step',
      });

      expect(step).toBeDefined();
      expect(step.stepId).toBe('test-step-1');
      expect(step.stepName).toBe('test-step');
      expect(step.status).toBe('pending');

      const retrieved = await steps.get(run.runId, step.stepId);
      expect(retrieved).toBeDefined();
      expect(retrieved.stepId).toBe(step.stepId);
    });
  });
});
