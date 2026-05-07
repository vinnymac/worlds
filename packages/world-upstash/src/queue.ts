import type {
  MessageId,
  Queue,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  ValidQueueName,
} from '@workflow/world';
import { Client, Receiver } from '@upstash/qstash';
import { monotonicFactory } from 'ulid';
import { debug } from './util.js';

interface QStashQueueConfig {
  client?: Client;
  token?: string;
  targetUrl?: string;
  deploymentId?: string;
  /**
   * QStash signing keys for signature verification on incoming deliveries.
   * When provided, the queue handler will reject unsigned or improperly signed requests.
   * @see https://upstash.com/docs/qstash/howto/signing
   */
  currentSigningKey?: string;
  nextSigningKey?: string;
  /**
   * Enable QStash deduplication via `deduplicationId` on publish.
   * When enabled, the generated `messageId` is passed as the deduplication ID,
   * giving free idempotency within QStash's 90-day dedup window.
   * @default true
   */
  enableDeduplication?: boolean;
}

export function createQueue(config: QStashQueueConfig): Queue {
  const token = config.token || process.env.QSTASH_TOKEN;
  const targetUrl = config.targetUrl || process.env.QSTASH_TARGET_URL;
  const deploymentId =
    config.deploymentId || process.env.WORKFLOW_DEPLOYMENT_ID || 'upstash-default';
  const ulid = monotonicFactory();
  const enableDeduplication = config.enableDeduplication ?? true;

  if (!token) {
    throw new Error('QStash token is required. Set QSTASH_TOKEN environment variable.');
  }

  if (!targetUrl) {
    throw new Error('QStash target URL is required. Set QSTASH_TARGET_URL environment variable.');
  }

  const client = config.client || new Client({ token });

  // Build Receiver for signature verification if signing keys are provided
  const currentSigningKey = config.currentSigningKey || process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = config.nextSigningKey || process.env.QSTASH_NEXT_SIGNING_KEY;

  const receiver =
    currentSigningKey || nextSigningKey
      ? new Receiver({
          currentSigningKey: currentSigningKey ?? '',
          nextSigningKey: nextSigningKey ?? '',
        })
      : null;

  return {
    async getDeploymentId(): Promise<string> {
      return deploymentId;
    },

    async queue(
      queueName: ValidQueueName,
      message: QueuePayload,
      opts: QueueOptions = {},
    ): Promise<{ messageId: MessageId | null }> {
      const messageId = `wmsg_${ulid()}` as MessageId;

      await client.publishJSON({
        url: targetUrl,
        body: {
          queueName,
          message,
          messageId,
        },
        ...(opts.delaySeconds && { delay: opts.delaySeconds }),
        ...(opts.headers && { headers: opts.headers }),
        // Enhancement 3: QStash deduplication via deduplicationId
        ...(enableDeduplication && { deduplicationId: messageId }),
      });

      return { messageId };
    },

    createQueueHandler(
      _queueNamePrefix: QueuePrefix,
      handler: (
        message: unknown,
        meta: {
          attempt: number;
          queueName: ValidQueueName;
          messageId: MessageId;
          requestId?: string;
        },
      ) => Promise<void | { timeoutSeconds: number }>,
    ): (req: Request) => Promise<Response> {
      return async (req: Request): Promise<Response> => {
        try {
          // Enhancement 2: QStash signature verification
          if (receiver) {
            const body = await req.clone().text();
            const signature = req.headers.get('upstash-signature');

            if (!signature) {
              debug('Queue handler rejected: missing upstash-signature header');
              return new Response('Missing signature', { status: 401 });
            }

            try {
              const isValid = await receiver.verify({
                signature,
                body,
                url: req.url,
              });
              if (!isValid) {
                debug('Queue handler rejected: invalid signature');
                return new Response('Invalid signature', { status: 401 });
              }
            } catch (err) {
              debug('Queue handler rejected: signature verification failed', err);
              return new Response('Signature verification failed', { status: 401 });
            }
          }

          const body = await req.json();
          const { queueName, message, messageId } = body as {
            queueName: ValidQueueName;
            message: unknown;
            messageId: MessageId;
          };

          const attempt = Number.parseInt(req.headers.get('upstash-retried') || '0', 10);
          const requestId = req.headers.get('x-request-id') || undefined;

          await handler(message, {
            attempt,
            queueName,
            messageId,
            requestId,
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          debug('Queue handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      };
    },
  };
}
