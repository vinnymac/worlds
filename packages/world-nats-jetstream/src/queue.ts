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
import type {
  ConsumerConfig,
  ConsumerInfo,
  JetStreamClient,
  JetStreamManager,
  JsMsg,
} from '@nats-io/jetstream';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  JetStreamError,
  RetentionPolicy,
} from '@nats-io/jetstream';
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
 * Default time JetStream waits for an ack before redelivering. Kept short so a
 * crashed worker's messages come back quickly; long-running handlers extend
 * the deadline via `msg.working()` heartbeats at a third of the ack wait.
 */
const DEFAULT_ACK_WAIT_MS = 30_000;

/** Largest delay `setTimeout` honors; beyond it Node fires after 1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Below this a third-of-ack-wait heartbeat leaves no room for network latency. */
const MIN_ACK_WAIT_MS = 1_000;

/** 24 days, the longest whole-day wait that still fits in one `setTimeout`. */
const MAX_ACK_WAIT_MS = 24 * 86_400_000;

/** How often each stream re-reads its durable's ack_wait, which another
 * process with a different `ackWaitMs` may have changed. */
const ACK_WAIT_REFRESH_MS = 5_000;

/** Consecutive ack_wait refresh failures before a stream re-reads less often. */
const MAX_REFRESH_FAILURES = 3;

/** Refresh spacing once a stream's consumer info keeps failing. */
const SLOW_ACK_WAIT_REFRESH_MS = 60_000;

/** Consecutive failed pulls tolerated quietly before one is logged loudly. */
const MAX_QUIET_PULL_FAILURES = 5;

/**
 * Failures `next()` rejects with that retrying the pull survives: a 503 while a
 * server is unreachable, the 409s a leadership change or request limit raises,
 * and the codeless error its idle-heartbeat monitor gives up with. A deleted
 * consumer is not one: that needs the consumer rebuilt.
 */
function isTransientPullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof JetStreamError && error.message === 'heartbeats missed') return true;
  if (!('code' in error)) return false;
  const code = error.code;
  if (code === 503) return true;
  return code === 409 && !/consumer deleted/i.test(error.message);
}

/** The 503 a pull gets from an unreachable server, or from a deleted consumer. */
function isNoRespondersError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 503;
}

/** Consumer info failing because the durable or its stream no longer exists. */
function isMissingConsumerError(error: unknown): boolean {
  if (!(error instanceof JetStreamApiError)) return false;
  return (
    error.code === JetStreamApiCodes.ConsumerNotFound ||
    error.code === JetStreamApiCodes.StreamNotFound
  );
}

/** Current heartbeat cadence for one stream's shared durable. */
interface AckWaitLease {
  intervalMs: number;
  /** In-flight heartbeats, fired at once when the interval shrinks. */
  beats: Set<() => void>;
}

/** Validate `ackWaitMs` and convert it to the nanoseconds JetStream takes. */
function resolveAckWaitNanos(configured?: number): number {
  const ackWaitMs = configured ?? DEFAULT_ACK_WAIT_MS;
  if (!Number.isInteger(ackWaitMs) || ackWaitMs < MIN_ACK_WAIT_MS || ackWaitMs > MAX_ACK_WAIT_MS) {
    throw new RangeError(
      `ackWaitMs must be an integer between ${MIN_ACK_WAIT_MS} and ${MAX_ACK_WAIT_MS}, got ${ackWaitMs}`,
    );
  }
  return ackWaitMs * 1_000_000;
}

/** Heartbeat interval for the ack wait the server actually holds: a third of
 * it, so a live delivery is never redelivered. An operator may set a wait too
 * long for a timer, so that is clamped: an early heartbeat is harmless. */
