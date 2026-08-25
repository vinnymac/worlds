import type {
  MessageId,
  Queue,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  ValidQueueName,
} from '@workflow/world';
import { parseQueueName } from '@workflow/world';
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
  /**
   * Queue transport. `'qstash'` (default) publishes via hosted QStash.
   * `'loopback'` delivers in-process by POSTing the QStash wire body straight
   * to the target app's flow/step routes (for tests and local development,
   * where hosted QStash cannot reach the app). Also selectable via
   * `WORKFLOW_UPSTASH_QUEUE_MODE=loopback`.
   */
  queueMode?: 'qstash' | 'loopback';
  /**
   * Max concurrent in-flight deliveries for the `'loopback'` transport.
   * @see {@link UpstashWorldConfig.loopbackConcurrency} for the rationale.
   * @default 10
   */
  loopbackConcurrency?: number;
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
   * Number of *failed* deliveries carried across self-republishes.
   * QStash's `upstash-retried` header resets to 0 on every republish, so the
   * running total lives in the body. The handler reports
   * `deliveryCount + retried + 1` as the 1-based `attempt`, which core caps
   * at MAX_QUEUE_DELIVERIES (48).
   *
   * Only hard failures (non-2xx responses, which QStash redelivers) count
   * here. A `{ timeoutSeconds }` republish deliberately does not increment
   * it; see {@link QueueMessageBody.republishCount}.
   */
  deliveryCount?: number;
  /**
   * Number of `{ timeoutSeconds }` self-republishes performed so far.
   *
   * These are core's *control-flow* re-invocations, not failed deliveries:
   * `sleep()`, step retry backoff, `TooEarlyError`, and `{ timeoutSeconds: 0 }`
   * ("re-invoke me with a fresh replay", which core returns whenever the
   * `stateUpdatedAt` precondition guard exhausts its reloads). Counting them
   * against `deliveryCount` would let a run that merely suspends often exhaust
   * core's MAX_QUEUE_DELIVERIES budget and be killed as a runaway, so they are
   * tracked separately and bounded only by {@link MAX_SOFT_REPUBLISHES}.
   */
  republishCount?: number;
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

/**
 * Safety ceiling on consecutive `{ timeoutSeconds }` self-republishes for a
 * single message, mirroring world-local's `MAX_LOCAL_SAFETY_LIMIT`.
 *
 * Soft republishes are legitimate control flow and must not consume core's
 * delivery budget, but an unbounded soft loop would spin a run forever. Set
 * comfortably above MAX_QUEUE_DELIVERIES (48) so it only trips on a genuine
 * runaway; exceeding it fails the delivery loudly (500) rather than silently
 * stranding the message, which hands the run back to the hard-failure path
 * where core's own cap applies.
 */
const MAX_SOFT_REPUBLISHES = 256;

/** @see {@link UpstashWorldConfig.loopbackConcurrency} */
const DEFAULT_LOOPBACK_CONCURRENCY = 10;

