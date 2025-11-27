import { setTimeout } from 'node:timers/promises';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import {
  createEventsStorage,
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

  const keyPrefix = 'workflow:test:';

  async function flushTestKeys() {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
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
  }, 120_000);

  beforeEach(async () => {
    await flushTestKeys();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  describe('runs', () => {
    describe('create', () => {
      it('should create a new workflow run', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          executionContext: { userId: 'user-1' },
          input: ['arg1', 'arg2'],
        };

        const run = await runs.create(runData);

        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe('deployment-123');
        expect(run.status).toBe('pending');
        expect(run.workflowName).toBe('test-workflow');
        expect(run.executionContext).toEqual({ userId: 'user-1' });
        expect(run.input).toEqual(['arg1', 'arg2']);
        expect(run.output).toBeUndefined();
        expect(run.error).toBeUndefined();
        expect(run.errorCode).toBeUndefined();
        expect(run.startedAt).toBeUndefined();
        expect(run.completedAt).toBeUndefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await runs.create({
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

    describe('update', () => {
      it('should update run status to running', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'running',
        });
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'completed',
          output: [{ result: 42 }],
        });
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await setTimeout(5);

        const run2 = await runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
      });

      it('should filter runs by workflowName', async () => {
        await runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });
    });

    describe('cancel', () => {
      it('should cancel a run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const cancelled = await runs.cancel(created.runId);

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('pause/resume', () => {
      it('should pause and resume a run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const paused = await runs.pause(created.runId);
        expect(paused.status).toBe('paused');

        const resumed = await runs.resume(created.runId);
        expect(resumed.status).toBe('running');
        expect(resumed.startedAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        };

        const step = await steps.create(testRunId, stepData);

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step-123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.attempt).toBe(1);
      });
    });

    describe('get', () => {
      it('should retrieve a step', async () => {
        const created = await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await steps.get(testRunId, 'step-123');
        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(
          steps.get(testRunId, 'missing-step')
        ).rejects.toMatchObject({ status: 404 });
      });

      it('should find step by stepId without runId using SCAN', async () => {
        const created = await steps.create(testRunId, {
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
        await expect(
          steps.get(undefined, 'nonexistent-step-id')
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('update', () => {
      it('should update step status to completed', async () => {
        await steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await steps.update(testRunId, 'step-123', {
          status: 'completed',
          output: ['ok'],
        });

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const event = await events.create(testRunId, eventData);

        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_started');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        const event1 = await events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        await setTimeout(5);

        const event2 = await events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[1].eventId).toBe(event2.eventId);
      });
    });

    describe('listByCorrelationId', () => {
      it('should list events by correlation ID', async () => {
        const correlationId = 'step-abc123';

        const event1 = await events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        const event2 = await events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        await events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'different-step',
        });

        const result = await events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[0].correlationId).toBe(correlationId);
        expect(result.data[1].correlationId).toBe(correlationId);
      });
    });
  });
});
