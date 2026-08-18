import { setTimeout } from 'node:timers/promises';
import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { PreconditionFailedError } from '@workflow/errors';
import { ulidToDate } from '@workflow/world';
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

      const waitsSnapshot = await doc.ref.collection('waits').get();
      for (const waitDoc of waitsSnapshot.docs) {
        batch.delete(waitDoc.ref);
      }

      // Subcollections outlive their parent document in Firestore, so the
      // optimistic-concurrency marker must be cleared explicitly.
      const metaSnapshot = await doc.ref.collection('meta').get();
      for (const metaDoc of metaSnapshot.docs) {
        batch.delete(metaDoc.ref);
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

      it('should throw WorkflowRunNotFoundError for non-existent run', async () => {
        // Core matches this error by NAME via WorkflowRunNotFoundError.is()
        await expect(storage.runs.get('missing')).rejects.toMatchObject({
          name: 'WorkflowRunNotFoundError',
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

      it('should throw HookNotFoundError for non-existent token', async () => {
        // Core's resume-or-start pattern matches this error by NAME via
        // HookNotFoundError.is()
        await expect(storage.hooks.getByToken('missing-token')).rejects.toMatchObject({
          name: 'HookNotFoundError',
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

      // Duplicate step_created event (replay scenario): the runtime's
      // concurrent-replay catch path swallows EntityConflictError. Appending
      // a second step_created event would diverge replay.
      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: stepId,
          eventData: { stepName: 'test-step', input: ['input1'] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // Verify only one step and one step_created event exist
      const listResult = await storage.steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      const events = await storage.events.list({ runId: run.runId, pagination: {} });
      const stepCreatedEvents = events.data.filter((e) => e.eventType === 'step_created');
      expect(stepCreatedEvents).toHaveLength(1);
    });

    it('should reject duplicate run_created events with EntityConflictError', async () => {
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

      // Duplicate run_created event: core start() treats
      // EntityConflictError as "run already exists" and returns safely.
      await expect(
        storage.events.create(runId, {
          eventType: 'run_created',
          eventData: {
            deploymentId: 'test-deployment',
            workflowName: 'test-workflow-idempotent',
            input: [],
          },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      const listResult = await storage.runs.list({ workflowName: 'test-workflow-idempotent' });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);

      const events = await storage.events.list({ runId, pagination: {} });
      const runCreatedEvents = events.data.filter((e) => e.eventType === 'run_created');
      expect(runCreatedEvents).toHaveLength(1);
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

  describe('Terminal-run guards', () => {
    async function createCancelledRun() {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });
      return run;
    }

    it('should reject step_created on a terminal run', async () => {
      const run = await createCancelledRun();
      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: 'late-step',
          eventData: { stepName: 'late', input: [] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('should reject hook_created on a terminal run (token must not leak)', async () => {
      const run = await createCancelledRun();
      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'late-hook',
          eventData: { token: 'late-token' },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // The token index must not contain an orphaned entry
      await expect(storage.hooks.getByToken('late-token')).rejects.toMatchObject({
        name: 'HookNotFoundError',
      });
    });

    it('should reject step_started on a non-running step of a terminal run with RunExpiredError', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'pending-step',
        eventData: { stepName: 'pending', input: [] },
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: 'pending-step',
        }),
      ).rejects.toMatchObject({ name: 'RunExpiredError' });
    });

    it('should allow step_completed for an in-flight step of a terminal run', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'running-step',
        eventData: { stepName: 'running', input: [] },
      });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'running-step',
      });
      await storage.events.create(run.runId, { eventType: 'run_cancelled' });

      const result = await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: 'running-step',
        eventData: { result: 'done' },
      });
      expect(result.step?.status).toBe('completed');
    });

    it('should reject run transitions out of a terminal state', async () => {
      const run = await createCancelledRun();
      await expect(
        storage.events.create(run.runId, {
          eventType: 'run_completed',
          eventData: { output: [] },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });

      // run_started on a terminal run uses RunExpiredError so the runtime
      // exits without retrying
      await expect(
        storage.events.create(run.runId, { eventType: 'run_started' }),
      ).rejects.toMatchObject({ name: 'RunExpiredError' });
    });

    it('should allow idempotent run_cancelled on an already cancelled run', async () => {
      const run = await createCancelledRun();
      const result = await storage.events.create(run.runId, { eventType: 'run_cancelled' });
      expect(result.run?.status).toBe('cancelled');
    });
  });

  describe('waits', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should create and complete a wait', async () => {
      const created = await storage.events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-1',
        eventData: { resumeAt: new Date(Date.now() + 60_000).toISOString() },
      });
      expect(created.wait).toMatchObject({
        waitId: `${testRunId}-wait-1`,
        runId: testRunId,
        status: 'waiting',
      });

      const completed = await storage.events.create(testRunId, {
        eventType: 'wait_completed',
        correlationId: 'wait-1',
      });
      expect(completed.wait).toMatchObject({ status: 'completed' });
      expect(completed.wait?.completedAt).toBeInstanceOf(Date);
    });

    it('should reject duplicate wait_created with EntityConflictError', async () => {
      await storage.events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-dup',
        eventData: { resumeAt: new Date().toISOString() },
      });
      await expect(
        storage.events.create(testRunId, {
          eventType: 'wait_created',
          correlationId: 'wait-dup',
          eventData: { resumeAt: new Date().toISOString() },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });

    it('should reject duplicate wait_completed with EntityConflictError', async () => {
      await storage.events.create(testRunId, {
        eventType: 'wait_created',
        correlationId: 'wait-race',
        eventData: { resumeAt: new Date().toISOString() },
      });
      await storage.events.create(testRunId, {
        eventType: 'wait_completed',
        correlationId: 'wait-race',
      });
      // wakeUpRun racing natural wake: the loser must get a conflict, not a
      // duplicate wait_completed event
      await expect(
        storage.events.create(testRunId, {
          eventType: 'wait_completed',
          correlationId: 'wait-race',
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('hook existence checks', () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      testRunId = run.runId;
    });

    it('should reject hook_received for a missing hook with HookNotFoundError', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_received',
          correlationId: 'no-such-hook',
        }),
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });

    it('should reject hook_disposed for a missing hook with HookNotFoundError', async () => {
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_disposed',
          correlationId: 'no-such-hook',
        }),
      ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    });

    it('should reject duplicate hook_created with EntityConflictError', async () => {
      await storage.events.create(testRunId, {
        eventType: 'hook_created',
        correlationId: 'hook-dup',
        eventData: { token: 'token-dup' },
      });
      await expect(
        storage.events.create(testRunId, {
          eventType: 'hook_created',
          correlationId: 'hook-dup',
          eventData: { token: 'token-dup' },
        }),
      ).rejects.toMatchObject({ name: 'EntityConflictError' });
    });
  });

  describe('resilient start', () => {
    it('should bootstrap the run from run_started eventData when run_created lost the race', async () => {
      const runId = `wrun_bootstrap_${Date.now()}`;
      const result = await storage.events.create(runId, {
        eventType: 'run_started',
        eventData: {
          deploymentId: 'deployment-boot',
          workflowName: 'bootstrap-workflow',
          input: ['boot-arg'],
        },
      });

      expect(result.run).toBeDefined();
      expect(result.run!.runId).toBe(runId);
      expect(result.run!.status).toBe('running');

      const run = await storage.runs.get(runId);
      expect(run.status).toBe('running');
      expect(run.workflowName).toBe('bootstrap-workflow');
      expect(run.input).toEqual(['boot-arg']);

      // The journal must contain a synthetic run_created BEFORE run_started
      const events = await storage.events.list({ runId, pagination: { sortOrder: 'asc' } });
      expect(events.data.map((e) => e.eventType)).toEqual(['run_created', 'run_started']);
    });

    it('should throw WorkflowRunNotFoundError for run_started without bootstrap data', async () => {
      await expect(
        storage.events.create('wrun_missing_no_bootstrap', { eventType: 'run_started' }),
      ).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' });
    });
  });

  describe('eventId ordering', () => {
    it('should paginate same-millisecond events without skips', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create many events back-to-back (several share a millisecond) —
      // eventId (monotonic ULID) ordering must not skip any of them.
      const total = 10;
      for (let i = 0; i < total; i++) {
        await storage.events.create(run.runId, {
          eventType: 'step_created',
          correlationId: `burst-${i}`,
          eventData: { stepName: `burst-${i}`, input: [] },
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await storage.events.list({
          runId: run.runId,
          pagination: { limit: 3, cursor, sortOrder: 'asc' },
        });
        seen.push(...page.data.map((e) => e.eventId));
        if (!page.hasMore || !page.cursor) break;
        cursor = page.cursor;
      }

      // run_created + 10 step_created
      expect(seen).toHaveLength(total + 1);
      expect(new Set(seen).size).toBe(total + 1);
      expect([...seen].sort()).toEqual(seen);
    });

    it('should paginate listByCorrelationId by eventId in both directions', async () => {
      const run = await createRun({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      const correlationId = 'ordered-step';

      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId,
        eventData: { stepName: 'ordered', input: [] },
      });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId,
      });
      await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId,
        eventData: { result: 'ok' },
      });

      const asc = await storage.events.listByCorrelationId({
        correlationId,
        pagination: { sortOrder: 'asc' },
      });
      expect(asc.data.map((e) => e.eventType)).toEqual([
        'step_created',
        'step_started',
        'step_completed',
      ]);

      const desc = await storage.events.listByCorrelationId({
        correlationId,
        pagination: { sortOrder: 'desc' },
      });
      expect(desc.data.map((e) => e.eventType)).toEqual([
        'step_completed',
        'step_started',
        'step_created',
      ]);

      // Cursor pagination must not skip events
      const page1 = await storage.events.listByCorrelationId({
        correlationId,
        pagination: { limit: 2, sortOrder: 'asc' },
      });
      expect(page1.data).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      const page2 = await storage.events.listByCorrelationId({
        correlationId,
        pagination: { limit: 2, cursor: page1.cursor || undefined, sortOrder: 'asc' },
      });
      expect(page2.data.map((e) => e.eventType)).toEqual(['step_completed']);
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
          { eventType: 'hook_disposed', correlationId: 'hook-guard', eventData: {} },
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
        firestore,
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
        createStorage({ firestore, deploymentId: 'test-deployment', maxEventsPerRun: 0 }),
      ).toThrow(/positive integer/);
    });

    it('propagates run_failed errorCode onto run.error.code', async () => {
      // How the runtime reports MAX_EVENTS_EXCEEDED: the error class does not
      // survive the wire, so eventData.errorCode is the only channel.
      const run = await createRun({
        deploymentId: 'test-deployment',
        workflowName: 'error-code-workflow',
        input: [],
      });
      await storage.events.create(run.runId, { eventType: 'run_started' });
      const failed = await storage.events.create(run.runId, {
        eventType: 'run_failed',
        eventData: {
          error: { message: 'Workflow exceeded the maximum of 10 events per run' },
          errorCode: 'MAX_EVENTS_EXCEEDED',
        },
      });
      expect(failed.run?.error?.code).toBe('MAX_EVENTS_EXCEEDED');
      const reread = await storage.runs.get(run.runId);
      expect(reread.error?.code).toBe('MAX_EVENTS_EXCEEDED');
    });
  });
});
