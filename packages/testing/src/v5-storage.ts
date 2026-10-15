import type { Storage, WorkflowRun } from '@workflow/world';
import { eventIdToSlot, FIRST_EVENT_SLOT, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';

/**
 * The storage half of a World under test. A getter, because suites create
 * their storage in a `beforeAll` that has not run when `describe` collects.
 */
export type StorageUnderTest = () => Pick<Storage, 'events' | 'runs' | 'steps'>;

async function createRun(
  storage: Pick<Storage, 'events'>,
  attributes?: Record<string, string>,
): Promise<WorkflowRun> {
  const result = await storage.events.create(null, {
    eventType: 'run_created',
    eventData: {
      deploymentId: 'slot-deployment',
      workflowName: 'slot-workflow',
      input: [],
      ...(attributes ? { attributes } : {}),
    },
  });
  if (!result.run) throw new Error('Expected run_created to return the run');
  return result.run;
}

function stepCreated(stepId: string) {
  return {
    eventType: 'step_created' as const,
    correlationId: stepId,
    eventData: { stepName: 'slot-step', input: [] },
  };
}

async function listAll(storage: Pick<Storage, 'events'>, runId: string) {
  const events = [];
  let cursor: string | null = null;
  do {
    const page = await storage.events.list({
      runId,
      pagination: { limit: 100, ...(cursor ? { cursor } : {}) },
    });
    events.push(...page.data);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return events;
}

/**
 * The parts of the v5 storage contract a World can get wrong without any type
 * error, checked at the storage layer:
 *
 * - every event id is its 1-based slot in its run's log, slots are dense and
 *   unique under concurrent appends, and a write sent with a stale
 *   `eventCount` bumps to the next free slot and reports what it skipped
 *   instead of being rejected;
 * - a `step_started` carrying `stepName` + `input` creates its step (lazy
 *   start), and exactly one of several concurrent lazy starts wins;
 * - errors are the runtime's serialized payloads and round-trip verbatim;
 * - run attributes come from `run_created` and change through `attr_set`;
 * - a terminal run refuses `step_started`, and `runs.list` takes several
 *   statuses.
 */
export function describeV5Storage(getStorage: StorageUnderTest): void {
  describe('slot-numbered event ids', () => {
    it('numbers a run densely from the first slot', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, stepCreated('slot-a'));
      await storage.events.create(run.runId, stepCreated('slot-b'));

      const events = await listAll(storage, run.runId);
      expect(events.map((e) => e.eventId)).toEqual(
        events.map((_, i) => slotToEventId(FIRST_EVENT_SLOT + i)),
      );
      expect(events.map((e) => e.eventType)).toEqual([
        'run_created',
        'run_started',
        'step_created',
        'step_created',
      ]);
    });

    it('keeps slots unique and dense under concurrent appends', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const width = 20;
      const results = await Promise.all(
        Array.from({ length: width }, (_, i) =>
          storage.events.create(run.runId, stepCreated(`slot-fan-${i}`), { eventCount: 2 }),
        ),
      );
      const committed = results.map((r) => eventIdToSlot(r.event!.eventId)!);
      expect(new Set(committed).size).toBe(width);

      const events = await listAll(storage, run.runId);
      expect(events).toHaveLength(width + 2);
      expect(events.map((e) => e.eventId)).toEqual(
        events.map((_, i) => slotToEventId(FIRST_EVENT_SLOT + i)),
      );
    });

    it('bumps a stale write to the next free slot and reports what it skipped', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });
      // The writer replayed a log of two events (run_created, run_started)...
      const staleCount = 2;
      // ...while two more landed behind its back.
      const skippedA = await storage.events.create(run.runId, stepCreated('slot-skip-a'));
      const skippedB = await storage.events.create(run.runId, stepCreated('slot-skip-b'));

      const bumped = await storage.events.create(run.runId, stepCreated('slot-stale'), {
        eventCount: staleCount,
      });

      expect(eventIdToSlot(bumped.event!.eventId)).toBe(staleCount + 3);
      expect(bumped.events?.map((e) => e.eventId)).toEqual([
        skippedA.event!.eventId,
        skippedB.event!.eventId,
      ]);
      expect(bumped.cursor).toBe(skippedB.event!.eventId);
      expect(bumped.hasMore).toBe(false);
    });

    it('reports nothing when the write lands on the slot it asked for', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const fresh = await storage.events.create(run.runId, stepCreated('slot-fresh'), {
        eventCount: 2,
      });
      expect(eventIdToSlot(fresh.event!.eventId)).toBe(3);
      expect(fresh.events).toBeUndefined();
    });
  });

  describe('v5 run contract', () => {
    it('refuses step_started on a terminal run even while the step reads running', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, stepCreated('slot-terminal-step'));
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'slot-terminal-step',
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: 'slot-terminal-step',
        }),
      ).rejects.toMatchObject({ name: 'RunExpiredError' });

      // An in-flight step can still record its outcome.
      const completed = await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: 'slot-terminal-step',
        eventData: { result: [] },
      });
      expect(completed.event?.eventType).toBe('step_completed');
    });

    it('creates the step on a lazy step_started, with exactly one winner', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const lazyStart = () =>
        storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: 'lazy-step',
          eventData: { stepName: 'lazy-step-name', input: new Uint8Array([1, 2, 3]) },
        });
      const results = await Promise.allSettled([lazyStart(), lazyStart(), lazyStart()]);
      const winners = results.filter((r) => r.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject({ name: 'EntityConflictError' });
        }
      }

      const step = await storage.steps.get(run.runId, 'lazy-step');
      expect(step.stepName).toBe('lazy-step-name');
      expect(step.status).toBe('running');

      // Replay sees step_created before step_started, with the input on the
      // created event and only the name on the started one.
      const events = await listAll(storage, run.runId);
      const types = events.map((e) => e.eventType);
      expect(types).toEqual(['run_created', 'run_started', 'step_created', 'step_started']);
      const started = events[3] as { eventData?: Record<string, unknown> };
      expect(started.eventData?.input).toBeUndefined();
      expect(events.map((e) => e.eventId)).toEqual(
        events.map((_, i) => slotToEventId(FIRST_EVENT_SLOT + i)),
      );
    });

    it('stores run and step errors as the serialized payload', async () => {
      const storage = getStorage();
      const run = await createRun(storage);
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, stepCreated('error-step'));
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'error-step',
      });
      const stepError = new Uint8Array([7, 8, 9]);
      await storage.events.create(run.runId, {
        eventType: 'step_failed',
        correlationId: 'error-step',
        eventData: { error: stepError },
      });
      const runError = new Uint8Array([4, 5, 6]);
      await storage.events.create(run.runId, {
        eventType: 'run_failed',
        eventData: { error: runError, errorCode: 'USER_ERROR' },
      });

      const failed = await storage.runs.get(run.runId);
      expect(new Uint8Array(failed.error as Uint8Array)).toEqual(runError);
      expect(failed.errorCode).toBe('USER_ERROR');
      const step = await storage.steps.get(run.runId, 'error-step');
      expect(new Uint8Array(step.error as Uint8Array)).toEqual(stepError);
    });

    it('keeps run_created attributes and applies attr_set changes', async () => {
      const storage = getStorage();
      const parent = await createRun(storage);
      const child = await createRun(storage, {
        $parentRunId: parent.runId,
        $rootRunId: parent.runId,
      });
      expect(child.attributes).toEqual({ $parentRunId: parent.runId, $rootRunId: parent.runId });

      await storage.events.create(child.runId, { eventType: 'run_started' });
      await storage.events.create(child.runId, {
        eventType: 'attr_set',
        eventData: {
          writer: { type: 'workflow' },
          changes: [{ key: 'tenant', value: 'acme' }],
        },
      });
      const reread = await storage.runs.get(child.runId);
      expect(reread.attributes).toEqual({
        $parentRunId: parent.runId,
        $rootRunId: parent.runId,
        tenant: 'acme',
      });
    });

    it('filters runs.list by an array of statuses', async () => {
      const storage = getStorage();
      const pending = await createRun(storage);
      const running = await createRun(storage);
      await storage.events.create(running.runId, { eventType: 'run_started' });

      const both = await storage.runs.list({ status: ['pending', 'running'] });
      const bothIds = both.data.map((r) => r.runId);
      expect(bothIds).toContain(pending.runId);
      expect(bothIds).toContain(running.runId);

      const onlyRunning = await storage.runs.list({ status: ['running'] });
      expect(onlyRunning.data.map((r) => r.runId)).toContain(running.runId);
      expect(onlyRunning.data.map((r) => r.runId)).not.toContain(pending.runId);

      const none = await storage.runs.list({ status: [] });
      expect(none.data).toEqual([]);
    });
  });
}
