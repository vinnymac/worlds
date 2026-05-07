import type { Container } from '@azure/cosmos';
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
      },
      delete: vi.fn(async () => ({})),
    } as any;

    mockHooksByTokenContainer = {
      items: {
        create: vi.fn(async (doc: any) => {
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
    it('should handle duplicate run_created events', async () => {
      const workflowName = 'test-workflow-idempotent';
      const eventData = {
        eventType: 'run_created' as const,
        eventData: { deploymentId: 'test-deployment', workflowName, input: [] },
      };

      const result1 = await storage.events.create(null, eventData);
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      const result2 = await storage.events.create(runId, eventData);
      expect(result2.run).toBeDefined();
      expect(result2.run!.runId).toBe(runId);

      const listResult = await storage.runs.list({ workflowName });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should handle duplicate step_created events', async () => {
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

      const result2 = await storage.events.create(run.runId, eventData);
      expect(result2.step).toBeDefined();
      expect(result2.step!.stepId).toBe(stepId);

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
});
