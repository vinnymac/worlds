import type { Queue, ValidQueueName } from '@workflow/world';
import { MessageId } from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';

export interface CloudflareQueueConfig {
  env: {
    WORKFLOW_QUEUE: CloudflareQueue;
  };
  deploymentId: string;
}

interface CloudflareQueue {
  send(message: unknown, options?: { contentType?: string }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

export function createQueue(
  config: CloudflareQueueConfig
): Queue & { start(): Promise<void> } {
  const { env, deploymentId } = config;

  // Create embedded world for test orchestration (like upstream world-postgres)
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  // Detect test mode
  const isTest =
    process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

  const _generateMessageId = monotonicFactory();

  return {
    async queue(queueName, message, opts) {
      // Re-check test mode on each call (for tests that set env after createQueue)
      const currentIsTest =
        process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
      if (currentIsTest) {
        // In tests: forward directly to embedded world for orchestration
        return await embeddedWorld.queue(queueName, message as any, opts);
      }

      // In production: use Cloudflare Queue
      const wrappedMessage = {
        queueName,
        message,
        idempotencyKey: opts?.idempotencyKey,
        timestamp: Date.now(),
      };

      await env.WORKFLOW_QUEUE.send(wrappedMessage);

      const messageId = MessageId.parse(
        `msg_${opts?.idempotencyKey || Date.now().toString()}`
      );

      return { messageId };
    },

    createQueueHandler(queueNamePrefix, handler) {
      if (isTest) {
        // In tests: use embedded world's handler (like upstream)
        return embeddedWorld.createQueueHandler(queueNamePrefix, handler);
      }

      // In production: create Cloudflare Queue handler
      const handlerFn = async (req: Request) => {
        try {
          const body = (await req.json()) as unknown;

          // Validate message structure
          if (
            typeof body !== 'object' ||
            body === null ||
            !('queueName' in body) ||
            !('message' in body)
          ) {
            return new Response('Invalid message format', { status: 400 });
          }

          interface QueueMessage {
            queueName: string;
            message: unknown;
            idempotencyKey?: string;
          }

          const { queueName, message, idempotencyKey } = body as QueueMessage;

          // Validate queue name prefix
          if (!queueName?.startsWith(queueNamePrefix)) {
            return new Response('Invalid queue', { status: 400 });
          }

          // Extract attempt count from Cloudflare headers
          const attemptStr = req.headers.get('CF-Queue-Retry-Count') || '0';
          const attempt = Number.parseInt(attemptStr, 10) + 1;

          // Generate or extract message ID
          const messageIdStr =
            req.headers.get('CF-Queue-Message-Id') ||
            `msg_${idempotencyKey || Date.now()}`;

          // Invoke the handler with the message
          await handler(message, {
            attempt,
            queueName: queueName as ValidQueueName,
            messageId: MessageId.parse(messageIdStr),
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          console.error('[Cloudflare Queue Handler] Error:', error);
          return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
          });
        }
      };

      return handlerFn;
    },

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTest && embeddedWorld.start) {
        // In test mode: start embedded world's HTTP server
        await embeddedWorld.start();
      }
      // In production: Cloudflare Queues is push-based, no polling needed
    },
  };
}
