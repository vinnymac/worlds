import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { WorkflowRun, Step } from '@workflow/world';
import { eventIdToSlot, slotToEventId } from '@workflow/world';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { expectEventType, expectRejectedWith } from '@fantasticfour/testing';
import { createWorld } from '../src/index.js';

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

    it('a redelivery heals a winner that crashed before claiming its creation event', async () => {
      // Seed the orphan window by hand: step entity written, claim and event
      // lost (a crash right after the entity create).
      const run = await createRun();
      const stepId = 'step-orphan-heal';

      const nc = await connect({ servers: natsUrl });
      try {
        const js = jetstream(nc);
        const kvm = new Kvm(js);
        const stepsBucket = await kvm.create('test_steps', { history: 10 });
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
      } finally {
        await nc.close();
      }

      // The redelivery loses the entity create but wins the creation claim,
      // so it completes the crashed winner's event append.
      const healed = await world.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(healed.step?.stepId).toBe(stepId);
      expect(eventIdToSlot(healed.event!.eventId)).not.toBeNull();

      const eventList = await world.events.list({ runId: run.runId });
      const created = eventList.data.filter(
        (e) => e.eventType === 'step_created' && e.correlationId === stepId,
      );
      expect(created).toHaveLength(1);

      // And a further redelivery is now a true duplicate.
      await expect(
        world.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('a redelivery takes over a claim whose winner crashed before appending', async () => {
      // Crash window two: entity + claim written, event append lost. The
      // redelivery polls the pending claim out, takes it over via revision
      // CAS, and appends the missing creation event.
      const run = await createRun();
      const stepId = 'step-claim-takeover';

      const nc = await connect({ servers: natsUrl });
      try {
        const js = jetstream(nc);
        const kvm = new Kvm(js);
        const stepsBucket = await kvm.create('test_steps', { history: 10 });
        const claimsBucket = await kvm.create('test_creation_claims', { history: 1 });
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
        await claimsBucket.create(`${run.runId}.${stepId}.step_created`, 'pending');
      } finally {
        await nc.close();
      }

      const healed = await world.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(healed.step?.stepId).toBe(stepId);

      const eventList = await world.events.list({ runId: run.runId });
      expect(
        eventList.data.filter(
          (e) => e.eventType === 'step_created' && e.correlationId === stepId,
        ),
      ).toHaveLength(1);
    }, 30_000);
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

    it('steps.get returns the latest revision', async () => {
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

      const fetched = await world.steps.get(run.runId, stepId);
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

    it('reports the ceiling only on run-lifecycle responses', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      const step = await createStep(run.runId, 'step-ceiling');
      const stepStarted = await world.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: step.stepId,
      });
      expect(stepStarted.maxEvents).toBeUndefined();

      const completed = await world.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: 'done' },
      });
      expect(completed.maxEvents).toBe(25_000);
    });
  });

  describe('Slot-numbered event ids', () => {
    it('numbers a run log densely from slot 1 in commit order', async () => {
      const run = await createRun();
      const started = await world.events.create(run.runId, { eventType: 'run_started' });
      expect(started.event?.eventId).toBe(slotToEventId(2));

      const stepId = 'step-slots';
      await createStep(run.runId, stepId);
      await world.events.create(run.runId, { eventType: 'step_started', correlationId: stepId });
      await world.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: stepId,
        eventData: { result: 1 },
      });

      const events = await world.events.list({ runId: run.runId, pagination: { sortOrder: 'asc' } });
      expect(events.data.map((e) => e.eventId)).toEqual([1, 2, 3, 4, 5].map(slotToEventId));
      expect(events.data[0].eventType).toBe('run_created');
    });

    it('concurrent appends race for slots without holes or duplicates', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          world.events.create(run.runId, {
            eventType: 'step_created',
            correlationId: `step-fanout-${i}`,
            eventData: { stepName: 'test-step', input: [i] },
          }),
        ),
      );

      const events = await world.events.list({ runId: run.runId, pagination: { sortOrder: 'asc' } });
      // run_created + run_started + 8 step_created, dense from 1.
      expect(events.data.map((e) => e.eventId)).toEqual(
        Array.from({ length: 10 }, (_, i) => slotToEventId(i + 1)),
      );
    });

    it('bumps a stale eventCount to the next free slot and reports the skipped span', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      // Log now holds slots 1..2. A writer that replayed only slot 1 sends
      // eventCount: 1; its write must land at slot 3 (not reject) and the
      // response must carry the slot-2 event it missed.
      const result = await world.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-bump',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { eventCount: 1 },
      );
      expect(result.event?.eventId).toBe(slotToEventId(3));
      expect(result.events?.map((e) => e.eventId)).toEqual([slotToEventId(2)]);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('accepts a fresh eventCount and a create with no eventCount', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });

      const fresh = await world.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-fresh-count',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { eventCount: 2 },
      );
      expect(fresh.event?.eventId).toBe(slotToEventId(3));
      expect(fresh.events).toBeUndefined();

      const uncounted = await world.events.create(run.runId, {
        eventType: 'wait_completed',
        correlationId: 'wait-fresh-count',
        eventData: {},
      });
      expect(uncounted.event?.eventId).toBe(slotToEventId(4));
    });

    it('returns the delta after sinceCursor on the create response', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const result = await world.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-since',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { sinceCursor: slotToEventId(1) },
      );
      // Everything strictly after slot 1, including the created event itself.
      expect(result.events?.map((e) => eventIdToSlot(e.eventId))).toEqual([2, 3]);
      expect(result.cursor).toBe(slotToEventId(3));
      expect(result.hasMore).toBe(false);
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

      await world.streams.write(run.runId, name, 'chunk-0');
      await world.streams.write(run.runId, name, 'chunk-1');
      await world.streams.write(run.runId, name, 'chunk-2');
      await world.streams.close(run.runId, name);

      // Reader attaches only after everything (including EOF) was written.
      const chunks = await collectStream(await world.streams.get(run.runId, name));
      expect(chunks).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);

      // A second reader replays the same chunks (acks must not consume them).
      const again = await collectStream(await world.streams.get(run.runId, name));
      expect(again).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
    });

    it('scopes streams to their run', async () => {
      const runA = await createRun();
      const runB = await createRun();
      const name = `scoped-${Date.now()}`;

      await world.streams.write(runA.runId, name, 'from-a');
      await world.streams.close(runA.runId, name);
      await world.streams.write(runB.runId, name, 'from-b');
      await world.streams.close(runB.runId, name);

      expect(await collectStream(await world.streams.get(runA.runId, name))).toEqual(['from-a']);
      expect(await collectStream(await world.streams.get(runB.runId, name))).toEqual(['from-b']);
    });

    it('resumes from startIndex without double-skipping', async () => {
      const run = await createRun();
      const name = `resume-${Date.now()}`;

      await world.streams.write(run.runId, name, 'a');
      await world.streams.writeMulti!(run.runId, name, ['b', 'c']);
      await world.streams.close(run.runId, name);

      expect(await collectStream(await world.streams.get(run.runId, name, 1))).toEqual(['b', 'c']);
      expect(await collectStream(await world.streams.get(run.runId, name, -1))).toEqual(['c']);
    });

    it('implements streams.getInfo, streams.getChunks, and streams.list', async () => {
      const run = await createRun();
      const name = `contract-${Date.now()}`;

      await world.streams.write(run.runId, name, 'one');
      await world.streams.write(run.runId, name, 'two');

      const openInfo = await world.streams.getInfo(run.runId, name);
      expect(openInfo).toEqual({ tailIndex: 1, done: false });

      await world.streams.close(run.runId, name);

      const info = await world.streams.getInfo(run.runId, name);
      expect(info).toEqual({ tailIndex: 1, done: true });

      const decoder = new TextDecoder();
      const firstPage = await world.streams.getChunks(run.runId, name, { limit: 1 });
      expect(firstPage.data.map((c) => ({ index: c.index, text: decoder.decode(c.data) }))).toEqual(
        [{ index: 0, text: 'one' }],
      );
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.cursor).not.toBeNull();

      const secondPage = await world.streams.getChunks(run.runId, name, {
        limit: 1,
        cursor: firstPage.cursor!,
      });
      expect(
        secondPage.data.map((c) => ({ index: c.index, text: decoder.decode(c.data) })),
      ).toEqual([{ index: 1, text: 'two' }]);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.done).toBe(true);

      const streams = await world.streams.list(run.runId);
      expect(streams).toContain(name);
    });
  });

  describe('events.listByCorrelationId run scoping', () => {
    // A hook is addressable from any run, so two runs can emit events under
    // one correlation id. Interleave them three apiece so an unscoped lookup
    // alternates between the runs. The buckets are never cleared between
    // tests, so each case seeds its own correlation id and token.
    async function seedInterleavedRuns(correlationId: string) {
      const runA = await createRun('scoping-workflow-a');
      const runB = await createRun('scoping-workflow-b');

      const a1 = await world.events.create(runA.runId, {
        eventType: 'hook_created',
        correlationId,
        eventData: { token: `token-${correlationId}` },
      });
      const b1 = await world.events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId,
        eventData: { payload: { request: 1 } },
      });
      const a2 = await world.events.create(runA.runId, {
        eventType: 'hook_received',
        correlationId,
        eventData: { payload: { request: 2 } },
      });
      const b2 = await world.events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId,
        eventData: { payload: { request: 3 } },
      });
      const a3 = await world.events.create(runA.runId, {
        eventType: 'hook_received',
        correlationId,
        eventData: { payload: { request: 4 } },
      });
      const b3 = await world.events.create(runB.runId, {
        eventType: 'hook_received',
        correlationId,
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
      const correlationId = 'hook-scoping-scoped';
      const seeded = await seedInterleavedRuns(correlationId);

      const result = await world.events.listByCorrelationId({
        correlationId,
        runId: seeded.runA,
        pagination: {},
      });

      expect(result.data.map((e) => e.eventId)).toEqual(seeded.a);
      expect(result.data.every((e) => e.runId === seeded.runA)).toBe(true);
      expect(result.hasMore).toBe(false);
    });

    it('paginates the scoped set without gaps or duplicates', async () => {
      const correlationId = 'hook-scoping-paginated';
      const seeded = await seedInterleavedRuns(correlationId);

      const page1 = await world.events.listByCorrelationId({
        correlationId,
        runId: seeded.runA,
        pagination: { limit: 2 },
      });

      expect(page1.data.map((e) => e.eventId)).toEqual([seeded.a[0], seeded.a[1]]);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe(seeded.a[1]);

      const page2 = await world.events.listByCorrelationId({
        correlationId,
        runId: seeded.runA,
        pagination: { limit: 2, cursor: page1.cursor ?? undefined },
      });

      expect(page2.data.map((e) => e.eventId)).toEqual([seeded.a[2]]);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe("resolveData: 'none' event data", () => {
    // `step_created` carries both a ref field (`input`) and display metadata
    // (`stepName`), so it distinguishes stripping refs from dropping eventData
    // wholesale. Event types outside the ref map are a no-op and prove nothing.
    it('strips only the ref field and keeps sibling metadata', async () => {
      const run = await createRun();
      await world.events.create(run.runId, { eventType: 'run_started' });
      const stepId = `step-strip-refs-${ulid()}`;
      await createStep(run.runId, stepId);

      const lean = await world.events.list({
        runId: run.runId,
        pagination: {},
        resolveData: 'none',
      });
      const leanEvent = expectEventType(
        lean.data.find((e) => e.eventType === 'step_created' && e.correlationId === stepId),
        'step_created',
      );
      expect(leanEvent.eventData).toEqual({ stepName: 'test-step' });

      const full = await world.events.list({ runId: run.runId, pagination: {} });
      const fullEvent = expectEventType(
        full.data.find((e) => e.eventType === 'step_created' && e.correlationId === stepId),
        'step_created',
      );
      expect(fullEvent.eventData).toEqual({ stepName: 'test-step', input: ['input1'] });
    });
  });
});
