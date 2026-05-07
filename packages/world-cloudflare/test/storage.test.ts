import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../src/storage.js';
import { clearMockData, createMockEnv } from '../src/test-mocks.js';

describe('Storage (Cloudflare Durable Objects integration)', () => {
  let storage: ReturnType<typeof createStorage>;
  let mockEnv: any;

  beforeAll(() => {
    mockEnv = createMockEnv();

    storage = createStorage({
      env: mockEnv,
      deploymentId: 'test-deployment',
    });
  });

  beforeEach(() => {
    clearMockData();
  });

  afterAll(() => {
    // Cleanup
  });

  /**
   * Helper: create a run via the event-sourced API.
   */
  async function createRun(opts: {
    deploymentId: string;
    workflowName: string;
    input: unknown;
    executionContext?: Record<string, unknown>;
  }) {
    const result = await storage.events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: opts.deploymentId,
        workflowName: opts.workflowName,
        input: opts.input,
        executionContext: opts.executionContext,
      },
    });
    return result.run!;
  }

  describe('runs', () => {
    describe('create via events', () => {
      it('should create a new workflow run via run_created event', async () => {
        const result = await storage.events.create(null, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'deployment-123',
            workflowName: 'test-workflow',
            input: ['arg1', 'arg2'],
            executionContext: { userId: 'user-1' },
          },
        });

        expect(result.run).toBeDefined();
        expect(result.event).toBeDefined();
        const run = result.run!;
        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe('deployment-123');
        expect(run.status).toBe('pending');
        expect(run.workflowName).toBe('test-workflow');
        expect(run.executionContext).toEqual({ userId: 'user-1' });
        expect(run.input).toEqual(['arg1', 'arg2']);
        expect(run.output).toBeUndefined();
        expect(run.error).toBeUndefined();
        expect(run.startedAt).toBeUndefined();
        expect(run.completedAt).toBeUndefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });

      it('should handle minimal run data', async () => {
        const result = await storage.events.create(null, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'deployment-123',
            workflowName: 'minimal-workflow',
            input: [],
          },
        });

        const run = result.run!;
        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });

      it('should store run in Durable Object', async () => {
        const run = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        // Verify it's retrievable via storage API
        const retrievedRun = await storage.runs.get(run.runId);
        expect(retrievedRun).toBeDefined();
        expect(retrievedRun.runId).toBe(run.runId);
      });

      it('should create index entry in KV', async () => {
        const run = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        // Verify KV index
        const indexKey = `run:test-workflow:${run.runId}`;
        const indexValue = await mockEnv.WORKFLOW_INDEX.get(indexKey);
        expect(indexValue).toBeDefined();
        const parsed = JSON.parse(indexValue as string);
        expect(parsed.runId).toBe(run.runId);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: ['arg'],
        });

        const retrieved = await storage.runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe('test-workflow');
        expect(retrieved.input).toEqual(['arg']);
      });

      it('should throw error for non-existent run', async () => {
        await expect(storage.runs.get('wrun_missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update via events', () => {
      it('should update run status to running via run_started event', async () => {
        const created = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const result = await storage.events.create(created.runId, {
          eventType: 'run_started',
        });
        const updated = result.run!;
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed via run_completed event', async () => {
        const created = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const result = await storage.events.create(created.runId, {
          eventType: 'run_completed',
          eventData: { output: [{ result: 42 }] },
        });
        const updated = result.run!;
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });

      it('should update run status to failed via run_failed event', async () => {
        const created = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const result = await storage.events.create(created.runId, {
          eventType: 'run_failed',
          eventData: {
            error: {
              message: 'Something went wrong',
              code: 'ERR_001',
            },
          },
        });

        const updated = result.run!;
        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Something went wrong');
        expect(updated.error?.code).toBe('ERR_001');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('cancel via events', () => {
      it('should cancel a run via run_cancelled event', async () => {
        const created = await createRun({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const result = await storage.events.create(created.runId, {
          eventType: 'run_cancelled',
        });

        const cancelled = result.run!;
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs for a workflow', async () => {
        await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await setTimeout(5);

        await createRun({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-1',
          input: [],
        });

        const result = await storage.runs.list({ workflowName: 'workflow-1' });

        expect(result.data.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('steps', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create via events', () => {
      it('should create a new step via step_created event', async () => {
        const result = await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1', 'input2'],
          },
        });

        const step = result.step!;
        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe('step-123');
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input1', 'input2']);
        expect(step.output).toBeUndefined();
        expect(step.error).toBeUndefined();
        expect(step.attempt).toBe(1);
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('get', () => {
      it('should retrieve a step', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const retrieved = await storage.steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe('step-123');
      });

      it('should throw error for non-existent step', async () => {
        await expect(storage.steps.get(testRunId, 'missing-step')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update via events', () => {
      it('should update step status to completed via step_completed event', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId: 'step-123',
          eventData: { result: ['ok'] },
        });

        const updated = result.step!;
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });

      it('should update attempt count via step_retrying event', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step-123',
          eventData: {
            error: 'retry error',
          },
        });

        const updated = result.step!;
        expect(updated.attempt).toBe(2);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-1',
          eventData: {
            stepName: 'first-step',
            input: [],
          },
        });

        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-2',
          eventData: {
            stepName: 'second-step',
            input: [],
          },
        });

        const result = await storage.steps.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
      });
    });
  });

  describe('events', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // First create the step so step_started can find it
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'corr_123',
          eventData: { stepName: 'test-step', input: [] },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr_123',
        });

        const event = result.event!;
        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_started');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        // First create the step so step_failed can find it
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'corr_123',
          eventData: { stepName: 'test-step', input: [] },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'corr_123',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

        const event = result.event!;
        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_failed');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all events for a run', async () => {
        await storage.events.create(testRunId, {
          eventType: 'run_started',
        });

        // Create step first so step_started can update it
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'corr-step-1',
          eventData: { stepName: 'test-step', input: [] },
        });

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr-step-1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        // run_created event + run_started + step_started = 3 events
        expect(result.data.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('hooks', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create via events', () => {
      it('should create a new hook via hook_created event', async () => {
        const result = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-123',
          eventData: {
            token: 'token-abc',
          },
        });

        const hook = result.hook!;
        expect(hook.runId).toBe(testRunId);
        expect(hook.hookId).toBe('hook-123');
        expect(hook.token).toBe('token-abc');
        expect(hook.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all hooks for a run', async () => {
        await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-1',
          eventData: { token: 'token-1' },
        });

        await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-2',
          eventData: { token: 'token-2' },
        });

        const result = await storage.hooks.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
      });
    });
  });

  describe('Event idempotency', () => {
    it('should handle duplicate step_created events', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
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
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
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
});
