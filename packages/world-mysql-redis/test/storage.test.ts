import { MySqlContainer } from '@testcontainers/mysql';
import { RedisContainer } from '@testcontainers/redis';
import { EntityConflictError } from '@workflow/errors';
import type { Step, Streamer, WorkflowRun } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { Redis } from 'ioredis';
import { decodeTime } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import { parse } from '@fantasticfour/shared';
import { expectEventType, expectRejectedWith } from '@fantasticfour/testing';
import { applyMigrations, MIGRATION_FILES } from '../src/migrate.js';
import { createQueue } from '../src/queue.js';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

describe('Storage (MySQL + Redis integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on docker containers', () => {});
    return;
  }

  let mysqlContainer: Awaited<ReturnType<MySqlContainer['start']>>;
  let redisContainer: Awaited<ReturnType<RedisContainer['start']>>;
  let connection: mysql.Connection;
  let db: MySql2Database<typeof schema>;
  let redisClient: Redis;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let streamer: Streamer;

  async function truncateTables() {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_events`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_steps`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_hooks`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_runs`');
    await connection.query('TRUNCATE TABLE `workflow`.`workflow_stream_chunks`');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    await redisClient.flushdb();
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
    // Start MySQL container
    mysqlContainer = await new MySqlContainer('mysql:8.0')
      .withDatabase('main')
      .withUsername('testuser')
      .withRootPassword('root')
      .withCommand(['--default-authentication-plugin=mysql_native_password'])
      .start();

    const dbUrl = `mysql://root:root@${mysqlContainer.getHost()}:${mysqlContainer.getPort()}/main`;
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_MYSQL_URL = dbUrl;

    // Apply the real migrations so the test schema matches production setup
    connection = await mysql.createConnection(dbUrl);
    await applyMigrations(connection);
    // Second run must be a no-op: the ledger skips every applied file.
    await applyMigrations(connection);

    redisContainer = await new RedisContainer('redis:7-alpine').start();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getFirstMappedPort();
    redisClient = new Redis(`redis://${redisHost}:${redisPort}`);

    db = drizzle(connection, { schema, mode: 'default' });
    runs = createRunsStorage(db);
    steps = createStepsStorage(db);
    hooks = createHooksStorage(db);
    events = createEventsStorage(db);
    streamer = createStreamer(db);
  }, 120_000);

  beforeEach(truncateTables);

  afterAll(async () => {
    await redisClient?.disconnect();
    await connection?.end();
    await mysqlContainer?.stop();
    await redisContainer?.stop();
  });

  describe('migrations', () => {
    it('converges on a database provisioned before the ledger existed', async () => {
      // Simulate a pre-ledger database: schema present, ledger absent. The
      // re-run must classify every statement as already applied (errno
      // tolerance) and rebuild the ledger.
      await connection.query('DROP TABLE `workflow`.`__migrations`');
      await applyMigrations(connection);
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT `tag` FROM `workflow`.`__migrations` ORDER BY `tag`',
      );
      expect(rows.map((row) => row.tag)).toEqual(
        MIGRATION_FILES.map((file) => file.replace(/\.sql$/, '')),
      );
    });
  });

  describe('Event idempotency', () => {
    it('rejects a duplicate run_created with EntityConflictError', async () => {
      const workflowName = 'test-workflow-idempotent';
      const eventData = {
        eventType: 'run_created' as const,
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      };

      const result1 = await events.create(null, eventData);
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // A redelivered run_created must not return the existing run AND
      // append a second run_created row; core catches EntityConflictError
      // as "the run already exists" on its concurrent-create path.
      await expect(events.create(runId, eventData)).rejects.toMatchObject({
        name: 'EntityConflictError',
      });

      const listResult = await runs.list({ workflowName });
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
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await events.list({ runId });
      expect(eventList.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('rejects a duplicate step_created with EntityConflictError', async () => {
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

      // Redelivered step_created: the runtime catches EntityConflictError as
      // its dedup signal. Returning success would append a second
      // step_created row and poison replay with ReplayDivergenceError.
      await expect(events.create(run.runId, eventData)).rejects.toSatisfy((err: unknown) =>
        EntityConflictError.is(err),
      );

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
      const waitId = 'wait-idempotent';
      const eventData = {
        eventType: 'wait_created' as const,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };

      await events.create(run.runId, eventData);

      // Waits have no entity table; the event log unique index is the only
      // guard against a replayed wait_created duplicating the log.
      await expect(events.create(run.runId, eventData)).rejects.toSatisfy((err: unknown) =>
        EntityConflictError.is(err),
      );

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
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

    async function completeStep(runId: string, stepId: string): Promise<number> {
      await createStep(runId, stepId);
      await events.create(runId, { eventType: 'step_started', correlationId: stepId });
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
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
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
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
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
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });

      // run_created / run_started omit stateUpdatedAt but are not externally
      // originated: advancing on them would reject every replay.
      const beforeHook = await events.create(run.runId, stepCreated('step-guard-pre-hook'), {
        stateUpdatedAt: 1,
      });
      expect(beforeHook.step?.stepId).toBe('step-guard-pre-hook');

      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-guard',
        eventData: { token: 'token-guard' },
      });
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
      const run = await createRun();

      const started = await events.create(run.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(25_000);

      // The idempotent replay path is the easy miss: core reads maxEvents only
      // off the run_started response, so it must be carried here too.
      const replayed = await events.create(run.runId, { eventType: 'run_started' });
      expect(replayed.maxEvents).toBe(25_000);
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

  describe('Error taxonomy', () => {
    it('throws WorkflowRunNotFoundError from runs.get for a missing run', async () => {
      await expect(runs.get('wrun_missing')).rejects.toMatchObject({
        name: 'WorkflowRunNotFoundError',
      });
    });

    it('throws HookNotFoundError from hooks.get and hooks.getByToken', async () => {
      await expect(hooks.get('hook-missing')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
      await expect(hooks.getByToken('token-missing')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
    });

    it('throws WorkflowRunNotFoundError for lifecycle events on a missing run', async () => {
      await expect(
        events.create('wrun_missing', { eventType: 'run_started' }),
      ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
      await expect(
        events.create('wrun_missing', { eventType: 'run_completed', eventData: { output: [] } }),
      ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
    });

    it('throws RunExpiredError for run_started on a terminal run', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_cancelled' });
      await expect(events.create(run.runId, { eventType: 'run_started' })).rejects.toMatchObject({
        name: 'RunExpiredError',
      });
    });

    it('throws EntityConflictError when modifying a terminal step', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-terminal');
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: ['done'] },
      });

      // Re-delivered step_completed must be rejected with EntityConflictError
      // so core's replay path can swallow it and re-enqueue the workflow.
      await expect(
        events.create(run.runId, {
          eventType: 'step_completed',
          correlationId: step.stepId,
          eventData: { result: ['done'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
      await expect(
        events.create(run.runId, {
          eventType: 'step_started',
          correlationId: step.stepId,
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('Resilient start (run_started bootstrap)', () => {
    it('bootstraps the run from run_started eventData when the run row is missing', async () => {
      const runId = 'wrun_bootstrap_test';
      const result = await events.create(runId, {
        eventType: 'run_started',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'bootstrap-flow',
          input: ['a'],
        },
      });

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
      expect(result.run!.status).toBe('running');

      const log = await events.list({ runId, pagination: { sortOrder: 'asc' } });
      const types = log.data.map((e) => e.eventType);
      expect(types).toEqual(['run_created', 'run_started']);
    });
  });

  describe('step retryAfter', () => {
    it('rejects step_started with TooEarlyError until retryAfter is reached', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-backoff');

      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'boom', retryAfter: new Date(Date.now() + 60_000) },
      });

      await expect(
        events.create(run.runId, { eventType: 'step_started', correlationId: step.stepId }),
      ).rejects.toMatchObject({ name: 'TooEarlyError' });
    });

    it('clears retryAfter when the step starts', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-clear');

      await events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'boom', retryAfter: new Date(Date.now() - 5_000) },
      });
      const retrying = await steps.get(run.runId, step.stepId);
      expect(retrying.retryAfter).toBeInstanceOf(Date);

      const started = await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      expect(started.step?.status).toBe('running');
      expect(started.step?.retryAfter).toBeUndefined();

      const retrieved = await steps.get(run.runId, step.stepId);
      expect(retrieved.retryAfter).toBeUndefined();
    });
  });

  describe('hook_created semantics', () => {
    it('throws EntityConflictError for a duplicate hook_created of the same hook', async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-dup',
        eventData: { token: 'token-dup' },
      });

      await expect(
        events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'hook-dup',
          eventData: { token: 'token-dup' },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // No hook_conflict event must be logged against the run's own hook
      const log = await events.list({ runId: run.runId });
      expect(log.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
      // And exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      expect(
        log.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === 'hook-dup'),
      ).toHaveLength(1);
    });

    it('completes the partial write for an orphaned hook row (crash recovery)', async () => {
      const run = await createRun();
      // Simulate a crash between the hook INSERT and the events INSERT
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

      const log = await events.list({ runId: run.runId });
      expect(log.data.filter((e) => e.eventType === 'hook_created')).toHaveLength(1);
    });

    it('logs hook_conflict with conflictingRunId when another run holds the token', async () => {
      const runA = await createRun();
      const runB = await createRun();

      await events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-a',
        eventData: { token: 'token-shared' },
      });

      const result = await events.create(runB.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-b',
        eventData: { token: 'token-shared' },
      });

      expect(result.hook).toBeUndefined();
      expect(expectEventType(result.event, 'hook_conflict').eventData).toMatchObject({
        token: 'token-shared',
        conflictingRunId: runA.runId,
      });
    });

    it('throws HookNotFoundError when disposing an already-disposed hook', async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-dispose',
        eventData: { token: 'token-dispose' },
      });

      await events.create(run.runId, {
        eventType: 'hook_disposed',
        correlationId: 'hook-dispose',
      });

      await expect(
        events.create(run.runId, {
          eventType: 'hook_disposed',
          correlationId: 'hook-dispose',
        }),
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });
  });

  describe('Streamer', () => {
    async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]> {
      const reader = stream.getReader();
      const out: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(Buffer.from(value).toString('utf-8'));
      }
      return out;
    }

    async function writeStream(name: string, runId: string, count: number): Promise<string[]> {
      const expected: string[] = [];
      for (let i = 0; i < count; i++) {
        const chunk = `chunk-${String(i).padStart(2, '0')}`;
        expected.push(chunk);
        await streamer.writeToStream(name, runId, chunk);
      }
      await streamer.closeStream(name, runId);
      return expected;
    }

    it('delivers bursty same-millisecond chunks in order without loss', async () => {
      const run = await createRun();
      const expected = await writeStream('strm-order', run.runId, 25);

      const received = await readAll(await streamer.readFromStream('strm-order'));
      expect(received).toEqual(expected);
    });

    it('honors positive and negative startIndex', async () => {
      const run = await createRun();
      const expected = await writeStream('strm-offset', run.runId, 12);

      const fromTen = await readAll(await streamer.readFromStream('strm-offset', 10));
      expect(fromTen).toEqual(expected.slice(10));

      const lastFive = await readAll(await streamer.readFromStream('strm-offset', -5));
      expect(lastFive).toEqual(expected.slice(-5));
    });

    it('implements getStreamInfo, getStreamChunks pagination, and listStreamsByRunId', async () => {
      const run = await createRun();
      const expected = await writeStream('strm-meta', run.runId, 15);

      expect(await streamer.getStreamInfo('strm-meta', run.runId)).toEqual({
        tailIndex: 14,
        done: true,
      });

      const pageOne = await streamer.getStreamChunks('strm-meta', run.runId, { limit: 10 });
      expect(pageOne.hasMore).toBe(true);
      expect(pageOne.done).toBe(true);
      expect(pageOne.data.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(pageOne.data.map((c) => Buffer.from(c.data).toString('utf-8'))).toEqual(
        expected.slice(0, 10),
      );

      const pageTwo = await streamer.getStreamChunks('strm-meta', run.runId, {
        limit: 10,
        cursor: pageOne.cursor ?? undefined,
      });
      expect(pageTwo.hasMore).toBe(false);
      expect(pageTwo.data.map((c) => c.index)).toEqual([10, 11, 12, 13, 14]);
      expect(pageTwo.data.map((c) => Buffer.from(c.data).toString('utf-8'))).toEqual(
        expected.slice(10),
      );

      expect(await streamer.listStreamsByRunId(run.runId)).toEqual(['strm-meta']);
    });
  });

  describe('Queue durability', () => {
    it('deduplicates idempotency keys, stores delays durably, and round-trips binary payloads', async () => {
      const queue = createQueue(redisClient, {
        databaseUrl: 'mysql://unused',
        redis: 'redis://unused',
        jobPrefix: 'testq_',
      });

      const input = new Uint8Array([1, 2, 3, 255]);
      const message = {
        runId: 'wrun_queue_test',
        runInput: {
          input,
          deploymentId: 'test-deployment',
          workflowName: 'queue-flow',
          specVersion: 3,
        },
      };

      await queue.queue('__wkf_workflow_wrun_queue_test', message, {
        idempotencyKey: 'idem-1',
      });
      // Duplicate enqueue with the same idempotency key is dropped
      await queue.queue('__wkf_workflow_wrun_queue_test', message, {
        idempotencyKey: 'idem-1',
      });
      expect(await redisClient.llen('testq_flows')).toBe(1);

      // The reservation is a per-key TTL'd string, not an immortal set member
      const ttl = await redisClient.ttl('testq_flows:idempotent:idem-1');
      expect(ttl).toBeGreaterThan(0);

      // The stored envelope round-trips Uint8Array values intact
      const payload = await redisClient.lindex('testq_flows', 0);
      const envelope = parse<{ message: { runInput?: { input: unknown } } }>(payload!);
      expect(envelope.message.runInput?.input).toBeInstanceOf(Uint8Array);
      expect(Array.from(envelope.message.runInput?.input as Uint8Array)).toEqual([1, 2, 3, 255]);

      // Delayed deliveries are persisted in the delayed sorted set, not an
      // in-process timer.
      await queue.queue('__wkf_workflow_wrun_queue_test', message, {
        idempotencyKey: 'idem-2',
        delaySeconds: 60,
      });
      expect(await redisClient.zcard('testq_flows:delayed')).toBe(1);
      expect(await redisClient.llen('testq_flows')).toBe(1);
    });
  });

  describe('events.listByCorrelationId run scoping', () => {
    const sharedCorrelationId = 'hook-shared-correlation';

    // A hook is addressable from any run, so two runs can emit events under
    // one correlation id. Interleave them three apiece so an unscoped lookup
    // alternates between the runs.
    async function seedInterleavedRuns() {
      const runA = await createRun('scoping-workflow-a');
      const runB = await createRun('scoping-workflow-b');

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
});
