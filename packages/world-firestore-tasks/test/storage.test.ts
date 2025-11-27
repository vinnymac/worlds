import { setTimeout } from 'node:timers/promises';
import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { createStorage } from '../src/storage.js';

describe('Storage (Firestore integration)', () => {
  // Skip these tests on Windows since it relies on a docker container
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: StartedFirestoreEmulatorContainer;
  let firestore: Firestore;
  let storage: ReturnType<typeof createStorage>;

  async function clearFirestoreData() {
    // Clear workflow_runs collection and its subcollections
    const runsSnapshot = await firestore.collection('workflow_runs').get();
    const batch = firestore.batch();

    for (const doc of runsSnapshot.docs) {
      // Delete subcollections first
      const eventsSnapshot = await doc.ref.collection('events').get();
      for (const eventDoc of eventsSnapshot.docs) {
        batch.delete(eventDoc.ref);
      }

      const stepsSnapshot = await doc.ref.collection('steps').get();
      for (const stepDoc of stepsSnapshot.docs) {
        batch.delete(stepDoc.ref);
      }

      const hooksSnapshot = await doc.ref.collection('hooks').get();
      for (const hookDoc of hooksSnapshot.docs) {
        batch.delete(hookDoc.ref);
      }

      // Delete the run document itself
      batch.delete(doc.ref);
    }

    // Clear hooks_by_token collection
    const hooksTokenSnapshot = await firestore
      .collection('hooks_by_token')
      .get();
    for (const doc of hooksTokenSnapshot.docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
  }

  beforeAll(async () => {
    // Start Firestore emulator container
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators'
    ).start();

    const emulatorHost = container.getEmulatorEndpoint();

    // Initialize Firestore with emulator
    firestore = new Firestore({
      projectId: 'test-project',
      host: emulatorHost,
      ssl: false,
      customHeaders: {
        Authorization: 'Bearer owner',
      },
    });

    // Required for handling discriminated unions with optional fields
    firestore.settings({
      ignoreUndefinedProperties: true,
    });

    storage = createStorage({
      firestore,
      deploymentId: 'test-deployment',
    });
  }, 120_000);

  beforeEach(async () => {
    await clearFirestoreData();
  });

  afterAll(async () => {
    await firestore.terminate();
    if (container) {
      await container.stop();
    }
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
        await expect(storage.runs.get('missing')).rejects.toMatchObject({
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

      it('should throw error for non-existent run', async () => {
        await expect(
          storage.runs.update('missing', { status: 'running' })
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      it('should list all runs', async () => {
        const run1 = await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps
        await setTimeout(5);

        const run2 = await storage.runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list({});

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThan(
          result.data[1].createdAt.getTime()
        );
      });

      it('should filter runs by workflowName', async () => {
        await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await storage.runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should filter runs by status', async () => {
        const run1 = await storage.runs.create({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await storage.runs.update(run1.runId, { status: 'running' });

        await storage.runs.create({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list({ status: 'running' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run1.runId);
        expect(result.data[0].status).toBe('running');
      });

      it('should support pagination', async () => {
        // Create multiple runs
        for (let i = 0; i < 5; i++) {
          await storage.runs.create({
            deploymentId: `deployment-${i}`,
            workflowName: `workflow-${i}`,
            input: [],
          });
          // Small delay to ensure different timestamps
          await setTimeout(2);
        }

        const page1 = await storage.runs.list({
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.runs.list({
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].runId).not.toBe(page1.data[0].runId);
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
        expect(step.startedAt).toBeUndefined();
        expect(step.completedAt).toBeUndefined();
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
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
      it('should update step status to running', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step-123', {
          status: 'running',
        });

        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

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

      it('should update step status to failed', async () => {
        await storage.steps.create(testRunId, {
          stepId: 'step-123',
          stepName: 'test-step',
          input: ['input1'],
        });

        const updated = await storage.steps.update(testRunId, 'step-123', {
          status: 'failed',
          error: {
            message: 'Step failed',
            code: 'STEP_ERR',
          },
        });

        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.error?.code).toBe('STEP_ERR');
        expect(updated.completedAt).toBeInstanceOf(Date);
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
        const step1 = await storage.steps.create(testRunId, {
          stepId: 'step-1',
          stepName: 'first-step',
          input: [],
        });

        await setTimeout(5);

        const step2 = await storage.steps.create(testRunId, {
          stepId: 'step-2',
          stepName: 'second-step',
          input: [],
        });

        const result = await storage.steps.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
        // Should be in descending order
        expect(result.data[0].stepId).toBe(step2.stepId);
        expect(result.data[1].stepId).toBe(step1.stepId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create multiple steps
        for (let i = 0; i < 5; i++) {
          await storage.steps.create(testRunId, {
            stepId: `step-${i}`,
            stepName: `step-name-${i}`,
            input: [],
          });
          await setTimeout(2);
        }

        const page1 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.steps.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].stepId).not.toBe(page1.data[0].stepId);
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

      it('should handle workflow completed events', async () => {
        const eventData = {
          eventType: 'workflow_completed' as const,
        };

        const event = await storage.events.create(testRunId, eventData);

        expect(event.eventType).toBe('workflow_completed');
        expect(event.correlationId).toBeUndefined();
      });
    });

    describe('list', () => {
      it('should list all events for a run in ascending order', async () => {
        const event1 = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        await setTimeout(5);

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        expect(result.data).toHaveLength(2);
        // Should be in chronological order (oldest first)
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[0].createdAt.getTime()
        );
      });

      it('should list events in descending order when explicitly requested', async () => {
        const event1 = await storage.events.create(testRunId, {
          eventType: 'workflow_started' as const,
        });

        await setTimeout(5);

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_started' as const,
          correlationId: 'corr-step-1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'desc' },
        });

        expect(result.data).toHaveLength(2);
        // Should be in reverse chronological order (newest first)
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
      });

      it('should support pagination', async () => {
        // Create multiple events
        for (let i = 0; i < 5; i++) {
          await storage.events.create(testRunId, {
            eventType: 'step_completed',
            correlationId: `corr_${i}`,
            eventData: { result: i },
          });
          await setTimeout(2);
        }

        const page1 = await storage.events.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.events.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].eventId).not.toBe(page1.data[0].eventId);
      });
    });

    describe('listByCorrelationId', () => {
      it('should list all events with a specific correlation ID', async () => {
        const correlationId = 'step-abc123';

        const event1 = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        // Create events with different correlation IDs (should be filtered out)
        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'different-step',
        });
        await storage.events.create(testRunId, {
          eventType: 'workflow_completed',
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[0].correlationId).toBe(correlationId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].correlationId).toBe(correlationId);
      });

      it('should list events across multiple runs with same correlation ID', async () => {
        const correlationId = 'hook-xyz789';

        // Create another run
        const run2 = await storage.runs.create({
          deploymentId: 'deployment-456',
          workflowName: 'test-workflow-2',
          input: [],
        });

        const event1 = await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId,
        });

        await setTimeout(5);

        const event2 = await storage.events.create(run2.runId, {
          eventType: 'hook_received',
          correlationId,
          eventData: { payload: { data: 'test' } },
        });

        await setTimeout(5);

        const event3 = await storage.events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId,
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventId).toBe(event1.eventId);
        expect(result.data[0].runId).toBe(testRunId);
        expect(result.data[1].eventId).toBe(event2.eventId);
        expect(result.data[1].runId).toBe(run2.runId);
        expect(result.data[2].eventId).toBe(event3.eventId);
        expect(result.data[2].runId).toBe(testRunId);
      });

      it('should return empty list for non-existent correlation ID', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'existing-step',
        });

        const result = await storage.events.listByCorrelationId({
          correlationId: 'non-existent-correlation-id',
          pagination: {},
        });

        expect(result.data).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.cursor).toBeNull();
      });

      it('should support pagination', async () => {
        const correlationId = 'step_paginated';

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId,
          eventData: { attempt: 1 },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const page1 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });

      it('should support descending order', async () => {
        const correlationId = 'step-desc-order';

        const event1 = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        const event2 = await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { sortOrder: 'desc' },
        });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].eventId).toBe(event2.eventId);
        expect(result.data[1].eventId).toBe(event1.eventId);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime()
        );
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

    describe('getByToken', () => {
      it('should retrieve a hook by token', async () => {
        await storage.hooks.create(testRunId, {
          hookId: 'hook-123',
          token: 'token-xyz',
        });

        const hook = await storage.hooks.getByToken('token-xyz');

        expect(hook.hookId).toBe('hook-123');
        expect(hook.token).toBe('token-xyz');
        expect(hook.runId).toBe(testRunId);
      });

      it('should throw error for non-existent token', async () => {
        await expect(
          storage.hooks.getByToken('missing-token')
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      it('should list all hooks for a run', async () => {
        const hook1 = await storage.hooks.create(testRunId, {
          hookId: 'hook-1',
          token: 'token-1',
        });

        await setTimeout(5);

        const hook2 = await storage.hooks.create(testRunId, {
          hookId: 'hook-2',
          token: 'token-2',
        });

        const result = await storage.hooks.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
        // Should be in descending order
        expect(result.data[0].hookId).toBe(hook2.hookId);
        expect(result.data[1].hookId).toBe(hook1.hookId);
      });

      it('should support pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await storage.hooks.create(testRunId, {
            hookId: `hook-${i}`,
            token: `token-${i}`,
          });
          await setTimeout(2);
        }

        const page1 = await storage.hooks.list({
          runId: testRunId,
          pagination: { limit: 2 },
        });

        expect(page1.data).toHaveLength(2);
        expect(page1.cursor).not.toBeNull();

        const page2 = await storage.hooks.list({
          runId: testRunId,
          pagination: { limit: 2, cursor: page1.cursor || undefined },
        });

        expect(page2.data).toHaveLength(2);
        expect(page2.data[0].hookId).not.toBe(page1.data[0].hookId);
      });
    });
  });
});
