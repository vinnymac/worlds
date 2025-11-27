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

describe('Firestore Real-time Listeners', () => {
  // Skip these tests on Windows since it relies on a docker container
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: StartedFirestoreEmulatorContainer;
  let firestore: Firestore;
  let storage: ReturnType<typeof createStorage>;
  let unsubscribeFns: (() => void)[] = [];

  async function clearFirestoreData() {
    const runsSnapshot = await firestore.collection('workflow_runs').get();
    const batch = firestore.batch();

    for (const doc of runsSnapshot.docs) {
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

      batch.delete(doc.ref);
    }

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
    // Clean up all listeners from previous test FIRST
    for (const unsubscribe of unsubscribeFns) {
      unsubscribe();
    }
    unsubscribeFns = [];
    // Wait for listeners to fully detach before clearing data
    await setTimeout(500);
    // Now clear data
    await clearFirestoreData();
    // Wait for Firestore emulator to propagate deletes
    await setTimeout(500);
  });

  afterEach(async () => {
    // Clean up listeners immediately after each test
    for (const unsubscribe of unsubscribeFns) {
      unsubscribe();
    }
    unsubscribeFns = [];
    // Wait for cleanup to complete
    await setTimeout(500);
  });

  afterAll(async () => {
    await firestore.terminate();
    if (container) {
      await container.stop();
    }
  });

  describe('run document listeners', () => {
    it('should receive real-time updates when a run is created', async () => {
      const updates: any[] = [];
      // Use unique workflow name to avoid seeing runs from other tests
      const uniqueWorkflowName = `test-workflow-${Date.now()}`;

      const unsubscribe = firestore
        .collection('workflow_runs')
        .where('workflowName', '==', uniqueWorkflowName)
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              updates.push({ type: 'added', data: change.doc.data() });
            }
          });
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: uniqueWorkflowName,
        input: [],
      });

      // Wait for listener to fire
      await setTimeout(100);

      expect(updates).toHaveLength(1);
      expect(updates[0].type).toBe('added');
      expect(updates[0].data.runId).toBe(run.runId);
      expect(updates[0].data.workflowName).toBe(uniqueWorkflowName);
    });

    it('should receive real-time updates when a run is modified', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      const updates: any[] = [];

      const unsubscribe = firestore
        .collection('workflow_runs')
        .doc(run.runId)
        .onSnapshot((doc) => {
          if (doc.exists) {
            updates.push(doc.data());
          }
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      await storage.runs.update(run.runId, { status: 'running' });
      await setTimeout(100);

      await storage.runs.update(run.runId, {
        status: 'completed',
        output: [{ result: 42 }],
      });
      await setTimeout(100);

      // Should have received at least 2 updates (running + completed)
      expect(updates.length).toBeGreaterThanOrEqual(2);

      const runningUpdate = updates.find((u) => u.status === 'running');
      expect(runningUpdate).toBeDefined();

      const completedUpdate = updates.find((u) => u.status === 'completed');
      expect(completedUpdate).toBeDefined();
      expect(completedUpdate?.output).toEqual([{ result: 42 }]);
    });
  });

  describe('events subcollection listeners', () => {
    it('should receive real-time updates when events are added', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      const events: any[] = [];

      const unsubscribe = firestore
        .collection('workflow_runs')
        .doc(run.runId)
        .collection('events')
        .orderBy('createdAt', 'asc')
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              events.push(change.doc.data());
            }
          });
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      await storage.events.create(run.runId, {
        eventType: 'workflow_started',
      });

      await setTimeout(100);

      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-1',
      });

      await setTimeout(100);

      await storage.events.create(run.runId, {
        eventType: 'step_completed',
        correlationId: 'step-1',
        eventData: { result: 'success' },
      });

      await setTimeout(100);

      expect(events).toHaveLength(3);
      expect(events[0].eventType).toBe('workflow_started');
      expect(events[1].eventType).toBe('step_started');
      expect(events[2].eventType).toBe('step_completed');
      expect(events[2].eventData).toEqual({ result: 'success' });
    });
  });

  describe('steps subcollection listeners', () => {
    it('should receive real-time updates when steps are created and updated', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      const stepUpdates: any[] = [];

      const unsubscribe = firestore
        .collection('workflow_runs')
        .doc(run.runId)
        .collection('steps')
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            stepUpdates.push({
              type: change.type,
              stepId: change.doc.data().stepId,
              status: change.doc.data().status,
            });
          });
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      await storage.steps.create(run.runId, {
        stepId: 'step-1',
        stepName: 'test-step',
        input: [],
      });

      await setTimeout(100);

      await storage.steps.update(run.runId, 'step-1', { status: 'running' });

      await setTimeout(100);

      await storage.steps.update(run.runId, 'step-1', {
        status: 'completed',
        output: ['result'],
      });

      await setTimeout(100);

      // Should have received: 1 added, 2 modified
      const added = stepUpdates.filter((u) => u.type === 'added');
      const modified = stepUpdates.filter((u) => u.type === 'modified');

      expect(added).toHaveLength(1);
      expect(added[0].status).toBe('pending');

      expect(modified.length).toBeGreaterThanOrEqual(2);
      expect(modified.some((u) => u.status === 'running')).toBe(true);
      expect(modified.some((u) => u.status === 'completed')).toBe(true);
    });
  });

  describe('collection group queries with listeners', () => {
    it('should listen to events across all runs using collection group', async () => {
      const run1 = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-1',
        input: [],
      });

      const run2 = await storage.runs.create({
        deploymentId: 'deployment-2',
        workflowName: 'workflow-2',
        input: [],
      });

      const allEvents: any[] = [];
      // Use unique correlationId per test run to prevent cross-test contamination
      const correlationId = `global-hook-123-${Date.now()}`;

      const unsubscribe = firestore
        .collectionGroup('events')
        .where('correlationId', '==', correlationId)
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              allEvents.push({
                runId: change.doc.data().runId,
                eventType: change.doc.data().eventType,
              });
            }
          });
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      await storage.events.create(run1.runId, {
        eventType: 'hook_created',
        correlationId,
      });

      await setTimeout(100);

      await storage.events.create(run2.runId, {
        eventType: 'hook_received',
        correlationId,
      });

      await setTimeout(100);

      await storage.events.create(run1.runId, {
        eventType: 'hook_disposed',
        correlationId,
      });

      await setTimeout(100);

      expect(allEvents).toHaveLength(3);
      expect(allEvents[0].runId).toBe(run1.runId);
      expect(allEvents[0].eventType).toBe('hook_created');
      expect(allEvents[1].runId).toBe(run2.runId);
      expect(allEvents[1].eventType).toBe('hook_received');
      expect(allEvents[2].runId).toBe(run1.runId);
      expect(allEvents[2].eventType).toBe('hook_disposed');
    });
  });

  describe('query filtering with real-time updates', () => {
    it('should only receive updates for filtered runs', async () => {
      const updates: any[] = [];

      const unsubscribe = firestore
        .collection('workflow_runs')
        .where('workflowName', '==', 'important-workflow')
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              updates.push(change.doc.data());
            }
          });
        });
      unsubscribeFns.push(unsubscribe);

      // Small delay to ensure listener is established
      await setTimeout(100);

      await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'unimportant-workflow',
        input: [],
      });

      await setTimeout(100);

      await storage.runs.create({
        deploymentId: 'deployment-2',
        workflowName: 'important-workflow',
        input: [],
      });

      await setTimeout(100);

      await storage.runs.create({
        deploymentId: 'deployment-3',
        workflowName: 'important-workflow',
        input: [],
      });

      await setTimeout(100);

      // Should only have received updates for the 2 "important-workflow" runs
      expect(updates).toHaveLength(2);
      expect(
        updates.every((u) => u.workflowName === 'important-workflow')
      ).toBe(true);
    });
  });

  describe('listener error handling', () => {
    it('should handle listener cleanup gracefully', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      const updates: any[] = [];

      const unsubscribe = firestore
        .collection('workflow_runs')
        .doc(run.runId)
        .onSnapshot((doc) => {
          if (doc.exists) {
            updates.push(doc.data());
          }
        });
      unsubscribeFns.push(unsubscribe);

      await setTimeout(100);

      await storage.runs.update(run.runId, { status: 'running' });
      await setTimeout(100);

      // Unsubscribe before next update
      unsubscribe();
      // Remove from tracking since we're testing cleanup behavior
      unsubscribeFns = unsubscribeFns.filter((fn) => fn !== unsubscribe);

      const updatesBefore = updates.length;

      await storage.runs.update(run.runId, {
        status: 'completed',
        output: [{ result: 42 }],
      });
      await setTimeout(100);

      // Should not have received the completed update
      expect(updates.length).toBe(updatesBefore);
    });
  });

  describe('composite index queries', () => {
    it('should query with multiple filters', async () => {
      await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-a',
        input: [],
      });

      const run2 = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-b',
        input: [],
      });

      await storage.runs.update(run2.runId, { status: 'running' });

      // Query with both workflowName and status filters
      const snapshot = await firestore
        .collection('workflow_runs')
        .where('workflowName', '==', 'workflow-b')
        .where('status', '==', 'running')
        .get();

      expect(snapshot.docs).toHaveLength(1);
      expect(snapshot.docs[0].data().runId).toBe(run2.runId);
    });
  });

  describe('transaction guarantees', () => {
    it('should ensure atomic updates across documents', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      // Use Firestore transaction for atomic update
      await firestore.runTransaction(async (transaction) => {
        const runRef = firestore.collection('workflow_runs').doc(run.runId);
        const runDoc = await transaction.get(runRef);

        if (!runDoc.exists) {
          throw new Error('Run not found');
        }

        // Update run status
        transaction.update(runRef, {
          status: 'running',
          updatedAt: new Date(),
        });

        // Create event in same transaction
        const eventRef = runRef.collection('events').doc();
        transaction.set(eventRef, {
          runId: run.runId,
          eventId: eventRef.id,
          eventType: 'workflow_started',
          createdAt: new Date(),
        });
      });

      // Verify both updates succeeded
      const updatedRun = await storage.runs.get(run.runId);
      expect(updatedRun.status).toBe('running');

      const events = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });
      expect(events.data).toHaveLength(1);
      expect(events.data[0].eventType).toBe('workflow_started');
    });

    it('should rollback transaction on error', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });

      try {
        await firestore.runTransaction(async (transaction) => {
          const runRef = firestore.collection('workflow_runs').doc(run.runId);

          transaction.update(runRef, {
            status: 'running',
            updatedAt: new Date(),
          });

          // Intentionally throw error to test rollback
          throw new Error('Intentional error for rollback test');
        });
      } catch (error: any) {
        expect(error.message).toBe('Intentional error for rollback test');
      }

      // Verify status was NOT updated (transaction rolled back)
      const unchangedRun = await storage.runs.get(run.runId);
      expect(unchangedRun.status).toBe('pending');
    });
  });
});
