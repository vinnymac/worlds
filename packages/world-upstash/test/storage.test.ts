import { expectEventType, expectRejectedWith } from '@fantasticfour/testing';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from '@upstash/redis';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
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
import { createStreamer } from '../src/streamer.js';
import { stringify } from '../src/util.js';

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
  let hooks: ReturnType<typeof createHooksStorage>;
  let streamer: ReturnType<typeof createStreamer>;

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
    srhContainer = await new GenericContainer('ghcr.io/vinnymac/serverless-redis-http:latest')
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
    hooks = createHooksStorage(config);
    streamer = createStreamer({ redis, keyPrefix, pollIntervalMs: 50 });
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
    it('should throw EntityConflictError for duplicate step_created events', async () => {
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

      // Duplicate step_created event (replay scenario); core catches
      // EntityConflictError (by name) as "step already exists, continuing".
      const err: unknown = await events
        .create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(err)).toBe(true);

      // Only ONE step_created event should exist in the log
      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const stepCreatedEvents = eventList.data.filter((e) => e.eventType === 'step_created');
      expect(stepCreatedEvents).toHaveLength(1);

      // Verify step appears in list query (critical!)
      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);
    });

    it('should throw EntityConflictError for duplicate wait_created events', async () => {
      const run = await createRun();
      const waitId = 'wait-idempotent-test';
      const eventData = {
        eventType: 'wait_created' as const,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };

      await events.create(run.runId, eventData);

      // Waits have no entity in this world — the creation-event claim is
      // the only guard against a replayed wait_created duplicating the log.
      const err: unknown = await events.create(run.runId, eventData).catch((e: unknown) => e);
      expect(EntityConflictError.is(err)).toBe(true);

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
    });

    it('should throw EntityConflictError for duplicate run_created events', async () => {
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

      // Duplicate run_created event; core's start() treats
      // EntityConflictError as the benign "run already exists" signal.
      const err: unknown = await events
        .create(runId, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'test-workflow-idempotent',
            input: [],
          },
        })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(err)).toBe(true);

      // Only ONE run_created event should exist in the log
      const eventList = await events.list({ runId, pagination: { sortOrder: 'asc' } });
      const runCreatedEvents = eventList.data.filter((e) => e.eventType === 'run_created');
      expect(runCreatedEvents).toHaveLength(1);

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
  });

  describe('Creation-claim hardening', () => {
    it('claim keys carry the default TTL', async () => {
      const run = await createRun();
      const stepId = 'step-claim-ttl';
      await createStep(run.runId, { stepId });

      const claimKey = `${keyPrefix}events:creation:${run.runId}:${stepId}:step_created`;
      const ttl = await redis.ttl(claimKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    });

    it('concurrent step_created deliveries converge on a single event row', async () => {
      const run = await createRun();
      const stepId = 'step-claim-race';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(run.runId, {
            eventType: 'step_created',
            correlationId: stepId,
            eventData: { stepName: 'test-step', input: ['input1'] },
          }),
        ),
      );
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await events.list({ runId: run.runId });
      expect(
        eventList.data.filter((e) => e.eventType === 'step_created' && e.correlationId === stepId),
      ).toHaveLength(1);
    });

    it('concurrent replays over a LEGACY token claim converge on one hook_created', async () => {
      const run = await createRun();
      const hookId = 'hook-legacy-claim';
      const token = 'token-legacy-claim';

      // Seed pre-eventId state by hand: hook entity + legacy token claim
      // (plain hookId, no canonical eventId) with NO hook_created event in
      // the log (the state a crash leaves under the old claim format).
      const legacyHook = {
        runId: run.runId,
        hookId,
        token,
        ownerId: '',
        projectId: '',
        environment: '',
        isWebhook: false,
        specVersion: run.specVersion,
        createdAt: new Date(),
      };
      await redis.set(`${keyPrefix}hook:${hookId}`, stringify(legacyHook));
      await redis.set(`${keyPrefix}hooks:by_token:${token}`, hookId);

      // Two concurrent replays race the legacy-claim upgrade; the CAS lets
      // exactly one install its eventId and the other adopts it.
      const replay = () =>
        events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        });
      const results = await Promise.allSettled([replay(), replay()]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      // Exactly one hook_created row, and never a self hook_conflict.
      const eventList = await events.list({ runId: run.runId });
      expect(
        eventList.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === hookId),
      ).toHaveLength(1);
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);

      // A further replay is a true duplicate.
      const err: unknown = await replay().catch((e: unknown) => e);
      expect(EntityConflictError.is(err)).toBe(true);
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

  describe('Error taxonomy (core matches by name)', () => {
    it('runs.get throws WorkflowRunNotFoundError for unknown run', async () => {
      const err: unknown = await runs.get('wrun_does_not_exist').catch((e: unknown) => e);
      expect(WorkflowRunNotFoundError.is(err)).toBe(true);
    });

    it('hooks.get throws HookNotFoundError for unknown hook', async () => {
      const err: unknown = await hooks.get('hook-does-not-exist').catch((e: unknown) => e);
      expect(HookNotFoundError.is(err)).toBe(true);
    });

    it('hooks.getByToken throws HookNotFoundError for unknown token', async () => {
      const err: unknown = await hooks.getByToken('token-does-not-exist').catch((e: unknown) => e);
      expect(HookNotFoundError.is(err)).toBe(true);
    });

    it('hook_received on unknown hook throws HookNotFoundError', async () => {
      const run = await createRun();
      const err: unknown = await events
        .create(run.runId, {
          eventType: 'hook_received',
          correlationId: 'hook-does-not-exist',
          eventData: { payload: {} },
        })
        .catch((e: unknown) => e);
      expect(HookNotFoundError.is(err)).toBe(true);
    });

    it('run_started on a missing run throws WorkflowRunNotFoundError', async () => {
      const err: unknown = await events
        .create('wrun_does_not_exist', { eventType: 'run_started' })
        .catch((e: unknown) => e);
      expect(WorkflowRunNotFoundError.is(err)).toBe(true);
    });

    it('terminal-step transitions throw EntityConflictError', async () => {
      const run = await createRun();
      const step = await createStep(run.runId, { stepId: 'step-terminal' });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: 'done' },
      });

      const startErr: unknown = await events
        .create(run.runId, { eventType: 'step_started', correlationId: step.stepId })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(startErr)).toBe(true);

      const completeErr: unknown = await events
        .create(run.runId, {
          eventType: 'step_completed',
          correlationId: step.stepId,
          eventData: { result: 'done-again' },
        })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(completeErr)).toBe(true);

      const failErr: unknown = await events
        .create(run.runId, {
          eventType: 'step_failed',
          correlationId: step.stepId,
          eventData: { error: 'boom' },
        })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(failErr)).toBe(true);
    });
  });

  describe('Step retry semantics', () => {
    it('step_started before retryAfter throws TooEarlyError with retryAfter seconds', async () => {
      const run = await createRun();
      const step = await createStep(run.runId, { stepId: 'step-retry' });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });

      const retryAfter = new Date(Date.now() + 60_000);
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'transient', retryAfter },
      });

      const err: unknown = await events
        .create(run.runId, { eventType: 'step_started', correlationId: step.stepId })
        .catch((e: unknown) => e);
      expect(TooEarlyError.is(err)).toBe(true);
      const tooEarly = err as TooEarlyError;
      expect(tooEarly.retryAfter).toBeGreaterThan(0);
      expect(tooEarly.retryAfter).toBeLessThanOrEqual(60);
    });

    it('step_started after retryAfter passes and clears retryAfter', async () => {
      const run = await createRun();
      const step = await createStep(run.runId, { stepId: 'step-retry-past' });
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });

      const retryAfter = new Date(Date.now() - 1_000);
      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'transient', retryAfter },
      });

      const result = await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      expect(result.step?.status).toBe('running');
      expect(result.step?.retryAfter).toBeUndefined();
      expect(result.step?.attempt).toBe(2);
    });
  });

  describe('Hook semantics', () => {
    it('same (runId, hookId) replay throws EntityConflictError, not hook_conflict', async () => {
      const run = await createRun();
      const hookId = 'hook-replay';
      const token = 'token-replay';

      const result1 = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(result1.hook).toBeDefined();
      expect(result1.event?.eventType).toBe('hook_created');

      const err: unknown = await events
        .create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        })
        .catch((e: unknown) => e);
      expect(EntityConflictError.is(err)).toBe(true);

      // No hook_conflict event may be logged for a self-replay
      const eventList = await events.list({ runId: run.runId });
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
      // And exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      expect(
        eventList.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === hookId),
      ).toHaveLength(1);
    });

    it('foreign token claim persists hook_conflict with conflictingRunId', async () => {
      const runA = await createRun();
      const runB = await createRun();
      const token = 'token-contested';

      await events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-a',
        eventData: { token },
      });

      const result = await events.create(runB.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-b',
        eventData: { token },
      });
      expect(result.hook).toBeUndefined();
      expect(expectEventType(result.event, 'hook_conflict').eventData).toMatchObject({
        conflictingRunId: runA.runId,
      });
    });

    it('persists isWebhook on the hook entity (default false)', async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-internal',
        eventData: { token: 'token-internal' },
      });
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-webhook',
        eventData: { token: 'token-webhook', isWebhook: true },
      });

      const internal = await hooks.get('hook-internal');
      expect(internal.isWebhook).toBe(false);

      const webhook = await hooks.getByToken('token-webhook');
      expect(webhook.isWebhook).toBe(true);
      expect(webhook.hookId).toBe('hook-webhook');
    });

    it('token is claimable again after hook_disposed', async () => {
      const run = await createRun();
      const token = 'token-reuse';
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-first',
        eventData: { token },
      });
      await events.create(run.runId, {
        eventType: 'hook_disposed',
        correlationId: 'hook-first',
      });

      const result = await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-second',
        eventData: { token },
      });
      expect(result.event?.eventType).toBe('hook_created');
      expect(result.hook?.hookId).toBe('hook-second');
    });
  });

  describe('Resilient start (run_started bootstrap)', () => {
    it('bootstraps the run from run_started eventData and returns the run entity', async () => {
      const runId = 'wrun_bootstrap_test';
      const result = await events.create(runId, {
        eventType: 'run_started',
        eventData: {
          deploymentId: 'deployment-bootstrap',
          workflowName: 'bootstrap-workflow',
          input: ['arg1'],
          executionContext: {},
        },
      });

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
      expect(result.run!.status).toBe('running');

      // A synthetic run_created event must precede run_started in the log
      const eventList = await events.list({ runId, pagination: { sortOrder: 'asc' } });
      const types = eventList.data.map((e) => e.eventType);
      expect(types).toContain('run_created');
      expect(types).toContain('run_started');
      expect(types.indexOf('run_created')).toBeLessThan(types.indexOf('run_started'));

      // And the persisted run must be retrievable
      const run = await runs.get(runId);
      expect(run.workflowName).toBe('bootstrap-workflow');
    });
  });

  describe('Streamer', () => {
    it('round-trips string chunks without corruption', async () => {
      const runId = 'wrun_stream_str';
      await streamer.writeToStream('out', runId, 'hello world');
      await streamer.closeStream('out', runId);

      const chunks = await streamer.getStreamChunks('out', runId);
      expect(chunks.data).toHaveLength(1);
      expect(new TextDecoder().decode(chunks.data[0].data)).toBe('hello world');
      expect(chunks.done).toBe(true);
    });

    it('round-trips binary chunks, including base64 text that looks like JSON scalars', async () => {
      const runId = 'wrun_stream_bin';
      // 0xd7 0x6d 0xf8 base64-encodes to "1234", which @upstash/redis
      // auto-deserialization would otherwise return as the number 1234.
      const tricky = new Uint8Array([0xd7, 0x6d, 0xf8]);
      const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await streamer.writeToStream('out', runId, tricky);
      await streamer.writeToStream('out', runId, binary);
      await streamer.closeStream('out', runId);

      const chunks = await streamer.getStreamChunks('out', runId);
      expect(chunks.data).toHaveLength(2);
      expect(Array.from(chunks.data[0].data)).toEqual([0xd7, 0x6d, 0xf8]);
      expect(Array.from(chunks.data[1].data)).toEqual([0, 1, 2, 253, 254, 255]);
      expect(chunks.done).toBe(true);
    });

    it('getStreamInfo reports done after closeStream', async () => {
      const runId = 'wrun_stream_info';
      await streamer.writeToStream('out', runId, 'chunk');
      expect((await streamer.getStreamInfo('out', runId)).done).toBe(false);
      await streamer.closeStream('out', runId);
      const info = await streamer.getStreamInfo('out', runId);
      expect(info.done).toBe(true);
      expect(info.tailIndex).toBe(0);
    });

    it('readFromStream resolves negative startIndex from the tail', async () => {
      const runId = 'wrun_stream_neg';
      for (const chunk of ['a', 'b', 'c', 'd']) {
        await streamer.writeToStream('out', runId, chunk);
      }
      await streamer.closeStream('out', runId);

      const stream = await streamer.readFromStream('out', -2, runId);
      const received: string[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received.push(new TextDecoder().decode(value));
      }
      expect(received).toEqual(['c', 'd']);
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
      const raw = await redis.get<string>(runStateKey(run.runId));
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
      // The event must not have landed in the log.
      expect(await redis.zcard(`${keyPrefix}events:by_correlation:stale-step`)).toBe(0);
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
  });

  describe('events.listByCorrelationId run scoping', () => {
    const sharedCorrelationId = 'hook-shared-correlation';

    // A hook is addressable from any run, so two runs can emit events under
    // one correlation id. Interleave them three apiece so an unscoped lookup
    // alternates between the runs.
    async function seedInterleavedRuns() {
      const runA = await createRun({ workflowName: 'scoping-workflow-a' });
      const runB = await createRun({ workflowName: 'scoping-workflow-b' });

      const a1 = await events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: sharedCorrelationId,
        eventData: { token: 'token-shared-correlation' },
      });
      const b1 = await events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId: sharedCorrelationId,
        eventData: { payload: { request: 1 } },
      });
      const a2 = await events.create(runA.runId, {
        eventType: 'hook_received',
        correlationId: sharedCorrelationId,
        eventData: { payload: { request: 2 } },
      });
      const b2 = await events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId: sharedCorrelationId,
        eventData: { payload: { request: 3 } },
      });
      const a3 = await events.create(runA.runId, {
        eventType: 'hook_received',
        correlationId: sharedCorrelationId,
        eventData: { payload: { request: 4 } },
      });
      const b3 = await events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId: sharedCorrelationId,
        eventData: { payload: { request: 5 } },
      });

      return {
        runA: runA.runId,
        runB: runB.runId,
        a: [a1, a2, a3].map((r) => r.event!.eventId),
        b: [b1, b2, b3].map((r) => r.event!.eventId),
      };
    }

    it('scopes events to the requested run', async () => {
      const seeded = await seedInterleavedRuns();

      const result = await events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        runId: seeded.runA,
        pagination: {},
      });

      expect(result.data.map((e) => e.eventId)).toEqual(seeded.a);
      expect(result.data.every((e) => e.runId === seeded.runA)).toBe(true);
      expect(result.hasMore).toBe(false);
    });

    it('lists every run when runId is omitted', async () => {
      const seeded = await seedInterleavedRuns();

      const result = await events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        pagination: {},
      });

      // Also pins the interleaving the scoped pagination test relies on.
      expect(result.data.map((e) => e.eventId)).toEqual([
        seeded.a[0],
        seeded.b[0],
        seeded.a[1],
        seeded.b[1],
        seeded.a[2],
        seeded.b[2],
      ]);
      expect(result.hasMore).toBe(false);
    });

    it('paginates the scoped set without gaps or duplicates', async () => {
      const seeded = await seedInterleavedRuns();

      const page1 = await events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        runId: seeded.runA,
        pagination: { limit: 2 },
      });

      expect(page1.data.map((e) => e.eventId)).toEqual([seeded.a[0], seeded.a[1]]);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe(seeded.a[1]);

      const page2 = await events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        runId: seeded.runA,
        pagination: { limit: 2, cursor: page1.cursor ?? undefined },
      });

      expect(page2.data.map((e) => e.eventId)).toEqual([seeded.a[2]]);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('events.list eventId ordering', () => {
    const rapidPairCount = 16;

    /**
     * Core derives `stateUpdatedAt` from the LAST event the log returns rather
     * than the maximum, so the log has to sort by eventId. Race two event types
     * that need a different number of round trips to reach their append: the
     * cheaper ones land ahead of events minted before them, which an index
     * scored by append time would preserve.
     */
    async function seedRapidEvents(runId: string) {
      const created = await Promise.all(
        Array.from({ length: rapidPairCount }, (_, index) =>
          events.create(runId, {
            eventType: 'step_created',
            correlationId: `step-ordering-${index}`,
            eventData: { stepName: 'ordering-step', input: [index] },
          }),
        ),
      );

      const raced = await Promise.all(
        created.flatMap((result, index) => [
          events.create(runId, {
            eventType: 'step_started',
            correlationId: result.step!.stepId,
          }),
          events.create(runId, {
            eventType: 'wait_created',
            correlationId: `wait-ordering-${index}`,
            eventData: { resumeAt: new Date(Date.now() + 60_000) },
          }),
        ]),
      );

      return [...created, ...raced].map((r) => r.event!.eventId);
    }

    it('returns rapid appends in ascending eventId order, newest last', async () => {
      const run = await createRun();
      const seeded = await seedRapidEvents(run.runId);

      const page = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });

      expect(page.hasMore).toBe(false);
      const eventIds = page.data.map((e) => e.eventId);
      // The seeded events plus the run_created that opened the run.
      expect(eventIds).toHaveLength(seeded.length + 1);
      expect(new Set(eventIds).size).toBe(eventIds.length);

      const ascending = [...eventIds].sort();
      expect(eventIds).toEqual(ascending);
      // Stated on its own because this is the element core actually reads.
      expect(eventIds.at(-1)).toBe(ascending.at(-1));
    });

    it('returns the descending log as the exact reverse', async () => {
      const run = await createRun();
      await seedRapidEvents(run.runId);

      const ascending = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const descending = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'desc' },
      });

      expect(descending.data.map((e) => e.eventId)).toEqual(
        ascending.data.map((e) => e.eventId).reverse(),
      );
    });
  });
});
