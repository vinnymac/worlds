import type { Firestore } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import type { Queue } from '@workflow/world';
import { MessageId } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { debug } from './util.js';

interface CloudTasksConfig {
  client?: CloudTasksClient;
  firestore?: Firestore;
  project: string;
  location: string;
  queueName: string;
  targetUrl: string;
  deploymentId: string;
}

/**
 * Sanitize a string for use as a Cloud Tasks task name.
 * Cloud Tasks names allow [a-zA-Z0-9_-] up to 500 chars.
 */
function sanitizeTaskName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 500);
}

/**
 * Check if a Cloud Tasks error is an ALREADY_EXISTS (duplicate task name) error.
 * This occurs when a task with the same name was created within the dedup window.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const error = err as { code?: number; message?: string };
    // gRPC status code 6 = ALREADY_EXISTS
    return error.code === 6 || (error.message?.includes('ALREADY_EXISTS') ?? false);
  }
  return false;
}

export function createQueue(config: CloudTasksConfig): Queue & {
  start(): Promise<void>;
  processAllQueuedTasks?: () => Promise<void>;
} {
  const { client, firestore, project, location, queueName, targetUrl, deploymentId } = config;

  // Create embedded world for test orchestration (like world-redis and world-cloudflare)
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  // Detect test mode
  const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;

  const parent = client?.queuePath(project, location, queueName);

  // Extract createQueueHandler as direct reference (like world-redis pattern)
  // This preserves embedded world's internal state management and handler registry
  const createQueueHandler = isTest
    ? embeddedWorld.createQueueHandler
    : (queueNamePrefix: string, handler: any) => {
        // In production: create Cloud Tasks handler with at-least-once delivery protection.
        // Cloud Tasks may deliver the same task twice on ack timeout; we use a
        // "processed_tasks" Firestore collection as an idempotency gate.
        return async (req: Request) => {
          try {
            const url = new URL(req.url);
            const queueName = url.pathname.split('/').pop() as
              | `__wkf_workflow_${string}`
              | `__wkf_step_${string}`;

            if (!queueName.startsWith(queueNamePrefix)) {
              return new Response('Invalid queue', { status: 400 });
            }

            const message = await req.json();

            // Cloud Tasks sends task info in headers
            const taskName = req.headers.get('X-CloudTasks-TaskName') || '';
            const taskId = taskName.split('/').pop() || Date.now().toString();
            const attemptStr = req.headers.get('X-CloudTasks-TaskExecutionCount') || '0';
            const attempt = Number.parseInt(attemptStr, 10) + 1;

            // Idempotent consumer: check if this task was already processed.
            // Uses a Firestore transaction to atomically mark the task as processed,
            // preventing duplicate execution from at-least-once delivery.
            if (firestore && taskName) {
              const wasProcessed = await firestore.runTransaction(async (tx) => {
                const ref = firestore.collection('processed_tasks').doc(sanitizeTaskName(taskId));
                const snap = await tx.get(ref);
                if (snap.exists) return true;

                tx.set(ref, {
                  taskName,
                  processedAt: new Date(),
                });
                return false;
              });

              if (wasProcessed) {
                debug('duplicate task delivery, ignoring', { taskName, taskId });
                return new Response('OK', { status: 200 });
              }
            }

            await handler(message, {
              attempt,
              queueName,
              messageId: MessageId.parse(`msg_${taskId}`),
            });

            return new Response('OK', { status: 200 });
          } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), {
              status: 500,
            });
          }
        };
      };

  return {
    async queue(queueName, message, opts) {
      // Re-check test mode on each call (for tests that set env after createQueue)
      const currentIsTest =
        process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;
      if (currentIsTest) {
        // In tests: forward directly to embedded world for orchestration
        return await embeddedWorld.queue(queueName, message as any, opts);
      }

      // In production: use Cloud Tasks
      // Use sanitized idempotency key as task name for dedup (Cloud Tasks rejects
      // duplicate names with ALREADY_EXISTS within ~1 hour of task completion)
      const sanitizedKey = opts?.idempotencyKey ? sanitizeTaskName(opts.idempotencyKey) : undefined;
      const task = {
        httpRequest: {
          url: `${targetUrl}/queue/${queueName}`,
          httpMethod: 'POST' as const,
          headers: {
            'Content-Type': 'application/json',
          },
          body: Buffer.from(JSON.stringify(message)).toString('base64'),
        },
        name: sanitizedKey
          ? client.taskPath(project, location, queueName, sanitizedKey)
          : undefined,
      };

      try {
        const [response] = await client.createTask({
          parent,
          task,
        });

        // Extract task ID from name: projects/PROJECT/locations/LOCATION/queues/QUEUE/tasks/TASK_ID
        const taskId = (response.name || '').split('/').pop() || '';
        const messageId = MessageId.parse(`msg_${taskId}`);

        return { messageId };
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          // Duplicate task name — dedup hit, return the idempotency key as message ID
          debug('duplicate task name (dedup hit)', { idempotencyKey: opts?.idempotencyKey });
          const messageId = MessageId.parse(`msg_${sanitizedKey || 'dedup'}`);
          return { messageId };
        }
        throw err;
      }
    },

    createQueueHandler,

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTest && embeddedWorld.start) {
        // In test mode: start embedded world's HTTP server
        await embeddedWorld.start();
      }
      // In production: Cloud Tasks is push-based, no polling needed
    },
  };
}
