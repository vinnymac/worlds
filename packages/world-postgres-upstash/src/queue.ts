import { Client } from '@upstash/qstash';
import { MessageId, type Queue } from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';

export interface QStashConfig {
  token: string;
  targetUrl: string;
}

export function createQueue(
  config: QStashConfig,
  deploymentId: string
): Queue & { start(): Promise<void> } {
  // Create embedded world for test orchestration
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  // Detect test mode - use embedded world when token is not set or in test environment
  const isTest =
    process.env.VITEST === 'true' ||
    process.env.NODE_ENV === 'test' ||
    !config.token ||
    config.token ===
      'eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=';

  const client = isTest ? undefined : new Client({ token: config.token });

  // Use embedded world's queue and handler in test mode
  const createQueueHandler = isTest
    ? embeddedWorld.createQueueHandler
    : (queueNamePrefix: string, handler: any) => {
        // In production: create QStash handler
        return async (req: Request) => {
          const url = new URL(req.url);
          const queueName = url.pathname.split('/').pop() as
            | `__wkf_workflow_${string}`
            | `__wkf_step_${string}`;

          if (!queueName.startsWith(queueNamePrefix)) {
            return new Response('Invalid queue', { status: 400 });
          }

          try {
            const message = await req.json();
            const rawId = req.headers.get('Upstash-Message-Id') || 'unknown';
            await handler(message, {
              attempt: 1,
              queueName,
              messageId: MessageId.parse(`msg_${rawId}`),
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
    queue: isTest
      ? async (queueName, message, opts) => {
          // In test mode: forward directly to embedded world for orchestration
          // The embedded world handles idempotency internally
          return embeddedWorld.queue(queueName, message, opts);
        }
      : async (queueName, message, opts) => {
          // Production: use QStash with built-in deduplication
          if (!client) {
            throw new Error('QStash client not initialized');
          }
          const response = await client.publishJSON({
            url: `${config.targetUrl}/queue/${queueName}`,
            body: message,
            retries: 3,
            deduplicationId: opts?.idempotencyKey,
          });

          // QStash returns an object with messageId, extract and parse as branded type
          const rawId =
            typeof response === 'string' ? response : response.messageId;
          const messageId = MessageId.parse(`msg_${rawId}`);

          return { messageId };
        },

    createQueueHandler,

    getDeploymentId: async () => deploymentId,

    start: async () => {
      // In test mode: start embedded world
      // In production: QStash is push-based, no polling needed
      if (isTest && embeddedWorld.start) {
        await embeddedWorld.start();
      }
    },
  };
}
