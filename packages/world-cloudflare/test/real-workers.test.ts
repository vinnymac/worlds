/**
 * Real Cloudflare Workers tests
 * These tests run in the Workers runtime using @cloudflare/vitest-pool-workers
 * and test REAL Durable Objects with SQLite storage; the same applyEvent
 * transaction and streamer RPC protocol used in production.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApplyEventOutcome, ApplyEventRequest } from '../src/apply-event.js';
import { createStreamer } from '../src/streamer.js';
import type { WorkflowRunDOStub } from '../src/storage.js';

interface InflightClaimStubLike {
  claimInflight(params: { messageId: string; staleMs: number }): Promise<{ claimed: boolean }>;
  releaseInflight(): Promise<void>;
}

type RunStub = WorkflowRunDOStub & InflightClaimStubLike;

function getRunStub(name: string): RunStub {
  const id = env.WORKFLOW_DB.idFromName(name);
  return env.WORKFLOW_DB.get(id) as unknown as RunStub;
}

function expectOk(outcome: ApplyEventOutcome): Extract<ApplyEventOutcome, { ok: true }> {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`Expected ok outcome, got ${outcome.code}`);
  return outcome;
}

function expectFailure(outcome: ApplyEventOutcome): Extract<ApplyEventOutcome, { ok: false }> {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('Expected failure outcome');
  return outcome;
}

describe('Real Cloudflare Durable Objects', () => {
  let runId: string;
  let stub: RunStub;

  const runCreated = (): ApplyEventRequest => ({
    runId,
    data: {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: ['test-input'],
      },
    },
  });

  beforeEach(() => {
    // vitest-pool-workers 0.18+ (vitest 4) no longer resets DO storage
    // between tests, so each test gets its own DO instance via a unique name.
    runId = `wrun_${crypto.randomUUID()}`;
    stub = getRunStub(runId);
  });

  describe('WorkflowRunDO.applyEvent - run lifecycle', () => {
    it('should create and retrieve a workflow run', async () => {
      const outcome = expectOk(await stub.applyEvent(runCreated()));

      expect(outcome.run).toMatchObject({
        runId,
        workflowName: 'test-workflow',
        input: ['test-input'],
        deploymentId: 'test-deployment',
        status: 'pending',
      });
      expect(outcome.run?.createdAt).toBeInstanceOf(Date);
      expect(outcome.event?.eventType).toBe('run_created');
      expect(outcome.runCreated?.workflowName).toBe('test-workflow');

      const retrieved = await stub.getRun();
      expect(retrieved?.runId).toBe(runId);
      expect(retrieved?.status).toBe('pending');
      expect(retrieved?.createdAt).toBeInstanceOf(Date);
    });

    it('should reject a duplicate run_created with the conflict outcome', async () => {
      expectOk(await stub.applyEvent(runCreated()));
      const replay = expectFailure(await stub.applyEvent(runCreated()));

      // Mapped to EntityConflictError at the storage layer; core treats the
      // 409 as benign ("the run already exists").
      expect(replay.code).toBe('ENTITY_CONFLICT');
      // No duplicate run_created event in the log
      const events = await stub.listEvents();
      expect(events.data.filter((e) => e.eventType === 'run_created')).toHaveLength(1);
    });

    it('should transition through start and completion with cleared error/output on running', async () => {
      expectOk(await stub.applyEvent(runCreated()));

      const started = expectOk(
        await stub.applyEvent({ runId, data: { eventType: 'run_started' } }),
      );
      expect(started.run?.status).toBe('running');
      expect(started.run?.startedAt).toBeInstanceOf(Date);
      expect(started.run?.completedAt).toBeUndefined();
      expect(started.run?.output).toBeUndefined();
      expect(started.run?.error).toBeUndefined();
      // run_started preloads the event log
      expect(started.events?.map((e) => e.eventType)).toEqual(['run_created', 'run_started']);

      const completed = expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'run_completed', eventData: { output: ['result'] } },
        }),
      );
      expect(completed.run?.status).toBe('completed');
      expect(completed.run?.output).toEqual(['result']);
      expect(completed.run?.completedAt).toBeInstanceOf(Date);
    });

    it('should reject run_started on a terminal run with RUN_EXPIRED and append no event', async () => {
      expectOk(await stub.applyEvent(runCreated()));
      expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));
      expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'run_completed', eventData: { output: [] } },
        }),
      );

      const before = await stub.listEvents();
      const failure = expectFailure(
        await stub.applyEvent({ runId, data: { eventType: 'run_started' } }),
      );
      expect(failure.code).toBe('RUN_EXPIRED');

      // The guarded transaction wrote nothing
      const after = await stub.listEvents();
      expect(after.data).toHaveLength(before.data.length);
      const run = await stub.getRun();
      expect(run?.status).toBe('completed');
    });

    it('should not append a duplicate run_started event on replay', async () => {
      expectOk(await stub.applyEvent(runCreated()));
      expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));
      const replay = expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));

      expect(replay.event).toBeUndefined();
      expect(replay.run?.status).toBe('running');
      const events = await stub.listEvents();
      expect(events.data.filter((e) => e.eventType === 'run_started')).toHaveLength(1);
    });

    it('should map run_failed string errors and errorCode', async () => {
      expectOk(await stub.applyEvent(runCreated()));
      expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));

      const failed = expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'run_failed',
            eventData: { error: 'boom', errorCode: 'REPLAY_TIMEOUT' },
          },
        }),
      );
      expect(failed.run?.status).toBe('failed');
      expect(failed.run?.error).toMatchObject({ message: 'boom', code: 'REPLAY_TIMEOUT' });
    });

    it('should return RUN_NOT_FOUND for events on a missing run', async () => {
      const failure = expectFailure(
        await stub.applyEvent({ runId, data: { eventType: 'run_started' } }),
      );
      expect(failure.code).toBe('RUN_NOT_FOUND');
      // Nothing persisted
      const events = await stub.listEvents();
      expect(events.data).toHaveLength(0);
    });

    it('should bootstrap the run from run_started eventData (resilient start)', async () => {
      const outcome = expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'run_started',
            eventData: {
              deploymentId: 'test-deployment',
              workflowName: 'bootstrap-workflow',
              input: [new Uint8Array([1, 2, 3])],
            },
          },
        }),
      );

      expect(outcome.run?.status).toBe('running');
      expect(outcome.runCreated?.workflowName).toBe('bootstrap-workflow');
      const events = await stub.listEvents();
      expect(events.data.map((e) => e.eventType)).toEqual(['run_created', 'run_started']);
      // Binary input survives the DO round-trip
      const run = await stub.getRun();
      const input = run?.input as Uint8Array[];
      expect(input[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(input[0])).toEqual([1, 2, 3]);
    });
  });

  describe('WorkflowRunDO.applyEvent - step lifecycle', () => {
    beforeEach(async () => {
      expectOk(await stub.applyEvent(runCreated()));
      expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));
    });

    it('should create, start, and complete steps with real storage', async () => {
      const created = expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: 'step-001',
            eventData: { stepName: 'test-step', input: ['step-input'] },
          },
        }),
      );
      expect(created.step).toMatchObject({
        stepId: 'step-001',
        stepName: 'test-step',
        status: 'pending',
        attempt: 0,
      });

      const started = expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'step-001' },
        }),
      );
      expect(started.step).toMatchObject({ status: 'running', attempt: 1 });
      expect(started.step?.startedAt).toBeInstanceOf(Date);

      const completed = expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_completed',
            correlationId: 'step-001',
            eventData: { result: ['step-result'] },
          },
        }),
      );
      expect(completed.step).toMatchObject({ status: 'completed', output: ['step-result'] });

      const retrieved = await stub.getStep('step-001');
      expect(retrieved?.status).toBe('completed');
    });

    it('should reject a duplicate step_created without overwriting the step', async () => {
      expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: 'step-001',
            eventData: { stepName: 'test-step', input: [] },
          },
        }),
      );
      expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'step-001' },
        }),
      );

      const failure = expectFailure(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: 'step-001',
            eventData: { stepName: 'test-step', input: [] },
          },
        }),
      );
      expect(failure.code).toBe('ENTITY_CONFLICT');

      // Step was NOT reset to pending/attempt 0
      const step = await stub.getStep('step-001');
      expect(step).toMatchObject({ status: 'running', attempt: 1 });
    });

    it('should return TOO_EARLY for step_started before retryAfter', async () => {
      expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: 'step-001',
            eventData: { stepName: 'test-step', input: [] },
          },
        }),
      );
      expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'step-001' },
        }),
      );
      expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_retrying',
            correlationId: 'step-001',
            eventData: { error: 'transient', retryAfter: new Date(Date.now() + 120_000) },
          },
        }),
      );

      const failure = expectFailure(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'step-001' },
        }),
      );
      expect(failure.code).toBe('TOO_EARLY');
      expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should reject events on a terminal step', async () => {
      expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: 'step-001',
            eventData: { stepName: 'test-step', input: [] },
          },
        }),
      );
      expectOk(
        await stub.applyEvent({
          runId,
          data: {
            eventType: 'step_failed',
            correlationId: 'step-001',
            eventData: { error: 'fatal', stack: 'at test' },
          },
        }),
      );

      const failure = expectFailure(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'step-001' },
        }),
      );
      expect(failure.code).toBe('ENTITY_CONFLICT');

      const step = await stub.getStep('step-001');
      expect(step?.status).toBe('failed');
      expect(step?.error).toMatchObject({ message: 'fatal', stack: 'at test' });
    });

    it('should return STEP_NOT_FOUND for lifecycle events on unknown steps', async () => {
      const failure = expectFailure(
        await stub.applyEvent({
          runId,
          data: { eventType: 'step_started', correlationId: 'missing-step' },
        }),
      );
      expect(failure.code).toBe('STEP_NOT_FOUND');
    });
  });

  describe('WorkflowRunDO.applyEvent - hooks', () => {
    beforeEach(async () => {
      expectOk(await stub.applyEvent(runCreated()));
    });

    it('should create hooks, reject duplicates, and release tokens on dispose', async () => {
      const created = expectOk(
        await stub.applyEvent({
          runId,
          tokenHolder: null,
          data: {
            eventType: 'hook_created',
            correlationId: 'hook-001',
            eventData: { token: 'test-token-123' },
          },
        }),
      );
      expect(created.hook).toMatchObject({ hookId: 'hook-001', token: 'test-token-123' });
      expect(created.hookToIndex?.token).toBe('test-token-123');

      // Exact duplicate (token index says we hold it, event already logged)
      const duplicate = expectFailure(
        await stub.applyEvent({
          runId,
          tokenHolder: { runId, hookId: 'hook-001' },
          data: {
            eventType: 'hook_created',
            correlationId: 'hook-001',
            eventData: { token: 'test-token-123' },
          },
        }),
      );
      expect(duplicate.code).toBe('ENTITY_CONFLICT');

      const disposed = expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'hook_disposed', correlationId: 'hook-001' },
        }),
      );
      expect(disposed.releasedHooks).toEqual([{ hookId: 'hook-001', token: 'test-token-123' }]);

      const hooks = await stub.listHooks();
      expect(hooks.data).toHaveLength(0);
    });

    it('should write a hook_conflict event when a different run holds the token', async () => {
      const outcome = expectOk(
        await stub.applyEvent({
          runId,
          tokenHolder: { runId: 'wrun_other', hookId: 'their-hook' },
          data: {
            eventType: 'hook_created',
            correlationId: 'hook-001',
            eventData: { token: 'contested-token' },
          },
        }),
      );

      expect(outcome.hook).toBeUndefined();
      expect(outcome.event?.eventType).toBe('hook_conflict');
      expect(outcome.event?.eventData).toMatchObject({
        token: 'contested-token',
        conflictingRunId: 'wrun_other',
      });
    });

    it('should release all hook tokens when the run completes', async () => {
      expectOk(await stub.applyEvent({ runId, data: { eventType: 'run_started' } }));
      expectOk(
        await stub.applyEvent({
          runId,
          tokenHolder: null,
          data: {
            eventType: 'hook_created',
            correlationId: 'hook-001',
            eventData: { token: 'token-a' },
          },
        }),
      );

      const completed = expectOk(
        await stub.applyEvent({
          runId,
          data: { eventType: 'run_completed', eventData: { output: [] } },
        }),
      );
      expect(completed.releasedHooks).toEqual([{ hookId: 'hook-001', token: 'token-a' }]);
    });
  });

  describe('WorkflowRunDO - event pagination with real SQLite storage', () => {
    it('should page through events by eventId without loss, asc and desc', async () => {
      expectOk(await stub.applyEvent(runCreated()));
      for (let i = 0; i < 9; i++) {
        expectOk(
          await stub.applyEvent({
            runId,
            data: {
              eventType: 'step_created',
              correlationId: `step-${i}`,
              eventData: { stepName: `step-${i}`, input: [i] },
            },
          }),
        );
      }

      // 10 events total (run_created + 9 step_created)
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await stub.listEvents({ limit: 4, cursor, sortOrder: 'asc' });
        seen.push(...page.data.map((e) => e.eventId));
        if (!page.hasMore) break;
        expect(page.data).toHaveLength(4);
        cursor = page.cursor ?? undefined;
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
      expect([...seen].sort()).toEqual(seen);

      const descPage = await stub.listEvents({ limit: 3, sortOrder: 'desc' });
      expect(descPage.data.map((e) => e.eventId)).toEqual(seen.slice(-3).reverse());
      const descPage2 = await stub.listEvents({
        limit: 3,
        sortOrder: 'desc',
        cursor: descPage.cursor ?? undefined,
      });
      expect(descPage2.data.map((e) => e.eventId)).toEqual(seen.slice(-6, -3).reverse());
    });

    it('should handle rapid successive event writes', async () => {
      expectOk(await stub.applyEvent(runCreated()));

      const creates = Array.from({ length: 20 }, (_, i) =>
        stub.applyEvent({
          runId,
          data: {
            eventType: 'step_created',
            correlationId: `step-${i}`,
            eventData: { stepName: `step-${i}`, input: [] },
          },
        }),
      );
      const outcomes = await Promise.all(creates);
      for (const outcome of outcomes) expectOk(outcome);

      const events = await stub.listEvents({ limit: 100 });
      expect(events.data).toHaveLength(21);
      const steps = await stub.listSteps({ limit: 100 });
      expect(steps.data).toHaveLength(20);
    });
  });

  describe('WorkflowRunDO - inflight queue claims', () => {
    it('should fence duplicate messages while allowing same-message re-entry', async () => {
      const claimStub = getRunStub(`claim:test-queue:${crypto.randomUUID()}`);

      const first = await claimStub.claimInflight({ messageId: 'msg_a', staleMs: 60_000 });
      expect(first.claimed).toBe(true);

      // Same message re-enters (redelivery after transient failure)
      const reentry = await claimStub.claimInflight({ messageId: 'msg_a', staleMs: 60_000 });
      expect(reentry.claimed).toBe(true);

      // Different message with the same key is fenced
      const duplicate = await claimStub.claimInflight({ messageId: 'msg_b', staleMs: 60_000 });
      expect(duplicate.claimed).toBe(false);

      // Stale claims are stolen
      const stolen = await claimStub.claimInflight({ messageId: 'msg_b', staleMs: 0 });
      expect(stolen.claimed).toBe(true);

      await claimStub.releaseInflight();
      const afterRelease = await claimStub.claimInflight({ messageId: 'msg_c', staleMs: 60_000 });
      expect(afterRelease.claimed).toBe(true);
    });
  });

  describe('Streamer against the real StreamDO', () => {
    let streamer: ReturnType<typeof createStreamer>;
    let streamName: string;
    let streamRunId: string;

    beforeEach(() => {
      streamer = createStreamer({ env: { WORKFLOW_STREAMS: env.WORKFLOW_STREAMS } });
      streamName = `test-stream-${crypto.randomUUID()}`;
      streamRunId = `wrun_${crypto.randomUUID()}`;
    });

    it('should write and read a stream end-to-end', async () => {
      await streamer.writeToStream(streamName, streamRunId, 'Hello, ');
      await streamer.writeToStream(
        streamName,
        streamRunId,
        new Uint8Array([119, 111, 114, 108, 100]),
      );
      await streamer.closeStream(streamName, streamRunId);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }

      expect(chunks).toHaveLength(2);
      const text = chunks.map((c) => new TextDecoder().decode(c)).join('');
      expect(text).toBe('Hello, world');
    });

    it('should expose stream info and reject writes after close', async () => {
      let info = await streamer.getStreamInfo(streamName, streamRunId);
      expect(info).toEqual({ tailIndex: -1, done: false });

      await streamer.writeToStream(streamName, streamRunId, 'data');
      await streamer.closeStream(streamName, streamRunId);

      info = await streamer.getStreamInfo(streamName, streamRunId);
      expect(info).toEqual({ tailIndex: 0, done: true });

      await expect(streamer.writeToStream(streamName, streamRunId, 'late')).rejects.toThrow();
    });

    it('should paginate stored chunks via getStreamChunks', async () => {
      for (let i = 0; i < 5; i++) {
        await streamer.writeToStream(streamName, streamRunId, `chunk-${i}`);
      }
      await streamer.closeStream(streamName, streamRunId);

      const page1 = await streamer.getStreamChunks(streamName, streamRunId, { limit: 3 });
      expect(page1.data.map((c) => c.index)).toEqual([0, 1, 2]);
      expect(page1.hasMore).toBe(true);
      expect(page1.done).toBe(true);

      const page2 = await streamer.getStreamChunks(streamName, streamRunId, {
        limit: 3,
        cursor: page1.cursor ?? undefined,
      });
      expect(page2.data.map((c) => c.index)).toEqual([3, 4]);
      expect(page2.hasMore).toBe(false);
      expect(new TextDecoder().decode(page2.data[1].data)).toBe('chunk-4');
    });

    it('should list streams by run id', async () => {
      await streamer.writeToStream(`${streamName}-a`, streamRunId, 'a');
      await streamer.writeToStream(`${streamName}-b`, streamRunId, 'b');

      const streams = await streamer.listStreamsByRunId(streamRunId);
      expect(streams.sort()).toEqual([`${streamName}-a`, `${streamName}-b`]);

      const empty = await streamer.listStreamsByRunId(`wrun_${crypto.randomUUID()}`);
      expect(empty).toEqual([]);
    });
  });
});
