import { setTimeout } from 'node:timers/promises';
import { expectRejectedWith } from '@fantasticfour/testing';
import { RedisContainer } from '@testcontainers/redis';
import { PreconditionFailedError } from '@workflow/errors';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

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
    it('rejects a duplicate step_created with EntityConflictError', async () => {
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

      // Redelivered step_created: the runtime catches EntityConflictError as
      // its dedup signal. Returning success would append a second
      // step_created row and poison replay with ReplayDivergenceError.
      await expect(
        events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

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
      const run = await createRun();
      const waitId = 'wait-idempotent-test';
      const eventData = {
        eventType: 'wait_created' as const,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };

      await events.create(run.runId, eventData);

      // Waits have no entity in this world; the event log is the only
      // dedup surface guarding a replayed wait_created.
      await expect(events.create(run.runId, eventData)).rejects.toMatchObject({
        name: 'EntityConflictError',
      });

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
    });

    it('rejects a duplicate run_created with EntityConflictError', async () => {
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

      // A redelivered run_created must not return the existing run AND
      // append a second run_created row; core catches EntityConflictError
      // as "the run already exists" on its concurrent-create path.
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

      const eventList = await events.list({ runId, pagination: {} });
      expect(eventList.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('concurrent creation deliveries settle on exactly one event row', async () => {
      const run = await createRun();

      // Steps: five racers, one entity, one step_created row.
      const stepId = 'step-race';
      const stepResults = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(run.runId, {
            eventType: 'step_created',
            correlationId: stepId,
            eventData: { stepName: 'test-step', input: ['input1'] },
          }),
        ),
      );
      expect(stepResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expectRejectedWith(stepResults, 'EntityConflictError');
      const stepEvents = await events.listByCorrelationId({
        correlationId: stepId,
        pagination: {},
      });
      expect(stepEvents.data.map((e) => e.eventType)).toEqual(['step_created']);

      // Hooks: five racers on one token, one hook_created row, no conflict.
      const hookId = 'hook-race';
      const hookResults = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(run.runId, {
            eventType: 'hook_created',
            correlationId: hookId,
            eventData: { token: 'race-token' },
          }),
        ),
      );
      expect(hookResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const hookEvents = await events.listByCorrelationId({
        correlationId: hookId,
        pagination: {},
      });
      expect(hookEvents.data.map((e) => e.eventType)).toEqual(['hook_created']);
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

    it('should throw WorkflowRunNotFoundError for run_started on missing run without bootstrap data', async () => {
      await expect(
        events.create('wrun_missing_run', { eventType: 'run_started' }),
      ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
    });
  });

  describe('Error taxonomy (core matches errors by name)', () => {
    it('should throw EntityConflictError for step_started on a terminal step', async () => {
      const run = await createRun();
      const stepId = 'step-terminal-guard';
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: 'ok' },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'step_started',
          correlationId: stepId,
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('should throw EntityConflictError for duplicate step_completed', async () => {
      const run = await createRun();
      const stepId = 'step-double-complete';
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: 'ok' },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'step_completed',
          correlationId: stepId,
          eventData: { result: 'ok again' },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('should throw HookNotFoundError for hook_disposed on a missing hook', async () => {
      const run = await createRun();
      await expect(
        events.create(run.runId, {
          eventType: 'hook_disposed',
          correlationId: 'hook-never-created',
        }),
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });

    it('should throw HookNotFoundError from hooks.get and hooks.getByToken', async () => {
      await expect(_hooks.get('missing-hook')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
      await expect(_hooks.getByToken('missing-token')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
    });
  });

  describe('step retry backoff (retryAfter)', () => {
    it('should reject early step_started with TooEarlyError while retryAfter is in the future', async () => {
      const run = await createRun();
      const stepId = 'step-backoff';
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: stepId,
        eventData: { error: 'boom', retryAfter: new Date(Date.now() + 60_000) },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'step_started',
          correlationId: stepId,
        }),
      ).rejects.toMatchObject({ name: 'TooEarlyError' });
    });

    it('should clear retryAfter once the step starts after the backoff window', async () => {
      const run = await createRun();
      const stepId = 'step-backoff-elapsed';
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: stepId,
        eventData: { error: 'boom', retryAfter: new Date(Date.now() - 1000) },
      });

      const beforeRestart = await steps.get(run.runId, stepId);
      expect(beforeRestart.retryAfter).toBeInstanceOf(Date);

      const result = await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: stepId,
      });
      expect(result.step?.status).toBe('running');
      expect(result.step?.retryAfter).toBeUndefined();

      const persisted = await steps.get(run.runId, stepId);
      expect(persisted.retryAfter).toBeUndefined();
    });
  });

  describe('hook_created duplicate semantics', () => {
    it('should throw EntityConflictError for a duplicate hook_created of the same hook', async () => {
      const run = await createRun();
      const hookId = 'hook-duplicate-same';
      const token = 'token-duplicate-same';

      const first = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(first.hook).toBeDefined();

      // Duplicate delivery of the SAME (runId, hookId): must be an
      // EntityConflictError, NOT a self hook_conflict event that would
      // poison later replays with HookConflictError.
      await expect(
        events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const eventList = await events.listByCorrelationId({
        correlationId: hookId,
        pagination: {},
      });
      expect(eventList.data.filter((e) => e.eventType === 'hook_conflict')).toHaveLength(0);
      // Exactly one hook_created row: a duplicate that appended a second
      // creation event would poison replay with ReplayDivergenceError.
      expect(eventList.data.map((e) => e.eventType)).toEqual(['hook_created']);
    });

    it('rejects a legacy crash orphan (hook entity without hook_created event)', async () => {
      const run = await createRun();
      const hookId = 'hook-orphan';
      const token = 'token-orphan';

      // Simulate a crash between the hook entity write and the event write:
      // create the hook entity + indexes directly, with no hook_created event.
      const orphanHook = {
        runId: run.runId,
        hookId,
        token,
        ownerId: '',
        projectId: '',
        environment: '',
        specVersion: 4,
        createdAt: new Date(),
      };
      await redis.set(`${keyPrefix}hook:${hookId}`, JSON.stringify(orphanHook));
      await redis.set(`${keyPrefix}hooks:by_token:${token}`, hookId);
      await redis.zadd(`${keyPrefix}hooks:by_run:${run.runId}`, Date.now(), hookId);

      // Entity and creation event are now written in one atomic script, so
      // this state can only be legacy data. A replayed hook_created rejects
      // (the entity exists) rather than risking a duplicate append; it does
      // NOT record a self hook_conflict.
      await expect(
        events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const eventList = await events.listByCorrelationId({
        correlationId: hookId,
        pagination: {},
      });
      expect(eventList.data.filter((e) => e.eventType === 'hook_created')).toHaveLength(0);
      expect(eventList.data.filter((e) => e.eventType === 'hook_conflict')).toHaveLength(0);
    });

    it('should record hook_conflict with conflictingRunId when another run holds the token', async () => {
      const runA = await createRun();
      const runB = await createRun();
      const token = 'token-cross-run';

      await events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-owner',
        eventData: { token },
      });

      const result = await events.create(runB.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-intruder',
        eventData: { token },
      });

      expect(result.hook).toBeUndefined();
      expect(result.event?.eventType).toBe('hook_conflict');
      expect(
        (result.event as { eventData?: { conflictingRunId?: string } }).eventData,
      ).toMatchObject({
        token,
        conflictingRunId: runA.runId,
      });
    });
  });

  describe('runs.list combined filtering', () => {
    it('should paginate correctly when combining workflowName and status filters', async () => {
      const workflowName = 'combined-filter-workflow';

      // 12 runs of the same workflow; complete every other one, so 6 remain
      // pending. With limit 3 the pending runs span multiple index pages.
      const runIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const run = await createRun({ workflowName });
        runIds.push(run.runId);
        if (i % 2 === 0) {
          await events.create(run.runId, { eventType: 'run_started' });
          await events.create(run.runId, {
            eventType: 'run_completed',
            eventData: { output: ['done'] },
          });
        }
        await setTimeout(2);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await runs.list({
          workflowName,
          status: 'pending',
          pagination: { limit: 3, ...(cursor ? { cursor } : {}) },
        });
        collected.push(...result.data.map((r) => r.runId));
        if (!result.hasMore) break;
        cursor = result.cursor;
      }

      const expectedPending = runIds.filter((_, i) => i % 2 === 1);
      expect(new Set(collected)).toEqual(new Set(expectedPending));
    });
  });

  describe('streamer', () => {
    it('should not drop chunks when stream sequence numbers cross a digit boundary', async () => {
      const streamer = createStreamer({ redis, keyPrefix });
      try {
        // Pre-populate a stream with entries in the same millisecond whose
        // sequence numbers cross the 9 -> 10 digit boundary. Lexicographic ID
        // comparison would drop entries 7-10 through 7-12 and the eof marker.
        const streamName = 'digit-boundary-stream';
        const key = `${keyPrefix}stream:${streamName}`;
        for (let seq = 1; seq <= 12; seq++) {
          await redis.xadd(
            key,
            `7-${seq}`,
            'data',
            Buffer.from(`chunk-${seq}`).toString('base64'),
            'eof',
            'false',
          );
        }
        await redis.xadd(key, '7-13', 'data', '', 'eof', 'true');

        const stream = await streamer.readFromStream(streamName);
        const reader = stream.getReader();
        const chunks: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(Buffer.from(value).toString());
        }

        expect(chunks).toEqual(Array.from({ length: 12 }, (_, i) => `chunk-${i + 1}`));
      } finally {
        await streamer.close();
      }
    });
  });

  describe('binary payload serialization', () => {
    it('round-trips Uint8Array through storage using the tagged base64 encoding', async () => {
      const payload = new Uint8Array([0, 1, 2, 250, 255]);
      const run = await createRun({ input: [payload] });

      const fetched = await runs.get(run.runId);
      const roundTripped = (fetched.input as unknown[])[0];
      expect(roundTripped).toBeInstanceOf(Uint8Array);
      expect(Array.from(roundTripped as Uint8Array)).toEqual([0, 1, 2, 250, 255]);

      const raw = await redis.get(`${keyPrefix}run:${run.runId}`);
      expect(raw).toContain('"__type":"Uint8Array"');
      expect(raw).not.toContain('__uint8array');
    });

    it('still reads the legacy number-array encoding already in Redis', async () => {
      const run = await createRun({ input: [new Uint8Array([1, 2, 3])] });
      const raw = await redis.get(`${keyPrefix}run:${run.runId}`);
      const legacy = raw!.replace(
        /\{"__type":"Uint8Array","data":"[^"]*"\}/,
        '{"__uint8array":true,"data":[1,2,3]}',
      );
      expect(legacy).toContain('__uint8array');
      await redis.set(`${keyPrefix}run:${run.runId}`, legacy);

      const fetched = await runs.get(run.runId);
      const roundTripped = (fetched.input as unknown[])[0];
      expect(roundTripped).toBeInstanceOf(Uint8Array);
      expect(Array.from(roundTripped as Uint8Array)).toEqual([1, 2, 3]);
    });

    it('round-trips a fat binary payload through a step result', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, { stepId: 'fat-step' });
      await events.create(run.runId, { eventType: 'step_started', correlationId: step.stepId });

      const payload = new Uint8Array(64 * 1024);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 256;
      }
      const result = await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: payload },
      });

      const output = result.step?.output as Uint8Array;
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBe(payload.length);
      expect(output[1000]).toBe(payload[1000]);

      const raw = await redis.get(`${keyPrefix}step:${run.runId}:${step.stepId}`);
      expect(raw).toContain('"__type":"Uint8Array"');
      expect(raw).not.toContain('__uint8array');
    });
  });

  describe('maxEvents (EventResult.maxEvents)', () => {
    it('reports the default per-run event ceiling on run_started', async () => {
      const run = await createRun();
      const result = await events.create(run.runId, { eventType: 'run_started' });
      expect(result.maxEvents).toBe(25_000);
    });

    it('reports the ceiling again on the idempotent run_started replay', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const replay = await events.create(run.runId, { eventType: 'run_started' });
      expect(replay.run?.status).toBe('running');
      expect(replay.maxEvents).toBe(25_000);
    });

    it('honours an explicit maxEventsPerRun config', async () => {
      const scoped = createEventsStorage({ redis, keyPrefix, maxEventsPerRun: 10 });
      const created = await scoped.create(null, {
        eventType: 'run_created',
        eventData: { deploymentId: 'd', workflowName: 'capped', input: [] },
      });
      expect(created.maxEvents).toBe(10);
      const started = await scoped.create(created.run!.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(10);
    });

    it('rejects a maxEventsPerRun that is not a positive integer', () => {
      expect(() => createEventsStorage({ redis, keyPrefix, maxEventsPerRun: 0 })).toThrow(
        TypeError,
      );
      expect(() => createEventsStorage({ redis, keyPrefix, maxEventsPerRun: 1.5 })).toThrow(
        TypeError,
      );
    });
  });

  describe('optimistic concurrency (stateUpdatedAt guard)', () => {
    const runStateKey = (runId: string) => `${keyPrefix}run:state:${runId}`;

    /** Create a run that is running with one completed step, so the per-run
     * state marker has been advanced by an externally-originated event. */
    async function runWithMarker() {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, { stepId: 'external-step' });
      await events.create(run.runId, { eventType: 'step_started', correlationId: step.stepId });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: 'ok' },
      });
      const raw = await redis.get(runStateKey(run.runId));
      expect(raw).not.toBeNull();
      return { run, marker: Number(raw) };
    }

    it('does not advance the marker on run lifecycle events', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      expect(await redis.get(runStateKey(run.runId))).toBeNull();
    });

    it('advances the marker on an externally-originated step_completed', async () => {
      const { marker } = await runWithMarker();
      expect(marker).toBeGreaterThan(0);
    });

    it('does not advance the marker for a replay-origin create', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, { stepId: 'replay-step' });
      await events.create(run.runId, { eventType: 'step_started', correlationId: step.stepId });
      await events.create(
        run.runId,
        {
          eventType: 'step_completed',
          correlationId: step.stepId,
          eventData: { result: 'ok' },
        },
        { stateUpdatedAt: Date.now() },
      );
      expect(await redis.get(runStateKey(run.runId))).toBeNull();
    });

    it('rejects a strictly older stateUpdatedAt with PreconditionFailedError', async () => {
      const { run, marker } = await runWithMarker();
      await expect(
        events.create(
          run.runId,
          {
            eventType: 'step_created',
            correlationId: 'stale-step',
            eventData: { stepName: 'stale', input: [] },
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toThrow(PreconditionFailedError);
      // The guarded write must not have landed.
      expect(await redis.get(`${keyPrefix}step:${run.runId}:stale-step`)).toBeNull();
    });

    it('accepts an equal stateUpdatedAt (anti-livelock)', async () => {
      const { run, marker } = await runWithMarker();
      const result = await events.create(
        run.runId,
        {
          eventType: 'step_created',
          correlationId: 'equal-step',
          eventData: { stepName: 'equal', input: [] },
        },
        { stateUpdatedAt: marker },
      );
      expect(result.step?.stepId).toBe('equal-step');
    });

    it('falls open when no stateUpdatedAt is supplied', async () => {
      const { run } = await runWithMarker();
      const result = await events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'unguarded-step',
        eventData: { stepName: 'unguarded', input: [] },
      });
      expect(result.step?.stepId).toBe('unguarded-step');
    });

    it('rejects a stale run_completed without marking the run terminal', async () => {
      const { run, marker } = await runWithMarker();
      await expect(
        events.create(
          run.runId,
          { eventType: 'run_completed', eventData: { output: [] } },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toThrow(PreconditionFailedError);

      const current = await runs.get(run.runId);
      expect(current.status).toBe('running');
    });

    it('rejects a stale hook_created', async () => {
      const { run, marker } = await runWithMarker();
      await expect(
        events.create(
          run.runId,
          {
            eventType: 'hook_created',
            correlationId: 'hook-guard',
            eventData: { token: 'token-guard' },
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toThrow(PreconditionFailedError);
      expect(await redis.get(`${keyPrefix}hook:hook-guard`)).toBeNull();
    });
  });

  // The compact `run:meta:` key and the per-run hook token map are both
  // written going forward but are absent from runs that already existed when
  // they were introduced. Each read path has to degrade to the old behaviour
  // rather than mistake a missing key for a missing entity.
  describe('records written before the meta key and hook token map existed', () => {
    it('validates events against the run body when the meta key is missing', async () => {
      const run = await createRun();
      await redis.del(`${keyPrefix}run:meta:${run.runId}`);

      // step_created only consults status/specVersion, which now normally come
      // from the meta key; without it the run body must still be consulted.
      const step = await createStep(run.runId, { stepId: 'step-no-meta' });
      expect(step.status).toBe('pending');
    });

    it('still rejects entity creation on a terminal run when the meta key is missing', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started', eventData: {} });
      await events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });
      await redis.del(`${keyPrefix}run:meta:${run.runId}`);

      await expect(createStep(run.runId, { stepId: 'step-after-terminal' })).rejects.toThrow(
        /terminal state/,
      );
    });

    it('releases hook tokens on a terminal run even without a token map', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started', eventData: {} });
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-legacy',
        eventData: { token: 'token-legacy' },
      });

      // Simulate a hook written before the token map was introduced.
      await redis.del(`${keyPrefix}hooks:tokens:${run.runId}`);
      expect(await redis.get(`${keyPrefix}hooks:by_token:token-legacy`)).toBe('hook-legacy');

      await events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });

      // Cleanup must reclaim the hook, its token lookup, and the index.
      expect(await redis.get(`${keyPrefix}hook:hook-legacy`)).toBeNull();
      expect(await redis.get(`${keyPrefix}hooks:by_token:token-legacy`)).toBeNull();
      expect(await redis.exists(`${keyPrefix}hooks:by_run:${run.runId}`)).toBe(0);
    });

    it('releases hook tokens on a terminal run via the token map', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started', eventData: {} });
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-mapped',
        eventData: { token: 'token-mapped' },
      });
      await events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });

      expect(await redis.get(`${keyPrefix}hook:hook-mapped`)).toBeNull();
      expect(await redis.get(`${keyPrefix}hooks:by_token:token-mapped`)).toBeNull();
      expect(await redis.exists(`${keyPrefix}hooks:tokens:${run.runId}`)).toBe(0);
    });
  });

  // `parse` takes a fast path that skips JSON's reviver when the payload holds
  // no binary. Dates still have to come back as Dates on that path.
  describe('date revival on the non-binary fast path', () => {
    it('revives entity timestamps as Date instances', async () => {
      const run = await createRun();
      const reread = await runs.get(run.runId);
      expect(reread.createdAt).toBeInstanceOf(Date);
      expect(reread.updatedAt).toBeInstanceOf(Date);
    });

    it('revives retryAfter inside a stored event payload', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started', eventData: {} });
      const step = await createStep(run.runId, { stepId: 'step-retry-date' });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
        eventData: {},
      });

      const retryAfter = new Date(Date.now() + 30_000);
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'boom', retryAfter },
      });

      // ListEventsByCorrelationIdParams takes no runId; the correlation id is
      // already run-scoped. The extra property was silently dropped before
      // tests were typechecked.
      const stored = await events.listByCorrelationId({
        correlationId: step.stepId,
      });
      const retrying = stored.data.find((e) => e.eventType === 'step_retrying');
      expect((retrying?.eventData as { retryAfter?: unknown })?.retryAfter).toBeInstanceOf(Date);
    });

    it('revives dates when the payload also contains binary', async () => {
      const run = await createRun({ input: [new Uint8Array([7, 8, 9])] });
      const reread = await runs.get(run.runId);
      expect(reread.createdAt).toBeInstanceOf(Date);
      expect((reread.input as Uint8Array[])[0]).toBeInstanceOf(Uint8Array);
    });
  });
});
