import type { Container } from '@azure/cosmos';
import { EntityConflictError, HookNotFoundError, WorkflowRunNotFoundError } from '@workflow/errors';
import type { WorkflowRun, Step } from '@workflow/world';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/storage.js';

describe('Storage (Azure Cosmos DB integration)', () => {
  let storage: ReturnType<typeof createStorage>;
  let mockContainer: Container;
  let mockHooksByTokenContainer: Container;
  let mockData: Map<string, any>;
  let mockHooksByTokenData: Map<string, any>;

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

  beforeAll(() => {
    mockData = new Map();
    mockHooksByTokenData = new Map();

    mockContainer = {
      items: {
        create: vi.fn(async (doc: any) => {
          if (mockData.has(doc.id)) {
            const error: any = new Error('Conflict');
            error.code = 409;
            throw error;
          }
          mockData.set(doc.id, doc);
          return { resource: doc };
        }),
        query: vi.fn((querySpec: any, options: any) => ({
          fetchAll: vi.fn(async () => {
            const resources: any[] = [];
            const query = querySpec.query;
            const paramMap: Record<string, any> = {};
            for (const param of querySpec.parameters || []) {
              paramMap[param.name] = param.value;
            }

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
              resources.push(doc);
            }
            return { resources };
          }),
        })),
        upsert: vi.fn(async (doc: any) => {
          mockData.set(doc.id, doc);
          return { resource: doc };
        }),
        // Mirrors @azure/cosmos transactional batch: all-or-nothing within a
        // partition, and failures are rethrown as a PLAIN Error with the
        // "Batch request error:" prefix (the real SDK discards the status
        // code), so the storage layer's unwrap/translate path is exercised.
        batch: vi.fn(async (operations: any[], _partitionKey: string) => {
          for (const op of operations) {
            if (op.operationType === 'Create' && mockData.has(op.resourceBody.id)) {
              throw new Error(
                'Batch request error: Entity with the specified id already exists in the system.',
              );
            }
            if (
              (op.operationType === 'Replace' || op.operationType === 'Delete') &&
              !mockData.has(op.id)
            ) {
              throw new Error('Batch request error: Entity with the specified id does not exist.');
            }
          }
          for (const op of operations) {
            if (op.operationType === 'Create' || op.operationType === 'Replace') {
              mockData.set(op.resourceBody.id ?? op.id, op.resourceBody);
            } else if (op.operationType === 'Delete') {
              mockData.delete(op.id);
            }
          }
          return { code: 200 };
        }),
      },
      item: vi.fn((id: string, _partitionKey: string) => ({
        read: vi.fn(async () => ({ resource: mockData.get(id) })),
        replace: vi.fn(async (doc: any) => {
          mockData.set(id, doc);
          return { resource: doc };
        }),
        delete: vi.fn(async () => {
          if (!mockData.has(id)) {
            const error: any = new Error('NotFound');
            error.code = 404;
            throw error;
          }
          mockData.delete(id);
          return {};
        }),
      })),
      delete: vi.fn(async () => ({})),
    } as any;

    mockHooksByTokenContainer = {
      items: {
        create: vi.fn(async (doc: any) => {
          if (mockHooksByTokenData.has(doc.id)) {
            const error: any = new Error('Conflict');
            error.code = 409;
            throw error;
          }
          mockHooksByTokenData.set(doc.id, doc);
          return { resource: doc };
        }),
        query: vi.fn(() => ({
          fetchAll: vi.fn(async () => ({
            resources: Array.from(mockHooksByTokenData.values()),
          })),
        })),
        upsert: vi.fn(async (doc: any) => {
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
    } as any;

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
      // duplicate creates — matching world-local/world-postgres semantics.
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

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun();

      // First run_started
      const result1 = await storage.events.create(run.runId, {
        eventType: 'run_started',
      });
      expect(result1.run?.status).toBe('running');
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario — should be idempotent)
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
      const runStartedEvents = eventList.data.filter((e: any) => e.eventType === 'run_started');
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
});
