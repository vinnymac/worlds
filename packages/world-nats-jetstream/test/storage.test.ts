import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { WorkflowRun, Step } from '@workflow/world';
import { connect } from 'nats';
import { decodeTime, ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { expectEventType, expectRejectedWith } from '@fantasticfour/testing';
import { createWorld } from '../src/index.js';

/** ULID time of a prefixed id, matching how the runtime derives stateUpdatedAt. */
function eventTime(eventId: string): number {
  return decodeTime(eventId.slice(eventId.lastIndexOf('_') + 1));
}

describe('Storage (NATS JetStream integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: StartedTestContainer;
  let world: ReturnType<typeof createWorld>;
  let natsUrl: string;

  async function createRun(workflowName = 'test-workflow'): Promise<WorkflowRun> {
    const result = await world.events.create(null, {
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
    const result = await world.events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'test-step', input: ['input1'] },
    });
    if (!result.step) throw new Error('Expected step to be created');
    return result.step;
  }

  beforeAll(async () => {
    container = await new GenericContainer('nats:2.10-alpine')
      .withExposedPorts(4222)
      .withCommand(['-js'])
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(4222);
    natsUrl = `${host}:${port}`;
    world = createWorld({ nats: natsUrl, keyPrefix: 'test_' });
    await world.start();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
    await container?.stop();
  });

  describe('Event idempotency', () => {
    it('rejects a duplicate run_created with EntityConflictError', async () => {
      const workflowName = 'test-workflow-idempotent';
      const eventData = {
        eventType: 'run_created' as const,
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      };

      const result1 = await world.events.create(null, eventData);
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // A redelivered run_created must not return the existing run AND
      // append a second run_created row; core catches EntityConflictError
      // as "the run already exists" on its concurrent-create path.
      await expect(world.events.create(runId, eventData)).rejects.toMatchObject({
        name: 'EntityConflictError',
      });

      const listResult = await world.runs.list({ workflowName });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);

      const eventList = await world.events.list({ runId });
      const runCreatedEvents = eventList.data.filter((e) => e.eventType === 'run_created');
      expect(runCreatedEvents).toHaveLength(1);
    });

    it('rejects a duplicate step_created with EntityConflictError', async () => {
      const run = await createRun();
      const stepId = 'step-idempotent';
      const eventData = {
        eventType: 'step_created' as const,
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      };

      const result1 = await world.events.create(run.runId, eventData);
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      // Redelivered step_created: the runtime catches EntityConflictError as its
      // dedup signal. Returning success would append a second step_created row
      // and poison replay with ReplayDivergenceError.
      await expect(world.events.create(run.runId, eventData)).rejects.toMatchObject({
        name: 'EntityConflictError',
      });

      const listResult = await world.steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      // The retried delivery must not append a second step_created row.
      const eventList = await world.events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const stepCreatedEvents = eventList.data.filter(
        (e: any) => e.eventType === 'step_created' && e.correlationId === stepId,
      );
      expect(stepCreatedEvents).toHaveLength(1);
    });

    it('should handle duplicate hook_created events', async () => {
      const run = await createRun();
      const hookId1 = 'hook-idempotent-1';
      const hookId2 = 'hook-idempotent-2';

      const result1 = await world.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId1,
        eventData: { token: 'test-token-1' },
      });
      expect(result1.hook).toBeDefined();

      const result2 = await world.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId2,
        eventData: { token: 'test-token-2' },
      });
      expect(result2.hook).toBeDefined();

      const listResult = await world.hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun();

      // First run_started
      const result1 = await world.events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result1.run?.status).toBe('running');
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario, should be idempotent)
      const result2 = await world.events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result2.run?.status).toBe('running');
      // startedAt should be preserved from first call
      expect(result2.run!.startedAt!.getTime()).toBe(originalStartedAt.getTime());

      // Only ONE run_started event should exist in the log
      const eventList = await world.events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const runStartedEvents = eventList.data.filter((e: any) => e.eventType === 'run_started');
      expect(runStartedEvents).toHaveLength(1);
    });
  });

  it('should create and retrieve entities', async () => {
    const run = await createRun();
    expect(run.runId).toBeDefined();
    expect(run.status).toBe('pending');

    const retrieved = await world.runs.get(run.runId);
    expect(retrieved.runId).toBe(run.runId);

    const step = await createStep(run.runId, 'test-step-1');
    expect(step.stepId).toBe('test-step-1');
    expect(step.status).toBe('pending');

    const retrievedStep = await world.steps.get(run.runId, step.stepId);
    expect(retrievedStep.stepId).toBe(step.stepId);
  });

  describe('Error taxonomy', () => {
    it('runs.get throws WorkflowRunNotFoundError for missing runs', async () => {
      await expect(world.runs.get('wrun_does_not_exist')).rejects.toMatchObject({
        name: 'WorkflowRunNotFoundError',
      });
    });

    it('hooks.getByToken throws HookNotFoundError for unknown tokens', async () => {
      await expect(world.hooks.getByToken('no-such-token')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
    });

    it('terminal step transitions throw EntityConflictError', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-terminal-guard');
      await world.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      await world.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: step.stepId,
        eventData: { result: 42 },
      });

      await expect(
        world.events.create(run.runId, {
          eventType: 'step_completed',
          correlationId: step.stepId,
          eventData: { result: 43 },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('Retry backoff (TooEarlyError)', () => {
    it('rejects step_started before retryAfter and clears it once reached', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const step = await createStep(run.runId, 'step-retry-backoff');
      await world.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });

      // Schedule a retry 60s out; starting again must be rejected.
      await world.events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'transient failure', retryAfter: new Date(Date.now() + 60_000) },
      });
      await expect(
        world.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: step.stepId,
        }),
      ).rejects.toMatchObject({ name: 'TooEarlyError' });

      // Once the deadline has passed, the step starts and retryAfter clears.
      await world.events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: step.stepId,
        eventData: { error: 'transient failure', retryAfter: new Date(Date.now() - 1_000) },
      });
      const started = await world.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      expect(started.step?.status).toBe('running');
      expect(started.step?.retryAfter).toBeUndefined();
      expect(started.step?.attempt).toBe(2);
    });
  });

  describe('Hook semantics', () => {
    it('replayed hook_created for the same hook throws EntityConflictError (no self-conflict)', async () => {
      const run = await createRun();
      const hookId = 'hook-replay';
      const token = 'replay-token';

      const first = await world.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(first.hook?.hookId).toBe(hookId);

      await expect(
        world.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // No hook_conflict event may be logged for the replay.
      const events = await world.events.list({ runId: run.runId });
      expect(events.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
      // And exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      expect(
        events.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === hookId),
      ).toHaveLength(1);
    });

    it('cross-run token conflict records hook_conflict with conflictingRunId', async () => {
      const runA = await createRun();
      const runB = await createRun();
      const token = 'contested-token';

      await world.events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-holder',
        eventData: { token },
      });

      const result = await world.events.create(runB.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-challenger',
        eventData: { token },
      });
      expect(result.hook).toBeUndefined();
      expect(expectEventType(result.event, 'hook_conflict').eventData).toMatchObject({
        conflictingRunId: runA.runId,
      });

      // The original holder is untouched.
      const holder = await world.hooks.getByToken(token);
      expect(holder.runId).toBe(runA.runId);
    });
  });

  describe('Wait entities', () => {
    it('creates, completes, and rejects duplicate wait transitions', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const correlationId = 'wait-1';
      const resumeAt = new Date(Date.now() + 1_000);

      const created = await world.events.create(run.runId, {
        eventType: 'wait_created',
        correlationId,
        eventData: { resumeAt },
      });
      expect(created.wait?.status).toBe('waiting');

      await expect(
        world.events.create(run.runId, {
          eventType: 'wait_created',
          correlationId,
          eventData: { resumeAt },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const completed = await world.events.create(run.runId, {
        eventType: 'wait_completed',
        correlationId,
        eventData: {},
      });
      expect(completed.wait?.status).toBe('completed');

      await expect(
        world.events.create(run.runId, {
          eventType: 'wait_completed',
          correlationId,
          eventData: {},
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('Creation-event races', () => {
    // Concurrent duplicate deliveries may EITHER reject with
    // EntityConflictError or converge on the winner's canonical eventId and
    // fulfill; the invariant is a single creation row either way.

    it('concurrent run_created deliveries produce exactly one run and one event row', async () => {
      const workflowName = `race-run-${Date.now()}`;
      const first = await world.events.create(null, {
        eventType: 'run_created',
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      });
      const runId = first.run!.runId;

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          world.events.create(runId, {
            eventType: 'run_created',
            eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
          }),
        ),
      );
      // The run entity is the arbiter: every redelivery rejects.
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await world.events.list({ runId });
      expect(eventList.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('concurrent step_created deliveries converge on a single event row', async () => {
      const run = await createRun();
      const stepId = 'step-race';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          world.events.create(run.runId, {
            eventType: 'step_created',
            correlationId: stepId,
            eventData: { stepName: 'test-step', input: ['input1'] },
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expectRejectedWith(results, 'EntityConflictError');

      const steps = await world.steps.list({ runId: run.runId });
      expect(steps.data).toHaveLength(1);
      const eventList = await world.events.list({ runId: run.runId });
      const created = eventList.data.filter(
        (e) => e.eventType === 'step_created' && e.correlationId === stepId,
      );
      expect(created).toHaveLength(1);
    });

    it('concurrent wait_created deliveries converge on a single event row', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const correlationId = 'wait-race';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          world.events.create(run.runId, {
            eventType: 'wait_created',
            correlationId,
            eventData: { resumeAt: new Date(Date.now() + 60_000) },
          }),
        ),
      );

      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await world.events.list({ runId: run.runId });
      const created = eventList.data.filter(
        (e) => e.eventType === 'wait_created' && e.correlationId === correlationId,
      );
      expect(created).toHaveLength(1);
    });

    it('concurrent hook_created deliveries converge on a single event row', async () => {
      const run = await createRun();
      const hookId = 'hook-race';
      const token = 'race-token';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          world.events.create(run.runId, {
            eventType: 'hook_created',
            correlationId: hookId,
            eventData: { token },
          }),
        ),
      );

      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expectRejectedWith(results, 'EntityConflictError');

      const eventList = await world.events.list({ runId: run.runId });
      expect(
        eventList.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === hookId),
      ).toHaveLength(1);
      // The race must never manufacture a self-conflict.
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
      const holder = await world.hooks.getByToken(token);
      expect(holder.hookId).toBe(hookId);
    });

    it('a delivery racing a crashed winner heals under the canonical eventId', async () => {
      // Seed the orphan window by hand: step entity + creation claim written,
      // event write lost (a crash between claim and putEvent).
      const run = await createRun();
      const stepId = 'step-orphan-heal';
      const canonicalEventId = `wevt_${ulid()}`;

      const nc = await connect({ servers: natsUrl });
      try {
        const js = nc.jetstream();
        const stepsBucket = await js.views.kv('test_steps', { history: 10 });
        const claimsBucket = await js.views.kv('test_creation_claims', { history: 1 });
        await stepsBucket.create(
          `${run.runId}.${stepId}`,
          JSON.stringify({
            runId: run.runId,
            stepId,
            stepName: 'test-step',
            input: ['input1'],
            status: 'pending',
            attempt: 0,
            specVersion: run.specVersion,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
        await claimsBucket.create(`${run.runId}.${stepId}.step_created`, canonicalEventId);
      } finally {
        await nc.close();
      }

      // The redelivery loses the claim, finds no durable event, and completes
      // the crashed winner's write under its canonical id.
      const healed = await world.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(healed.step?.stepId).toBe(stepId);
      expect(healed.event?.eventId).toBe(canonicalEventId);

      const eventList = await world.events.list({ runId: run.runId });
      const created = eventList.data.filter(
        (e) => e.eventType === 'step_created' && e.correlationId === stepId,
      );
      expect(created).toHaveLength(1);
      expect(created[0].eventId).toBe(canonicalEventId);

      // And a further redelivery is now a true duplicate.
      await expect(
        world.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('KV revision correctness', () => {
    it('lists a multi-transition run exactly once with its live status', async () => {
      const workflowName = `test-workflow-dedup-${Date.now()}`;
      const run = await createRun(workflowName);
      await world.events.create(run.runId, { eventType: 'run_started' });
      await world.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });

      // Unfiltered list must not duplicate the run per KV revision.
      const listed = await world.runs.list({ workflowName });
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0].status).toBe('completed');
    });

    it('steps.get without runId returns the latest revision', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const stepId = `step-latest-${Date.now()}`;
      await createStep(run.runId, stepId);
      await world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId });
      await world.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: 'output-value' },
      });

      const fetched = await world.steps.get(undefined, stepId);
      expect(fetched.status).toBe('completed');
      expect(fetched.output).toBe('output-value');
    });

    it('concurrent terminal transitions settle on exactly one status', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      const results = await Promise.allSettled([
        world.events.create(run.runId, {
          eventType: 'run_completed',
          eventData: { output: 'winner' },
        }),
        world.events.create(run.runId, { eventType: 'run_cancelled' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: 'EntityConflictError',
      });

      // The run is indexed under exactly one terminal status.
      const finalRun = await world.runs.get(run.runId);
      const [completedList, cancelledList] = await Promise.all([
        world.runs.list({ status: 'completed' }),
        world.runs.list({ status: 'cancelled' }),
      ]);
      const inCompleted = completedList.data.some((r) => r.runId === run.runId);
      const inCancelled = cancelledList.data.some((r) => r.runId === run.runId);
      expect(inCompleted).toBe(finalRun.status === 'completed');
      expect(inCancelled).toBe(finalRun.status === 'cancelled');
    });

    it('concurrent step_started events both count their attempts', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const stepId = 'step-concurrent-start';
      await createStep(run.runId, stepId);

      await Promise.all([
        world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId }),
        world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId }),
      ]);

      const fetched = await world.steps.get(run.runId, stepId);
      // Without CAS both writers read attempt 0 and store 1 (lost update).
      expect(fetched.attempt).toBe(2);
    });
  });

  describe('Event ceiling (maxEvents)', () => {
    it('reports the default ceiling on every run_started response', async () => {
      const run = await createRun();

      const started = await world.events.create(run.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(25_000);

      // The replay path must repeat it: the runtime re-reads the ceiling from
      // every run_started response and drops the limit when it is absent.
      const replay = await world.events.create(run.runId, { eventType: 'run_started' });
      expect(replay.run?.status).toBe('running');
      expect(replay.maxEvents).toBe(25_000);
    });

    it('honours a configured ceiling', async () => {
      const configured = createWorld({
        nats: natsUrl,
        keyPrefix: 'test_maxevents_',
        maxEventsPerRun: 7,
      });
      try {
        const created = await configured.events.create(null, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'test-workflow-max-events',
            input: [],
          },
        });
        const started = await configured.events.create(created.run!.runId, {
          eventType: 'run_started',
        });
        expect(started.maxEvents).toBe(7);
      } finally {
        await configured.close();
      }
    });

    it('only reports the ceiling on run_started responses', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      const completed = await world.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });
      expect(completed.maxEvents).toBeUndefined();
    });
  });

  describe('Optimistic concurrency (stateUpdatedAt)', () => {
    const resumeAt = () => new Date(Date.now() + 60_000);

    it('rejects a create whose snapshot predates an externally-originated event', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      const hookId = `hook-guard-${Date.now()}`;
      await world.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token: `guard-token-${Date.now()}` },
      });

      // No stateUpdatedAt: externally originated, so it advances the marker.
      const received = await world.events.create(run.runId, {
        eventType: 'hook_received',
        correlationId: hookId,
        eventData: { payload: 'value' },
      });
      const marker = eventTime(received.event!.eventId);

      // Strictly older snapshot -> 412.
      await expect(
        world.events.create(
          run.runId,
          {
            eventType: 'wait_created',
            correlationId: 'wait-stale',
            eventData: { resumeAt: resumeAt() },
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toMatchObject({ name: 'PreconditionFailedError', status: 412 });

      // Equal snapshot must pass; rejecting an up-to-date client livelocks it.
      const equal = await world.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-equal',
          eventData: { resumeAt: resumeAt() },
        },
        { stateUpdatedAt: marker },
      );
      expect(equal.wait?.status).toBe('waiting');

      // An absent stateUpdatedAt disables the guard entirely.
      const unguarded = await world.events.create(run.runId, {
        eventType: 'wait_created',
        correlationId: 'wait-unguarded',
        eventData: { resumeAt: resumeAt() },
      });
      expect(unguarded.wait?.status).toBe('waiting');
    });

    it('advances the marker on an unguarded step_completed', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const stepId = `step-marker-${Date.now()}`;
      await createStep(run.runId, stepId);
      await world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId });

      const completed = await world.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: 42 },
      });
      const marker = eventTime(completed.event!.eventId);

      await expect(
        world.events.create(
          run.runId,
          {
            eventType: 'wait_created',
            correlationId: 'wait-after-step',
            eventData: { resumeAt: resumeAt() },
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toMatchObject({ name: 'PreconditionFailedError' });
    });

    it('does not advance the marker for replay-origin creates', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const stepId = `step-replay-origin-${Date.now()}`;
      await createStep(run.runId, stepId);
      await world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId });

      // Carries stateUpdatedAt -> replay origin -> must not advance the marker.
      const completed = await world.events.create(
        run.runId,
        { eventType: 'step_completed', correlationId: stepId, eventData: { result: 42 } },
        { stateUpdatedAt: Date.now() },
      );

      // A far older snapshot still passes, because nothing advanced.
      const wait = await world.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-no-advance',
          eventData: { resumeAt: resumeAt() },
        },
        { stateUpdatedAt: eventTime(completed.event!.eventId) - 60_000 },
      );
      expect(wait.wait?.status).toBe('waiting');
    });

    it('scopes the marker to its own run', async () => {
      const runA = await createRun();
      const runB = await createRun();
      await world.events.create(runA.runId, { eventType: 'run_started' });
      await world.events.create(runB.runId, { eventType: 'run_started' });

      const hookId = `hook-scope-${Date.now()}`;
      await world.events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token: `scope-token-${Date.now()}` },
      });
      const received = await world.events.create(runA.runId, {
        eventType: 'hook_received',
        correlationId: hookId,
        eventData: { payload: 'value' },
      });

      // runB has no marker of its own, so runA's must not reject it.
      const wait = await world.events.create(
        runB.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-other-run',
          eventData: { resumeAt: resumeAt() },
        },
        { stateUpdatedAt: eventTime(received.event!.eventId) - 60_000 },
      );
      expect(wait.wait?.status).toBe('waiting');
    });
  });

  describe('Streamer', () => {
    async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
      const chunks: string[] = [];
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value));
      }
      return chunks;
    }

    it('retains chunks written before any reader attaches', async () => {
      const run = await createRun();
      const name = `late-reader-${Date.now()}`;

      await world.writeToStream(name, run.runId, 'chunk-0');
      await world.writeToStream(name, run.runId, 'chunk-1');
      await world.writeToStream(name, run.runId, 'chunk-2');
      await world.closeStream(name, run.runId);

      // Reader attaches only after everything (including EOF) was written.
      const chunks = await collectStream(await world.readFromStream(name));
      expect(chunks).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);

      // A second reader replays the same chunks (acks must not consume them).
      const again = await collectStream(await world.readFromStream(name));
      expect(again).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
    });

    it('resumes from startIndex without double-skipping', async () => {
      const run = await createRun();
      const name = `resume-${Date.now()}`;

      await world.writeToStream(name, run.runId, 'a');
      await world.writeToStream(name, run.runId, 'b');
      await world.writeToStream(name, run.runId, 'c');
      await world.closeStream(name, run.runId);

      expect(await collectStream(await world.readFromStream(name, 1))).toEqual(['b', 'c']);
      expect(await collectStream(await world.readFromStream(name, -1))).toEqual(['c']);
    });

    it('implements getStreamInfo, getStreamChunks, and listStreamsByRunId', async () => {
      const run = await createRun();
      const name = `contract-${Date.now()}`;

      await world.writeToStream(name, run.runId, 'one');
      await world.writeToStream(name, run.runId, 'two');

      const openInfo = await world.getStreamInfo(name, run.runId);
      expect(openInfo).toEqual({ tailIndex: 1, done: false });

      await world.closeStream(name, run.runId);

      const info = await world.getStreamInfo(name, run.runId);
      expect(info).toEqual({ tailIndex: 1, done: true });

      const decoder = new TextDecoder();
      const firstPage = await world.getStreamChunks(name, run.runId, { limit: 1 });
      expect(firstPage.data.map((c) => ({ index: c.index, text: decoder.decode(c.data) }))).toEqual(
        [{ index: 0, text: 'one' }],
      );
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.cursor).not.toBeNull();

      const secondPage = await world.getStreamChunks(name, run.runId, {
        limit: 1,
        cursor: firstPage.cursor!,
      });
      expect(
        secondPage.data.map((c) => ({ index: c.index, text: decoder.decode(c.data) })),
      ).toEqual([{ index: 1, text: 'two' }]);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.done).toBe(true);

      const streams = await world.listStreamsByRunId(run.runId);
      expect(streams).toContain(name);
    });
  });
});
