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

      it('should throw error for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toMatchObject({
          status: 404,
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
});