/** Simple counting semaphore bounding concurrent loopback deliveries. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

export function createQueue(config: QStashQueueConfig): Queue {
  const queueMode =
    config.queueMode ??
    (process.env.WORKFLOW_UPSTASH_QUEUE_MODE === 'loopback' ? 'loopback' : 'qstash');
  const token = config.token || process.env.QSTASH_TOKEN;
  const targetUrl = config.targetUrl || process.env.QSTASH_TARGET_URL;
  const deploymentId =
    config.deploymentId || process.env.WORKFLOW_DEPLOYMENT_ID || 'upstash-default';
  const ulid = monotonicFactory();
  const enableDeduplication = config.enableDeduplication ?? true;
  const retries = config.retries ?? DEFAULT_QSTASH_RETRIES;

  if (queueMode === 'qstash' && !token) {
    throw new Error('QStash token is required. Set QSTASH_TOKEN environment variable.');
  }

  if (queueMode === 'qstash' && !targetUrl) {
    throw new Error('QStash target URL is required. Set QSTASH_TARGET_URL environment variable.');
  }

  const client = queueMode === 'qstash' ? config.client || new Client({ token: token! }) : null;

  /** Loopback delivery target, resolved lazily per publish: the
   * world-testing harness binds its port (and sets `process.env.PORT`) only
   * after the server is listening, which is after the world is created. */
  function loopbackUrl(queueName: ValidQueueName): string {
    const base = targetUrl ?? `http://localhost:${process.env.PORT ?? '3000'}`;
    const { kind } = parseQueueName(queueName);
    const pathname = kind === 'step' ? 'step' : 'flow';
    return `${base.replace(/\/$/, '')}/.well-known/workflow/v1/${pathname}`;
  }

  /** deduplicationIds the loopback pump has accepted; mirrors the
   * QStash-side dedup core relies on to collapse replayed step enqueues. */
  const loopbackDeliveredDedupIds = new Set<string>();

  /** Loopback hard-failure budget: QStash redelivers on non-2xx; the pump
   * mirrors that with a short linear backoff, sized for tests. */
  const LOOPBACK_MAX_DELIVERIES = 5;
  const LOOPBACK_RETRY_DELAY_MS = 1_000;

  /** Bounds concurrent loopback deliveries; see {@link QStashQueueConfig.loopbackConcurrency}. */
  const loopbackSemaphore = new Semaphore(
    config.loopbackConcurrency ?? DEFAULT_LOOPBACK_CONCURRENCY,
  );

  /** Fire-and-forget delivery of the QStash wire body to the target app,
   * honouring the publish delay and reporting the redelivery count via the
   * `upstash-retried` header exactly as QStash would. */
  function scheduleLoopbackDelivery(
    body: QueueMessageBody,
    opts: { delaySeconds?: number; headers?: Record<string, string>; deduplicationId?: string },
  ): void {
    const payload = stringify(body);
    void (async () => {
      if (opts.delaySeconds) {
        await new Promise((resolve) => setTimeout(resolve, opts.delaySeconds! * 1000));
      }
      // Self-POSTs have no natural throttle the way real QStash round trips
      // do, so an immediate `{ timeoutSeconds: 0 }` republish loop would
      // otherwise fire unboundedly many concurrent requests.
      await loopbackSemaphore.acquire();
      try {
        for (let attempt = 0; attempt < LOOPBACK_MAX_DELIVERIES; attempt++) {
          try {
            const res = await fetch(loopbackUrl(body.queueName), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'upstash-retried': String(attempt),
                ...opts.headers,
              },
              body: payload,
            });
            if (res.ok) return;
            debug(`loopback delivery got ${res.status} for ${body.messageId}`);
          } catch (err) {
            debug('loopback delivery failed', err);
          }
          await new Promise((resolve) => setTimeout(resolve, LOOPBACK_RETRY_DELAY_MS));
        }
        // Release the dedup reservation before giving up. The pump has
        // dropped this message for good, so leaving the key in place would
        // silently swallow core's next re-enqueue of the same step and wedge
        // the run forever (world-redis releases its reservation on final
        // drop for the same reason).
        if (opts.deduplicationId) {
          loopbackDeliveredDedupIds.delete(opts.deduplicationId);
        }
        // Crash loudly in logs rather than stranding the run silently.
        console.error(
          `[world-upstash] loopback delivery permanently failed for message ${body.messageId}`,
        );
      } finally {
        loopbackSemaphore.release();
      }
    })();
  }

  async function publishBody(
    body: QueueMessageBody,
    opts: { delaySeconds?: number; deduplicationId?: string; headers?: Record<string, string> },
  ): Promise<void> {
    if (queueMode === 'loopback') {
      if (opts.deduplicationId) {
        if (loopbackDeliveredDedupIds.has(opts.deduplicationId)) return;
        loopbackDeliveredDedupIds.add(opts.deduplicationId);
      }
      scheduleLoopbackDelivery(body, opts);
      return;
    }
    await client!.publish({
      url: targetUrl!,
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

          const { queueName, message, messageId, deliveryCount, republishCount } =
            parse<QueueMessageBody>(await req.text());

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
            const republishes = (republishCount ?? 0) + 1;
            if (republishes > MAX_SOFT_REPUBLISHES) {
              // Refuse to keep the soft loop going. Throwing lands on the 500
              // below, which QStash redelivers as a hard failure, so core's
              // own MAX_QUEUE_DELIVERIES cap ends the run with a real error
              // instead of this message spinning silently forever.
              throw new Error(
                `[world-upstash] message ${messageId} exceeded ${MAX_SOFT_REPUBLISHES} timeoutSeconds republishes on ${queueName}`,
              );
            }
            await publishBody(
              {
                queueName,
                message,
                messageId,
                // Carry only the failed-delivery total. A soft republish is
                // core asking to be re-invoked, not a delivery that failed,
                // so it must not push `attempt` toward MAX_QUEUE_DELIVERIES.
                deliveryCount: (deliveryCount ?? 0) + retried,
                republishCount: republishes,
              },
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
