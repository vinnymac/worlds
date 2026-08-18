import { setTimeout } from 'node:timers/promises';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import { ulidToDate } from '@workflow/world';
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

      it('should throw WorkflowRunNotFoundError for non-existent run', async () => {
        await expect(storage.runs.get('wrun_missing')).rejects.toSatisfy((error) =>
          WorkflowRunNotFoundError.is(error),
        );
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
        // Upstream contract: steps are created at attempt 0; step_started
        // increments the counter.
        expect(step.attempt).toBe(0);
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

      it('should increment attempt via step_started and reset to pending via step_retrying', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const started = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-123',
        });
        expect(started.step!.attempt).toBe(1);
        expect(started.step!.status).toBe('running');
        expect(started.step!.startedAt).toBeInstanceOf(Date);

        const result = await storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId: 'step-123',
          eventData: {
            error: 'retry error',
          },
        });

        const updated = result.step!;
        // step_retrying records the error and returns to pending; the attempt
        // counter only advances on step_started.
        expect(updated.status).toBe('pending');
        expect(updated.attempt).toBe(1);
        expect(updated.error?.message).toBe('retry error');

        const restarted = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-123',
        });
        expect(restarted.step!.attempt).toBe(2);
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
    it('should reject duplicate step_created events with EntityConflictError', async () => {
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

      // Duplicate step_created (replay scenario): core catches
      // EntityConflictError for this exact case and continues.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      // The original step must be untouched (not reset to a fresh pending step)
      const listResult = await storage.steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      // And only ONE step_created event exists in the log
      const events = await storage.events.list({ runId: run.runId, pagination: {} });
      expect(events.data.filter((e) => e.eventType === 'step_created')).toHaveLength(1);
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

    it('should not create duplicate run_started event on replay', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

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
      const runStartedEvents = eventList.data.filter((e) => e.eventType === 'run_started');
      expect(runStartedEvents).toHaveLength(1);
    });
  });

  describe('Terminal-state guards', () => {
    async function createCompletedRun() {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: ['done'] },
      });
      return run;
    }

    it('should throw RunExpiredError for run_started on a terminal run', async () => {
      const run = await createCompletedRun();

      await expect(
        storage.events.create(run.runId, { eventType: 'run_started' }),
      ).rejects.toSatisfy((error) => RunExpiredError.is(error));

      // The run must NOT be resurrected to running
      const current = await storage.runs.get(run.runId);
      expect(current.status).toBe('completed');
    });

    it('should throw EntityConflictError for terminal transitions on a terminal run', async () => {
      const run = await createCompletedRun();

      await expect(
        storage.events.create(run.runId, {
          eventType: 'run_completed',
          eventData: { output: ['again'] },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      await expect(
        storage.events.create(run.runId, {
          eventType: 'run_failed',
          eventData: { error: 'late failure' },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      await expect(
        storage.events.create(run.runId, { eventType: 'run_cancelled' }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));
    });

    it('should treat run_cancelled as idempotent on an already-cancelled run', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      const result = await storage.events.create(run.runId, { eventType: 'run_cancelled' });
      expect(result.run?.status).toBe('cancelled');
    });

    it('should reject step_created and hook_created on a terminal run', async () => {
      const run = await createCompletedRun();

      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: 'late-step',
          eventData: { stepName: 'late', input: [] },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'late-hook',
          eventData: { token: 'late-token' },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));
    });

    it('should reject step lifecycle events on a terminal step', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: { stepName: 'test-step', input: [] },
      });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-1',
      });
      await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: 'step-1',
        eventData: { result: ['ok'] },
      });

      for (const eventType of ['step_started', 'step_completed', 'step_failed'] as const) {
        await expect(
          storage.events.create(run.runId, {
            eventType,
            correlationId: 'step-1',
            eventData: { result: [], error: 'x', stepName: 'test-step', input: [] },
          }),
        ).rejects.toSatisfy((error) => EntityConflictError.is(error));
      }

      // Step state is untouched
      const step = await storage.steps.get(run.runId, 'step-1');
      expect(step.status).toBe('completed');
      expect(step.output).toEqual(['ok']);
    });

    it('should throw TooEarlyError for step_started before retryAfter', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: { stepName: 'test-step', input: [] },
      });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-1',
      });
      await storage.events.create(run.runId, {
        eventType: 'step_retrying',
        correlationId: 'step-1',
        eventData: {
          error: 'transient',
          retryAfter: new Date(Date.now() + 60_000),
        },
      });

      let caught: unknown;
      try {
        await storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: 'step-1',
        });
      } catch (error) {
        caught = error;
      }
      expect(TooEarlyError.is(caught)).toBe(true);
    });

    it('should throw WorkflowRunNotFoundError for events on a missing run', async () => {
      await expect(
        storage.events.create('wrun_missing', { eventType: 'run_started' }),
      ).rejects.toSatisfy((error) => WorkflowRunNotFoundError.is(error));

      await expect(
        storage.events.create('wrun_missing', {
          eventType: 'run_completed',
          eventData: { output: [] },
        }),
      ).rejects.toSatisfy((error) => WorkflowRunNotFoundError.is(error));
    });
  });

  describe('run_failed error mapping', () => {
    it('should preserve string errors and errorCode', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_started' });

      const result = await storage.events.create(run.runId, {
        eventType: 'run_failed',
        eventData: {
          error: 'plain string failure',
          errorCode: 'MAX_DELIVERIES_EXCEEDED',
        },
      });

      expect(result.run?.status).toBe('failed');
      expect(result.run?.error?.message).toBe('plain string failure');
      expect(result.run?.error?.code).toBe('MAX_DELIVERIES_EXCEEDED');
    });

    it('should preserve string errors on step_failed', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: { stepName: 'test-step', input: [] },
      });

      const result = await storage.events.create(run.runId, {
        eventType: 'step_failed',
        correlationId: 'step-1',
        eventData: { error: 'string step failure', stack: 'at somewhere' },
      });

      expect(result.step?.error?.message).toBe('string step failure');
      expect(result.step?.error?.stack).toBe('at somewhere');
    });
  });

  describe('Hook semantics (4.2.1)', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should resolve hooks by token and by hookId', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: 'token-1', metadata: { kind: 'test' } },
      });

      const byToken = await storage.hooks.getByToken('token-1');
      expect(byToken.hookId).toBe('hook-1');
      expect(byToken.runId).toBe(testRunId);

      const byId = await storage.hooks.get('hook-1');
      expect(byId.token).toBe('token-1');
    });

    it('should reject an exact duplicate hook_created with EntityConflictError', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: 'token-1' },
      });

      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-1',
          eventData: { token: 'token-1' },
        }),
      ).rejects.toSatisfy((error) => EntityConflictError.is(error));

      // The original hook still resolves to the original run
      const hook = await storage.hooks.getByToken('token-1');
      expect(hook.runId).toBe(testRunId);
    });

    it('should record hook_conflict with conflictingRunId when another run holds the token', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: 'shared-token' },
      });

      const otherRun = await createRun({
        deploymentId: 'deployment-456',
        workflowName: 'other-workflow',
        input: [],
      });

      const result = await storage.events.create(otherRun.runId, {
        eventType: 'hook_created',
        correlationId: 'other-hook',
        eventData: { token: 'shared-token' },
      });

      // No hook entity for the thief; a hook_conflict event instead
      expect(result.hook).toBeUndefined();
      expect(result.event?.eventType).toBe('hook_conflict');
      expect(result.event?.eventData).toMatchObject({
        token: 'shared-token',
        conflictingRunId: testRunId,
      });

      // Token still routes to the legitimate holder
      const hook = await storage.hooks.getByToken('shared-token');
      expect(hook.runId).toBe(testRunId);
    });

    it('should release the token on hook_disposed', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: 'token-1' },
      });

      await storage.events.create(testRunId, {
        eventType: 'hook_disposed',
        correlationId: 'hook-1',
      });

      await expect(storage.hooks.getByToken('token-1')).rejects.toSatisfy((error) =>
        HookNotFoundError.is(error),
      );
      await expect(storage.hooks.get('hook-1')).rejects.toSatisfy((error) =>
        HookNotFoundError.is(error),
      );

      // Disposed hooks are no longer listed for the run
      const hooks = await storage.hooks.list({ runId: testRunId });
      expect(hooks.data).toHaveLength(0);
    });

    it('should throw HookNotFoundError when disposing a missing hook', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'missing-hook',
        }),
      ).rejects.toSatisfy((error) => HookNotFoundError.is(error));
    });

    it('should release hook tokens when the run reaches a terminal state', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: 'token-terminal' },
      });
      await storage.events.create(testRunId, { eventType: 'run_started' });
      await storage.events.create(testRunId, {
        eventType: 'run_completed',
        eventData: { output: [] },
      });

      // Token no longer resolves — payload deliveries cannot reach dead runs
      await expect(storage.hooks.getByToken('token-terminal')).rejects.toSatisfy((error) =>
        HookNotFoundError.is(error),
      );
    });
  });

  describe('Resilient start (run_started bootstrap)', () => {
    it('should bootstrap the run from run_started eventData when run_created never landed', async () => {
      const runId = 'wrun_bootstrap_test';

      const result = await storage.events.create(runId, {
        eventType: 'run_started',
        eventData: {
          deploymentId: 'deployment-123',
          workflowName: 'bootstrap-workflow',
          input: ['boot-input'],
        },
      });

      // The bootstrap must return the run entity, already running
      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
      expect(result.run!.status).toBe('running');
      expect(result.run!.input).toEqual(['boot-input']);

      // A synthetic run_created event precedes run_started in the log
      const events = await storage.events.list({
        runId,
        pagination: { sortOrder: 'asc' },
      });
      expect(events.data.map((e) => e.eventType)).toEqual(['run_created', 'run_started']);

      // The run is indexed for list operations
      const listed = await storage.runs.list({ workflowName: 'bootstrap-workflow' });
      expect(listed.data.some((r) => r.runId === runId)).toBe(true);
    });

    it('should preload events on run_started', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      const result = await storage.events.create(run.runId, { eventType: 'run_started' });
      expect(result.events).toBeDefined();
      expect(result.events!.map((e) => e.eventType)).toEqual(['run_created', 'run_started']);
    });
  });

  describe('Pagination', () => {
    it('should paginate events by monotonic eventId without dropping entries', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      for (let i = 0; i < 7; i++) {
        await storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: `step-${i}`,
          eventData: { stepName: `step-${i}`, input: [] },
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await storage.events.list({
          runId: run.runId,
          pagination: { limit: 3, cursor, sortOrder: 'asc' },
        });
        seen.push(...page.data.map((e) => e.eventId));
        pages++;
        if (!page.hasMore) break;
        cursor = page.cursor ?? undefined;
      }

      // run_created + 7 step_created = 8 events over 3 pages, none dropped
      expect(pages).toBe(3);
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
      expect([...seen].sort()).toEqual(seen);
    });

    it('should paginate events in descending order', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      for (let i = 0; i < 4; i++) {
        await storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: `step-${i}`,
          eventData: { stepName: `step-${i}`, input: [] },
        });
      }

      const page1 = await storage.events.list({
        runId: run.runId,
        pagination: { limit: 3, sortOrder: 'desc' },
      });
      expect(page1.data).toHaveLength(3);
      expect(page1.hasMore).toBe(true);

      const page2 = await storage.events.list({
        runId: run.runId,
        pagination: { limit: 3, sortOrder: 'desc', cursor: page1.cursor ?? undefined },
      });
      expect(page2.data).toHaveLength(2);
      expect(page2.hasMore).toBe(false);

      const all = [...page1.data, ...page2.data].map((e) => e.eventId);
      expect(new Set(all).size).toBe(5);
      expect([...all].sort().reverse()).toEqual(all);
    });

    it('should paginate steps with limit and cursor', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      for (let i = 0; i < 5; i++) {
        await storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: `step-${i}`,
          eventData: { stepName: `step-${i}`, input: [] },
        });
      }

      const page1 = await storage.steps.list({ runId: run.runId, pagination: { limit: 2 } });
      expect(page1.data).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await storage.steps.list({
        runId: run.runId,
        pagination: { limit: 2, cursor: page1.cursor ?? undefined },
      });
      const page3 = await storage.steps.list({
        runId: run.runId,
        pagination: { limit: 2, cursor: page2.cursor ?? undefined },
      });

      const all = [...page1.data, ...page2.data, ...page3.data].map((s) => s.stepId);
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5);
    });

    it('should paginate runs.list without dropping a run at page boundaries', async () => {
      for (let i = 0; i < 7; i++) {
        await createRun({
          deploymentId: `deployment-${i}`,
          workflowName: 'paged-workflow',
          input: [],
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await storage.runs.list({
          workflowName: 'paged-workflow',
          pagination: { limit: 3, cursor },
        });
        seen.push(...page.data.map((r) => r.runId));
        if (!page.hasMore) break;
        cursor = page.cursor ?? undefined;
      }

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });

  describe('Optimistic concurrency guard (stateUpdatedAt, world 4.3.1)', () => {
    /** ULID time (epoch ms) of an event id, i.e. the state-marker unit. */
    function eventTime(eventId: string): number {
      const time = ulidToDate(eventId.slice(eventId.lastIndexOf('_') + 1))?.getTime();
      if (time === undefined) throw new Error(`not a decodable event id: ${eventId}`);
      return time;
    }

    /**
     * Drive a run to the point where an externally-originated step_completed
     * has advanced the state marker, and report the marker value.
     */
    async function runWithMarker(): Promise<{ runId: string; marker: number }> {
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'guard-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_started' });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-guard',
        eventData: { stepName: 'guarded', input: [] },
      });
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
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'guard-hook-workflow',
        input: [],
      });
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

      await expect(
        storage.events.create(
          run.runId,
          {
            eventType: 'hook_disposed',
            correlationId: 'hook-guard',
            eventData: {},
          },
          { stateUpdatedAt: marker - 1 },
        ),
      ).rejects.toSatisfy((err) => PreconditionFailedError.is(err));
    });

    it('does not arm the guard from run lifecycle events', async () => {
      // run_created / run_started are created without a snapshot but are NOT
      // externally originated; treating them as such would 412 every replay.
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'guard-lifecycle-workflow',
        input: [],
      });
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
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'max-events-workflow',
        input: [],
      });

      const started = await storage.events.create(run.runId, { eventType: 'run_started' });
      expect(started.maxEvents).toBe(25_000);

      // The runtime reads maxEvents only from run_started, so the replay path
      // (already-running, no new event) must report it too.
      const replay = await storage.events.create(run.runId, { eventType: 'run_started' });
      expect(replay.event).toBeUndefined();
      expect(replay.maxEvents).toBe(25_000);
    });

    it('does not report a ceiling on non-run_started responses', async () => {
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'max-events-scope-workflow',
        input: [],
      });
      const created = await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-max',
        eventData: { stepName: 'x', input: [] },
      });
      expect(created.maxEvents).toBeUndefined();
    });

    it('honors an explicitly configured ceiling', async () => {
      const configured = createStorage({
        env: mockEnv,
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
        createStorage({ env: mockEnv, deploymentId: 'test-deployment', maxEventsPerRun: 0 }),
      ).toThrow(/positive integer/);
    });
  });
});
