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
import type { JetStreamClient, JsMsg } from 'nats';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy } from 'nats';
import { monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';
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
 * is never redelivered — and executed concurrently — while still running.
 */
const ACK_PROGRESS_INTERVAL_MS = 10_000;

/**
 * JetStream delivery cap. Core's poison-pill escalation triggers at
 * MAX_QUEUE_DELIVERIES (48) attempts and marks the run/step failed; this cap
 * only exists as a backstop above that so JetStream never silently drops a
 * message before core has had a chance to record the failure.
 */
const MAX_DELIVER = 64;

/** Redelivery delay for failed dispatches (matches world-local's 5s linear backoff). */
const NAK_DELAY_MS = 5_000;

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

  /**
   * Serialization key for a delivery, or `undefined` when it may run freely.
   *
   * Only workflow invocations are keyed: step deliveries must stay parallel so
   * fan-out is preserved. A payload that is not a workflow invocation (a step
   * or health-check message on the workflow stream) falls through unserialized.
   */
  function workflowRunSerializationKey(kind: QueueKind, message: QueuePayload): string | undefined {
    if (kind !== 'workflow') return undefined;
    const invoke = WorkflowInvokePayloadSchema.safeParse(message);
    if (!invoke.success) return undefined;
    return `workflow:${invoke.data.runId}`;
  }

  /**
   * Run `task`, serialized against every other delivery sharing `key`.
   *
   * All worker coroutines for a stream share one durable consumer, so two
   * deliveries for the same run are routinely handed to two workers at once.
   * Replaying a run twice concurrently corrupts its event log: each replay
   * allocates its own `step_created` correlationId, and neither replay can
   * consume the other's event, which surfaces as `ReplayDivergenceError` and
   * ultimately `CorruptedEventLogError`. Chaining deliveries per run removes
   * that race.
   *
   * A failed task must not poison the chain, hence the `catch` on the
   * predecessor; the identity check before deleting keeps a newer link from
   * being evicted by an older one's cleanup.
   *
   * This mirrors the reference world-postgres implementation and shares its
   * limitation: it serializes within a process, not across them. The storage
   * layer's `stateUpdatedAt` guard is what covers the cross-process case.
   */
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
    pathname: string,
  ): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
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

  /**
   * Dispatch one delivery and settle it (ack / nak). Never throws: every
   * failure mode is translated into a nak so JetStream owns the redelivery.
   */
  async function deliver(
    msg: JsMsg,
    envelope: MessageEnvelope,
    pathname: string,
    streamName: string,
  ): Promise<void> {
    try {
      // Derive the attempt from JetStream's delivery count (1-based) so
      // redeliveries surface as attempt 2, 3, ... and core's poison-pill
      // escalation (attempt > MAX_QUEUE_DELIVERIES) can trigger.
      const response = await dispatch(envelope, msg.info.deliveryCount, pathname);

      if (response.ok) {
        msg.ack();
        health.lastSuccessfulFetch = Date.now();
        health.totalProcessed++;
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
        // previous max_deliver: 3) — reconcile the retry policy in place.
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

        // Extend the ack deadline for as long as this delivery is ours. That
        // covers both the in-flight dispatch (HTTP handlers may run up to
        // httpTimeoutMs, default 300s, far beyond ack_wait's 30s) and any
        // time spent queued behind another replay of the same run — a
        // waiting message that stopped heartbeating would be redelivered to
        // another worker and reintroduce the concurrency we are removing.
        const progressTimer = setInterval(() => {
          msg.working();
        }, ACK_PROGRESS_INTERVAL_MS);

        try {
          await runSerialized(workflowRunSerializationKey(kind, envelope.message), () =>
            deliver(msg, envelope, pathname, streamName),
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