function progressIntervalFor(ackWaitNanos: number | undefined, consumer: string): number {
  const intervalMs = Math.floor((ackWaitNanos ?? Number.NaN) / 3_000_000);
  if (!(intervalMs >= 1)) {
    throw new Error(`consumer ${consumer} reported an unusable ack_wait of ${ackWaitNanos}ns`);
  }
  return Math.min(intervalMs, MAX_TIMER_DELAY_MS);
}

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
): Queue & { start(): Promise<void>; close(): Promise<void>; getHealth(): WorkerHealth } {
  const generateMessageId = monotonicFactory();
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const ackWaitNanos = resolveAckWaitNanos(config.ackWaitMs);
  const leases = new Map<string, AckWaitLease>();

  /** Aborted by `close()`: workers stop pulling and backoff sleeps end. */
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  /** Deliveries `close()` waits on, so their acks go out before the drain. */
  const inflightDeliveries = new Set<Promise<void>>();
  /** Pending ack_wait refresh per stream, cleared by `close()`. */
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One durable setup per stream, shared by its workers until one tears down. */
  const consumerSetups = new Map<string, Promise<AckWaitLease>>();

  /** Backoff sleep. Resolves false when `close()` cut it short. */
  async function pause(ms: number): Promise<boolean> {
    try {
      await delay(ms, undefined, { signal: shutdown.signal });
      return true;
    } catch (error) {
      if (shutdown.signal.aborted) return false;
      throw error;
    }
  }

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
        health.consecutiveFailures = 0;
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

  /** Keep re-reading the durable's ack_wait until `close()`. */
  function startAckWaitRefresh(
    streamName: string,
    consumerName: string,
    jsm: JetStreamManager,
    lease: AckWaitLease,
  ): void {
    let failures = 0;
    let slowed = false;
    // One self-rescheduling loop per stream until close(): the lease it
    // updates is shared with every in-flight heartbeat, so it backs off while
    // consumer info fails rather than giving up and stranding them.
    const schedule = (delayMs: number) => {
      if (shutdown.signal.aborted) return;
      const timer = setTimeout(() => {
        jsm.consumers
          .info(streamName, consumerName)
          .then((current) => {
            if (slowed) {
              slowed = false;
              debug(`Refreshing ack_wait for ${consumerName} again`);
            }
            failures = 0;
            adoptAckWait(lease, consumerName, current);
          })
          .catch((error: unknown) => {
            debug(`Could not refresh ack_wait for ${consumerName}`, { error });
            // close() drains the connection under a read already in flight.
            if (shutdown.signal.aborted) return;
            failures++;
            if (failures === MAX_REFRESH_FAILURES) {
              slowed = true;
              console.error(
                `[world-nats-jetstream worker] could not refresh ack_wait for ${consumerName} ${MAX_REFRESH_FAILURES} times; retrying every ${SLOW_ACK_WAIT_REFRESH_MS}ms, heartbeats stay at ${lease.intervalMs}ms meanwhile:`,
                error,
              );
            }
          })
          .finally(() => {
            schedule(
              failures >= MAX_REFRESH_FAILURES ? SLOW_ACK_WAIT_REFRESH_MS : ACK_WAIT_REFRESH_MS,
            );
          });
      }, delayMs);
      timer.unref();
      refreshTimers.set(streamName, timer);
    };
    schedule(ACK_WAIT_REFRESH_MS);
  }

  /** Heartbeat for the durable's reported ack_wait, at once if it shrank. */
  function adoptAckWait(lease: AckWaitLease, consumerName: string, info: ConsumerInfo): void {
    const intervalMs = progressIntervalFor(info.config.ack_wait, consumerName);
    if (intervalMs === lease.intervalMs) return;
    debug(
      `${consumerName} ack_wait is now ${info.config.ack_wait}ns; heartbeating every ${intervalMs}ms`,
    );
    const shrank = intervalMs < lease.intervalMs;
    lease.intervalMs = intervalMs;
    if (shrank) for (const beat of lease.beats) beat();
  }

  /** Create or reconcile a stream's durable and the lease its workers share. */
  async function setUpConsumer(
    jsm: JetStreamManager,
    streamName: string,
    consumerName: string,
  ): Promise<AckWaitLease> {
    let info: ConsumerInfo;
    try {
      info = await jsm.consumers.add(streamName, {
        durable_name: consumerName,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: MAX_DELIVER,
        ack_wait: ackWaitNanos,
        filter_subject: `${streamName}.>`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already') && !message.includes('in use')) {
        throw err;
      }
      // The durable already exists, possibly from an older version
      // (max_deliver: 3) or another process. Reconcile only what this process
      // is entitled to: rewriting ack_wait unasked makes two processes with
      // different values flap it on every restart.
      const current = await jsm.consumers.info(streamName, consumerName);
      const changes: Partial<ConsumerConfig> = {};
      if (current.config.max_deliver !== MAX_DELIVER) changes.max_deliver = MAX_DELIVER;
      if (config.ackWaitMs !== undefined && current.config.ack_wait !== ackWaitNanos) {
        console.warn(
          `[world-nats-jetstream worker] ${consumerName} ack_wait is ${current.config.ack_wait}ns, not the configured ${ackWaitNanos}ns; rewriting it. Workers sharing this durable should use the same ackWaitMs.`,
        );
        changes.ack_wait = ackWaitNanos;
      }
      info =
        Object.keys(changes).length > 0
          ? await jsm.consumers.update(streamName, consumerName, changes)
          : current;
    }

    // The durable is shared, so heartbeat for the server's ack_wait rather than
    // ours, and keep re-reading it: another process may change it at any time.
    let lease = leases.get(streamName);
    if (!lease) {
      lease = {
        intervalMs: progressIntervalFor(info.config.ack_wait, consumerName),
        beats: new Set(),
      };
      leases.set(streamName, lease);
      startAckWaitRefresh(streamName, consumerName, jsm, lease);
    }
    adoptAckWait(lease, consumerName, info);
    return lease;
  }

  /** The stream's shared setup, run once however many workers ask for it. */
  function ensureConsumer(
    jsm: JetStreamManager,
    streamName: string,
    consumerName: string,
  ): Promise<AckWaitLease> {
    let setup = consumerSetups.get(streamName);
    if (!setup) {
      setup = setUpConsumer(jsm, streamName, consumerName);
      consumerSetups.set(streamName, setup);
    }
    return setup;
  }

  /** A pull to a deleted consumer gets the same 503 as an unreachable server.
   * Throws when the durable or its stream is gone, so the worker rebuilds it. */
  async function assertConsumerExists(
    jsm: JetStreamManager,
    streamName: string,
    consumerName: string,
  ): Promise<void> {
    try {
      await jsm.consumers.info(streamName, consumerName);
    } catch (error) {
      if (isMissingConsumerError(error)) throw error;
      // Anything else is the outage the 503 reported: keep retrying the pull.
      debug(`Could not check that ${consumerName} still exists`, { error });
    }
  }

  async function worker(kind: QueueKind, streamName: string) {
    if (shutdown.signal.aborted) return;
    let setup: Promise<AckWaitLease> | undefined;
    try {
      const jetstream = await getJetStream();
      const jsm = await jetstream.jetstreamManager();
      const consumerName = `${streamName}_worker`;

      setup = ensureConsumer(jsm, streamName, consumerName);
      const streamLease = await setup;

      const consumer = await jetstream.consumers.get(streamName, consumerName);
      const pathname = QUEUE_PATHNAMES[kind];
      let pullFailures = 0;

      while (!shutdown.signal.aborted) {
        // Pull one message at a time: a buffered delivery's ack wait would run
        // with no heartbeat while this worker is busy with another.
        let msg: JsMsg | null;
        try {
          msg = await consumer.next();
          pullFailures = 0;
        } catch (error) {
          // close() drains the connection, which fails a pull issued after it.
          if (shutdown.signal.aborted) {
            debug(`Pull from ${streamName} ended by close`, { error });
            return;
          }
          // next() is a fetch, so unlike consume() it rejects on the transient
          // 409/503 statuses a server blip produces. Retry those in place
          // rather than tearing the worker (and its consumer setup) down.
          if (!isTransientPullError(error)) throw error;
          pullFailures++;
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** pullFailures, MAX_BACKOFF_MS);
          debug(
            `Pull from ${streamName} failed (pullFailures=${pullFailures}), retrying in ${backoff}ms`,
            { error },
          );
          if (pullFailures === MAX_QUIET_PULL_FAILURES) {
            console.error(
              `[world-nats-jetstream worker] ${MAX_QUIET_PULL_FAILURES} consecutive pull failures on ${streamName}, still retrying:`,
              error,
            );
          }
          if (pullFailures >= MAX_QUIET_PULL_FAILURES && isNoRespondersError(error)) {
            await assertConsumerExists(jsm, streamName, consumerName);
          }
          if (!(await pause(backoff))) return;
          continue;
        }
        if (shutdown.signal.aborted) {
          // Pulled while closing: hand it back so another worker takes it now.
          msg?.nak();
          return;
        }
        if (!msg) continue;
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
        let heartbeat: ReturnType<typeof setTimeout> | undefined;
        const beat = () => {
          clearTimeout(heartbeat);
          msg.working();
          heartbeat = setTimeout(beat, streamLease.intervalMs);
        };
        heartbeat = setTimeout(beat, streamLease.intervalMs);
        streamLease.beats.add(beat);

        const delivery = runSerialized(workflowRunSerializationKey(kind, envelope.message), () =>
          deliver(msg, envelope, pathname, streamName, kind),
        );
        inflightDeliveries.add(delivery);
        try {
          await delivery;
        } finally {
          clearTimeout(heartbeat);
          streamLease.beats.delete(beat);
          inflightDeliveries.delete(delivery);
        }
      }
    } catch (error) {
      // A rebuild must re-add the durable, unless another worker already did.
      if (setup && consumerSetups.get(streamName) === setup) consumerSetups.delete(streamName);
      if (shutdown.signal.aborted) {
        // close() drains the connection under whatever this worker awaited.
        debug(`Worker for ${streamName} stopped by close`, { error });
        return;
      }
      health.consecutiveFailures++;
      health.totalFailed++;

      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** health.consecutiveFailures, MAX_BACKOFF_MS);

      debug(
        `Worker for ${streamName} failed (consecutiveFailures=${health.consecutiveFailures}), backing off ${backoff}ms`,
        { error },
      );

      console.error(`[world-nats-jetstream worker] Error in worker for ${streamName}:`, error);

      if (!(await pause(backoff))) return;
      void worker(kind, streamName);
    }
  }

  async function startWorkers() {
    await initStreams();
    if (shutdown.signal.aborted) return;

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
    /** Stop pulling and wait for in-flight deliveries. Call before draining
     * the connection: a pull issued on a drained connection throws. */
    close(): Promise<void> {
      closing ??= (async () => {
        shutdown.abort();
        for (const timer of refreshTimers.values()) clearTimeout(timer);
        refreshTimers.clear();
        // Each worker surfaces its own delivery's failure, so only wait here.
        await Promise.allSettled(inflightDeliveries);
      })();
      return closing;
    },
    getHealth(): WorkerHealth {
      return { ...health };
    },
  };
}
