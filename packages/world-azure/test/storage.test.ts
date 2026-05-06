import type { Container } from '@azure/cosmos';
import type { WorkflowRun, Step } from '@workflow/world';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/storage.js';

describe('Storage (Azure Cosmos DB integration)', () => {
  // These tests use mocked Cosmos DB to avoid requiring actual Azure credentials
  // In a real environment, you would use Cosmos DB emulator or actual credentials

  let storage: ReturnType<typeof createStorage>;
  let mockContainer: Container;
  let mockHooksByTokenContainer: Container;
  let mockData: Map<string, any>;
  let mockHooksByTokenData: Map<string, any>;

  beforeAll(() => {
    // Create mock data stores
    mockData = new Map();
    mockHooksByTokenData = new Map();

    // Mock main Container
    mockContainer = {
      items: {
        create: vi.fn(async (doc: any) => {
          const id = doc.id;
          if (mockData.has(id)) {
            // Simulate Cosmos DB 409 Conflict error when document already exists
            const error: any = new Error('Conflict');
            error.code = 409;
            throw error;
          }
          mockData.set(id, doc);
          return { resource: doc };
        }),
        query: vi.fn((querySpec: any, options: any) => {
          return {
            fetchAll: vi.fn(async () => {
              const resources: any[] = [];
              for (const [_id, doc] of mockData.entries()) {
                // Simple filtering - in reality Cosmos DB would parse SQL
                if (options?.partitionKey && doc.runId !== options.partitionKey) {
                  continue;
                }
                // Simple type filtering
                const query = querySpec.query;
                if (query.includes('c.type = "run"') && doc.type !== 'run') continue;
                if (query.includes('c.type = "step"') && doc.type !== 'step') continue;
                if (query.includes('c.type = "hook"') && doc.type !== 'hook') continue;
                if (query.includes('c.type = "event"') && doc.type !== 'event') continue;

                resources.push(doc);
              }
              return { resources };
            }),
          };
        }),
        upsert: vi.fn(async (doc: any) => {
          mockData.set(doc.id, doc);
          return { resource: doc };
        }),
      },
      delete: vi.fn(async () => ({})),
    } as any;

    // Mock hooks by token container
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

  afterAll(() => {
    // Cleanup
  });

  /**
   * Helper: create a run via run_created event and return the run entity.
   */
  async function createRun(opts?: {
    deploymentId?: string;
    workflowName?: string;
    input?: any;
    executionContext?: Record<string, any>;
  }): Promise<WorkflowRun> {
    const result = await storage.events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: opts?.deploymentId ?? 'deployment-123',
        workflowName: opts?.workflowName ?? 'test-workflow',
        input: opts?.input ?? [],
        executionContext: opts?.executionContext,
      },
    });
    if (!result.run) {
      throw new Error('Expected run to be created');
    }
    return result.run;
  }

  /**
   * Helper: create a step via step_created event and return the step entity.
   */
  async function createStep(
    runId: string,
    opts?: { stepId?: string; stepName?: string; input?: any },
  ): Promise<Step> {
    const stepId = opts?.stepId ?? 'step-123';
    const result = await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      eventData: {
        stepName: opts?.stepName ?? 'test-step',
        input: opts?.input ?? ['input1'],
      },
    });
    if (!result.step) {
      throw new Error('Expected step to be created');
    }
    return result.step;
  }

  describe('Event idempotency', () => {
    it('should handle duplicate step_created events', async () => {
      const run = await createRun();
      const stepId = 'step-idempotent-test';

      // First step_created event
      const result1 = await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      // Duplicate step_created event (replay scenario)
      const result2 = await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: stepId,
        eventData: { stepName: 'test-step', input: ['input1'] },
      });
      expect(result2.step).toBeDefined();
      expect(result2.step!.stepId).toBe(stepId);

      // Verify step appears in list query (critical!)
      const listResult = await storage.steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);
    });

    it('should handle duplicate run_created events', async () => {
      // First run_created event
      const result1 = await storage.events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-idempotent',
          input: [],
        },
      });
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // Duplicate run_created event (replay scenario)
      const result2 = await storage.events.create(runId, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow-idempotent',
          input: [],
        },
      });
      expect(result2.run).toBeDefined();
      expect(result2.run!.runId).toBe(runId);

      const listResult = await storage.runs.list({ workflowName: 'test-workflow-idempotent' });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should handle duplicate hook_created events with different tokens', async () => {
      const run = await createRun();
      const hookId1 = 'hook-idempotent-test-1';
      const hookId2 = 'hook-idempotent-test-2';

      // Test idempotency by creating two separate hooks
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

      // Both hooks should be in the index
      const listResult = await storage.hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
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

      const retrieved = await storage.runs.get({ runId: run.runId });
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

      const retrieved = await storage.steps.get({ runId: run.runId, stepId: step.stepId });
      expect(retrieved).toBeDefined();
      expect(retrieved.stepId).toBe(step.stepId);
    });
  });
});
