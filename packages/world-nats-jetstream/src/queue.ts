import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  type QueuePayload,
  type ValidQueueName,
  WorkflowInvokePayloadSchema,
} from '@workflow/world';
import type { JetStreamClient, JsMsg } from '@nats-io/jetstream';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy } from '@nats-io/jetstream';
import type { KV } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';
import { monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';
import { createWorkflowUrl } from '@workflow/utils';
import type { NatsJetStreamWorldConfig } from './config.js';
import { debug } from './util.js';

interface MessageEnvelope {
  messageId: string;
  idempotencyKey?: string;
  queueName: ValidQueueName;
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

/**
 * How long JetStream waits for an ack before redelivering. Kept short so a
 * crashed worker's messages come back quickly; long-running handlers extend
 * the deadline via `msg.working()` heartbeats (see ACK_PROGRESS_INTERVAL_MS).
 */
const ACK_WAIT_NANOS = 30 * 1_000_000_000; // 30 seconds

/**
 * Interval at which in-flight deliveries send `working()` progress heartbeats
 * to extend the ack deadline. Must be comfortably below ACK_WAIT_NANOS so a
 * handler that outlives ack_wait (HTTP dispatch allows up to httpTimeoutMs)
 * is never redelivered (and executed concurrently) while still running.
 */
const ACK_PROGRESS_INTERVAL_MS = 10_000;

/**
 * Safety ceiling on `{ timeoutSeconds }` soft naks for a single message,
 * mirroring world-upstash's MAX_SOFT_REPUBLISHES and world-local's
 * MAX_LOCAL_SAFETY_LIMIT.
 *
 * Suspensions are legitimate control flow and must not consume core's delivery
 * budget, but an unbounded soft loop would spin a message forever. Past this
 * ceiling the delivery is nak'd as a real failure so it starts counting toward
 * core's own cap and the run ends with a recorded error.
 */
const MAX_SOFT_NAKS = 256;

/**
 * JetStream delivery cap. Core's poison-pill escalation triggers at
 * MAX_QUEUE_DELIVERIES (48) *failed* attempts and marks the run/step failed;
 * this cap only exists as a backstop above that so JetStream never silently
 * drops a message before core has had a chance to record the failure.
 *
 * Soft naks share JetStream's delivery counter (there is no way to redeliver
 * without incrementing `num_delivered`), so the cap has to clear the soft
 * ceiling plus core's failure budget, not just core's budget alone.
 */
const MAX_DELIVER = MAX_SOFT_NAKS + 64;

/** Redelivery delay for failed dispatches (matches world-local's 5s linear backoff). */
const NAK_DELAY_MS = 5_000;

/**
 * How long a soft-nak counter outlives its message. Matched to the streams'
 * `max_age` so a counter cannot outlive the message it describes.
 */
const SOFT_NAK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const QUEUE_PATHNAMES = {
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, string>;

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
 *
 * Message payloads are serialized with the shared tagged-JSON codec so that
 * Uint8Array values (e.g. the CBOR-transport `runInput.input` on workflow
 * messages) survive the queue round-trip intact.
 */
export function createQueue(
  getJetStream: () => Promise<JetStreamClient>,
  config: NatsJetStreamWorldConfig,
): Queue & { start(): Promise<void>; getHealth(): WorkerHealth } {
  const generateMessageId = monotonicFactory();
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Streams = {
    workflow: `${prefix}flows`,
    step: `${prefix}steps`,
  } as const satisfies Record<QueueKind, string>;

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

  /**
   * In-flight workflow replays, keyed by run. See `runSerialized`.
   */
  const inflightWorkflowRuns = new Map<string, Promise<void>>();

  /** Serialization key for a delivery, or `undefined` when it may run freely.
   * Only workflow invocations are keyed; step deliveries stay parallel so
   * fan-out is preserved. */
  function workflowRunSerializationKey(kind: QueueKind, message: QueuePayload): string | undefined {
    if (kind !== 'workflow') return undefined;
    const invoke = WorkflowInvokePayloadSchema.safeParse(message);
    if (!invoke.success) return undefined;
    return `workflow:${invoke.data.runId}`;
  }

  /** Run `task`, serialized against every other delivery sharing `key`. Workers
   * share one durable consumer, so two deliveries for a run would otherwise
   * replay concurrently and corrupt its event log. Per-process only. */
  async function runSerialized(key: string | undefined, task: () => Promise<void>): Promise<void> {
    if (!key) {
      await task();
      return;
    }
    const previous = inflightWorkflowRuns.get(key);
    const execution = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (inflightWorkflowRuns.get(key) === execution) {
          inflightWorkflowRuns.delete(key);
        }
      });
    inflightWorkflowRuns.set(key, execution);
    await execution;
  }

  /**
   * Per-message tally of `{ timeoutSeconds }` suspensions.
   *
   * `{ timeoutSeconds }` is core's *control-flow* signal, not a failed
   * delivery: `sleep()`, step retry backoff, `TooEarlyError`, and
   * `{ timeoutSeconds: 0 }` ("re-invoke me with a fresh replay", returned
   * whenever the `stateUpdatedAt` precondition guard exhausts its reloads or
   * `run_completed` is rejected as stale). JetStream's only durable redelivery
   * timer is `nak(delay)`, which unavoidably increments `num_delivered`, so the
   * suspensions are counted here and subtracted back out before the delivery is
   * reported to core as an `attempt`.
   *
   * Kept in KV rather than in memory so the tally survives a worker restart or
   * a consumer rebalance; losing it would silently restore the old behaviour of
   * counting suspensions against core's budget.
   */
  let softNakBucket: KV | undefined;
  const getSoftNakBucket = async (): Promise<KV> => {
    if (!softNakBucket) {
      const jetstream = await getJetStream();
      softNakBucket = await new Kvm(jetstream).create(`${prefix}queue_soft_naks`, {
        history: 1,
        ttl: SOFT_NAK_TTL_MS,
      });
    }
    return softNakBucket;
  };

  /** Stable per-message key. `streamSequence` identifies the message within its
   * stream and does not change across redeliveries, unlike `deliveryCount`. */
  function softNakKey(kind: QueueKind, msg: JsMsg): string {
    return `${kind}_${msg.info.streamSequence}`;
  }

  async function readSoftNaks(key: string): Promise<number> {
    const entry = await (await getSoftNakBucket()).get(key);
    if (!entry) return 0;
    const value = Number.parseInt(new TextDecoder().decode(entry.value), 10);
    return Number.isFinite(value) ? value : 0;
  }

  async function writeSoftNaks(key: string, count: number): Promise<void> {
    await (await getSoftNakBucket()).put(key, new TextEncoder().encode(String(count)));
  }

  /** Drop a settled message's tally. Best effort: the delivery is already
   * acked, so a failure here must not resurrect it (the bucket TTL is the
   * backstop). */
  function clearSoftNaks(key: string): void {
    void getSoftNakBucket()
      .then((bucket) => bucket.purge(key))
      .catch((err) => {
        debug(`failed to purge soft-nak counter ${key}`, { err });
      });
  }

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

    const { kind, id } = parseQueueName(queueName);
    const streamName = Streams[kind];
    const subject = `${streamName}.${id}`;
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      message,
    };
    const payload = stringify(envelope);

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
        const body = parse<unknown>(await req.text());
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

  async function dispatch(
    envelope: MessageEnvelope,
    attempt: number,
    pathname: 'flow' | 'step',
  ): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = createWorkflowUrl(baseUrl, { type: pathname });
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': envelope.messageId,
        'x-vqs-message-attempt': String(attempt),
      },
      body: stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  /** Dispatch one delivery and settle it (ack / nak). Never throws: every
   * failure is translated into a nak so JetStream owns the redelivery. */
  async function deliver(
    msg: JsMsg,
    envelope: MessageEnvelope,
    pathname: 'flow' | 'step',
    streamName: string,
    kind: QueueKind,
  ): Promise<void> {
    const key = softNakKey(kind, msg);
    try {
      // Report only *failed* deliveries as the attempt, so core's poison-pill
      // escalation (attempt > MAX_QUEUE_DELIVERIES) still fires on a genuinely
      // stuck message but a run that merely suspends is never killed as a
      // runaway. The first delivery cannot have suspended yet, so the happy
      // path skips the KV read entirely.
      const softNaks = msg.info.deliveryCount > 1 ? await readSoftNaks(key) : 0;
      const attempt = Math.max(1, msg.info.deliveryCount - softNaks);

      const response = await dispatch(envelope, attempt, pathname);

      if (response.ok) {
        msg.ack();
        health.lastSuccessfulFetch = Date.now();
        health.totalProcessed++;
        if (softNaks > 0) clearSoftNaks(key);
        return;
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
          const next = softNaks + 1;
          if (next > MAX_SOFT_NAKS) {
            // Refuse to keep the soft loop going. Nak'ing without recording the
            // suspension makes this delivery count as a real failure, so the
            // attempt climbs and core ends the run with a recorded error
            // instead of the message spinning silently until max_deliver.
            console.error(
              `[world-nats-jetstream worker] message ${envelope.messageId} exceeded ${MAX_SOFT_NAKS} timeoutSeconds naks on ${streamName}`,
            );
            msg.nak(NAK_DELAY_MS);
            health.totalFailed++;
            return;
          }
          // Record the suspension BEFORE nak'ing: JetStream may redeliver the
          // moment the delay elapses, and a redelivery that read a stale count
          // would report an inflated attempt.
          await writeSoftNaks(key, next);
          // JetStream supports a custom nak delay (in ms).
          const timeoutMs = (parsed as { timeoutSeconds: number }).timeoutSeconds * 1000;
          msg.nak(timeoutMs);
          return;
        }
      }

      msg.nak(NAK_DELAY_MS);
      health.totalFailed++;
      console.error(
        `[world-nats-jetstream worker] HTTP ${response.status} on ${streamName}: ${text}`,
      );
    } catch (error) {
      console.error(`[world-nats-jetstream worker] dispatch error from ${streamName}:`, error);
      msg.nak(NAK_DELAY_MS);
      health.totalFailed++;
    }
  }

  async function worker(kind: QueueKind, streamName: string) {
    try {
      const jetstream = await getJetStream();
      const jsm = await jetstream.jetstreamManager();
      const consumerName = `${streamName}_worker`;

      try {
        await jsm.consumers.add(streamName, {
          durable_name: consumerName,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          max_deliver: MAX_DELIVER,
          ack_wait: ACK_WAIT_NANOS,
          filter_subject: `${streamName}.>`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('already') && !message.includes('in use')) {
          throw err;
        }
        // The durable already exists with an older configuration (e.g. the
        // previous max_deliver: 3); reconcile the retry policy in place.
        await jsm.consumers.update(streamName, consumerName, {
          max_deliver: MAX_DELIVER,
          ack_wait: ACK_WAIT_NANOS,
        });
      }

      const consumer = await jetstream.consumers.get(streamName, consumerName);
      const messages = await consumer.consume();

      health.consecutiveFailures = 0;
      const pathname = QUEUE_PATHNAMES[kind];

      for await (const msg of messages) {
        let envelope: MessageEnvelope;
        try {
          const data = new TextDecoder().decode(msg.data);
          envelope = parse<MessageEnvelope>(data);
        } catch (error) {
          console.error(
            `[world-nats-jetstream worker] invalid envelope from ${streamName}:`,
            error,
          );
          msg.ack(); // can't redeliver something we can't parse
          health.totalFailed++;
          continue;
        }

        // Extend the ack deadline while this delivery is ours: dispatch may run to
        // httpTimeoutMs, and a message queued behind another replay of the same run
        // would otherwise be redelivered to a second worker.
        const progressTimer = setInterval(() => {
          msg.working();
        }, ACK_PROGRESS_INTERVAL_MS);

        try {
          await runSerialized(workflowRunSerializationKey(kind, envelope.message), () =>
            deliver(msg, envelope, pathname, streamName, kind),
          );
        } finally {
          clearInterval(progressTimer);
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
      void worker(kind, streamName);
    }
  }

  async function startWorkers() {
    await initStreams();

    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Streams) as [QueueKind, string][];

    for (const [kind, streamName] of entries) {
      for (let i = 0; i < concurrency; i++) {
        void worker(kind, streamName);
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
