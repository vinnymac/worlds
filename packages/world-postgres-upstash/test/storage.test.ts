import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import * as schema from '../src/schema.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from '../src/storage.js';
import { createStreamer } from '../src/streamer.js';

describe('Storage (PostgreSQL integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let db: ReturnType<typeof drizzle>;
  let sql: ReturnType<typeof postgres>;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;
  let streamer: ReturnType<typeof createStreamer>;

  async function truncateTables() {
    await sql`TRUNCATE TABLE workflow_events, workflow_steps, workflow_hooks, workflow_runs, workflow_stream_chunks RESTART IDENTITY CASCADE`;
  }

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    // Apply schema
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // Initialize postgres client and drizzle
    sql = postgres(dbUrl, { max: 1 });
    db = drizzle(sql, { schema }) as any; // Cast to compatible type

    runs = createRunsStorage(db, 'test-deployment');
    steps = createStepsStorage(db);
    events = createEventsStorage(db);
    hooks = createHooksStorage(db, {
      ownerId: 'test-owner',
      projectId: 'test-project',
      environment: 'test',
    });
    streamer = createStreamer(db);
  }, 120_000);

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await sql.end();
    await container.stop();
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

        const run = await runs.create(runData);

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

        const run = await runs.create(runData);

        expect(run.executionContext).toBeUndefined();
        expect(run.input).toEqual([]);
      });
    });

    describe('get', () => {
      it('should retrieve an existing run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: ['arg'],
        });

        const retrieved = await runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe('test-workflow');
        expect(retrieved.input).toEqual(['arg']);
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.get('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update', () => {
      it('should update run status to running', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'running',
        });
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update run status to completed', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'completed',
          output: ['result'],
        });
        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual(['result']);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update run status to failed with error', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const updated = await runs.update(created.runId, {
          status: 'failed',
          error: {
            message: 'Test error',
            stack: 'Error stack trace',
            code: 'TEST_ERROR',
          },
        });
        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Test error');
        expect(updated.error?.code).toBe('TEST_ERROR');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should throw error for non-existent run', async () => {
        await expect(
          runs.update('missing', { status: 'running' })
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'workflow-1',
          input: [],
        });
        await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'workflow-2',
          input: [],
        });
        await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'workflow-1',
          input: [],
        });
      });

      it('should list all runs', async () => {
        const result = await runs.list({});
        expect(result.data).toHaveLength(3);
      });

      it('should filter by workflowName', async () => {
        const result = await runs.list({ workflowName: 'workflow-1' });
        expect(result.data).toHaveLength(2);
        expect(result.data.every((r) => r.workflowName === 'workflow-1')).toBe(
          true
        );
      });

      it('should filter by status', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test',
          input: [],
        });
        await runs.update(created.runId, { status: 'running' });

        const result = await runs.list({ status: 'running' });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe('running');
      });

      it('should support pagination', async () => {
        const page1 = await runs.list({ pagination: { limit: 2 } });
        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBeDefined();

        const page2 = await runs.list({
          pagination: { limit: 2, cursor: page1.cursor as string },
        });
        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });
    });

    describe('cancel', () => {
      it('should cancel a pending run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const cancelled = await runs.cancel(created.runId);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.completedAt).toBeInstanceOf(Date);
      });

      it('should cancel a running run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.update(created.runId, { status: 'running' });

        const cancelled = await runs.cancel(created.runId);
        expect(cancelled.status).toBe('cancelled');
      });

      it('should not cancel an already completed run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.update(created.runId, { status: 'completed' });

        await expect(runs.cancel(created.runId)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('should not cancel an already failed run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.update(created.runId, {
          status: 'failed',
          error: { message: 'Failed' },
        });

        await expect(runs.cancel(created.runId)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('should not cancel an already cancelled run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.cancel(created.runId);

        await expect(runs.cancel(created.runId)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.cancel('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('pause', () => {
      it('should pause a pending run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });

        const paused = await runs.pause(created.runId);
        expect(paused.status).toBe('paused');
      });

      it('should pause a running run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.update(created.runId, { status: 'running' });

        const paused = await runs.pause(created.runId);
        expect(paused.status).toBe('paused');
      });

      it('should not pause an already paused run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.pause(created.runId);

        await expect(runs.pause(created.runId)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('should not pause a completed run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.update(created.runId, { status: 'completed' });

        await expect(runs.pause(created.runId)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.pause('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('resume', () => {
      it('should resume a paused run', async () => {
        const created = await runs.create({
          deploymentId: 'deployment-123',
          workflowName: 'test-workflow',
          input: [],
        });
        await runs.pause(created.runId);

        const resumed = await runs.resume(created.runId);
        expect(resumed.status).toBe('running');
        expect(resumed.startedAt).toBeInstanceOf(Date);
      });

      it('should throw error for non-existent run', async () => {
        await expect(runs.resume('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });
  });

  describe('steps', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      runId = run.runId;
    });

    describe('create', () => {
      it('should create a new step', async () => {
        const step = await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: ['input'],
        });

        expect(step.stepId).toBe('step-1');
        expect(step.runId).toBe(runId);
        expect(step.stepName).toBe('test-step');
        expect(step.status).toBe('pending');
        expect(step.input).toEqual(['input']);
        expect(step.output).toBeUndefined();
        expect(step.error).toBeUndefined();
        expect(step.attempt).toBe(1);
        expect(step.startedAt).toBeUndefined();
        expect(step.completedAt).toBeUndefined();
        expect(step.createdAt).toBeInstanceOf(Date);
        expect(step.updatedAt).toBeInstanceOf(Date);
      });

      it('should return existing step on duplicate creation', async () => {
        const step1 = await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        const step2 = await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        // Should return the existing step (idempotent behavior)
        expect(step2.stepId).toBe(step1.stepId);
        expect(step2.runId).toBe(step1.runId);
        expect(step2.status).toBe(step1.status);
      });
    });

    describe('get', () => {
      it('should retrieve an existing step', async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: ['input'],
        });

        const step = await steps.get(runId, 'step-1');
        expect(step.stepId).toBe('step-1');
        expect(step.stepName).toBe('test-step');
      });

      it('should throw error for non-existent step', async () => {
        await expect(steps.get(runId, 'missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('update', () => {
      it('should update step status to running', async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        const updated = await steps.update(runId, 'step-1', {
          status: 'running',
        });
        expect(updated.status).toBe('running');
        expect(updated.startedAt).toBeInstanceOf(Date);
      });

      it('should update step status to completed', async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        const updated = await steps.update(runId, 'step-1', {
          status: 'completed',
          output: ['result'],
        });
        expect(updated.status).toBe('completed');
        expect(updated.output).toEqual(['result']);
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should update step status to failed with error', async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        const updated = await steps.update(runId, 'step-1', {
          status: 'failed',
          error: {
            message: 'Step failed',
            stack: 'Error stack',
            code: 'STEP_ERROR',
          },
        });
        expect(updated.status).toBe('failed');
        expect(updated.error?.message).toBe('Step failed');
        expect(updated.error?.code).toBe('STEP_ERROR');
        expect(updated.completedAt).toBeInstanceOf(Date);
      });

      it('should increment attempt count', async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'test-step',
          input: [],
        });

        const updated = await steps.update(runId, 'step-1', { attempt: 2 });
        expect(updated.attempt).toBe(2);
      });

      it('should throw error for non-existent step', async () => {
        await expect(
          steps.update(runId, 'missing', { status: 'running' })
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await steps.create(runId, {
          stepId: 'step-1',
          stepName: 'step-1',
          input: [],
        });
        await steps.create(runId, {
          stepId: 'step-2',
          stepName: 'step-2',
          input: [],
        });
        await steps.create(runId, {
          stepId: 'step-3',
          stepName: 'step-3',
          input: [],
        });
      });

      it('should list all steps for a run', async () => {
        const result = await steps.list({ runId });
        expect(result.data).toHaveLength(3);
      });

      it('should support pagination', async () => {
        const page1 = await steps.list({ runId, pagination: { limit: 2 } });
        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await steps.list({
          runId,
          pagination: { limit: 2, cursor: page1.cursor as string },
        });
        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });
    });
  });

  describe('events', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      runId = run.runId;
    });

    describe('create', () => {
      it('should create a new event', async () => {
        const event = await events.create(runId, {
          eventType: 'run.created',
          eventData: { foo: 'bar' },
        });

        expect(event.eventId).toMatch(/^wevt_/);
        expect(event.runId).toBe(runId);
        expect(event.eventType).toBe('run.created');
        expect(event.eventData).toEqual({ foo: 'bar' });
        expect(event.createdAt).toBeInstanceOf(Date);
      });

      it('should create event with correlation ID', async () => {
        const event = await events.create(runId, {
          eventType: 'step.started',
          correlationId: 'correlation-123',
        });

        expect(event.correlationId).toBe('correlation-123');
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await events.create(runId, { eventType: 'run.created' });
        await events.create(runId, { eventType: 'step.started' });
        await events.create(runId, { eventType: 'step.completed' });
      });

      it('should list all events for a run', async () => {
        const result = await events.list({ runId });
        expect(result.data).toHaveLength(3);
      });

      it('should support pagination', async () => {
        const page1 = await events.list({ runId, pagination: { limit: 2 } });
        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await events.list({
          runId,
          pagination: { limit: 2, cursor: page1.cursor as string },
        });
        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });

      it('should support descending order', async () => {
        const result = await events.list({
          runId,
          pagination: { sortOrder: 'desc' },
        });
        expect(result.data[0].eventType).toBe('step.completed');
        expect(result.data[2].eventType).toBe('run.created');
      });
    });

    describe('listByCorrelationId', () => {
      beforeEach(async () => {
        await events.create(runId, {
          eventType: 'step.started',
          correlationId: 'corr-1',
        });
        await events.create(runId, {
          eventType: 'step.completed',
          correlationId: 'corr-1',
        });
        await events.create(runId, {
          eventType: 'step.started',
          correlationId: 'corr-2',
        });
      });

      it('should list events by correlation ID', async () => {
        const result = await events.listByCorrelationId({
          correlationId: 'corr-1',
        });
        expect(result.data).toHaveLength(2);
        expect(result.data.every((e) => e.correlationId === 'corr-1')).toBe(
          true
        );
      });

      it('should support pagination', async () => {
        const page1 = await events.listByCorrelationId({
          correlationId: 'corr-1',
          pagination: { limit: 1 },
        });
        expect(page1.data).toHaveLength(1);
        expect(page1.hasMore).toBe(true);

        const page2 = await events.listByCorrelationId({
          correlationId: 'corr-1',
          pagination: { limit: 1, cursor: page1.cursor as string },
        });
        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });
    });
  });

  describe('hooks', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await runs.create({
        deploymentId: 'deployment-123',
        workflowName: 'test-workflow',
        input: [],
      });
      runId = run.runId;
    });

    describe('create', () => {
      it('should create a new hook', async () => {
        const hook = await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-123',
        });

        expect(hook.hookId).toBe('hook-1');
        expect(hook.runId).toBe(runId);
        expect(hook.token).toBe('token-123');
        expect(hook.ownerId).toBe('test-owner');
        expect(hook.projectId).toBe('test-project');
        expect(hook.environment).toBe('test');
        expect(hook.createdAt).toBeInstanceOf(Date);
      });

      it('should return existing hook on duplicate creation', async () => {
        const hook1 = await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-123',
        });

        const hook2 = await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-456',
        });

        // Should return the existing hook (idempotent behavior)
        expect(hook2.hookId).toBe(hook1.hookId);
        expect(hook2.runId).toBe(hook1.runId);
        expect(hook2.token).toBe(hook1.token); // Original token, not the new one
      });
    });

    describe('get', () => {
      it('should retrieve an existing hook', async () => {
        await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-123',
        });

        const hook = await hooks.get('hook-1');
        expect(hook?.hookId).toBe('hook-1');
        expect(hook?.token).toBe('token-123');
      });

      it('should return undefined for non-existent hook', async () => {
        const hook = await hooks.get('missing');
        expect(hook).toBeUndefined();
      });
    });

    describe('getByToken', () => {
      it('should retrieve hook by token', async () => {
        await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-123',
        });

        const hook = await hooks.getByToken('token-123');
        expect(hook.hookId).toBe('hook-1');
      });

      it('should throw error for non-existent token', async () => {
        await expect(hooks.getByToken('missing')).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-1',
        });
        await hooks.create(runId, {
          hookId: 'hook-2',
          token: 'token-2',
        });
        await hooks.create(runId, {
          hookId: 'hook-3',
          token: 'token-3',
        });
      });

      it('should list all hooks for a run', async () => {
        const result = await hooks.list({ runId });
        expect(result.data).toHaveLength(3);
      });

      it('should support pagination', async () => {
        const page1 = await hooks.list({ runId, pagination: { limit: 2 } });
        expect(page1.data).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await hooks.list({
          runId,
          pagination: { limit: 2, cursor: page1.cursor as string },
        });
        expect(page2.data).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });
    });

    describe('dispose', () => {
      it('should dispose of a hook', async () => {
        await hooks.create(runId, {
          hookId: 'hook-1',
          token: 'token-123',
        });

        await hooks.dispose('hook-1');

        const hook = await hooks.get('hook-1');
        expect(hook).toBeUndefined();
      });

      it('should not throw for non-existent hook', async () => {
        await expect(hooks.dispose('missing')).resolves.toBeUndefined();
      });
    });
  });

  describe('streamer', () => {
    it('should write and read chunks from stream', async () => {
      const streamName = 'test-stream';
      const runIdPromise = Promise.resolve('test-run');

      // Write chunks
      await streamer.writeToStream(streamName, runIdPromise, 'chunk1');
      await streamer.writeToStream(streamName, runIdPromise, 'chunk2');
      await streamer.writeToStream(streamName, runIdPromise, 'chunk3');
      await streamer.closeStream(streamName, runIdPromise);

      // Read chunks
      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const chunks: string[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      } finally {
        reader.releaseLock();
      }

      expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });

    it('should handle binary data', async () => {
      const streamName = 'binary-stream';
      const runIdPromise = Promise.resolve('test-run');
      const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

      await streamer.writeToStream(streamName, runIdPromise, binaryData);
      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const { value } = await reader.read();

      expect(value).toEqual(binaryData);
      reader.releaseLock();
    });

    it('should handle empty stream', async () => {
      const streamName = 'empty-stream';
      const runIdPromise = Promise.resolve('test-run');

      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();
      const { done } = await reader.read();

      expect(done).toBe(true);
      reader.releaseLock();
    });

    it('should support stream cancellation', async () => {
      const streamName = 'cancel-stream';
      const runIdPromise = Promise.resolve('test-run');

      await streamer.writeToStream(streamName, runIdPromise, 'chunk1');
      await streamer.closeStream(streamName, runIdPromise);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      // Read chunk1
      const { value: chunk1, done: done1 } = await reader.read();
      expect(done1).toBe(false);
      expect(new TextDecoder().decode(chunk1)).toBe('chunk1');

      // Read EOF marker
      const { done: done2 } = await reader.read();
      expect(done2).toBe(true);
      reader.releaseLock();
    });
  });
});
