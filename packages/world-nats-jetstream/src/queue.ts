import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  type Queue,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import type { JetStreamClient } from 'nats';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy } from 'nats';
import { monotonicFactory } from 'ulid';
import type { NatsJetStreamWorldConfig } from './config.js';
import { debug } from './util.js';

interface MessageEnvelope {
  messageId: string;
  idempotencyKey?: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
}

/** Health statistics for a queue worker. */
export interface WorkerHealth {
  lastSuccessfulFetch: number | null;
  consecutiveFailures: number;
  totalProcessed: number;
  totalFailed: number;
}

/** Default deduplication window: 15 minutes. */
const DEFAULT_DEDUP_WINDOW_MS = 15 * 60 * 1000;

/** Backoff constants for worker reconnection. */
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 30_000;

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, string>;

function resolveBaseUrl(config: NatsJetStreamWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * NATS JetStream queue. Each queue type gets its own stream + durable consumer
 * in work-queue mode. Deduplication uses `Nats-Msg-Id` (configurable window).
 *
 * Worker delivery: messages are pulled from JetStream and dispatched via HTTP
 * fetch to `${baseUrl}/.well-known/workflow/v1/{flow|step}`. JetStream itself
 * handles redelivery via `max_deliver` and `nak()`.
 */
export function createQueue(
  getJetStream: () => Promise<JetStreamClient>,
  config: NatsJetStreamWorldConfig,
): Queue & { start(): Promise<void>; getHealth(): WorkerHealth } {
  const generateMessageId = monotonicFactory();
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Streams = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const dedupWindowMs = config.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  // JetStream takes nanoseconds for its time fields.
  const dedupWindowNanos = dedupWindowMs * 1_000_000;

  const health: WorkerHealth = {
    lastSuccessfulFetch: null,
    consecutiveFailures: 0,
    totalProcessed: 0,
    totalFailed: 0,
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'nats-jetstream';

  let initialized = false;
  const initStreams = async () => {
    if (initialized) return;

    const jetstream = await getJetStream();
    const jsm = await jetstream.jetstreamManager();

    for (const streamName of Object.values(Streams)) {
      try {
        await jsm.streams.add({
          name: streamName,
          subjects: [`${streamName}.>`],
          retention: RetentionPolicy.Workqueue,
          discard: DiscardPolicy.Old,
          max_msgs: 100000,
          max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days
          duplicate_window: dedupWindowNanos,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('already in use')) {
          throw err;
        }
      }
    }

    initialized = true;
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    await initStreams();

    const queuePrefix = parseQueuePrefix(queueName);
    const streamName = Streams[queuePrefix];
    const id = queueName.slice(queuePrefix.length);
    const subject = `${streamName}.${id}`;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };
    const payload = JSON.stringify(envelope);

    const js = await getJetStream();
    await js.publish(subject, new TextEncoder().encode(payload), {
      msgID: idempotencyKey,
    });

    return { messageId };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (queueNamePrefix, handler) => {
    return async (req) => {
      const reqQueueName = req.headers.get('x-vqs-queue-name') as ValidQueueName | null;
      const reqMessageId = req.headers.get('x-vqs-message-id') as MessageId | null;
      const attemptStr = req.headers.get('x-vqs-message-attempt');

      if (!reqQueueName || !reqMessageId || !attemptStr || !req.body) {
        return Response.json({ error: 'Missing required headers or body' }, { status: 400 });
      }
      if (!reqQueueName.startsWith(queueNamePrefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      const attempt = Number.parseInt(attemptStr, 10);
      try {
        const body = await req.json();
        const result = await handler(body, {
          attempt,
          queueName: reqQueueName,
          messageId: reqMessageId,
        });
        if (result && typeof result.timeoutSeconds === 'number') {
          return Response.json({ timeoutSeconds: result.timeoutSeconds }, { status: 503 });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  async function dispatch(envelope: MessageEnvelope, pathname: string): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': envelope.messageId,
        'x-vqs-message-attempt': String(envelope.attempt),
      },
      body: JSON.stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  async function worker(workerQueuePrefix: QueuePrefix, streamName: string) {
    try {
      const jetstream = await getJetStream();
      const jsm = await jetstream.jetstreamManager();
      const consumerName = `${streamName}_worker`;

      try {
        await jsm.consumers.add(streamName, {
          durable_name: consumerName,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          max_deliver: 3,
          ack_wait: 30 * 1_000_000_000, // 30 seconds
          filter_subject: `${streamName}.>`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('already in use')) {
          throw err;
        }
      }

      const consumer = await jetstream.consumers.get(streamName, consumerName);
      const messages = await consumer.consume();

      health.consecutiveFailures = 0;
      const pathname = QUEUE_PATHNAMES[workerQueuePrefix];

      for await (const msg of messages) {
        let envelope: MessageEnvelope;
        try {
          const data = new TextDecoder().decode(msg.data);
          envelope = JSON.parse(data) as MessageEnvelope;
        } catch (error) {
          console.error(
            `[world-nats-jetstream worker] invalid envelope from ${streamName}:`,
            error,
          );
          msg.ack(); // can't redeliver something we can't parse
          health.totalFailed++;
          continue;
        }

        try {
          const response = await dispatch(envelope, pathname);

          if (response.ok) {
            msg.ack();
            health.lastSuccessfulFetch = Date.now();
            health.totalProcessed++;
            continue;
          }

          const text = await response.text();

          if (response.status === 503) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
            if (
              parsed &&
              typeof parsed === 'object' &&
              typeof (parsed as { timeoutSeconds?: unknown }).timeoutSeconds === 'number'
            ) {
              // JetStream supports a custom nak delay (in ns).
              const timeoutMs = (parsed as { timeoutSeconds: number }).timeoutSeconds * 1000;
              msg.nak(timeoutMs);
              continue;
            }
          }

          msg.nak();
          health.totalFailed++;
          console.error(
            `[world-nats-jetstream worker] HTTP ${response.status} on ${streamName}: ${text}`,
          );
        } catch (error) {
          console.error(`[world-nats-jetstream worker] dispatch error from ${streamName}:`, error);
          msg.nak();
          health.totalFailed++;
        }
      }
    } catch (error) {
      health.consecutiveFailures++;
      health.totalFailed++;

      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** health.consecutiveFailures, MAX_BACKOFF_MS);

      debug(
        `Worker for ${streamName} failed (consecutiveFailures=${health.consecutiveFailures}), backing off ${backoff}ms`,
        { error },
      );

      console.error(`[world-nats-jetstream worker] Error in worker for ${streamName}:`, error);

      await delay(backoff);
      void worker(workerQueuePrefix, streamName);
    }
  }

  async function startWorkers() {
    await initStreams();

    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Streams) as [QueuePrefix, string][];

    for (const [queuePrefix, streamName] of entries) {
      for (let i = 0; i < concurrency; i++) {
        void worker(queuePrefix, streamName);
      }
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      void startWorkers();
    },
    getHealth(): WorkerHealth {
      return { ...health };
    },
  };
}

const parseQueuePrefix = (name: ValidQueueName): QueuePrefix => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) return prefix;
  }
  throw new Error(`Invalid queue name: ${name}`);
};
