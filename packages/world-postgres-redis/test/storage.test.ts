import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { asEventRequest, expectEventType, expectRejectedWith } from '@fantasticfour/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { EntityConflictError, TooEarlyError, WorkflowRunNotFoundError } from '@workflow/errors';
import type { Hook, Step, WorkflowRun } from '@workflow/world';
import postgres from 'postgres';
import { decodeTime } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

// Helper types for events storage
type EventsStorage = ReturnType<typeof createEventsStorage>;

// Helper functions to create entities through events.create
async function createRun(
  events: EventsStorage,
  data: {
    deploymentId: string;
    workflowName: string;
    input: any[];
    executionContext?: Record<string, unknown>;
  },
): Promise<WorkflowRun> {
  const result = await events.create(null, {
    eventType: 'run_created',
    eventData: data,
  });
  if (!result.run) {
    throw new Error('Expected run to be created');
  }
  return result.run;
}

async function updateRun(
  events: EventsStorage,
  runId: string,
  eventType: 'run_started' | 'run_completed' | 'run_failed',
  eventData?: Record<string, unknown>,
): Promise<WorkflowRun> {
  // `eventType` is the union of all three run transitions here, so no single
  // eventData shape narrows against it; callers pass the payload their case
  // needs. See asEventRequest for why this widening is confined to helpers
  // whose tag is a parameter.
  const result = await events.create(runId, asEventRequest({ eventType, eventData }));
  if (!result.run) {
    throw new Error('Expected run to be updated');
  }
  return result.run;
}

async function createStep(
  events: EventsStorage,
  runId: string,
  data: {
    stepId: string;
    stepName: string;
    input: any[];
  },
): Promise<Step> {
  const result = await events.create(runId, {
    eventType: 'step_created',
    correlationId: data.stepId,
    eventData: { stepName: data.stepName, input: data.input },
  });
  if (!result.step) {
    throw new Error('Expected step to be created');
  }
  return result.step;
}

async function updateStep(
  events: EventsStorage,
  runId: string,
  stepId: string,
  eventType: 'step_started' | 'step_completed' | 'step_failed',
  eventData?: Record<string, unknown>,
): Promise<Step> {
  const result = await events.create(
    runId,
    asEventRequest({ eventType, correlationId: stepId, eventData }),
  );
  if (!result.step) {
    throw new Error('Expected step to be updated');
  }
  return result.step;
}

async function createHook(
  events: EventsStorage,
  runId: string,
  data: {
    hookId: string;
    token: string;
    metadata?: unknown;
  },
): Promise<Hook> {
  const result = await events.create(runId, {
    eventType: 'hook_created',
    correlationId: data.hookId,
    eventData: { token: data.token, metadata: data.metadata },
  });
  if (!result.hook) {
    throw new Error('Expected hook to be created');
  }
  return result.hook;
}

