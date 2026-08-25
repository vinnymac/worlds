import type { Container, FeedOptions, JSONValue, SqlQuerySpec } from '@azure/cosmos';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import type { WorkflowRun, Step } from '@workflow/world';
import { ulidToDate } from '@workflow/world';
import type { Mock } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/storage.js';

// Mirrors the unexported CosmosDoc shape in src/storage.ts, plus an index signature for the rest.
interface MockDoc {
  id: string;
  type?: string;
  runId?: string;
  stepId?: string;
  hookId?: string;
  eventId?: string;
  correlationId?: string;
  token?: string;
  [key: string]: unknown;
}

// Stands in for @azure/cosmos's QueryIterator class; the mock only needs fetchAll().
interface MockQueryIterator<T> {
  fetchAll: () => Promise<{ resources: T[] }>;
}

// Narrowed stand-in for @azure/cosmos's OperationInput union, limited to what storage.ts emits.
type MockBatchOperation =
  | { operationType: 'Create' | 'Upsert'; id?: string; resourceBody: MockDoc }
  | { operationType: 'Replace'; id: string; resourceBody: MockDoc }
  | { operationType: 'Delete'; id: string }
  | {
      operationType: 'Patch';
      id: string;
      resourceBody: { condition?: string; operations: { path: string; value: unknown }[] };
    };

type MockBatchResult = { code: number; result: { statusCode: number }[] };

type MockBatchImpl = (
  operations: MockBatchOperation[],
  partitionKey: string,
) => Promise<MockBatchResult>;

