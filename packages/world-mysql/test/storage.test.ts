import { MySqlContainer } from '@testcontainers/mysql';
import { EntityConflictError, TooEarlyError } from '@workflow/errors';
import type { Step, WorkflowRun } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { decodeTime } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';
import { applyMigrations, MIGRATION_FILES } from '../src/migrate.js';

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
    // Second run must be a no-op: the ledger skips every applied file.
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
      for (const r of results) {
        expect(r.status).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          name: 'EntityConflictError',
        });
      }

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
      // its dedup signal. Returning success would append a second step_created
      // row and poison replay with ReplayDivergenceError.
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

    it('completes a partial step_created write on redelivery', async () => {
      const run = await createRun();
      const stepId = 'step-orphaned';
      const eventData = {
        eventType: 'step_created' as const,
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      };

      await events.create(run.runId, eventData);
      // Simulate a crash between the step INSERT and the event INSERT: the
      // entity row survives but the creation event never became durable.
      await connection.query(
        "DELETE FROM `workflow`.`workflow_events` WHERE `type` = 'step_created' AND `correlation_id` = ?",
        [stepId],
      );

      const result = await events.create(run.runId, eventData);
      expect(result.step?.stepId).toBe(stepId);

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(eventList.data.filter((e) => e.eventType === 'step_created')).toHaveLength(1);
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

      // The rejected create must leave nothing behind.
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
        eventData: {},
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
      // And exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      expect(
        eventList.data.filter(
          (e) => e.eventType === 'hook_created' && e.correlationId === 'hook-replay',
        ),
      ).toHaveLength(1);
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
  // `resolveData: 'none'` now projects the payload columns out of the SQL
  // instead of reading them and stripping them in JS. The rows must still
  // satisfy the entity schemas, and 'all' must be unaffected.
  describe("resolveData: 'none' column projection", () => {
    it('omits run input/output but keeps the rest of the entity intact', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      await events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: [{ big: 'x'.repeat(1000) }] },
      });

      const full = await runs.get(run.runId);
      expect(full.output).toBeDefined();

      const lean = await runs.get(run.runId, { resolveData: 'none' });
      expect(lean.input).toBeUndefined();
      expect(lean.output).toBeUndefined();
      // Everything else must survive the projection.
      expect(lean.runId).toBe(run.runId);
      expect(lean.workflowName).toBe(full.workflowName);
      expect(lean.deploymentId).toBe(full.deploymentId);
      expect(lean.status).toBe('completed');
      expect(lean.specVersion).toBe(full.specVersion);
      expect(lean.createdAt).toBeInstanceOf(Date);
      expect(lean.completedAt).toBeInstanceOf(Date);
    });

    it('omits step input/output but keeps the rest of the entity intact', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-projection');
      await events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: [{ big: 'y'.repeat(1000) }] },
      });

      const full = await steps.get(run.runId, step.stepId);
      expect(full.output).toBeDefined();

      const lean = await steps.get(run.runId, step.stepId, { resolveData: 'none' });
      expect(lean.input).toBeUndefined();
      expect(lean.output).toBeUndefined();
      expect(lean.stepId).toBe(step.stepId);
      expect(lean.runId).toBe(run.runId);
      expect(lean.stepName).toBe(full.stepName);
      expect(lean.status).toBe('completed');
      expect(lean.attempt).toBe(full.attempt);
      expect(lean.createdAt).toBeInstanceOf(Date);
    });

    it('projects in list queries too', async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: 'run_started' });
      await createStep(run.runId, 'step-list-projection');

      const runList = await runs.list({ pagination: { limit: 10 }, resolveData: 'none' });
      expect(runList.data.length).toBeGreaterThan(0);
      for (const r of runList.data) {
        expect(r.input).toBeUndefined();
        expect(r.output).toBeUndefined();
        expect(r.runId).toBeTruthy();
        expect(r.status).toBeTruthy();
      }

      const stepList = await steps.list({
        runId: run.runId,
        pagination: { limit: 10 },
        resolveData: 'none',
      });
      expect(stepList.data.length).toBeGreaterThan(0);
      for (const st of stepList.data) {
        expect(st.input).toBeUndefined();
        expect(st.output).toBeUndefined();
        expect(st.stepId).toBeTruthy();
      }
    });

    it("returns the entity from events.create under resolveData 'none'", async () => {
      const run = await createRun();
      const started = await events.create(
        run.runId,
        { eventType: 'run_started' },
        { resolveData: 'none' },
      );
      expect(started.run?.runId).toBe(run.runId);
      expect(started.run?.status).toBe('running');
      expect(started.run?.input).toBeUndefined();
    });
  });
});
