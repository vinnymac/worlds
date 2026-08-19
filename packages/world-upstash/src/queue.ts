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
import { debug, parse, stringify } from './util.js';

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
   * When enabled, `opts.idempotencyKey` (sent by core on every step
   * enqueue) is passed as the deduplication ID, so replayed enqueues of the
   * same logical dispatch are collapsed within QStash's 90-day dedup window.
   * @default true
   */
  enableDeduplication?: boolean;
  /**
   * Number of times QStash redelivers a message whose handler responds with a
   * status outside 200-299 (a hard failure). QStash's own default is small (3
   * on the free plan), well below core's retry budget: core allows up to
   * `MAX_QUEUE_DELIVERIES` (48) total deliveries before marking a run failed.
   * We default to 47 retries (48 total deliveries), so QStash's redelivery
   * budget matches core's expectation and transient failures are not dropped
   * before core would give up.
   *
   * Note: QStash clamps this to the maximum allowed by your plan, so the
   * effective value may be lower on smaller plans.
   * @default 47
   * @see https://upstash.com/docs/qstash/features/retry
   */
  retries?: number;
}

/**
 * Wire format of a QStash queue message body. Serialized with the
 * tagged-JSON codec from `@fantasticfour/shared` so `Uint8Array` payloads
 * (e.g. `runInput.input` for resilient start) survive the queue round-trip.
 */
interface QueueMessageBody {
  queueName: ValidQueueName;
  message: unknown;
  messageId: MessageId;
  /**
   * Number of completed deliveries carried across self-republishes.
   * QStash's `upstash-retried` header resets to 0 on every republish, so the
   * running total lives in the body. The handler reports
   * `deliveryCount + retried + 1` as the 1-based `attempt`, which core caps
   * at MAX_QUEUE_DELIVERIES (48).
   */
  deliveryCount?: number;
}

/**
 * Cap for self-republish delays, matching QStash's smallest plan limit for
 * message delay (7 days). Waking up early is safe: the handler recomputes
 * the remaining time from persistent state and returns another
 * `{ timeoutSeconds }` if the wait is not over.
 */
const MAX_REDELIVERY_DELAY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Default QStash hard-failure retry count. 47 retries = 48 total deliveries,
 * matching core's MAX_QUEUE_DELIVERIES so QStash keeps redelivering right up to
 * (but not past) the point where core gives up on the run.
 */
const DEFAULT_QSTASH_RETRIES = 47;

export function createQueue(config: QStashQueueConfig): Queue {
  const token = config.token || process.env.QSTASH_TOKEN;
  const targetUrl = config.targetUrl || process.env.QSTASH_TARGET_URL;
  const deploymentId =
    config.deploymentId || process.env.WORKFLOW_DEPLOYMENT_ID || 'upstash-default';
  const ulid = monotonicFactory();
  const enableDeduplication = config.enableDeduplication ?? true;
  const retries = config.retries ?? DEFAULT_QSTASH_RETRIES;

  if (!token) {
    throw new Error('QStash token is required. Set QSTASH_TOKEN environment variable.');
  }

  if (!targetUrl) {
    throw new Error('QStash target URL is required. Set QSTASH_TARGET_URL environment variable.');
  }
  // TS does not preserve the narrowing above inside closures; rebind.
  const resolvedTargetUrl: string = targetUrl;

  const client = config.client || new Client({ token });

  async function publishBody(
    body: QueueMessageBody,
    opts: { delaySeconds?: number; deduplicationId?: string; headers?: Record<string, string> },
  ): Promise<void> {
    await client.publish({
      url: resolvedTargetUrl,
      body: stringify(body),
      // Give QStash the same hard-failure redelivery budget core expects.
      retries,
      headers: {
        'Content-Type': 'application/json',
        ...opts.headers,
      },
      ...(opts.delaySeconds ? { delay: opts.delaySeconds } : {}),
      ...(opts.deduplicationId ? { deduplicationId: opts.deduplicationId } : {}),
    });
  }

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

      await publishBody(
        { queueName, message, messageId },
        {
          delaySeconds: opts.delaySeconds,
          headers: opts.headers,
          // Pass core's idempotencyKey through as QStash's deduplicationId.
          // Core re-enqueues pending step messages with idempotencyKey=stepId
          // on every workflow replay and relies on queue-level dedup to
          // prevent the same step from executing concurrently twice.
          ...(enableDeduplication &&
            opts.idempotencyKey && { deduplicationId: opts.idempotencyKey }),
        },
      );

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
          // QStash signature verification
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

          const { queueName, message, messageId, deliveryCount } = parse<QueueMessageBody>(
            await req.text(),
          );

          const retried = Number.parseInt(req.headers.get('upstash-retried') || '0', 10);
          // 1-based delivery counter (matches world-local's
          // x-vqs-message-attempt), carried across self-republishes via the
          // body since upstash-retried resets on each publish.
          const attempt = (deliveryCount ?? 0) + retried + 1;
          const requestId = req.headers.get('x-request-id') || undefined;

          const result = await handler(message, {
            attempt,
            queueName,
            messageId,
            requestId,
          });

          // { timeoutSeconds } is core's retry/sleep signal: the message must
          // be redelivered after the timeout (sleep() waits, step retry
          // backoff, TooEarlyError). Returning a plain 200 would ACK the
          // QStash message permanently and strand the run, so republish the
          // same body with the requested delay before ACKing. Deliberately
          // no deduplicationId here; the redelivery must not be swallowed
          // by QStash dedup. If the republish fails, the thrown error falls
          // through to the 500 below and QStash redelivers this attempt.
          if (result && typeof result.timeoutSeconds === 'number') {
            const timeoutSeconds = Math.min(
              Math.max(0, Math.ceil(result.timeoutSeconds)),
              MAX_REDELIVERY_DELAY_SECONDS,
            );
            await publishBody(
              { queueName, message, messageId, deliveryCount: attempt },
              { delaySeconds: timeoutSeconds },
            );
          }

          return new Response('OK', { status: 200 });
        } catch (error) {
          debug('Queue handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      };
    },
  };
}
