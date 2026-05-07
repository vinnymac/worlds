import { RedisContainer } from '@testcontainers/redis';
import { Redis } from '@upstash/redis';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';

describe('Storage (Upstash Redis integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on docker containers', () => {});
    return;
  }

  let network: StartedNetwork;
  let redisContainer: StartedTestContainer;
  let srhContainer: StartedTestContainer;
  let redis: Redis;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let _hooks: ReturnType<typeof createHooksStorage>;

  const keyPrefix = 'workflow:test:';
  const SRH_TOKEN = 'test-token';

  async function flushTestKeys() {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const result = await redis.scan(cursor, {
        match: `${keyPrefix}*`,
        count: 100,
      });
      cursor = result[0];
      if (result[1].length > 0) {
        keys.push(...result[1]);
      }
    } while (cursor !== '0');

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
    // Create a Docker network so the SRH container can reach Redis
    network = await new Network().start();

    // Start Redis container
    redisContainer = await new RedisContainer('redis:7-alpine')
      .withNetwork(network)
      .withNetworkAliases('redis')
      .start();

    // Start serverless-redis-http (Upstash-compatible REST API)
    srhContainer = await new GenericContainer('hiett/serverless-redis-http:latest')
      .withNetwork(network)
      .withEnvironment({
        SRH_MODE: 'env',
        SRH_TOKEN,
        SRH_CONNECTION_STRING: 'redis://redis:6379',
      })
      .withExposedPorts(80)
      .start();

    const srhUrl = `http://${srhContainer.getHost()}:${srhContainer.getMappedPort(80)}`;

    // Initialize Upstash Redis client pointing at the local SRH
    redis = new Redis({
      url: srhUrl,
      token: SRH_TOKEN,
    });

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
    await srhContainer?.stop();
    await redisContainer?.stop();
    await network?.stop();
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

    it('should list steps for a run', async () => {
      const run = await createRun();
      await createStep(run.runId, { stepId: 'step-1' });
      await createStep(run.runId, { stepId: 'step-2' });
      await createStep(run.runId, { stepId: 'step-3' });

      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(3);
    });
  });
});
