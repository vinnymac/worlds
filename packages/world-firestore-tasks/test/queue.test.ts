import { stringify } from '@fantasticfour/shared';
import { Firestore } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFirestoreTasksWorld } from '../src/index.js';
import { createQueue } from '../src/queue.js';

type CreateTaskRequest = Parameters<CloudTasksClient['createTask']>[0];

const createTask = vi.fn(async (_request: CreateTaskRequest) => [{ name: 'tasks/t1' }]);
const client = {
  createTask,
  queuePath: vi.fn(() => 'queue-path'),
  taskPath: vi.fn(() => 'task-path'),
} as unknown as CloudTasksClient;

const baseConfig = {
  client,
  project: 'p',
  location: 'l',
  queueName: 'q',
  targetUrl: 'https://example.test',
  deploymentId: 'd',
};

async function createBothTasks(dispatchDeadlineMs: number | undefined) {
  const queue = createQueue({ ...baseConfig, dispatchDeadlineMs });
  await queue.queue('__wkf_workflow_w', { runId: 'wrun_1' });
  const handler = queue.createQueueHandler('__wkf_workflow_', async () => ({ timeoutSeconds: 5 }));
  const response = await handler(
    new Request('https://example.test/queue/__wkf_workflow_w', {
      method: 'POST',
      body: stringify({ runId: 'wrun_1' }),
    }),
  );
  expect(response.status).toBe(200);
  return createTask.mock.calls.map(([request]) => request.task?.dispatchDeadline);
}

describe('createQueue dispatchDeadlineMs', () => {
  beforeEach(() => {
    // Leave test mode so both production createTask sites run.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    createTask.mockClear();
  });

  test.each([
    { dispatchDeadlineMs: undefined, expected: undefined },
    { dispatchDeadlineMs: 15_000, expected: { seconds: 15, nanos: 0 } },
    { dispatchDeadlineMs: 1_234_567, expected: { seconds: 1234, nanos: 567_000_000 } },
    { dispatchDeadlineMs: 1_800_000, expected: { seconds: 1800, nanos: 0 } },
  ])(
    'applies $dispatchDeadlineMs to every created task',
    async ({ dispatchDeadlineMs, expected }) => {
      const deadlines = await createBothTasks(dispatchDeadlineMs);
      expect(deadlines).toEqual([expected, expected]);
    },
  );

  test('createFirestoreTasksWorld passes it through', async () => {
    const world = createFirestoreTasksWorld({
      firestore: new Firestore({ projectId: 'p' }),
      tasksClient: client,
      dispatchDeadlineMs: 900_000,
    });
    await world.queue('__wkf_workflow_w', { runId: 'wrun_1' });
    expect(createTask.mock.calls[0]?.[0].task?.dispatchDeadline).toEqual({
      seconds: 900,
      nanos: 0,
    });
    expect(() => createFirestoreTasksWorld({ tasksClient: client, dispatchDeadlineMs: 0 })).toThrow(
      RangeError,
    );
  });

  test.each([14_999, 1_800_001, Number.NaN, Number.POSITIVE_INFINITY, 20_000.5])(
    'throws at construction for %s',
    (dispatchDeadlineMs) => {
      expect(() => createQueue({ ...baseConfig, dispatchDeadlineMs })).toThrow(RangeError);
    },
  );
});
