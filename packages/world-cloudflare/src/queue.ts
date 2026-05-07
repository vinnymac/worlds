import { WorkflowWorldError } from '@workflow/errors';
import type { Queue, ValidQueueName } from '@workflow/world';
import { MessageId } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import { debug } from './util.js';

/**
 * HTTP status codes that indicate permanent (non-retryable) failures.
 * Messages with these errors are acked immediately to avoid wasting retry budget.
 *
 * - 404: Resource not found (e.g., run was deleted)
 * - 409: Conflict (e.g., duplicate event that can't be replayed)
 * - 410: Gone (e.g., run was already terminal)
 * - 422: Unprocessable entity (e.g., invalid payload structure)
 */
const PERMANENT_ERROR_STATUSES = new Set([404, 409, 410, 422]);

/**
 * Determine whether an error is permanent (should not be retried).
 * Permanent errors are acked immediately; transient errors bubble up for retry.
 */
function isPermanentError(err: unknown): boolean {
  if (err instanceof WorkflowWorldError && err.status !== undefined) {
    return PERMANENT_ERROR_STATUSES.has(err.status);
  }
  return false;
}

/**
 * Compute exponential backoff delay in seconds for transient retries.
 * Caps at 60 seconds.
 */
function computeBackoff(attempt: number): number {
  return Math.min(60, 2 ** attempt);
}

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

export function createQueue(config: CloudflareQueueConfig): Queue & { start(): Promise<void> } {
  const { env, deploymentId } = config;

  // Create embedded world for test orchestration (like upstream world-postgres)
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  // Detect test mode
  const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

  const _generateMessageId = monotonicFactory();

  return {
    async queue(queueName, message, opts) {
      // Re-check test mode on each call (for tests that set env after createQueue)
      const currentIsTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
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

      const messageId = MessageId.parse(`msg_${opts?.idempotencyKey || Date.now().toString()}`);

      return { messageId };
    },

    createQueueHandler(queueNamePrefix, handler) {
      if (isTest) {
        // In tests: use embedded world's handler (like upstream)
        return embeddedWorld.createQueueHandler(queueNamePrefix, handler);
      }

      // In production: create Cloudflare Queue handler
      const handlerFn = async (req: Request) => {
        // Extract attempt count from Cloudflare headers (hoisted for use in catch)
        const retryCount = Number.parseInt(req.headers.get('CF-Queue-Retry-Count') || '0', 10);

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

          const attempt = retryCount + 1;

          // Generate or extract message ID
          const messageIdStr =
            req.headers.get('CF-Queue-Message-Id') || `msg_${idempotencyKey || Date.now()}`;

          // Invoke the handler with the message
          await handler(message, {
            attempt,
            queueName: queueName as ValidQueueName,
            messageId: MessageId.parse(messageIdStr),
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          // Differentiate permanent vs. transient failures.
          // Permanent errors (404, 409, 410, 422) are acked to avoid wasting retry budget.
          // Transient errors bubble up so Cloudflare Queues can retry with backoff.
          if (isPermanentError(error)) {
            const status = (error as WorkflowWorldError).status;
            debug('[Cloudflare Queue Handler] Permanent error, acking message:', {
              status,
              error: String(error),
            });
            return new Response(JSON.stringify({ error: String(error), permanent: true }), {
              status: 200, // 200 signals "handled" -- Cloudflare won't retry
            });
          }

          const backoffSeconds = computeBackoff(retryCount);
          debug('[Cloudflare Queue Handler] Transient error, will retry:', {
            error: String(error),
            backoffSeconds,
          });
          return new Response(
            JSON.stringify({
              error: String(error),
              retryAfter: backoffSeconds,
            }),
            {
              status: 500,
              headers: { 'Retry-After': String(backoffSeconds) },
            },
          );
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
