/**
 * Real Cloudflare Workers tests
 * These tests run in the Workers runtime using @cloudflare/vitest-pool-workers
 * and test REAL Durable Objects with SQLite storage
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowRunDO } from '../src/durable-objects/WorkflowRunDO.js';

describe('Real Cloudflare Durable Objects', () => {
  let _runDO: WorkflowRunDO;
  let durableObjectStub: DurableObjectStub;

  beforeEach(() => {
    // Get a DO stub from the test environment
    const id = env.WORKFLOW_DB.idFromName('test-run-id');
    durableObjectStub = env.WORKFLOW_DB.get(id);
  });

  describe('WorkflowRunDO - Real SQLite Storage', () => {
    it('should create and retrieve a workflow run', async () => {
      const runData = {
        runId: 'wrun_test_001',
        workflowName: 'test-workflow',
        input: ['test-input'],
        deploymentId: 'test-deployment',
      };

      // Create run via RPC
      const created = await durableObjectStub.createRun(runData);

      expect(created).toMatchObject({
        runId: runData.runId,
        workflowName: runData.workflowName,
        input: runData.input,
        deploymentId: runData.deploymentId,
        status: 'pending',
      });
      expect(created.createdAt).toBeInstanceOf(Date);

      // Retrieve run via RPC
      const retrieved = await durableObjectStub.getRun();
      expect(retrieved).toMatchObject(created);
    });

    it('should update run status with automatic timestamps', async () => {
      const runData = {
        runId: 'wrun_test_002',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Update to running (should auto-set startedAt)
      const running = await durableObjectStub.updateRun({ status: 'running' });
      expect(running.status).toBe('running');
      expect(running.startedAt).toBeInstanceOf(Date);
      expect(running.completedAt).toBeUndefined();

      // Update to completed (should auto-set completedAt)
      const completed = await durableObjectStub.updateRun({
        status: 'completed',
        output: ['result'],
      });
      expect(completed.status).toBe('completed');
      expect(completed.output).toEqual(['result']);
      expect(completed.completedAt).toBeInstanceOf(Date);
    });

    it('should handle steps with real storage', async () => {
      const runData = {
        runId: 'wrun_test_003',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Create step
      const stepData = {
        runId: runData.runId,
        stepId: 'step-001',
        stepName: 'test-step',
        status: 'pending' as const,
        input: ['step-input'],
        attempt: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        output: undefined,
        error: undefined,
        startedAt: undefined,
        completedAt: undefined,
        retryAfter: undefined,
      };

      const created = await durableObjectStub.createStep(stepData);
      expect(created.stepId).toBe(stepData.stepId);

      // Retrieve step
      const retrieved = await durableObjectStub.getStep('step-001');
      expect(retrieved).toMatchObject({
        stepId: 'step-001',
        stepName: 'test-step',
        status: 'pending',
      });

      // Update step
      const updated = await durableObjectStub.updateStep('step-001', {
        status: 'completed',
        output: ['step-result'],
      });
      expect(updated.status).toBe('completed');
      expect(updated.output).toEqual(['step-result']);
      expect(updated.completedAt).toBeInstanceOf(Date);

      // List steps
      const list = await durableObjectStub.listSteps();
      expect(list.data).toHaveLength(1);
      expect(list.data[0].stepId).toBe('step-001');
    });

    it('should handle events with real storage', async () => {
      const runData = {
        runId: 'wrun_test_004',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Create events
      const event1 = {
        runId: runData.runId,
        eventId: 'evt-001',
        eventType: 'workflow_started',
        createdAt: new Date(),
      };

      const event2 = {
        runId: runData.runId,
        eventId: 'evt-002',
        eventType: 'step_completed',
        correlationId: 'step-001',
        createdAt: new Date(),
      };

      await durableObjectStub.createEvent(event1);
      await durableObjectStub.createEvent(event2);

      // List events
      const list = await durableObjectStub.listEvents();
      expect(list.data).toHaveLength(2);
      expect(list.data[0].eventType).toBe('workflow_started');
      expect(list.data[1].eventType).toBe('step_completed');
    });

    it('should handle hooks with real storage', async () => {
      const runData = {
        runId: 'wrun_test_005',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Create hook
      const hookData = {
        runId: runData.runId,
        hookId: 'hook-001',
        token: 'test-token-123',
        ownerId: 'owner-001',
        projectId: 'project-001',
        environment: 'test',
        createdAt: new Date(),
        metadata: undefined,
      };

      const created = await durableObjectStub.createHook(hookData);
      expect(created.hookId).toBe('hook-001');
      expect(created.token).toBe('test-token-123');

      // List hooks
      const list = await durableObjectStub.listHooks();
      expect(list.data).toHaveLength(1);
      expect(list.data[0].hookId).toBe('hook-001');
    });

    it('should persist data across multiple operations', async () => {
      const runData = {
        runId: 'wrun_test_006',
        workflowName: 'test-workflow',
        input: ['initial'],
        deploymentId: 'test-deployment',
      };

      // Create
      await durableObjectStub.createRun(runData);

      // Update
      await durableObjectStub.updateRun({ status: 'running' });

      // Add steps
      await durableObjectStub.createStep({
        runId: runData.runId,
        stepId: 'step-1',
        stepName: 'first',
        status: 'pending',
        input: [],
        attempt: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        output: undefined,
        error: undefined,
        startedAt: undefined,
        completedAt: undefined,
        retryAfter: undefined,
      });

      // Add events
      await durableObjectStub.createEvent({
        runId: runData.runId,
        eventId: 'evt-1',
        eventType: 'step_started',
        createdAt: new Date(),
      });

      // Verify all persisted
      const run = await durableObjectStub.getRun();
      const steps = await durableObjectStub.listSteps();
      const events = await durableObjectStub.listEvents();

      expect(run?.status).toBe('running');
      expect(steps.data).toHaveLength(1);
      expect(events.data).toHaveLength(1);
    });
  });

  describe('SQLite Storage Characteristics', () => {
    it('should handle rapid successive writes', async () => {
      const runData = {
        runId: 'wrun_test_007',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Create many events rapidly
      const creates = Array.from({ length: 20 }, (_, i) =>
        durableObjectStub.createEvent({
          runId: runData.runId,
          eventId: `evt-${i}`,
          eventType: 'test_event',
          createdAt: new Date(),
        })
      );

      await Promise.all(creates);

      const events = await durableObjectStub.listEvents();
      expect(events.data).toHaveLength(20);
    });

    it('should maintain data consistency', async () => {
      const runData = {
        runId: 'wrun_test_008',
        workflowName: 'test-workflow',
        input: [],
        deploymentId: 'test-deployment',
      };

      await durableObjectStub.createRun(runData);

      // Concurrent updates
      await Promise.all([
        durableObjectStub.createStep({
          runId: runData.runId,
          stepId: 'step-1',
          stepName: 'first',
          status: 'pending',
          input: [],
          attempt: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          output: undefined,
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
          retryAfter: undefined,
        }),
        durableObjectStub.createEvent({
          runId: runData.runId,
          eventId: 'evt-1',
          eventType: 'workflow_started',
          createdAt: new Date(),
        }),
        durableObjectStub.updateRun({ status: 'running' }),
      ]);

      // All should succeed
      const run = await durableObjectStub.getRun();
      const steps = await durableObjectStub.listSteps();
      const events = await durableObjectStub.listEvents();

      expect(run?.status).toBe('running');
      expect(steps.data).toHaveLength(1);
      expect(events.data).toHaveLength(1);
    });
  });

  describe('StreamDO - Real Storage', () => {
    let streamStub: DurableObjectStub;

    beforeEach(() => {
      // Get a StreamDO stub from the test environment
      const id = env.WORKFLOW_STREAMS.idFromName('test-stream-1');
      streamStub = env.WORKFLOW_STREAMS.get(id);
    });

    it('should store and retrieve a single chunk', async () => {
      await streamStub.storeChunk(0, 'Hello, world!');

      const retrieved = await streamStub.getChunk(0);
      expect(retrieved).toBe('Hello, world!');
    });

    it('should store and retrieve multiple chunks in order', async () => {
      await streamStub.storeChunk(0, 'First');
      await streamStub.storeChunk(1, 'Second');
      await streamStub.storeChunk(2, 'Third');

      const chunk0 = await streamStub.getChunk(0);
      const chunk1 = await streamStub.getChunk(1);
      const chunk2 = await streamStub.getChunk(2);

      expect(chunk0).toBe('First');
      expect(chunk1).toBe('Second');
      expect(chunk2).toBe('Third');
    });

    it('should get all chunks in order', async () => {
      await streamStub.storeChunk(0, 'Chunk 0');
      await streamStub.storeChunk(1, 'Chunk 1');
      await streamStub.storeChunk(2, 'Chunk 2');

      const allChunks = await streamStub.getAllChunks();
      expect(allChunks).toHaveLength(3);
      expect(allChunks[0]).toBe('Chunk 0');
      expect(allChunks[1]).toBe('Chunk 1');
      expect(allChunks[2]).toBe('Chunk 2');
    });

    it('should handle non-sequential chunk indices', async () => {
      await streamStub.storeChunk(0, 'First');
      await streamStub.storeChunk(5, 'Sixth');
      await streamStub.storeChunk(10, 'Eleventh');

      const chunk0 = await streamStub.getChunk(0);
      const chunk5 = await streamStub.getChunk(5);
      const chunk10 = await streamStub.getChunk(10);

      expect(chunk0).toBe('First');
      expect(chunk5).toBe('Sixth');
      expect(chunk10).toBe('Eleventh');
    });

    it('should return null for non-existent chunks', async () => {
      const chunk = await streamStub.getChunk(999);
      expect(chunk).toBeNull();
    });

    it('should clear all chunks', async () => {
      await streamStub.storeChunk(0, 'Data 1');
      await streamStub.storeChunk(1, 'Data 2');
      await streamStub.storeChunk(2, 'Data 3');

      // Verify chunks exist
      let allChunks = await streamStub.getAllChunks();
      expect(allChunks).toHaveLength(3);

      // Clear chunks
      await streamStub.clearChunks();

      // Verify chunks are gone
      allChunks = await streamStub.getAllChunks();
      expect(allChunks).toHaveLength(0);

      const chunk0 = await streamStub.getChunk(0);
      expect(chunk0).toBeNull();
    });

    it('should persist data across multiple operations', async () => {
      // Store chunks
      await streamStub.storeChunk(0, 'Persistent 1');
      await streamStub.storeChunk(1, 'Persistent 2');

      // Retrieve to verify
      const chunk0First = await streamStub.getChunk(0);
      expect(chunk0First).toBe('Persistent 1');

      // Store more chunks
      await streamStub.storeChunk(2, 'Persistent 3');

      // Get all chunks to verify persistence
      const allChunks = await streamStub.getAllChunks();
      expect(allChunks).toHaveLength(3);
      expect(allChunks[0]).toBe('Persistent 1');
      expect(allChunks[1]).toBe('Persistent 2');
      expect(allChunks[2]).toBe('Persistent 3');
    });

    it('should handle rapid concurrent chunk writes', async () => {
      // Store many chunks concurrently
      const stores = Array.from({ length: 20 }, (_, i) =>
        streamStub.storeChunk(i, `Chunk ${i}`)
      );

      await Promise.all(stores);

      const allChunks = await streamStub.getAllChunks();
      expect(allChunks).toHaveLength(20);
      expect(allChunks[0]).toBe('Chunk 0');
      expect(allChunks[19]).toBe('Chunk 19');
    });

    it('should overwrite existing chunks at same index', async () => {
      await streamStub.storeChunk(0, 'Original');

      const original = await streamStub.getChunk(0);
      expect(original).toBe('Original');

      // Overwrite
      await streamStub.storeChunk(0, 'Updated');

      const updated = await streamStub.getChunk(0);
      expect(updated).toBe('Updated');
    });

    it('should handle base64-encoded binary data', async () => {
      // Simulate base64-encoded binary data
      const binaryData = Buffer.from([1, 2, 3, 4, 5]).toString('base64');

      await streamStub.storeChunk(0, binaryData);

      const retrieved = await streamStub.getChunk(0);
      expect(retrieved).toBe(binaryData);

      // Verify decoding works
      const decoded = Buffer.from(retrieved as string, 'base64');
      expect(decoded).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    });
  });
});
