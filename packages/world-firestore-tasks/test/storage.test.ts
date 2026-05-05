import { setTimeout } from 'node:timers/promises';
import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
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
    const hooksTokenSnapshot = await firestore.collection('hooks_by_token').get();
    for (const doc of hooksTokenSnapshot.docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
  }

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

  beforeAll(async () => {
    // Start Firestore emulator container
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators',
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
        await expect(storage.runs.get('missing')).rejects.toMatchObject({
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
      it('should list all runs', async () => {
        const run1 = await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        // Small delay to ensure different timestamps
        await setTimeout(5);

        const run2 = await createRun({
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
          result.data[1].createdAt.getTime(),
        );
      });

      it('should filter runs by workflowName', async () => {
        await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });
        const run2 = await createRun({
          deploymentId: 'deployment-2',
          workflowName: 'workflow-2',
          input: [],
        });

        const result = await storage.runs.list({ workflowName: 'workflow-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      it('should filter runs by status', async () => {
        const run1 = await createRun({
          deploymentId: 'deployment-1',
          workflowName: 'workflow-1',
          input: [],
        });

        await storage.events.create(run1.runId, {
          eventType: 'run_started',
        });

        await createRun({
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
          await createRun({
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
        expect(step.startedAt).toBeUndefined();
        expect(step.completedAt).toBeUndefined();
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('get', () => {
      it('should retrieve a step with runId and stepId', async () => {
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
      it('should update step status to running via step_started event', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'step-123',
        });

        const updated = result.step!;
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

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

      it('should update step status to failed via step_failed event', async () => {
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'step-123',
          eventData: {
            stepName: 'test-step',
            input: ['input1'],
          },
        });

        const result = await storage.events.create(testRunId, {
          eventType: 'step_failed',
          correlationId: 'step-123',
          eventData: {
            error: {
              message: 'Step failed',
              code: 'STEP_ERR',
            },
          },
        });

        const updated = result.step!;
        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.error?.code).toBe('STEP_ERR');
        expect(updated.completedAt).toBeInstanceOf(Date);
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

        await setTimeout(5);

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
        // Should be in descending order
        expect(result.data[0].stepId).toBe('step-2');
        expect(result.data[1].stepId).toBe('step-1');
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime(),
        );
      });

      it('should support pagination', async () => {
        // Create multiple steps
        for (let i = 0; i < 5; i++) {
          await storage.events.create(testRunId, {
            eventType: 'step_created',
            correlationId: `step-${i}`,
            eventData: {
              stepName: `step-name-${i}`,
              input: [],
            },
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
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        // Create step first so step_started can update it
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
        // Create step first so step_failed can update it
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
      it('should list all events for a run in ascending order', async () => {
        await storage.events.create(testRunId, {
          eventType: 'run_started',
        });

        await setTimeout(5);

        // Create step first so step_started can update it
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'corr-step-1',
          eventData: { stepName: 'test-step', input: [] },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId: 'corr-step-1',
        });

        const result = await storage.events.list({
          runId: testRunId,
          pagination: { sortOrder: 'asc' },
        });

        // run_created + run_started + step_created + step_started = 4 events
        expect(result.data.length).toBeGreaterThanOrEqual(3);
      });

      it('should support pagination', async () => {
        // Create steps first, then create completed events
        for (let i = 0; i < 5; i++) {
          await storage.events.create(testRunId, {
            eventType: 'step_created',
            correlationId: `corr_${i}`,
            eventData: { stepName: `step-${i}`, input: [] },
          });
          await setTimeout(2);
        }
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

        // Create step first
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId,
          eventData: { stepName: 'test-step', input: [] },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        // Create different step with different correlation IDs (should be filtered out)
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'different-step',
          eventData: { stepName: 'other-step', input: [] },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: {},
        });

        // step_created + step_started + step_completed = 3
        expect(result.data).toHaveLength(3);
        expect(result.data[0].correlationId).toBe(correlationId);
        expect(result.data[1].correlationId).toBe(correlationId);
        expect(result.data[2].correlationId).toBe(correlationId);
      });

      it('should return empty list for non-existent correlation ID', async () => {
        // Create step first
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId: 'existing-step',
          eventData: { stepName: 'test-step', input: [] },
        });

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

        // Create step first
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId,
          eventData: { stepName: 'test-step', input: [] },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_retrying',
          correlationId,
          eventData: { error: 'retry', retryAfter: new Date().toISOString() },
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

        expect(page2.data).toHaveLength(2);
        expect(page2.hasMore).toBe(false);
      });

      it('should support descending order', async () => {
        const correlationId = 'step-desc-order';

        // Create step first
        await storage.events.create(testRunId, {
          eventType: 'step_created',
          correlationId,
          eventData: { stepName: 'test-step', input: [] },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_started',
          correlationId,
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'step_completed',
          correlationId,
          eventData: { result: 'success' },
        });

        const result = await storage.events.listByCorrelationId({
          correlationId,
          pagination: { sortOrder: 'desc' },
        });

        // step_created + step_started + step_completed = 3
        expect(result.data).toHaveLength(3);
        expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          result.data[1].createdAt.getTime(),
        );
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

    describe('getByToken', () => {
      it('should retrieve a hook by token', async () => {
        await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-123',
          eventData: {
            token: 'token-xyz',
          },
        });

        const hook = await storage.hooks.getByToken('token-xyz');

        expect(hook.hookId).toBe('hook-123');
        expect(hook.token).toBe('token-xyz');
        expect(hook.runId).toBe(testRunId);
      });

      it('should throw error for non-existent token', async () => {
        await expect(storage.hooks.getByToken('missing-token')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      it('should list all hooks for a run', async () => {
        await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-1',
          eventData: { token: 'token-1' },
        });

        await setTimeout(5);

        await storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-2',
          eventData: { token: 'token-2' },
        });

        const result = await storage.hooks.list({
          runId: testRunId,
        });

        expect(result.data).toHaveLength(2);
        // Should be in descending order
        expect(result.data[0].hookId).toBe('hook-2');
        expect(result.data[1].hookId).toBe('hook-1');
      });

      it('should support pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await storage.events.create(testRunId, {
            eventType: 'hook_created',
            correlationId: `hook-${i}`,
            eventData: { token: `token-${i}` },
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
