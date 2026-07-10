import { setTimeout } from 'node:timers/promises';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

describe('Storage (Redis integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<RedisContainer['start']>>;
  let redis: Redis;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let _hooks: ReturnType<typeof createHooksStorage>;

  const keyPrefix = 'workflow:test:';

  async function flushTestKeys() {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  /**
   * Helper: create a run via run_created event and return the run entity.
   */
  async function createRun(opts?: {
    deploymentId?: string;
    workflowName?: string;
    input?: any;
    executionContext?: Record<string, any>;
  }) {
    const result = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: opts?.deploymentId ?? 'deployment-123',
        workflowName: opts?.workflowName ?? 'test-workflow',
        input: opts?.input ?? [],
        executionContext: opts?.executionContext,
      },
    });
    return result.run!;
  }

  /**
   * Helper: create a step via step_created event and return the step entity.
   */
  async function createStep(
    runId: string,
    opts?: { stepId?: string; stepName?: string; input?: any },
  ) {
    const stepId = opts?.stepId ?? 'step-123';
    const result = await events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: {
        stepName: opts?.stepName ?? 'test-step',
        input: opts?.input ?? ['input1'],
      },
    });
    return result.step!;
  }

  beforeAll(async () => {
    // Start Redis container
    container = await new RedisContainer('redis:7-alpine').start();
    const redisUrl = container.getConnectionUrl();

    // Initialize Redis client and storage
    redis = new Redis(redisUrl);
    const config = { redis, keyPrefix };
    runs = createRunsStorage(config);
    steps = createStepsStorage(config);
    events = createEventsStorage(config);
    _hooks = createHooksStorage(config);
  }, 120_000);

  beforeEach(async () => {
    await flushTestKeys();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  describe('runs', () => {
    describe('create via event', () => {
      it('should create a new workflow run via run_created event', async () => {
        const run = await createRun({
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
        const run = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'minimal-workflow',
          input: [],
        });

        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun({
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
        await expect(runs.get('missing')).rejects.toMatchObject({
          name: 'WorkflowRunNotFoundError',
        });
      });
    });

    describe('status transitions via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun();

        const result = await events.create(created.runId, {
          eventType: 'run_started',
        });

        expect(result.run?.status).toBe('running');
        expect(result.run?.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed via run_completed event', async () => {
        const created = await createRun();

        await events.create(created.runId, {
          eventType: 'run_started',
        });

        const result = await events.create(created.runId, {
          eventType: 'run_completed',
          eventData: { output: [{ result: 42 }] },
        });

        expect(result.run?.status).toBe('completed');
        expect(result.run?.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
        });

        await setTimeout(5);

        const run2 = await createRun({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
        });

        const result = await runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
      });

      it('should filter runs by workflowName', async () => {
        await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
        });
        const run2 = await createRun({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
        });

        const result = await runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });
    });

    describe('cancel via event', () => {
      it('should cancel a run via run_cancelled event', async () => {
        const created = await createRun();

        const result = await events.create(created.runId, {
          eventType: 'run_cancelled',
        });

        expect(result.run?.status).toBe('cancelled');
        expect(result.run?.completedAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    describe('create via event', () => {
      it('should create a new step via step_created event', async () => {
        const step = await createStep(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        });

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step-123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.attempt).toBe(0);
      });
    });

    describe('get', () => {
      it('should retrieve a step', async () => {
        const created = await createStep(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(testRunId, 'step-123');
        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(steps.get(testRunId, 'missing-step')).rejects.toMatchObject({ status: 404 });
      });

      it('should find step by stepId without runId using SCAN', async () => {
        const created = await createStep(testRunId, {
          stepId: 'unique-step-scan-test',
          stepName: 'test-step',
          input: ['input1'],
        });

        // Retrieve without runId (uses SCAN instead of KEYS)
        const retrieved = await steps.get(undefined, 'unique-step-scan-test');
        expect(retrieved.stepId).toBe(created.stepId);
        expect(retrieved.runId).toBe(testRunId);
        expect(retrieved.stepName).toBe('test-step');
      });

      it('should throw 404 when step not found without runId', async () => {
        await expect(steps.get(undefined, 'nonexistent-step-id')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update via events', () => {
      it('should update step status to completed via step_completed event', async () => {
        await createStep(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        // Start the step first
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-123',
        });

        const result = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-123',
          eventData: { result: ['ok'] },
        });

        expect(result.step?.status).toBe('completed');
        expect(result.step?.completedAt).toBeInstanceOf(Date);
      });

      it('should increment attempt on step_started', async () => {
        await createStep(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const result = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-123',
        });

        expect(result.step?.attempt).toBe(1);
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // First create a step so step_started has a target
        await createStep(testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
        });

        const result = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr_123',
        });

        expect(result.event?.runId).toBe(testRunId);
        expect(result.event?.eventId).toMatch(/^wevt_/);
        expect(result.event?.eventType).toBe('step_started');
        expect(result.event?.correlationId).toBe('corr_123');
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        // Create a step first
        await createStep(testRunId, {
          stepId: 'corr_123',
          stepName: 'test-step',
        });

        // Start the step
        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr_123',
        });

        const result = await events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'corr_123',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

        expect(result.event?.runId).toBe(testRunId);
        expect(result.event?.eventId).toMatch(/^wevt_/);
        expect(result.event?.eventType).toBe('step_failed');
        expect(result.event?.correlationId).toBe('corr_123');
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        // The run_created event is already created by createRun
        // Create a second event
        const startResult = await events.create(testRunId, {
          eventType: 'run_started',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        // run_created + run_started
        expect(result.data.length).toBeGreaterThanOrEqual(2);
        expect(result.data[0].eventType).toBe('run_created');
        expect(result.data[1].eventId).toBe(startResult.event?.eventId);
      });
    });

    describe('listByCorrelationId', () => {
      it('should list events by correlation ID', async () => {
        const correlationId = 'step-abc123';

        // Create a step first
        await createStep(testRunId, {
          stepId: correlationId,
          stepName: 'test-step',
        });

        const startResult = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        const completeResult = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        // step_created + step_started + step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventType).toBe('step_created');
        expect(result.data[1].eventId).toBe(startResult.event?.eventId);
        expect(result.data[2].eventId).toBe(completeResult.event?.eventId);
      });

      it('should handle hook lifecycle events', async () => {
        const hookId = 'hook_test123';

        // Create a typical hook lifecycle
        const createdResult = await events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token: 'test-token-123' },
        });

        await setTimeout(5);

        const received1Result = await events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        await setTimeout(5);

        const received2Result = await events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        await setTimeout(5);

        const disposedResult = await events.create(testRunId, {
          eventType: 'hook_disposed',
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

  describe('Event idempotency', () => {
    it('should reject duplicate step_created events with EntityConflictError', async () => {
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

      // Duplicate step_created event (replay scenario) — must reject so the
      // log ends with exactly one creation event. Core matches this error by
      // name and treats it as benign.
      await expect(
        events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // Verify step appears in list query (critical!)
      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      // Exactly ONE step_created event in the correlation log
      const eventList = await events.listByCorrelationId({ correlationId: stepId });
      const created = eventList.data.filter((e) => e.eventType === 'step_created');
      expect(created).toHaveLength(1);
    });

    it('should reject duplicate run_created events with EntityConflictError', async () => {
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
      await expect(
        events.create(runId, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'test-workflow-idempotent',
            input: [],
          },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const listResult = await runs.list({ workflowName: 'test-workflow-idempotent' });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);

      // Exactly ONE run_created event in the run's log
      const eventList = await events.list({ runId, pagination: { sortOrder: 'asc' } });
      const created = eventList.data.filter((e) => e.eventType === 'run_created');
      expect(created).toHaveLength(1);
    });

    it('should not re-add a run to the pending status index on duplicate run_created', async () => {
      const result = await events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'index-corruption-test',
          input: [],
        },
      });
      const runId = result.run!.runId;

      await events.create(runId, { eventType: 'run_started' });

      // Duplicate run_created after the run has moved on — must not
      // resurrect the run in the pending index.
      await expect(
        events.create(runId, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'index-corruption-test',
            input: [],
          },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const pending = await runs.list({ status: 'pending' });
      expect(pending.data.some((r) => r.runId === runId)).toBe(false);
      const running = await runs.list({ status: 'running' });
      expect(running.data.some((r) => r.runId === runId)).toBe(true);
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
      const listResult = await _hooks.list({ runId: run.runId });
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

  describe('waits', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    it('should create a wait entity via wait_created', async () => {
      const resumeAt = new Date(Date.now() + 60_000);
      const result = await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-1',
        eventData: { resumeAt },
      });

      expect(result.event?.eventType).toBe('wait_created');
      expect(result.wait).toMatchObject({ runId: testRunId, status: 'waiting' });
      expect(result.wait?.resumeAt?.getTime()).toBe(resumeAt.getTime());
    });

    it('should reject duplicate wait_created with EntityConflictError', async () => {
      await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-dup',
        eventData: { resumeAt: new Date() },
      });

      await expect(
        events.create(testRunId, {
          eventType: 'wait_created',
          correlationId: 'wait-dup',
          eventData: { resumeAt: new Date() },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const eventList = await events.listByCorrelationId({ correlationId: 'wait-dup' });
      expect(eventList.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
    });

    it('should complete a wait exactly once', async () => {
      await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-once',
        eventData: { resumeAt: new Date() },
      });

      const completed = await events.create(testRunId, {
        eventType: 'wait_completed',
        correlationId: 'wait-once',
      });
      expect(completed.wait?.status).toBe('completed');
      expect(completed.wait?.completedAt).toBeInstanceOf(Date);

      // Replay: a second wait_completed must reject instead of appending a
      // duplicate event that would corrupt the log on future replays.
      await expect(
        events.create(testRunId, {
          eventType: 'wait_completed',
          correlationId: 'wait-once',
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const eventList = await events.listByCorrelationId({ correlationId: 'wait-once' });
      expect(eventList.data.filter((e) => e.eventType === 'wait_completed')).toHaveLength(1);
    });

    it('should reject concurrent duplicate wait_completed replays', async () => {
      await events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-race',
        eventData: { resumeAt: new Date() },
      });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(testRunId, {
            eventType: 'wait_completed',
            correlationId: 'wait-race',
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      for (const rejection of results.filter((r) => r.status === 'rejected')) {
        expect((rejection as PromiseRejectedResult).reason).toMatchObject({
          name: 'EntityConflictError',
        });
      }

      const eventList = await events.listByCorrelationId({ correlationId: 'wait-race' });
      expect(eventList.data.filter((e) => e.eventType === 'wait_completed')).toHaveLength(1);
    });

    it('should throw 404 for wait_completed on unknown wait', async () => {
      await expect(
        events.create(testRunId, {
          eventType: 'wait_completed',
          correlationId: 'wait-missing',
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('hook_created semantics', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    it('should reject a duplicate hook_created for the same run+hook+token', async () => {
      await events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-same-claim',
        eventData: { token: 'same-claim-token' },
      });

      // A redelivered hook_created for the SAME claim must NOT emit a
      // hook_conflict against its own token — that would fail the workflow.
      await expect(
        events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-same-claim',
          eventData: { token: 'same-claim-token' },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const eventList = await events.listByCorrelationId({ correlationId: 'hook-same-claim' });
      expect(eventList.data.map((e) => e.eventType)).toEqual(['hook_created']);

      // The token mapping still resolves to the original hook
      const byToken = await _hooks.getByToken('same-claim-token');
      expect(byToken.hookId).toBe('hook-same-claim');
      expect(byToken.runId).toBe(testRunId);
    });

    it('should emit hook_conflict with conflictingRunId when a different run claims the token', async () => {
      await events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-owner',
        eventData: { token: 'contested-token' },
      });

      const otherRun = await createRun({ workflowName: 'other-workflow' });
      const result = await events.create(otherRun.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-challenger',
        eventData: { token: 'contested-token' },
      });

      expect(result.hook).toBeUndefined();
      expect(result.event?.eventType).toBe('hook_conflict');
      expect(
        result.event && 'eventData' in result.event ? result.event.eventData : null,
      ).toMatchObject({
        token: 'contested-token',
        conflictingRunId: testRunId,
      });

      // The rightful owner's token mapping must be untouched
      const byToken = await _hooks.getByToken('contested-token');
      expect(byToken.hookId).toBe('hook-owner');
      expect(byToken.runId).toBe(testRunId);
    });
  });

  describe('error taxonomy', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    it('should throw EntityConflictError when modifying a terminal step', async () => {
      await createStep(testRunId, { stepId: 'step-terminal' });
      await events.create(testRunId, {
        eventType: 'step_started',
        correlationId: 'step-terminal',
      });
      await events.create(testRunId, {
        eventType: 'step_completed',
        correlationId: 'step-terminal',
        eventData: { result: ['done'] },
      });

      // Redelivered step_completed after the step finished — core swallows
      // EntityConflictError and re-enqueues the workflow.
      await expect(
        events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-terminal',
          eventData: { result: ['done'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      await expect(
        events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-terminal',
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('should reject concurrent terminal step transitions exactly once', async () => {
      await createStep(testRunId, { stepId: 'step-race' });
      await events.create(testRunId, {
        eventType: 'step_started',
        correlationId: 'step-race',
      });

      const results = await Promise.allSettled([
        events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-race',
          eventData: { result: ['a'] },
        }),
        events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'step-race',
          eventData: { error: 'boom' },
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const step = await steps.get(testRunId, 'step-race');
      expect(['completed', 'failed']).toContain(step.status);
    });

    it('should gate step_started behind retryAfter with TooEarlyError', async () => {
      await createStep(testRunId, { stepId: 'step-backoff' });
      await events.create(testRunId, {
        eventType: 'step_started',
        correlationId: 'step-backoff',
      });
      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step-backoff',
        eventData: { error: 'transient', retryAfter: new Date(Date.now() + 60_000) },
      });

      await expect(
        events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-backoff',
        }),
      ).rejects.toMatchObject({ name: 'TooEarlyError' });
    });

    it('should clear retryAfter once the backoff has elapsed', async () => {
      await createStep(testRunId, { stepId: 'step-backoff-elapsed' });
      await events.create(testRunId, {
        eventType: 'step_started',
        correlationId: 'step-backoff-elapsed',
      });
      await events.create(testRunId, {
        eventType: 'step_retrying',
        correlationId: 'step-backoff-elapsed',
        eventData: { error: 'transient', retryAfter: new Date(Date.now() - 1000) },
      });

      const result = await events.create(testRunId, {
        eventType: 'step_started',
        correlationId: 'step-backoff-elapsed',
      });
      expect(result.step?.status).toBe('running');
      expect(result.step?.attempt).toBe(2);
      expect(result.step?.retryAfter).toBeUndefined();
    });

    it('should throw RunExpiredError for run_started on a terminal run', async () => {
      await events.create(testRunId, { eventType: 'run_started' });
      await events.create(testRunId, {
        eventType: 'run_completed',
        eventData: { output: [] },
      });

      await expect(events.create(testRunId, { eventType: 'run_started' })).rejects.toMatchObject({
        name: 'RunExpiredError',
      });
    });

    it('should throw WorkflowRunNotFoundError for run_started without a run or runInput', async () => {
      await expect(
        events.create('wrun_does_not_exist', { eventType: 'run_started' }),
      ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
    });

    it('should throw HookNotFoundError for hook getters and hook events on unknown hooks', async () => {
      await expect(_hooks.get('missing-hook')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
      await expect(_hooks.getByToken('missing-token')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
      await expect(
        events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'missing-hook',
          eventData: { payload: {} },
        }),
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });

    it('should allow exactly one terminal run transition', async () => {
      await events.create(testRunId, { eventType: 'run_started' });

      const results = await Promise.allSettled([
        events.create(testRunId, { eventType: 'run_completed', eventData: { output: [] } }),
        events.create(testRunId, { eventType: 'run_cancelled' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const run = await runs.get(testRunId);
      expect(['completed', 'cancelled']).toContain(run.status);

      // The run must be a member of exactly one status index
      const completed = await runs.list({ status: 'completed' });
      const cancelled = await runs.list({ status: 'cancelled' });
      const memberships = [
        completed.data.some((r) => r.runId === testRunId),
        cancelled.data.some((r) => r.runId === testRunId),
      ].filter(Boolean);
      expect(memberships).toHaveLength(1);
    });
  });

  describe('pagination cursors', () => {
    it('should throw on an invalid runs cursor instead of silently skipping', async () => {
      await createRun();
      await expect(
        runs.list({ pagination: { cursor: 'wrun_bogus_cursor' } }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('should throw on an invalid events cursor', async () => {
      const run = await createRun();
      await expect(
        events.list({ runId: run.runId, pagination: { cursor: 'wevt_bogus' } }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('should paginate combined workflowName+status listings without dropping runs', async () => {
      // 5 completed + 5 pending runs interleaved under one workflow name
      const completedIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const run = await createRun({ workflowName: 'combined-filter' });
        if (i % 2 === 0) {
          await events.create(run.runId, { eventType: 'run_started' });
          await events.create(run.runId, {
            eventType: 'run_completed',
            eventData: { output: [] },
          });
          completedIds.push(run.runId);
        }
        await setTimeout(2);
      }

      // Page size 2: naive limit+1 candidate fetches under-fetch because the
      // in-memory status filter rejects interleaved pending runs.
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await runs.list({
          workflowName: 'combined-filter',
          status: 'completed',
          pagination: { limit: 2, ...(cursor ? { cursor } : {}) },
        });
        seen.push(...result.data.map((r) => r.runId));
        if (!result.hasMore) break;
        cursor = result.cursor;
      }

      expect(seen.toSorted()).toEqual(completedIds.toSorted());
    });
  });
});
