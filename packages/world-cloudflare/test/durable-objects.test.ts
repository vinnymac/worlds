import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../src/storage.js';
import { clearMockData, createMockEnv } from '../src/test-mocks.js';

describe('Cloudflare Durable Objects Features', () => {
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

  describe('Durable Object Isolation', () => {
    it('should isolate data between different run DOs', async () => {
      const run1 = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-1',
        input: ['run1-data'],
      });

      const run2 = await storage.runs.create({
        deploymentId: 'deployment-2',
        workflowName: 'workflow-2',
        input: ['run2-data'],
      });

      // Verify isolation via storage API
      const retrieved1 = await storage.runs.get(run1.runId);
      const retrieved2 = await storage.runs.get(run2.runId);

      expect(retrieved1.runId).not.toBe(retrieved2.runId);
      expect(retrieved1.input).toEqual(['run1-data']);
      expect(retrieved2.input).toEqual(['run2-data']);
    });

    it('should maintain separate DO instances per runId', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create steps in the same DO
      await storage.steps.create(run.runId, {
        stepId: 'step-1',
        stepName: 'first-step',
        input: [],
      });

      await storage.steps.create(run.runId, {
        stepId: 'step-2',
        stepName: 'second-step',
        input: [],
      });

      // All data should be accessible via storage API
      const retrievedRun = await storage.runs.get(run.runId);
      const steps = await storage.steps.list({ runId: run.runId });

      expect(retrievedRun).toBeDefined();
      expect(steps.data).toHaveLength(2);
    });
  });

  describe('Durable Object Persistence', () => {
    it('should persist data across "restarts" (simulated)', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: ['initial-data'],
      });

      const runId = run.runId;

      // Update the run
      await storage.runs.update(runId, { status: 'running' });

      // Simulate "restart" by getting a fresh reference
      const retrievedRun = await storage.runs.get(runId);

      expect(retrievedRun.status).toBe('running');
      expect(retrievedRun.input).toEqual(['initial-data']);
    });

    it('should persist steps across multiple operations', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create step
      await storage.steps.create(run.runId, {
        stepId: 'step-1',
        stepName: 'test-step',
        input: ['data'],
      });

      // Update step
      await storage.steps.update(run.runId, 'step-1', {
        status: 'completed',
        output: ['result'],
      });

      // Retrieve step
      const step = await storage.steps.get(run.runId, 'step-1');

      expect(step.status).toBe('completed');
      expect(step.output).toEqual(['result']);
      expect(step.input).toEqual(['data']);
    });
  });

  describe('KV Indexing for List Operations', () => {
    it('should create KV index entries for runs', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'indexed-workflow',
        input: [],
      });

      // Verify KV index
      const indexKey = `run:indexed-workflow:${run.runId}`;
      const indexValue = await mockEnv.WORKFLOW_INDEX.get(indexKey);

      expect(indexValue).toBeDefined();
      const parsed = JSON.parse(indexValue as string);
      expect(parsed.runId).toBe(run.runId);
      expect(parsed.status).toBe('pending');
    });

    it('should support efficient list queries via KV prefix matching', async () => {
      // Create runs for same workflow
      await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'workflow-a',
        input: [],
      });

      await storage.runs.create({
        deploymentId: 'deployment-2',
        workflowName: 'workflow-a',
        input: [],
      });

      await storage.runs.create({
        deploymentId: 'deployment-3',
        workflowName: 'workflow-b',
        input: [],
      });

      // List via KV prefix
      const result = await mockEnv.WORKFLOW_INDEX.list({
        prefix: 'run:workflow-a:',
      });

      expect(result.keys.length).toBe(2);
      expect(
        result.keys.every((k: any) => k.name.startsWith('run:workflow-a:'))
      ).toBe(true);
    });

    it('should handle KV pagination for large result sets', async () => {
      // Create many runs
      for (let i = 0; i < 15; i++) {
        await storage.runs.create({
          deploymentId: `deployment-${i}`,
          workflowName: 'paginated-workflow',
          input: [],
        });
      }

      // List with limit
      const page1 = await mockEnv.WORKFLOW_INDEX.list({
        prefix: 'run:paginated-workflow:',
        limit: 10,
      });

      expect(page1.keys.length).toBe(10);
      expect(page1.list_complete).toBe(false);
    });
  });

  describe('Durable Object State Management', () => {
    it('should handle concurrent updates to the same DO', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      // Simulate concurrent updates
      const updates = await Promise.all([
        storage.steps.create(run.runId, {
          stepId: 'step-1',
          stepName: 'concurrent-step-1',
          input: [],
        }),
        storage.steps.create(run.runId, {
          stepId: 'step-2',
          stepName: 'concurrent-step-2',
          input: [],
        }),
        storage.events.create(run.runId, {
          eventType: 'workflow_started',
        }),
      ]);

      expect(updates).toHaveLength(3);

      // Verify all updates persisted
      const steps = await storage.steps.list({ runId: run.runId });
      expect(steps.data).toHaveLength(2);

      const events = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });
      expect(events.data).toHaveLength(1);
    });

    it('should maintain consistent state across multiple operations', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      // Series of operations
      await storage.runs.update(run.runId, { status: 'running' });
      await storage.steps.create(run.runId, {
        stepId: 'step-1',
        stepName: 'test-step',
        input: [],
      });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-1',
      });
      await storage.steps.update(run.runId, 'step-1', {
        status: 'completed',
        output: ['result'],
      });
      await storage.runs.update(run.runId, {
        status: 'completed',
        output: [{ final: 'result' }],
      });

      // Verify final state
      const finalRun = await storage.runs.get(run.runId);
      const finalStep = await storage.steps.get(run.runId, 'step-1');
      const events = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });

      expect(finalRun.status).toBe('completed');
      expect(finalRun.output).toEqual([{ final: 'result' }]);
      expect(finalStep.status).toBe('completed');
      expect(finalStep.output).toEqual(['result']);
      expect(events.data).toHaveLength(1);
    });
  });

  describe('Edge-Native Performance Characteristics', () => {
    it('should handle rapid successive reads efficiently', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      const startTime = Date.now();

      // Perform many reads
      const reads = await Promise.all(
        Array.from({ length: 100 }, () => storage.runs.get(run.runId))
      );

      const duration = Date.now() - startTime;

      expect(reads).toHaveLength(100);
      expect(reads.every((r) => r.runId === run.runId)).toBe(true);
      // Should be fast (mock, but validates pattern)
      expect(duration).toBeLessThan(1000);
    });

    it('should handle batch creates efficiently', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      const startTime = Date.now();

      // Create many events
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          storage.events.create(run.runId, {
            eventType: 'step_completed',
            correlationId: `step-${i}`,
            eventData: { index: i },
          })
        )
      );

      const duration = Date.now() - startTime;

      const events = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });

      expect(events.data).toHaveLength(50);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Durable Object ID Generation', () => {
    it('should use deterministic IDs from run names', async () => {
      const run1 = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      const run2 = await storage.runs.create({
        deploymentId: 'deployment-2',
        workflowName: 'test-workflow',
        input: [],
      });

      // Different runs should get different DOs (based on runId)
      expect(run1.runId).not.toBe(run2.runId);

      // Verify runs are isolated via storage API
      const retrieved1 = await storage.runs.get(run1.runId);
      const retrieved2 = await storage.runs.get(run2.runId);

      expect(retrieved1.workflowName).toBe('test-workflow');
      expect(retrieved2.workflowName).toBe('test-workflow');
      expect(retrieved1.deploymentId).not.toBe(retrieved2.deploymentId);
    });

    it('should reuse same DO for same runId', async () => {
      const run = await storage.runs.create({
        deploymentId: 'deployment-1',
        workflowName: 'test-workflow',
        input: [],
      });

      // Multiple operations on same run use same DO
      await storage.steps.create(run.runId, {
        stepId: 'step-1',
        stepName: 'test-step',
        input: [],
      });

      await storage.events.create(run.runId, {
        eventType: 'step_started',
        correlationId: 'step-1',
      });

      // Verify all accessible via storage API
      const retrievedRun = await storage.runs.get(run.runId);
      const steps = await storage.steps.list({ runId: run.runId });
      const events = await storage.events.list({
        runId: run.runId,
        pagination: {},
      });

      expect(retrievedRun).toBeDefined();
      expect(steps.data).toHaveLength(1);
      expect(events.data).toHaveLength(1);
    });
  });

  describe('Error Handling in DO Operations', () => {
    it('should handle DO fetch failures gracefully', async () => {
      // Try to get non-existent run
      await expect(storage.runs.get('wrun_nonexistent')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('should handle invalid DO responses', async () => {
      // Try to update non-existent run
      await expect(
        storage.runs.update('wrun_nonexistent', { status: 'running' })
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
