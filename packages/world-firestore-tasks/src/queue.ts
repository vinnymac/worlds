import type { CloudTasksClient } from '@google-cloud/tasks';
import type { Queue } from '@workflow/world';
import { MessageId } from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';

interface CloudTasksConfig {
  client?: CloudTasksClient;
  project: string;
  location: string;
  queueName: string;
  targetUrl: string;
  deploymentId: string;
}

export function createQueue(config: CloudTasksConfig): Queue & {
  start(): Promise<void>;
  processAllQueuedTasks?: () => Promise<void>;
} {
  const { client, project, location, queueName, targetUrl, deploymentId } =
    config;

  // Create embedded world for test orchestration (like world-redis and world-cloudflare)
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  // Detect test mode
  const isTest =
    process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;

  const parent = client?.queuePath(project, location, queueName);

  // Extract createQueueHandler as direct reference (like world-redis pattern)
  // This preserves embedded world's internal state management and handler registry
  const createQueueHandler = isTest
    ? embeddedWorld.createQueueHandler
    : (queueNamePrefix: string, handler: any) => {
        // In production: create Cloud Tasks handler
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
            const attemptStr =
              req.headers.get('X-CloudTasks-TaskExecutionCount') || '0';
            const attempt = Number.parseInt(attemptStr, 10) + 1;

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
        process.env.VITEST === 'true' ||
        process.env.NODE_ENV === 'test' ||
        !client;
      if (currentIsTest) {
        // In tests: forward directly to embedded world for orchestration
        return await embeddedWorld.queue(queueName, message as any, opts);
      }

      // In production: use Cloud Tasks
      const task = {
        httpRequest: {
          url: `${targetUrl}/queue/${queueName}`,
          httpMethod: 'POST' as const,
          headers: {
            'Content-Type': 'application/json',
          },
          body: Buffer.from(JSON.stringify(message)).toString('base64'),
        },
        name: opts?.idempotencyKey
          ? client.taskPath(project, location, queueName, opts.idempotencyKey)
          : undefined,
      };

      const [response] = await client.createTask({
        parent,
        task,
      });

      // Extract task ID from name: projects/PROJECT/locations/LOCATION/queues/QUEUE/tasks/TASK_ID
      const taskId = (response.name || '').split('/').pop() || '';
      const messageId = MessageId.parse(`msg_${taskId}`);

      return { messageId };
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