describe('Storage (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let sql: ReturnType<typeof postgres>;
  let drizzle: ReturnType<typeof createClient>;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;
  let events: ReturnType<typeof createEventsStorage>;

  async function truncateTables() {
    await sql`TRUNCATE TABLE workflow.workflow_events, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs, workflow.workflow_stream_chunks RESTART IDENTITY CASCADE`;
  }

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    // Apply schema through the real setup CLI, twice: the second run must
    // be a no-op (the applied-migrations ledger skips every file).
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // Initialize database clients and storage
    sql = postgres(dbUrl, { max: 1 });
    drizzle = createClient(sql);
    runs = createRunsStorage(drizzle);
    steps = createStepsStorage(drizzle);
    hooks = createHooksStorage(drizzle);
    events = createEventsStorage(drizzle);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  describe('runs', () => {
    describe('create via events', () => {
      it('should create a new workflow run', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          executionContext: { userId: 'user-1' },
          input: ['arg1', 'arg2'],
        });

        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe('deployment-123');
        expect(run.status).toBe('pending');
        expect(run.workflowName).toBe('test-workflow');
        expect(run.executionContext).toEqual({ userId: 'user-1' });
        expect(run.input).toEqual(['arg1', 'arg2']);
        expect(run.output).toBeUndefined();
        expect(run.error).toBeUndefined();
        expect(run.startedAt).toBeUndefined();
        expect(run.completedAt).toBeUndefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });

      it('should handle minimal run data', async () => {
        const run = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'minimal-workflow',
          input: [],
        });

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: ['arg'],
        });

        const retrieved = await runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe('test-workflow');
        expect(retrieved.input).toEqual(['arg']);
      });

      it('should throw WorkflowRunNotFoundError for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toSatisfy((error) =>
          WorkflowRunNotFoundError.is(error),
        );
      });
    });

    describe('update via events', () => {
      it('should update run status to running', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(events, created.runId, 'run_started');
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(events, created.runId, 'run_completed', {
          output: [{ result: 42 }],
        });
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });

      it('should update run status to failed', async () => {
        const created = await createRun(events, {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await updateRun(events, created.runId, 'run_failed', {
          error: 'Something went wrong',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Something went wrong');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun(events, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await setTimeout(2);

        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThan(
          result.data[1].createdAt.getTime(),
        );
      });

      it('should filter runs by workflowName', async () => {
        await createRun(events, {
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await createRun(events, {
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should support pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await createRun(events, {
            deploymentId: `deployment-${i}`,
            workflowName: `workflow-${i}`,
            input: [],
          });
        }

        const page1 = await runs.list({
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await runs.list({
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].runId).not.toBe(page1.data[0].runId);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create via events', () => {
      it('should create a new step', async () => {
        const step = await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        });

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step-123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.output).toBeUndefined();
        expect(step.error).toBeUndefined();
        expect(step.attempt).toBe(0); // steps are created with attempt 0
        expect(step.startedAt).toBeUndefined();
        expect(step.completedAt).toBeUndefined();
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
        const created = await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should retrieve a step with only stepId', async () => {
        const created = await createStep(events, testRunId, {
          stepId: 'unique-step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(undefined, 'unique-step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(steps.get(testRunId, 'missing-step')).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('update via events', () => {
      it('should update step status to running via step_started event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(events, testRunId, 'step-123', 'step_started');

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
        expect(updated.attempt).toBe(1);
      });

      it('should update step status to completed via step_completed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(events, testRunId, 'step-123', 'step_completed', {
          result: ['ok'],
        });

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });

      it('should update step status to failed via step_failed event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(events, testRunId, 'step-123', 'step_failed', {
          error: 'Step failed',
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        const step1 = await createStep(events, testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: [],
        });
        const step2 = await createStep(events, testRunId, {
          stepId: 'step-2',
          stepName: 'second-step',
          input: [],
        });

        const result = await steps.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
        // Should be in descending order
        expect(result.data[0].stepId).toBe(step2.stepId);
        expect(result.data[1].stepId).toBe(step1.stepId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime(),
        );
      });

      it('should support pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await createStep(events, testRunId, {
            stepId: `step-${i}`,
            stepName: `step-name-${i}`,
            input: [],
          });
        }

        const page1 = await steps.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].stepId).not.toBe(page1.data[0].stepId);
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        await createStep(events, testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
          input: [],
        });

        const result = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        });

        expect(result.event?.runId).toBe(testRunId);
        expect(result.event?.eventId).toMatch(/^wevt_/);
        expect(result.event?.eventType).toBe('step_started');
        expect(result.event?.correlationId).toBe('corr_123');
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });

      it('should handle run completed events', async () => {
        const result = await events.create(testRunId, {
          eventType: 'run_completed' as const,
          eventData: { output: [{ result: 42 }] },
        });

        expect(result.event?.eventType).toBe('run_completed');
        expect(result.event?.correlationId).toBeUndefined();
      });

      it('should create a new event with null byte in payload', async () => {
        await createStep(events, testRunId, {
          stepId: 'corr_123_null',
          stepName: 'test-step-null',
          input: [],
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr_123_null',
        });

        const result = await events.create(testRunId, {
          eventType: 'step_failed' as const,
          correlationId: 'corr_123_null',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

        expect(result.event?.runId).toBe(testRunId);
        expect(result.event?.eventId).toMatch(/^wevt_/);
        expect(result.event?.eventType).toBe('step_failed');
        expect(result.event?.correlationId).toBe('corr_123_null');
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const result1 = await events.create(testRunId, {
          eventType: 'run_started' as const,
        });

        await setTimeout(2);

        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: [],
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        // 4 events: run_created, run_started, step_created, step_started
        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventType).toBe('run_created');
        expect(result.data[1].eventId).toBe(result1.event?.eventId);
        expect(result.data[3].eventId).toBe(result2.event?.eventId);
        expect(result.data[3].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime(),
        );
      });

      it('should list events in descending order when explicitly requested', async () => {
        await events.create(testRunId, {
          eventType: 'run_started' as const,
        });

        await setTimeout(2);

        await createStep(events, testRunId, {
          stepId: 'corr-step-1',
          stepName: 'test-step',
          input: [],
        });

        const result2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventId).toBe(result2.event?.eventId);
        expect(result.data[3].eventType).toBe('run_created');
      });

      it('should support pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await createStep(events, testRunId, {
            stepId: `corr_${i}`,
            stepName: `test-step-${i}`,
            input: [],
          });
          await events.create(testRunId, {
            eventType: 'step_started',
            correlationId: `corr_${i}`,
          });
          await events.create(testRunId, {
            eventType: 'step_completed',
            correlationId: `corr_${i}`,
            eventData: { result: [i] },
          });
        }

        const page1 = await events.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await events.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].eventId).not.toBe(page1.data[0].eventId);
      });
    });

    describe('listByCorrelationId', () => {
      it('should list all events with a specific correlation ID', async () => {
        const correlationId = 'step-abc123';

        await createStep(events, testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
          input: [],
        });

        const result1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(2);

        const result2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: ['success'] },
        });

        // Create events with different correlation IDs
        await createStep(events, testRunId, {
          stepId: 'different-step',
          stepName: 'different-step',
          input: [],
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'different-step',
        });
        await events.create(testRunId, {
          eventType: 'run_completed',
          eventData: { output: ['done'] },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        // 3 events: step_created, step_started, step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventType).toBe('step_created');
        expect(result.data[1].eventId).toBe(result1.event?.eventId);
        expect(result.data[2].eventId).toBe(result2.event?.eventId);
      });

      it('should list events across multiple runs with same correlation ID', async () => {
        const correlationId = 'hook-xyz789';

        const run2 = await createRun(events, {
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        const result1 = await events.create(testRunId, {
          eventType: 'hook_created',
          correlationId,
          eventData: { token: 'test-token-1' },
        });

        await setTimeout(2);

        const result2 = await events.create(run2.runId, {
          eventType: 'hook_received',
          correlationId,
          eventData: { payload: { data: 'test' } },
        });

        await setTimeout(2);

        const result3 = await events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventId).toBe(result1.event?.eventId);
        expect(result.data[0].runId).toBe(testRunId);
        expect(result.data[1].eventId).toBe(result2.event?.eventId);
        expect(result.data[1].runId).toBe(run2.runId);
        expect(result.data[2].eventId).toBe(result3.event?.eventId);
        expect(result.data[2].runId).toBe(testRunId);
      });

      it('should return empty list for non-existent correlation ID', async () => {
        await createStep(events, testRunId, {
          stepId: 'existing-step',
          stepName: 'existing-step',
          input: [],
        });
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'existing-step',
        });

        const result = await events.listByCorrelationId({
          correlationId: 'non-existent-correlation-id',
          pagination: {},
        });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.cursor).toBeNull();
      });

      it('should handle hook lifecycle events', async () => {
        const hookId = 'hook_test123';

        const createdResult = await events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: hookId,
          eventData: { token: 'lifecycle-test-token' },
        });

        await setTimeout(2);

        const received1Result = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        await setTimeout(2);

        const received2Result = await events.create(testRunId, {
          eventType: 'hook_received' as const,
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await setTimeout(2);

        const disposedResult = await events.create(testRunId, {
          eventType: 'hook_disposed' as const,
          correlationId: hookId,
        });

        const result = await events.listByCorrelationId({
          correlationId: hookId,
          pagination: {},
        });

        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventId).toBe(createdResult.event?.eventId);
        expect(result.data[0].eventType).toBe('hook_created');
        expect(result.data[1].eventId).toBe(received1Result.event?.eventId);
        expect(result.data[1].eventType).toBe('hook_received');
        expect(result.data[2].eventId).toBe(received2Result.event?.eventId);
        expect(result.data[2].eventType).toBe('hook_received');
        expect(result.data[3].eventId).toBe(disposedResult.event?.eventId);
        expect(result.data[3].eventType).toBe('hook_disposed');
      });
    });
  });

  describe('step terminal state validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should reject step_started on completed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_terminal_1',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_terminal_1', 'step_completed', {
        result: ['ok'],
      });

      await expect(
        updateStep(events, testRunId, 'step_terminal_1', 'step_started'),
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_completed on already completed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_terminal_2',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_terminal_2', 'step_completed', {
        result: ['ok'],
      });

      await expect(
        updateStep(events, testRunId, 'step_terminal_2', 'step_completed', {
          result: ['ok2'],
        }),
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_failed on completed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_terminal_3',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_terminal_3', 'step_completed', {
        result: ['ok'],
      });

      await expect(
        updateStep(events, testRunId, 'step_terminal_3', 'step_failed', {
          error: 'Should not work',
        }),
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject step_started on failed step', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_failed_1',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_failed_1', 'step_failed', {
        error: 'Failed permanently',
      });

      await expect(updateStep(events, testRunId, 'step_failed_1', 'step_started')).rejects.toThrow(
        /terminal/i,
      );
    });
  });

  describe('run terminal state validation', () => {
    it('should reject run_started on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: ['done'] });

      await expect(updateRun(events, run.runId, 'run_started')).rejects.toThrow(/terminal/i);
    });

    it('should reject step_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: ['done'] });

      await expect(
        createStep(events, run.runId, {
          stepId: 'new_step',
          stepName: 'test-step',
          input: [],
        }),
      ).rejects.toThrow(/terminal/i);
    });

    it('should reject hook_created on completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: ['done'] });

      await expect(
        createHook(events, run.runId, {
          hookId: 'new_hook',
          token: 'new-token',
        }),
      ).rejects.toThrow(/terminal/i);
    });

    it('should throw EntityConflictError when failing a completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: ['done'] });

      await expect(
        events.create(run.runId, {
          eventType: 'run_failed',
          eventData: { error: 'boom' },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      const persisted = await runs.get(run.runId);
      expect(persisted.status).toBe('completed');
      expect(persisted.output).toEqual(['done']);
    });

    it('should throw EntityConflictError when cancelling a completed run', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await updateRun(events, run.runId, 'run_completed', { output: ['done'] });

      await expect(events.create(run.runId, { eventType: 'run_cancelled' })).rejects.toSatisfy(
        (error) => EntityConflictError.is(error),
      );

      // Run stays parseable and completed, never a cancelled run with output
      const persisted = await runs.get(run.runId);
      expect(persisted.status).toBe('completed');
    });

    it('should allow run_cancelled on already cancelled run (idempotent)', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await events.create(run.runId, { eventType: 'run_cancelled' });

      const result = await events.create(run.runId, {
        eventType: 'run_cancelled',
      });
      expect(result.run?.status).toBe('cancelled');
    });
  });

  describe('event ordering validation', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should reject step_completed before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'nonexistent_step',
          eventData: { result: ['ok'] },
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_started before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'nonexistent_step_started',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_disposed before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'nonexistent_hook',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_received before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'nonexistent_hook_received',
          eventData: { payload: {} },
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('step_retrying event handling', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should set step status to pending and record error', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_1',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_retry_1', 'step_started');

      const result = await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_1',
        eventData: {
          error: 'Temporary failure',
          retryAfter: new Date(Date.now() + 5000),
        },
      });

      expect(result.step?.status).toBe('pending');
      expect(result.step?.error?.message).toBe('Temporary failure');
      expect(result.step?.retryAfter).toBeInstanceOf(Date);
    });

    it('should throw TooEarlyError when step_started arrives before retryAfter', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_too_early',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_too_early', 'step_started');

      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_too_early',
        eventData: {
          error: 'Temporary failure',
          retryAfter: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        updateStep(events, testRunId, 'step_too_early', 'step_started'),
      ).rejects.toSatisfy((error) => TooEarlyError.is(error));
    });

    it('should clear retryAfter once the step starts again', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_clear',
        stepName: 'test-step',
        input: [],
      });
      await updateStep(events, testRunId, 'step_retry_clear', 'step_started');

      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_clear',
        eventData: {
          error: 'Temporary failure',
          retryAfter: new Date(Date.now() - 1000),
        },
      });

      const restarted = await updateStep(events, testRunId, 'step_retry_clear', 'step_started');
      expect(restarted.retryAfter).toBeUndefined();
      expect(restarted.attempt).toBe(2);
    });

    it('should increment attempt when step_started is called after step_retrying', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: [],
      });

      const started1 = await updateStep(events, testRunId, 'step_retry_2', 'step_started');
      expect(started1.attempt).toBe(1);

      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_2',
        eventData: { error: 'Temporary failure' },
      });

      const started2 = await updateStep(events, testRunId, 'step_retry_2', 'step_started');
      expect(started2.attempt).toBe(2);
    });
  });

  describe('hook token conflict', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should return hook_conflict event with conflictingRunId for duplicate token', async () => {
      const token = 'unique-token-test';

      await events.create(testRunId, {
        eventType: 'hook_created' as const,
        correlationId: 'hook_1',
        eventData: { token },
      });

      const run2 = await createRun(events, {
        deploymentId: 'deployment-456',
        workflowName: 'test-workflow-2',
        input: [],
      });

      const result = await events.create(run2.runId, {
        eventType: 'hook_created' as const,
        correlationId: 'hook_2',
        eventData: { token },
      });

      expect(expectEventType(result.event, 'hook_conflict').eventData).toMatchObject({
        token,
        conflictingRunId: testRunId,
      });
      expect(result.hook).toBeUndefined();
    });

    it('should throw EntityConflictError for a re-delivered hook_created of the same hook', async () => {
      const token = 'same-hook-duplicate-token';

      await events.create(testRunId, {
        eventType: 'hook_created' as const,
        correlationId: 'hook_same',
        eventData: { token },
      });

      await expect(
        events.create(testRunId, {
          eventType: 'hook_created' as const,
          correlationId: 'hook_same',
          eventData: { token },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      // No hook_conflict event may be written into the run's log
      const eventList = await events.list({ runId: testRunId, pagination: { sortOrder: 'asc' } });
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
      // And exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      expect(
        eventList.data.filter(
          (e) => e.eventType === 'hook_created' && e.correlationId === 'hook_same',
        ),
      ).toHaveLength(1);
    });

    it('should allow token reuse after hook is disposed', async () => {
      const token = 'reusable-token-test';

      await events.create(testRunId, {
        eventType: 'hook_created' as const,
        correlationId: 'hook_reuse_1',
        eventData: { token },
      });

      await events.create(testRunId, {
        eventType: 'hook_disposed' as const,
        correlationId: 'hook_reuse_1',
      });

      const run2 = await createRun(events, {
        deploymentId: 'deployment-789',
        workflowName: 'test-workflow-3',
        input: [],
      });

      const result = await events.create(run2.runId, {
        eventType: 'hook_created' as const,
        correlationId: 'hook_reuse_2',
        eventData: { token },
      });

      expect(result.hook).toBeDefined();
      expect(result.hook?.token).toBe(token);
    });
  });

  describe('Event idempotency - creation events', () => {
    it('rejects a duplicate step_created with EntityConflictError', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-idempotency',
        workflowName: 'test-workflow-idempotency',
        input: [],
      });
      const stepId = 'step-idempotent-test';

      // First step_created event
      const result1 = await events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      // Redelivered step_created: the runtime catches EntityConflictError as
      // its dedup signal. Returning success would append a second
      // step_created row and poison replay with ReplayDivergenceError.
      await expect(
        events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'step_created')).toHaveLength(1);
    });

    it('rejects a duplicate wait_created with EntityConflictError', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-idempotency',
        workflowName: 'test-workflow-wait-idempotency',
        input: [],
      });
      const waitId = 'wait-idempotent-test';
      const eventData = {
        eventType: 'wait_created' as const,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };

      await events.create(run.runId, eventData);

      // Waits have no entity table; the event log unique index is the only
      // guard against a replayed wait_created duplicating the log.
      await expect(events.create(run.runId, eventData)).rejects.toSatisfy((error) =>
        EntityConflictError.is(error),
      );

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
    });

    it('should handle duplicate run_created events', async () => {
      // First run_created event
      const result1 = await events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-run-idempotent',
          input: [],
        },
      });
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // Duplicate run_created (replay scenario): must not return the
      // existing run AND append a second run_created row. Core catches
      // EntityConflictError as "the run already exists".
      await expect(
        events.create(runId, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'test-workflow-run-idempotent',
            input: [],
          },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const listResult = await runs.list({ workflowName: 'test-workflow-run-idempotent' });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);

      const eventList = await events.list({ runId });
      expect(eventList.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('concurrent run_created deliveries leave exactly one event row', async () => {
      const eventData = {
        eventType: 'run_created' as const,
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-run-race',
          input: [],
        },
      };
      const first = await events.create(null, eventData);
      const runId = first.run!.runId;

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => events.create(runId, eventData)),
      );
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await events.list({ runId });
      expect(eventList.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('should handle duplicate hook_created events with different tokens', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-hooks',
        workflowName: 'test-workflow-hooks',
        input: [],
      });
      const hookId1 = 'hook-idempotent-test-1';
      const hookId2 = 'hook-idempotent-test-2';

      // Test idempotency by creating two separate hooks
      const result1 = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId1,
        eventData: { token: 'test-token-unique-1' },
      });
      expect(result1.hook).toBeDefined();

      const result2 = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId2,
        eventData: { token: 'test-token-unique-2' },
      });
      expect(result2.hook).toBeDefined();

      // Both hooks should be in the index
      const listResult = await hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-run-started',
        workflowName: 'test-workflow-run-started',
        input: [],
      });

      // First run_started
      const result1 = await events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result1.run?.status).toBe('running');
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario, should be idempotent)
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

  // @workflow/world 4.3.1 `CreateEventParams.stateUpdatedAt`: the conformance
  // suite has no coverage for this, so pin the semantics here.
  describe('stateUpdatedAt optimistic-concurrency guard', () => {
    const ulidTime = (eventId: string) => decodeTime(eventId.slice(eventId.lastIndexOf('_') + 1));

    async function startRun(workflowName: string): Promise<WorkflowRun> {
      const run = await createRun(events, {
        deploymentId: 'deployment-state-guard',
        workflowName,
        input: [],
      });
      await updateRun(events, run.runId, 'run_started');
      return run;
    }

    async function completeStep(runId: string, stepId: string): Promise<number> {
      await createStep(events, runId, { stepId, stepName: 'guarded-step', input: [] });
      await updateStep(events, runId, stepId, 'step_started');
      const completed = await events.create(runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: [] },
      });
      return ulidTime(completed.event!.eventId);
    }

    function stepCreated(stepId: string) {
      return {
        eventType: 'step_created' as const,
        correlationId: stepId,
        eventData: { stepName: 'guarded-step', input: [] },
      };
    }

    it('rejects a snapshot strictly older than the marker with PreconditionFailedError', async () => {
      const run = await startRun('state-guard-stale');
      const marker = await completeStep(run.runId, 'step-guard-source');

      await expect(
        events.create(run.runId, stepCreated('step-guard-stale'), {
          stateUpdatedAt: marker - 1,
        }),
      ).rejects.toMatchObject({ name: 'PreconditionFailedError', status: 412 });

      // The unlocked fail-fast check runs before any entity write.
      const stepList = await steps.list({ runId: run.runId });
      expect(stepList.data.some((s) => s.stepId === 'step-guard-stale')).toBe(false);
    });

    it('accepts an equal snapshot and an absent snapshot, and never advances on replay creates', async () => {
      const run = await startRun('state-guard-equal');
      const marker = await completeStep(run.runId, 'step-guard-source');

      // Equal must pass; `<=` here would livelock an up-to-date client.
      const equal = await events.create(run.runId, stepCreated('step-guard-equal'), {
        stateUpdatedAt: marker,
      });
      expect(equal.step?.stepId).toBe('step-guard-equal');

      // Replay-origin creates carry a stateUpdatedAt and must not advance the
      // marker, so the same snapshot still passes afterwards.
      const again = await events.create(run.runId, stepCreated('step-guard-equal-2'), {
        stateUpdatedAt: marker,
      });
      expect(again.step?.stepId).toBe('step-guard-equal-2');

      // Absent stateUpdatedAt fails open.
      const unguarded = await events.create(run.runId, stepCreated('step-guard-absent'));
      expect(unguarded.step?.stepId).toBe('step-guard-absent');
    });

    it('advances the marker on hook_received but not on run lifecycle events', async () => {
      const run = await startRun('state-guard-hook');

      // run_created / run_started omit stateUpdatedAt but are not externally
      // originated: advancing on them would reject every replay.
      const beforeHook = await events.create(run.runId, stepCreated('step-guard-pre-hook'), {
        stateUpdatedAt: 1,
      });
      expect(beforeHook.step?.stepId).toBe('step-guard-pre-hook');

      await createHook(events, run.runId, { hookId: 'hook-guard', token: 'token-guard' });
      const received = await events.create(run.runId, {
        eventType: 'hook_received',
        correlationId: 'hook-guard',
        eventData: { payload: {} },
      });
      const marker = ulidTime(received.event!.eventId);

      await expect(
        events.create(run.runId, stepCreated('step-guard-post-hook'), {
          stateUpdatedAt: marker - 1,
        }),
      ).rejects.toMatchObject({ name: 'PreconditionFailedError', status: 412 });
    });
  });

  describe('maxEvents', () => {
    it('reports the per-run event ceiling on both run_started paths', async () => {
      const run = await createRun(events, {
        deploymentId: 'deployment-max-events',
        workflowName: 'max-events',
        input: [],
      });

      const started = await events.create(run.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(25_000);

      // The idempotent replay path is the easy miss: core reads maxEvents only
      // off the run_started response, so it must be carried here too.
      const replayed = await events.create(run.runId, { eventType: 'run_started' });
      expect(replayed.maxEvents).toBe(25_000);
    });
  });

  describe('resilient start (run_started bootstrap)', () => {
    it('should bootstrap the run from run_started eventData and return the run entity', async () => {
      const runId = `wrun_bootstrap_${Date.now()}`;

      const result = await events.create(runId, {
        eventType: 'run_started',
        eventData: {
          deploymentId: 'deployment-bootstrap',
          workflowName: 'bootstrap-workflow',
          input: ['arg1'],
        },
      } as Parameters<EventsStorage['create']>[1]);

      expect(result.run).toBeDefined();
      expect(result.run?.runId).toBe(runId);
      expect(result.run?.status).toBe('running');

      // The synthetic run_created must sort before run_started
      const eventList = await events.list({ runId, pagination: { sortOrder: 'asc' } });
      const types = eventList.data.map((e) => e.eventType);
      expect(types.indexOf('run_created')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('run_created')).toBeLessThan(types.indexOf('run_started'));
    });
  });
});
