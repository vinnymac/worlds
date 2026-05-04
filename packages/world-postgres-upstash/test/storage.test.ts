import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Hook, Step, WorkflowRun } from '@workflow/world';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

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
  }
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
  eventData?: Record<string, unknown>
): Promise<WorkflowRun> {
  const result = await events.create(runId, {
    eventType,
    eventData,
  });
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
  }
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
  eventData?: Record<string, unknown>
): Promise<Step> {
  const result = await events.create(runId, {
    eventType,
    correlationId: stepId,
    eventData,
  });
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
  }
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

describe('Storage (PostgreSQL integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let db: ReturnType<typeof drizzle>;
  let sqlClient: ReturnType<typeof postgres>;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let _hooks: ReturnType<typeof createHooksStorage>;
  let streamer: ReturnType<typeof createStreamer>;

  async function truncateTables() {
    await sqlClient`TRUNCATE TABLE workflow.workflow_events, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs, workflow.workflow_stream_chunks RESTART IDENTITY CASCADE`;
  }

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    // Apply schema
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // Initialize postgres client and drizzle
    sqlClient = postgres(dbUrl, { max: 1 });
    db = drizzle(sqlClient, { schema }) as any; // Cast to compatible type

    runs = createRunsStorage(db);
    steps = createStepsStorage(db);
    events = createEventsStorage(db);
    _hooks = createHooksStorage(db);
    streamer = createStreamer(sqlClient, db);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    // End the connection with a short timeout to allow pending queries to complete
    await sqlClient.end({ timeout: 1 });
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

      it('should throw error for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toMatchObject({
          status: 404,
        });
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

        const updated = await updateRun(
          events,
          created.runId,
          'run_completed',
          { output: [{ result: 42 }] }
        );
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
          result.data[1].createdAt.getTime()
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
        await expect(
          steps.get(testRunId, 'missing-step')
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('update via events', () => {
      it('should update step status to running via step_started event', async () => {
        await createStep(events, testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_started'
        );

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

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_completed',
          { result: ['ok'] }
        );

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

        const updated = await updateStep(
          events,
          testRunId,
          'step-123',
          'step_failed',
          { error: 'Step failed' }
        );

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
          result.data[1].createdAt.getTime()
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
          result.data[1].createdAt.getTime()
        );
      });

      it('should list events in descending order when explicitly requested', async () => {
        const _result1 = await events.create(testRunId, {
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
        updateStep(events, testRunId, 'step_terminal_1', 'step_started')
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
        })
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
        })
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

      await expect(
        updateStep(events, testRunId, 'step_failed_1', 'step_started')
      ).rejects.toThrow(/terminal/i);
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

      await expect(updateRun(events, run.runId, 'run_started')).rejects.toThrow(
        /terminal/i
      );
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
        })
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
        })
      ).rejects.toThrow(/terminal/i);
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
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject step_started before step_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'nonexistent_step_started',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_disposed before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'nonexistent_hook',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject hook_received before hook_created', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'nonexistent_hook_received',
          eventData: { payload: {} },
        })
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

    it('should increment attempt when step_started is called after step_retrying', async () => {
      await createStep(events, testRunId, {
        stepId: 'step_retry_2',
        stepName: 'test-step',
        input: [],
      });

      const started1 = await updateStep(
        events,
        testRunId,
        'step_retry_2',
        'step_started'
      );
      expect(started1.attempt).toBe(1);

      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step_retry_2',
        eventData: { error: 'Temporary failure' },
      });

      const started2 = await updateStep(
        events,
        testRunId,
        'step_retry_2',
        'step_started'
      );
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

    it('should return hook_conflict event for duplicate token', async () => {
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

      expect(result.event?.eventType).toBe('hook_conflict');
      expect(result.hook).toBeUndefined();
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

  describe('streamer', () => {
    it('should write and read chunks from stream', async () => {
      const streamName = 'test-stream';
      const runIdPromise = Promise.resolve('test-run');

      // Write chunks
      await streamer.writeToStream(streamName, runIdPromise, 'chunk1');
      await streamer.writeToStream(streamName, runIdPromise, 'chunk2');
      await streamer.writeToStream(streamName, runIdPromise, 'chunk3');
      await streamer.closeStream(streamName, runIdPromise);

      // Read chunks
      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const chunks: string[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      } finally {
        reader.releaseLock();
      }

      expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });

    it('should handle binary data', async () => {
      const streamName = 'binary-stream';
      const runIdPromise = Promise.resolve('test-run');
      const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

      await streamer.writeToStream(streamName, runIdPromise, binaryData);
      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const { value } = await reader.read();

      expect(value).toEqual(binaryData);
      reader.releaseLock();
    });

    it('should handle empty stream', async () => {
      const streamName = 'empty-stream';
      const runIdPromise = Promise.resolve('test-run');

      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const { done } = await reader.read();

      expect(done).toBe(true);
      reader.releaseLock();
    });

    it('should support stream cancellation', async () => {
      const streamName = 'cancel-stream';
      const runIdPromise = Promise.resolve('test-run');

      await streamer.writeToStream(streamName, runIdPromise, 'chunk1');
      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      // Read chunk1
      const { value: chunk1, done: done1 } = await reader.read();
      expect(done1).toBe(false);
      expect(new TextDecoder().decode(chunk1)).toBe('chunk1');

      // Read EOF marker
      const { done: done2 } = await reader.read();
      expect(done2).toBe(true);
      reader.releaseLock();
    });
  });
});
