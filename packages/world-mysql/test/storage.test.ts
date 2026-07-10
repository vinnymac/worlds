import { MySqlContainer } from '@testcontainers/mysql';
import { EntityConflictError, TooEarlyError } from '@workflow/errors';
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
import { applyMigrations } from './migrate.js';

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

    await applyMigrations(connection);

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

  it('persists specVersion on runs, steps, hooks and events', async () => {
    const run = await createRun();
    expect(run.specVersion).toBeTypeOf('number');

    const step = await createStep(run.runId, 'step-spec-version');
    expect(step.specVersion).toBeTypeOf('number');

    const hookResult = await events.create(run.runId, {
      eventType: 'hook_created',
      correlationId: 'hook-spec-version',
      eventData: { token: 'token-spec-version' },
    });
    expect(hookResult.hook?.specVersion).toBeTypeOf('number');
  });

  describe('Terminal transition guards', () => {
    it('rejects run_failed after run_completed with EntityConflictError', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      await events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: ['done'] },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'run_failed',
          eventData: { error: 'boom' },
        }),
      ).rejects.toSatisfy((err: unknown) => EntityConflictError.is(err));

      const retrieved = await runs.get(run.runId);
      expect(retrieved.status).toBe('completed');
    });

    it('rejects step_completed on a terminal step with EntityConflictError', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-terminal');
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: ['ok'] },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'step_completed',
          correlationId: step.stepId,
          eventData: { result: ['dup'] },
        }),
      ).rejects.toSatisfy((err: unknown) => EntityConflictError.is(err));
    });
  });

  describe('retryAfter backoff', () => {
    it('throws TooEarlyError when step_started arrives before retryAfter', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-retry');
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: {
          error: 'transient',
          retryAfter: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'step_started',
          correlationId: step.stepId,
        }),
      ).rejects.toSatisfy(
        (err: unknown) => TooEarlyError.is(err) && (err as TooEarlyError).retryAfter! > 0,
      );
    });

    it('clears retryAfter once the step starts after the backoff window', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-retry-clear');
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: {
          error: 'transient',
          retryAfter: new Date(Date.now() - 1_000),
        },
      });

      const restarted = await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      expect(restarted.step?.status).toBe('running');
      expect(restarted.step?.retryAfter).toBeUndefined();
      expect(restarted.step?.attempt).toBe(2);
    });
  });

  describe('hook_created semantics', () => {
    it('throws EntityConflictError on a replayed hook_created for the same hook', async () => {
      const run = await createRun();
      const create = () =>
        events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'hook-replay',
          eventData: { token: 'token-replay' },
        });

      const first = await create();
      expect(first.hook?.hookId).toBe('hook-replay');

      await expect(create()).rejects.toSatisfy((err: unknown) => EntityConflictError.is(err));

      // No hook_conflict event may be persisted for the run's own hook
      const eventList = await events.list({ runId: run.runId });
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
    });

    it('completes the partial write when the hook row exists without its event', async () => {
      const run = await createRun();
      // Simulate a crash between the hook INSERT and the event INSERT
      await db.insert(schema.hooks).values({
        runId: run.runId,
        hookId: 'hook-orphan',
        token: 'token-orphan',
        ownerId: '',
        projectId: '',
        environment: '',
      });

      const result = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-orphan',
        eventData: { token: 'token-orphan' },
      });
      expect(result.event?.eventType).toBe('hook_created');
      expect(result.hook?.hookId).toBe('hook-orphan');

      const eventList = await events.list({ runId: run.runId });
      expect(eventList.data.filter((e) => e.eventType === 'hook_created')).toHaveLength(1);
    });

    it('emits hook_conflict with conflictingRunId when another run holds the token', async () => {
      const runA = await createRun();
      const runB = await createRun();

      await events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-owner',
        eventData: { token: 'token-contested' },
      });

      const result = await events.create(runB.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-contender',
        eventData: { token: 'token-contested' },
      });
      expect(result.hook).toBeUndefined();
      expect(result.event?.eventType).toBe('hook_conflict');
      expect(result.event?.eventData).toMatchObject({
        token: 'token-contested',
        conflictingRunId: runA.runId,
      });
    });
  });
});
