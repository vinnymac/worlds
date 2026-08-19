import { setTimeout } from 'node:timers/promises';
import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import { createStorage } from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

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

  /**
   * Helper: create a run via the event-sourced API.
   */
  async function createRun(opts: { deploymentId: string; workflowName: string; input: unknown }) {
    const result = await storage.events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: opts.deploymentId,
        workflowName: opts.workflowName,
        input: opts.input,
      },
    });
    return result.run!;
  }

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

    const hooksTokenSnapshot = await firestore.collection('hooks_by_token').get();
    for (const doc of hooksTokenSnapshot.docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
  }

  beforeAll(async () => {
    // Start Firestore emulator container
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators',
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

      const run = await createRun({
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
      const run = await createRun({
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

      await storage.events.create(run.runId, {
        eventType: 'run_started',
      });
      await setTimeout(100);

      await storage.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: [{ result: 42 }] },
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
      const run = await createRun({
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
        eventType: 'run_started',
      });

      await setTimeout(100);

      // Create step first so step_started/step_completed can find it
      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: { stepName: 'test-step', input: [] },
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

      // run_created (from createRun) + run_started + step_created + step_started + step_completed = 5 events
      expect(events).toHaveLength(5);
      expect(events[0].eventType).toBe('run_created');
      expect(events[1].eventType).toBe('run_started');
      expect(events[2].eventType).toBe('step_created');
      expect(events[3].eventType).toBe('step_started');
      expect(events[4].eventType).toBe('step_completed');
      expect(events[4].eventData).toEqual({ result: 'success' });
    });
  });

  describe('steps subcollection listeners', () => {
    it('should receive real-time updates when steps are created and updated', async () => {
      const run = await createRun({
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

      await storage.events.create(run.runId, {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: {
          stepName: 'test-step',
          input: [],
        },
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
        eventData: { result: ['result'] },
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
      const run1 = await createRun({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-1',
        input: [],
      });

      const run2 = await createRun({
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
        eventData: {
          token: `token-${correlationId}-1`,
        },
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

      await createRun({
        deploymentId: 'deployment-1',
        workflowName: 'unimportant-workflow',
        input: [],
      });

      await setTimeout(100);

      await createRun({
        deploymentId: 'deployment-2',
        workflowName: 'important-workflow',
        input: [],
      });

      await setTimeout(100);

      await createRun({
        deploymentId: 'deployment-3',
        workflowName: 'important-workflow',
        input: [],
      });

      await setTimeout(100);

      // Should only have received updates for the 2 "important-workflow" runs
      expect(updates).toHaveLength(2);
      expect(updates.every((u) => u.workflowName === 'important-workflow')).toBe(true);
    });
  });

  describe('listener error handling', () => {
    it('should handle listener cleanup gracefully', async () => {
      const run = await createRun({
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

      await storage.events.create(run.runId, {
        eventType: 'run_started',
      });
      await setTimeout(100);

      // Unsubscribe before next update
      unsubscribe();
      // Remove from tracking since we're testing cleanup behavior
      unsubscribeFns = unsubscribeFns.filter((fn) => fn !== unsubscribe);

      const updatesBefore = updates.length;

      await storage.events.create(run.runId, {
        eventType: 'run_completed',
        eventData: { output: [{ result: 42 }] },
      });
      await setTimeout(100);

      // Should not have received the completed update
      expect(updates.length).toBe(updatesBefore);
    });
  });

  describe('composite index queries', () => {
    it('should query with multiple filters', async () => {
      await createRun({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-a',
        input: [],
      });

      const run2 = await createRun({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-b',
        input: [],
      });

      await storage.events.create(run2.runId, {
        eventType: 'run_started',
      });

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
      const run = await createRun({
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

        // Create event in same transaction. Events are ordered by eventId
        // (monotonic ULID); use a doc ID that sorts after existing wevt_ ids.
        const eventRef = runRef.collection('events').doc('wevt_zzzzzzzzzzzzzzzzzzzzzzzzzz');
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
      // run_created (from createRun) + workflow_started (from transaction) = 2 events
      expect(events.data).toHaveLength(2);
      expect(events.data[0].eventType).toBe('run_created');
      expect(events.data[1].eventType).toBe('workflow_started');
    });

    it('should rollback transaction on error', async () => {
      const run = await createRun({
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

  describe('streamer', () => {
    async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value));
      }
      return chunks;
    }

    async function writeStream(streamer: ReturnType<typeof createStreamer>, name: string) {
      // Write chunks back-to-back so several land in the same millisecond;
      // the ordering key must not collide (previously it was the truncated
      // ULID ms-timestamp, which deadlocked/skipped same-ms chunks).
      for (let i = 0; i < 10; i++) {
        await streamer.writeToStream(name, 'run-stream-test', `chunk-${i}`);
      }
      await streamer.closeStream(name, 'run-stream-test');
    }

    for (const mode of ['listener', 'polling'] as const) {
      it(`should deliver same-millisecond chunks in order and terminate (${mode})`, async () => {
        const streamer = createStreamer({ firestore, mode, pollIntervalMs: 50 });
        const name = `stream-${mode}-${Date.now()}`;
        await writeStream(streamer, name);

        const chunks = await collectStream(await streamer.readFromStream(name));
        expect(chunks).toEqual(Array.from({ length: 10 }, (_, i) => `chunk-${i}`));
      });

      it(`should honor positive and negative startIndex (${mode})`, async () => {
        const streamer = createStreamer({ firestore, mode, pollIntervalMs: 50 });
        const name = `stream-${mode}-start-${Date.now()}`;
        await writeStream(streamer, name);

        const fromSeven = await collectStream(await streamer.readFromStream(name, 7));
        expect(fromSeven).toEqual(['chunk-7', 'chunk-8', 'chunk-9']);

        const lastThree = await collectStream(await streamer.readFromStream(name, -3));
        expect(lastThree).toEqual(['chunk-7', 'chunk-8', 'chunk-9']);
      });
    }

    it('should stream chunks written after the reader attached (listener)', async () => {
      const streamer = createStreamer({ firestore, mode: 'listener' });
      const name = `stream-live-${Date.now()}`;
      await streamer.writeToStream(name, 'run-stream-test', 'early');

      const collected = collectStream(await streamer.readFromStream(name));
      await setTimeout(300);
      await streamer.writeToStream(name, 'run-stream-test', 'late-1');
      await streamer.writeToStream(name, 'run-stream-test', 'late-2');
      await streamer.closeStream(name, 'run-stream-test');

      expect(await collected).toEqual(['early', 'late-1', 'late-2']);
    });

    it('should report stream info and paginated chunks', async () => {
      const streamer = createStreamer({ firestore });
      const name = `stream-info-${Date.now()}`;

      expect(await streamer.getStreamInfo(name, 'run-stream-test')).toEqual({
        tailIndex: -1,
        done: false,
      });

      await writeStream(streamer, name);

      expect(await streamer.getStreamInfo(name, 'run-stream-test')).toEqual({
        tailIndex: 9,
        done: true,
      });

      const decoder = new TextDecoder();
      const page1 = await streamer.getStreamChunks(name, 'run-stream-test', { limit: 4 });
      expect(page1.data.map((c) => decoder.decode(c.data))).toEqual([
        'chunk-0',
        'chunk-1',
        'chunk-2',
        'chunk-3',
      ]);
      expect(page1.data.map((c) => c.index)).toEqual([0, 1, 2, 3]);
      expect(page1.hasMore).toBe(true);
      expect(page1.done).toBe(false);

      const page2 = await streamer.getStreamChunks(name, 'run-stream-test', {
        limit: 100,
        cursor: page1.cursor ?? undefined,
      });
      expect(page2.data.map((c) => decoder.decode(c.data))).toEqual([
        'chunk-4',
        'chunk-5',
        'chunk-6',
        'chunk-7',
        'chunk-8',
        'chunk-9',
      ]);
      expect(page2.data.map((c) => c.index)).toEqual([4, 5, 6, 7, 8, 9]);
      expect(page2.hasMore).toBe(false);
      expect(page2.done).toBe(true);
    });

    it('should list streams by runId', async () => {
      const streamer = createStreamer({ firestore });
      const runId = `run-list-${Date.now()}`;
      await streamer.writeToStream(`${runId}-stream-a`, runId, 'a');
      await streamer.writeToStream(`${runId}-stream-b`, runId, 'b');

      const streams = await streamer.listStreamsByRunId(runId);
      expect(streams.sort()).toEqual([`${runId}-stream-a`, `${runId}-stream-b`]);
    });
  });
});
