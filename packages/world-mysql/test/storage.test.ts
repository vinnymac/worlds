import { MySqlContainer } from '@testcontainers/mysql';
import type { Step, WorkflowRun } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

describe('Storage (MySQL integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<MySqlContainer['start']>>;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;
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
  }

  async function createRun(workflowName = 'test-workflow'): Promise<WorkflowRun> {
    const result = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'test-deployment',
        workflowName,
        input: [],
      },
    });
    if (!result.run) throw new Error('Expected run to be created');
    return result.run;
  }

  async function createStep(runId: string, stepId = 'step-123'): Promise<Step> {
    const result = await events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'test-step', input: ['input1'] },
    });
    if (!result.step) throw new Error('Expected step to be created');
    return result.step;
  }

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.0')
      .withDatabase('main')
      .withUsername('testuser')
      .withRootPassword('root')
      .withCommand(['--default-authentication-plugin=mysql_native_password'])
      .start();

    const dbUrl = `mysql://root:root@${container.getHost()}:${container.getPort()}/main`;
    connection = await mysql.createConnection(dbUrl);

    await connection.query('CREATE SCHEMA IF NOT EXISTS `workflow`');
    await connection.query(`CREATE TABLE \`workflow\`.\`workflow_runs\` (
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
    )`);
    await connection.query(`CREATE TABLE \`workflow\`.\`workflow_events\` (
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
    )`);
    await connection.query(`CREATE TABLE \`workflow\`.\`workflow_steps\` (
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
    )`);
    await connection.query(`CREATE TABLE \`workflow\`.\`workflow_hooks\` (
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
    )`);
    await connection.query(`CREATE TABLE \`workflow\`.\`workflow_stream_chunks\` (
      \`id\` VARCHAR(255) NOT NULL,
      \`stream_id\` VARCHAR(255) NOT NULL,
      \`data\` BLOB NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`eof\` BOOLEAN NOT NULL,
      \`sequence\` BIGINT NOT NULL,
      PRIMARY KEY (\`stream_id\`, \`id\`),
      INDEX \`idx_stream_chunks_sequence\` (\`stream_id\`, \`sequence\`)
    )`);

    db = drizzle(connection, { schema, mode: 'default' });
    runs = createRunsStorage(db);
    steps = createStepsStorage(db);
    hooks = createHooksStorage(db);
    events = createEventsStorage(db);
  }, 120_000);

  beforeEach(truncateTables);

  afterAll(async () => {
    await connection?.end();
    await container?.stop();
  });

  describe('Event idempotency', () => {
    it('should handle duplicate run_created events', async () => {
      const workflowName = 'test-workflow-idempotent';
      const eventData = {
        eventType: 'run_created' as const,
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      };

      const result1 = await events.create(null, eventData);
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      const result2 = await events.create(runId, eventData);
      expect(result2.run).toBeDefined();
      expect(result2.run!.runId).toBe(runId);

      const listResult = await runs.list({ workflowName });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should handle duplicate step_created events', async () => {
      const run = await createRun();
      const stepId = 'step-idempotent';
      const eventData = {
        eventType: 'step_created' as const,
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      };

      const result1 = await events.create(run.runId, eventData);
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      const result2 = await events.create(run.runId, eventData);
      expect(result2.step).toBeDefined();
      expect(result2.step!.stepId).toBe(stepId);

      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);
    });

    it('should handle duplicate hook_created events', async () => {
      const run = await createRun();
      const hookId1 = 'hook-idempotent-1';
      const hookId2 = 'hook-idempotent-2';

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

      const listResult = await hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun();

      // First run_started
      const result1 = await events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result1.run?.status).toBe('running');
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario — should be idempotent)
      const result2 = await events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result2.run?.status).toBe('running');
      // startedAt should be preserved from first call
      expect(result2.run!.startedAt!.getTime()).toBe(originalStartedAt.getTime());

      // Only ONE run_started event should exist in the log
      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const runStartedEvents = eventList.data.filter((e) => e.eventType === 'run_started');
      expect(runStartedEvents).toHaveLength(1);
    });
  });

  it('should create and retrieve entities', async () => {
    const run = await createRun();
    expect(run.runId).toBeDefined();
    expect(run.status).toBe('pending');

    const retrieved = await runs.get(run.runId);
    expect(retrieved.runId).toBe(run.runId);

    const step = await createStep(run.runId, 'test-step-1');
    expect(step.stepId).toBe('test-step-1');
    expect(step.status).toBe('pending');

    const retrievedStep = await steps.get(run.runId, step.stepId);
    expect(retrievedStep.stepId).toBe(step.stepId);
  });
});