describe('Storage (Azure Cosmos DB integration)', () => {
  let storage: ReturnType<typeof createStorage>;
  let mockContainer: Container;
  let mockHooksByTokenContainer: Container;
  let mockData: Map<string, MockDoc>;
  let mockHooksByTokenData: Map<string, MockDoc>;

  async function createRun(workflowName = 'test-workflow'): Promise<WorkflowRun> {
    const result = await storage.events.create(null, {
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
    const result = await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'test-step', input: ['input1'] },
    });
    if (!result.step) throw new Error('Expected step to be created');
    return result.step;
  }

  async function createStepResult(runId: string, stepId: string) {
    return storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'test-step', input: ['input1'] },
    });
  }

  beforeAll(() => {
    mockData = new Map();
    mockHooksByTokenData = new Map();

    mockContainer = {
      items: {
        create: vi.fn(async (doc: MockDoc) => {
          if (mockData.has(doc.id)) {
            throw Object.assign(new Error('Conflict'), { code: 409 });
          }
          mockData.set(doc.id, doc);
          return { resource: doc };
        }),
        query: vi.fn(
          (querySpec: SqlQuerySpec, options?: FeedOptions): MockQueryIterator<MockDoc> => ({
            fetchAll: async () => {
              const resources: MockDoc[] = [];
              const query = querySpec.query;
              const paramMap: Record<string, JSONValue> = {};
              for (const param of querySpec.parameters || []) {
                paramMap[param.name] = param.value;
              }

              // `ORDER BY c.<field> ASC|DESC ... LIMIT @limit` and the
              // `c.eventId >|< @cursor` predicate are modelled here so
              // pagination is exercised rather than assumed.
              const orderBy = /ORDER BY c\.(\w+) (ASC|DESC)/.exec(query);
              const cursorOp = /c\.eventId (>|<) @cursor/.exec(query)?.[1];
              const cursor = paramMap['@cursor'];

              for (const [_id, doc] of mockData.entries()) {
                if (options?.partitionKey && doc.runId !== options.partitionKey) continue;
                if (query.includes('c.type = "run"') && doc.type !== 'run') continue;
                if (query.includes('c.type = "step"') && doc.type !== 'step') continue;
                if (query.includes('c.type = "hook"') && doc.type !== 'hook') continue;
                if (query.includes('c.type = "event"') && doc.type !== 'event') continue;
                if (paramMap['@runId'] && doc.runId !== paramMap['@runId']) continue;
                if (paramMap['@stepId'] && doc.stepId !== paramMap['@stepId']) continue;
                if (paramMap['@hookId'] && doc.hookId !== paramMap['@hookId']) continue;
                if (paramMap['@eventId'] && doc.eventId !== paramMap['@eventId']) continue;
                if (
                  paramMap['@correlationId'] &&
                  doc.correlationId !== paramMap['@correlationId']
                ) {
                  continue;
                }
                if (cursorOp && typeof cursor === 'string') {
                  const eventId = doc.eventId ?? '';
                  if (cursorOp === '>' ? eventId <= cursor : eventId >= cursor) continue;
                }
                resources.push(doc);
              }

              if (orderBy) {
                const [, field, direction] = orderBy;
                resources.sort((left, right) => {
                  const a = String(left[field] ?? '');
                  const b = String(right[field] ?? '');
                  return direction === 'ASC' ? a.localeCompare(b) : b.localeCompare(a);
                });
              }

              const limit = paramMap['@limit'];
              return {
                resources: typeof limit === 'number' ? resources.slice(0, limit) : resources,
              };
            },
          }),
        ),
        upsert: vi.fn(async (doc: MockDoc) => {
          mockData.set(doc.id, doc);
          return { resource: doc };
        }),
        // Mirrors @azure/cosmos transactional batch: all-or-nothing within a
        // partition, and a rejected operation RESOLVES with HTTP 207 carrying the
        // failing status on result[i].statusCode (siblings 424) rather than throwing.
        batch: vi.fn<MockBatchImpl>(async (operations, _partitionKey) => {
          /** Evaluate the `from c where c.<field> <op> <number>` conditions we emit. */
          const conditionHolds = (
            condition: string | undefined,
            doc: MockDoc | undefined,
          ): boolean => {
            if (!condition) return true;
            const match = /from c where c\.(\w+) (<=|<|>=|>) (-?\d+)$/.exec(condition.trim());
            if (!match) throw new Error(`mock cannot evaluate condition: ${condition}`);
            const [, field, operator, rawValue] = match;
            const actual = doc?.[field];
            if (typeof actual !== 'number') return false;
            const expected = Number(rawValue);
            switch (operator) {
              case '<=':
                return actual <= expected;
              case '<':
                return actual < expected;
              case '>=':
                return actual >= expected;
              default:
                return actual > expected;
            }
          };

          const statuses = operations.map((op) => {
            if (op.operationType === 'Create' && mockData.has(op.resourceBody.id)) return 409;
            if (
              (op.operationType === 'Replace' || op.operationType === 'Delete') &&
              !mockData.has(op.id)
            ) {
              return 404;
            }
            if (op.operationType === 'Patch') {
              if (!mockData.has(op.id)) return 404;
              return conditionHolds(op.resourceBody.condition, mockData.get(op.id)) ? 200 : 412;
            }
            return op.operationType === 'Create' ? 201 : 200;
          });

          const failedIndex = statuses.findIndex((status) => status >= 400);
          if (failedIndex !== -1) {
            return {
              code: 207,
              result: statuses.map((status, index) => ({
                statusCode: index === failedIndex ? status : 424,
              })),
            };
          }

          for (const op of operations) {
            if (
              op.operationType === 'Create' ||
              op.operationType === 'Replace' ||
              op.operationType === 'Upsert'
            ) {
              mockData.set(op.resourceBody.id ?? op.id, op.resourceBody);
            } else if (op.operationType === 'Delete') {
              mockData.delete(op.id);
            } else if (op.operationType === 'Patch') {
              const existing = mockData.get(op.id);
              if (!existing) {
                throw new Error(`Patch on a document the mock never stored: ${op.id}`);
              }
              const doc: MockDoc = { ...existing };
              for (const patch of op.resourceBody.operations) {
                doc[patch.path.replace(/^\//, '')] = patch.value;
              }
              mockData.set(op.id, doc);
            }
          }
          return { code: 200, result: statuses.map((statusCode) => ({ statusCode })) };
        }),
      },
      item: vi.fn((id: string, _partitionKey: string) => ({
        read: vi.fn(async () => ({ resource: mockData.get(id) })),
        replace: vi.fn(async (doc: MockDoc) => {
          mockData.set(id, doc);
          return { resource: doc };
        }),
        delete: vi.fn(async () => {
          if (!mockData.has(id)) {
            throw Object.assign(new Error('NotFound'), { code: 404 });
          }
          mockData.delete(id);
          return {};
        }),
      })),
      delete: vi.fn(async () => ({})),
      // Container is a class with private members the mock can't structurally
      // satisfy; it only implements the subset storage.ts calls.
    } as unknown as Container;

    mockHooksByTokenContainer = {
      items: {
        create: vi.fn(async (doc: MockDoc) => {
          if (mockHooksByTokenData.has(doc.id)) {
            throw Object.assign(new Error('Conflict'), { code: 409 });
          }
          mockHooksByTokenData.set(doc.id, doc);
          return { resource: doc };
        }),
        query: vi.fn((): MockQueryIterator<MockDoc> => ({
          fetchAll: async () => ({
            resources: Array.from(mockHooksByTokenData.values()),
          }),
        })),
        upsert: vi.fn(async (doc: MockDoc) => {
          mockHooksByTokenData.set(doc.id, doc);
          return { resource: doc };
        }),
      },
      item: vi.fn((id: string, _partitionKey: string) => ({
        read: vi.fn(async () => ({ resource: mockHooksByTokenData.get(id) })),
        delete: vi.fn(async () => {
          mockHooksByTokenData.delete(id);
          return {};
        }),
      })),
      delete: vi.fn(async () => ({})),
    } as unknown as Container;

    storage = createStorage({
      container: mockContainer,
      hooksByTokenContainer: mockHooksByTokenContainer,
      deploymentId: 'test-deployment',
    });
  });

  beforeEach(() => {
    mockData.clear();
    mockHooksByTokenData.clear();
    vi.clearAllMocks();
  });

  describe('Event idempotency', () => {
    it('should reject duplicate run_created events with EntityConflictError', async () => {
      const workflowName = 'test-workflow-idempotent';
      const eventData = {
        eventType: 'run_created' as const,
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      };

      const result1 = await storage.events.create(null, eventData);
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;
      // Entity fields must not leak Cosmos doc internals or raw CBOR
      expect(result1.run!.input).toEqual([]);
      expect(result1.run).not.toHaveProperty('id');
      expect(result1.run).not.toHaveProperty('type');

      // The runtime's start() path swallows EntityConflictError for raced
      // duplicate creates, matching world-local/world-postgres semantics.
      await expect(storage.events.create(runId, eventData)).rejects.toSatisfy((err) =>
        EntityConflictError.is(err),
      );

      const listResult = await storage.runs.list({ workflowName });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should reject duplicate step_created events with EntityConflictError', async () => {
      const run = await createRun();
      const stepId = 'step-idempotent';
      const eventData = {
        eventType: 'step_created' as const,
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      };

      const result1 = await storage.events.create(run.runId, eventData);
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);
      expect(result1.step!.input).toEqual(['input1']);
      expect(result1.step).not.toHaveProperty('id');
      expect(result1.step).not.toHaveProperty('type');

      await expect(storage.events.create(run.runId, eventData)).rejects.toSatisfy((err) =>
        EntityConflictError.is(err),
      );

      const listResult = await storage.steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);
    });

    it('should handle duplicate hook_created events', async () => {
      const run = await createRun();
      const hookId1 = 'hook-idempotent-1';
      const hookId2 = 'hook-idempotent-2';

      const result1 = await storage.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId1,
        eventData: { token: 'test-token-1' },
      });
      expect(result1.hook).toBeDefined();

      const result2 = await storage.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId2,
        eventData: { token: 'test-token-2' },
      });
      expect(result2.hook).toBeDefined();

      const listResult = await storage.hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });

    it('rejects a duplicate hook_created of the same hook with a single event row', async () => {
      const run = await createRun();
      const hookId = 'hook-duplicate-same';
      const token = 'token-duplicate-same';

      const first = await storage.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: hookId,
        eventData: { token },
      });
      expect(first.hook).toBeDefined();

      // Duplicate delivery of the SAME (runId, hookId): must be an
      // EntityConflictError, NOT a self hook_conflict event.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toSatisfy((err) => EntityConflictError.is(err));

      // Exactly one hook_created row: a second one would poison replay
      // with ReplayDivergenceError.
      const eventList = await storage.events.list({ runId: run.runId });
      expect(
        eventList.data.filter((e) => e.eventType === 'hook_created' && e.correlationId === hookId),
      ).toHaveLength(1);
      expect(eventList.data.some((e) => e.eventType === 'hook_conflict')).toBe(false);
    });

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun();

      // First run_started
      const result1 = await storage.events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result1.run?.status).toBe('running');
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario, should be idempotent)
      const result2 = await storage.events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result2.run?.status).toBe('running');
      // startedAt should be preserved from first call
      expect(result2.run!.startedAt!.getTime()).toBe(originalStartedAt.getTime());

      // Only ONE run_started event should exist in the log
      const eventList = await storage.events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc' },
      });
      const runStartedEvents = eventList.data.filter((e) => e.eventType === 'run_started');
      expect(runStartedEvents).toHaveLength(1);
    });
  });

  it('should create and retrieve entities', async () => {
    const run = await createRun();
    expect(run.runId).toBeDefined();
    expect(run.status).toBe('pending');

    const retrieved = await storage.runs.get(run.runId);
    expect(retrieved.runId).toBe(run.runId);

    const step = await createStep(run.runId, 'test-step-1');
    expect(step.stepId).toBe('test-step-1');
    expect(step.status).toBe('pending');

    const retrievedStep = await storage.steps.get(run.runId, step.stepId);
    expect(retrievedStep.stepId).toBe(step.stepId);
  });

  it('should throw WorkflowRunNotFoundError for missing runs', async () => {
    await expect(storage.runs.get('wrun_missing')).rejects.toSatisfy((err) =>
      WorkflowRunNotFoundError.is(err),
    );
  });

  it('should resolve steps without a runId via cross-partition lookup', async () => {
    const run = await createRun();
    const step = await createStep(run.runId, 'step-no-runid');

    const resolved = await storage.steps.get(undefined, step.stepId);
    expect(resolved.stepId).toBe(step.stepId);
    expect(resolved.runId).toBe(run.runId);
  });

  describe('run_failed error mapping', () => {
    it('should persist eventData.errorCode and structured errors', async () => {
      const run = await createRun();
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const result = await storage.events.create(run.runId, {
        eventType: 'run_failed',
        eventData: {
          error: { message: 'boom', stack: 'stack-trace' },
          errorCode: 'RUNTIME_ERROR',
        },
      });

      expect(result.run?.status).toBe('failed');
      expect(result.run?.error).toEqual({
        message: 'boom',
        stack: 'stack-trace',
        code: 'RUNTIME_ERROR',
      });
    });

    it('should preserve plain string errors', async () => {
      const run = await createRun();
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const result = await storage.events.create(run.runId, {
        eventType: 'run_failed',
        eventData: { error: 'plain failure' },
      });

      expect(result.run?.status).toBe('failed');
      expect(result.run?.error?.message).toBe('plain failure');
    });
  });

  describe('Waits', () => {
    it('should create and complete wait entities, rejecting duplicates', async () => {
      const run = await createRun();
      const correlationId = 'wait-1';
      const resumeAt = new Date(Date.now() + 60_000);

      const created = await storage.events.create(run.runId, {
        eventType: 'wait_created',
        correlationId,
        eventData: { resumeAt },
      });
      expect(created.wait?.status).toBe('waiting');
      expect(created.wait?.resumeAt?.getTime()).toBe(resumeAt.getTime());

      // Suspended replays re-send wait_created; duplicates must be
      // EntityConflictError so the runtime's catch path swallows them.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'wait_created',
          correlationId,
          eventData: { resumeAt },
        }),
      ).rejects.toSatisfy((err) => EntityConflictError.is(err));

      const completed = await storage.events.create(run.runId, {
        eventType: 'wait_completed',
        correlationId,
      });
      expect(completed.wait?.status).toBe('completed');

      // At-least-once wake-up deliveries must not append duplicate events.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'wait_completed',
          correlationId,
        }),
      ).rejects.toSatisfy((err) => EntityConflictError.is(err));

      const events = await storage.events.list({ runId: run.runId });
      expect(events.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(1);
      expect(events.data.filter((e) => e.eventType === 'wait_completed')).toHaveLength(1);
    });
  });

  describe('Hook lifecycle', () => {
    it('hook_disposed deletes the hook and releases its token for reuse', async () => {
      const run = await createRun();
      const token = 'token-reuse';

      await storage.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-a',
        eventData: { token },
      });

      await storage.events.create(run.runId, {
        eventType: 'hook_disposed',
        correlationId: 'hook-a',
        eventData: { token },
      });

      // The hook is gone and its token is released
      await expect(storage.hooks.getByToken(token)).rejects.toSatisfy((err) =>
        HookNotFoundError.is(err),
      );

      // A different run can now claim the same token without a conflict
      const otherRun = await createRun();
      const recreated = await storage.events.create(otherRun.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-b',
        eventData: { token },
      });
      expect(recreated.hook?.runId).toBe(otherRun.runId);
    });

    it('hook_disposed on a missing hook throws HookNotFoundError', async () => {
      const run = await createRun();
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_disposed',
          correlationId: 'nonexistent-hook',
        }),
      ).rejects.toSatisfy((err) => HookNotFoundError.is(err));
    });

    it('hook_received on a missing hook throws HookNotFoundError', async () => {
      const run = await createRun();
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_received',
          correlationId: 'nonexistent-hook',
          eventData: { payload: { hello: 'world' } },
        }),
      ).rejects.toSatisfy((err) => HookNotFoundError.is(err));
    });
  });

  describe('Terminal-state races', () => {
    it('run_started never resurrects a run that raced to terminal', async () => {
      const run = await createRun();
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, { eventType: 'run_completed', eventData: {} });

      await expect(storage.events.create(run.runId, { eventType: 'run_started' })).rejects.toThrow(
        /terminal state/,
      );

      const current = await storage.runs.get(run.runId);
      expect(current.status).toBe('completed');
    });

    it('duplicate terminal run events are rejected without appending to the log', async () => {
      const run = await createRun();
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, { eventType: 'run_completed', eventData: {} });

      await expect(
        storage.events.create(run.runId, {
          eventType: 'run_failed',
          eventData: { error: { message: 'late failure' } },
        }),
      ).rejects.toSatisfy((err) => EntityConflictError.is(err));

      const events = await storage.events.list({ runId: run.runId });
      expect(events.data.filter((e) => e.eventType === 'run_failed')).toHaveLength(0);
      expect(events.data.filter((e) => e.eventType === 'run_completed')).toHaveLength(1);
    });
  });

  describe('Optimistic concurrency guard (stateUpdatedAt, world 4.3.1)', () => {
    /** ULID time (epoch ms) of an event id, i.e. the state-marker unit. */
    function eventTime(eventId: string): number {
      const time = ulidToDate(eventId.slice(eventId.lastIndexOf('_') + 1))?.getTime();
      if (time === undefined) throw new Error(`not a decodable event id: ${eventId}`);
      return time;
    }

    /** Drive a run until an externally-originated step_completed has advanced the
     * state marker, and report the marker value. */
    async function runWithMarker(): Promise<{ runId: string; marker: number }> {
      const run = await createRun('guard-workflow');
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await createStep(run.runId, 'step-guard');
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-guard',
        eventData: {},
      });
      // No stateUpdatedAt -> externally originated -> advances the marker.
      const completed = await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: 'step-guard',
        eventData: { result: 'ok' },
      });
      return { runId: run.runId, marker: eventTime(completed.event!.eventId) };
    }

    it('rejects a strictly older snapshot with PreconditionFailedError', async () => {
      const { runId, marker } = await runWithMarker();

      await expect(
        storage.events.create(
          runId,
          {
            eventType: 'wait_created',
            correlationId: 'wait-stale',
            eventData: { resumeAt: new Date(Date.now() + 60_000) },
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toSatisfy((err) => PreconditionFailedError.is(err));

      // The rejected create must not have appended anything.
      const events = await storage.events.list({ runId, pagination: { limit: 100 } });
      expect(events.data.some((e) => e.eventType === 'wait_created')).toBe(false);
    });

    it('rejects inside the batch when the marker advances after the pre-check', async () => {
      // The fast-path compare passes, so only the in-batch Patch condition can
      // catch this -- exactly the race the guard exists for.
      const { runId, marker } = await runWithMarker();
      // runWithMarker() always seeds the marker doc, so this lookup can't miss.
      const markerDoc = mockData.get(`marker:${runId}`)!;
      expect(markerDoc.stateUpdatedAt).toBe(marker);

      const batch = mockContainer.items.batch as unknown as Mock<MockBatchImpl>;
      const original = batch.getMockImplementation()!;
      batch.mockImplementationOnce(async (operations, partitionKey) => {
        markerDoc.stateUpdatedAt = marker + 1000;
        return original(operations, partitionKey);
      });

      await expect(
        storage.events.create(
          runId,
          {
            eventType: 'wait_created',
            correlationId: 'wait-raced',
            eventData: { resumeAt: new Date(Date.now() + 60_000) },
          },
          { stateUpdatedAt: marker },
        ),
      ).rejects.toSatisfy((err) => PreconditionFailedError.is(err));

      const events = await storage.events.list({ runId, pagination: { limit: 100 } });
      expect(events.data.some((e) => e.eventType === 'wait_created')).toBe(false);
    });

    it('accepts an equal snapshot and does not advance the marker', async () => {
      const { runId, marker } = await runWithMarker();

      // Equal passes (anti-livelock for an up-to-date client)...
      await storage.events.create(
        runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-a',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { stateUpdatedAt: marker },
      );
      // ...and a replay-origin create must not move the marker forward, so the
      // same snapshot still passes afterwards.
      await storage.events.create(
        runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-b',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { stateUpdatedAt: marker },
      );

      expect(mockData.get(`marker:${runId}`)!.stateUpdatedAt).toBe(marker);
      const events = await storage.events.list({ runId, pagination: { limit: 100 } });
      expect(events.data.filter((e) => e.eventType === 'wait_created')).toHaveLength(2);
    });

    it('fails open when no snapshot is supplied', async () => {
      const { runId } = await runWithMarker();

      const result = await storage.events.create(runId, {
        eventType: 'wait_created',
        correlationId: 'wait-unguarded',
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      });
      expect(result.event).toBeDefined();
    });

    it('advances the marker on an externally-originated hook_received', async () => {
      const run = await createRun('guard-hook-workflow');
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook-guard',
        eventData: { token: 'token-guard' },
      });
      const received = await storage.events.create(run.runId, {
        eventType: 'hook_received',
        correlationId: 'hook-guard',
        eventData: { payload: {} },
      });
      const marker = eventTime(received.event!.eventId);
      expect(mockData.get(`marker:${run.runId}`)!.stateUpdatedAt).toBe(marker);

      await expect(
        storage.events.create(
          run.runId,
          { eventType: 'hook_disposed', correlationId: 'hook-guard', eventData: {} },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toSatisfy((err) => PreconditionFailedError.is(err));
    });

    it('does not arm the guard from run lifecycle events', async () => {
      // run_created / run_started are created without a snapshot but are NOT
      // externally originated; treating them as such would 412 every replay.
      const run = await createRun('guard-lifecycle-workflow');
      const started = await storage.events.create(run.runId, { eventType: 'run_started' });
      const startedAt = eventTime(started.event!.eventId);

      const result = await storage.events.create(
        run.runId,
        {
          eventType: 'wait_created',
          correlationId: 'wait-x',
          eventData: { resumeAt: new Date(Date.now() + 60_000) },
        },
        { stateUpdatedAt: startedAt - 1000 },
      );
      expect(result.event).toBeDefined();
    });
  });

  describe('Event ceiling (EventResult.maxEvents, world 4.3.1)', () => {
    it('reports the default ceiling on run_started and on its idempotent replay', async () => {
      const run = await createRun('max-events-workflow');

      const started = await storage.events.create(run.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(25_000);

      // The runtime reads maxEvents only from run_started, so the replay path
      // (already-running) must report it too.
      const replay = await storage.events.create(run.runId, { eventType: 'run_started' });
      expect(replay.maxEvents).toBe(25_000);
    });

    it('does not report a ceiling on non-run_started responses', async () => {
      const run = await createRun('max-events-scope-workflow');
      const created = await createStepResult(run.runId, 'step-max');
      expect(created.maxEvents).toBeUndefined();
    });

    it('honors an explicitly configured ceiling', async () => {
      const configured = createStorage({
        container: mockContainer,
        hooksByTokenContainer: mockHooksByTokenContainer,
        deploymentId: 'test-deployment',
        maxEventsPerRun: 10,
      });
      const created = await configured.events.create(null, {
        eventType: 'run_created',
        eventData: { deploymentId: 'test-deployment', workflowName: 'capped', input: [] },
      });
      const started = await configured.events.create(created.run!.runId, {
        eventType: 'run_started',
      });
      expect(started.maxEvents).toBe(10);
    });

    it('rejects a non-positive configured ceiling', () => {
      expect(() =>
        createStorage({
          container: mockContainer,
          hooksByTokenContainer: mockHooksByTokenContainer,
          deploymentId: 'test-deployment',
          maxEventsPerRun: 0,
        }),
      ).toThrow(/positive integer/);
    });
  });

  describe('events.listByCorrelationId run scoping', () => {
    const sharedCorrelationId = 'step-shared-correlation';

    // Entities live in their run's partition here, so the cross-run case is
    // two runs walking the same step lifecycle under one correlation id.
    // Interleave them so an unscoped lookup alternates between the runs.
    async function seedInterleavedRuns() {
      const runA = await createRun('scoping-workflow-a');
      const runB = await createRun('scoping-workflow-b');

      const a1 = await storage.events.create(runA.runId, {
        eventType: 'step_created',
        correlationId: sharedCorrelationId,
        eventData: { stepName: 'shared-step', input: [] },
      });
      const b1 = await storage.events.create(runB.runId, {
        eventType: 'step_created',
        correlationId: sharedCorrelationId,
        eventData: { stepName: 'shared-step', input: [] },
      });
      const a2 = await storage.events.create(runA.runId, {
        eventType: 'step_started',
        correlationId: sharedCorrelationId,
      });
      const b2 = await storage.events.create(runB.runId, {
        eventType: 'step_started',
        correlationId: sharedCorrelationId,
      });
      const a3 = await storage.events.create(runA.runId, {
        eventType: 'step_completed',
        correlationId: sharedCorrelationId,
        eventData: { result: 'ok' },
      });
      const b3 = await storage.events.create(runB.runId, {
        eventType: 'step_completed',
        correlationId: sharedCorrelationId,
        eventData: { result: 'ok' },
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

      const result = await storage.events.listByCorrelationId({
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

      const result = await storage.events.listByCorrelationId({
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

      const page1 = await storage.events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        runId: seeded.runA,
        pagination: { limit: 2 },
      });

      expect(page1.data.map((e) => e.eventId)).toEqual([seeded.a[0], seeded.a[1]]);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe(seeded.a[1]);

      const page2 = await storage.events.listByCorrelationId({
        correlationId: sharedCorrelationId,
        runId: seeded.runA,
        pagination: { limit: 2, cursor: page1.cursor ?? undefined },
      });

      expect(page2.data.map((e) => e.eventId)).toEqual([seeded.a[2]]);
      expect(page2.hasMore).toBe(false);
    });
  });
});
