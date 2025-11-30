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

  describe('runs', () => {
    describe('create', () => {
      it('should create a new workflow run', async () => {
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          executionContext: { userId: 'user-1' },
          input: ['arg1', 'arg2'],
        };

        const run = await storage.runs.create(runData);

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
        const runData = {
          deploymentId: 'deployment-123',
          workflowName: 'minimal-workflow',
          input: [],
        };

        const run = await storage.runs.create(runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });

      it('should store run in Durable Object', async () => {
        const run = await storage.runs.create({
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
        const run = await storage.runs.create({
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
        const created = await storage.runs.create({
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

    describe('update', () => {
      it('should update run status to running', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await storage.runs.update(created.runId, {
          status: 'running',
        });
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await storage.runs.update(created.runId, {
          status: 'completed',
          output: [{ result: 42 }],
        });
        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual([{ result: 42 }]);
      });

      it('should update run status to failed', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await storage.runs.update(created.runId, {
          status: 'failed',
          error: {
            message: 'Something went wrong',
            code: 'ERR_001',
          },
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Something went wrong');
        expect(updated.error?.code).toBe('ERR_001');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('cancel', () => {
      it('should cancel a run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const cancelled = await storage.runs.cancel(created.runId);

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });
    });

    describe('pause', () => {
      it('should pause a run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const paused = await storage.runs.pause(created.runId);

        expect(paused.status).toBe('paused');
      });
    });

    describe('resume', () => {
      it('should resume a paused run', async () => {
        const created = await storage.runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        await storage.runs.pause(created.runId);
        const resumed = await storage.runs.resume(created.runId);

        expect(resumed.status).toBe('running');
        expect(resumed.startedAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all runs for a workflow', async () => {
        await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await setTimeout(5);

        await storage.runs.create({
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
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const stepData = {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1', 'input2'],
        };

        const step = await storage.steps.create(testRunId, stepData);

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
        const created = await storage.steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const retrieved = await storage.steps.get(testRunId, 'step-123');

        expect(retrieved.stepId).toBe(created.stepId);
      });

      it('should throw error for non-existent step', async () => {
        await expect(
          storage.steps.get(testRunId, 'missing-step')
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('update', () => {
      it('should update step status to completed', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step-123', {
          status: 'completed',
          output: ['ok'],
        });

        expect(updated.status).toBe('completed');
        expect(updated.completedAt).toBeInstanceOf(Date);
        expect(updated.output).toEqual(['ok']);
      });

      it('should update attempt count', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step-123', {
          attempt: 2,
        });

        expect(updated.attempt).toBe(2);
      });
    });

    describe('list', () => {
      it('should list all steps for a run', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: [],
        });

        await storage.steps.create(testRunId, {
          stepId: 'step-2',
          stepName: 'second-step',
          input: [],
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
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        const eventData = {
          eventType: 'step_started' as const,
          correlationId: 'corr_123',
        };

        const event = await storage.events.create(testRunId, eventData);

        expect(event.runId).toBe(testRunId);
        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.eventType).toBe('step_started');
        expect(event.correlationId).toBe('corr_123');
        expect(event.createdAt).toBeInstanceOf(Date);
      });

      it('should create a new event with null byte in payload', async () => {
        const event = await storage.events.create(testRunId, {
          eventType: 'step_failed' as const,
          correlationId: 'corr_123',
          eventData: { error: 'Error with null byte \u0000 in message' },
        });

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
          eventType: 'workflow_started' as const,
        });

        await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(2);
      });
    });
  });

  describe('hooks', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new hook', async () => {
        const hookData = {
          hookId: 'hook-123',
          token: 'token-abc',
        };

        const hook = await storage.hooks.create(testRunId, hookData);

        expect(hook.runId).toBe(testRunId);
        expect(hook.hookId).toBe('hook-123');
        expect(hook.token).toBe('token-abc');
        expect(hook.createdAt).toBeInstanceOf(Date);
      });
    });

    describe('list', () => {
      it('should list all hooks for a run', async () => {
        await storage.hooks.create(testRunId, {
          hookId: 'hook-1',
          token: 'token-1',
        });

        await storage.hooks.create(testRunId, {
          hookId: 'hook-2',
          token: 'token-2',
        });

        const result = await storage.hooks.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
      });
    });
  });
});
