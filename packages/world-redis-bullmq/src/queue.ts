import { uint8ArrayReplacer } from '@fantasticfour/shared';
import { hasBinary } from './util.js';
import {
  MessageId,
  type Queue as QueueInterface,
  type QueuePayload,
  type ValidQueueName,
} from '@workflow/world';
import { createWorkflowUrl } from '@workflow/utils';
import { DelayedError, type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { RedisWorldConfig } from './config.js';
import { debug } from './util.js';

/**
 * Queue statistics from BullMQ, useful for monitoring and observability.
 */
export interface QueueStats {
  /** Jobs waiting to be processed */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Successfully completed jobs (still retained) */
  completed: number;
  /** Failed jobs (still retained) */
  failed: number;
  /** Jobs scheduled for future execution */
  delayed: number;
}

interface QueueJobData {
  /** The full workflow queue name (e.g. `__wkf_workflow_wrun_...`) */
  queueName: ValidQueueName;
  /**
   * The queue payload, serialized with the tagged-JSON transport, forwarded
   * verbatim as the fetch body. Pre-serializing keeps Uint8Array values (e.g.
   * the resilient-start runInput.input) intact through BullMQ's own JSON
   * serialization of job data.
   */
  message: string;
}

/**
 * JSON transport that preserves Uint8Array values via a tagged envelope
 * ({ __type: 'Uint8Array', data: '<base64>' }), matching the upstream
 * world-local/world-postgres queue transports. Required because BullMQ
 * JSON-serializes job data, which would otherwise mangle binary payloads.
 */
// Same fast path as storage: a replacer/reviver forces V8 off its fast path,
// costing ~2.6x on serialize and ~8x on parse. Queue payloads carry the same
// step inputs and results, so this applies per enqueue and dequeue.
function serializeQueueMessage(message: unknown): string {
  return hasBinary(message) ? JSON.stringify(message, uint8ArrayReplacer) : JSON.stringify(message);
}

function queueMessageReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const tagged = value as { __type?: unknown; data?: unknown };
    if (tagged.__type === 'Uint8Array' && typeof tagged.data === 'string') {
      return new Uint8Array(Buffer.from(tagged.data, 'base64'));
    }
  }
  return value;
}

function deserializeQueueMessage(text: string): QueuePayload {
  // Queue messages carry no Date fields, so with the tag absent a plain parse
  // is exactly equivalent.
  return (
    text.includes('"__type"') ? JSON.parse(text, queueMessageReviver) : JSON.parse(text)
  ) as QueuePayload;
}

/**
 * Build the HTTP callback URL the BullMQ worker will POST to. The user must
 * mount `world.createQueueHandler(...)` at `/.well-known/workflow/v1/flow`
 * (the Workflow DevKit convention).
 */
function resolveBaseUrl(config: RedisWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * BullMQ-backed Queue. Job dispatch happens via HTTP fetch to the user's
 * server; this package does not embed a workflow runtime.
 *
 * One BullMQ queue per world: `${prefix}flows`. Steps travel on the workflow
 * topic (v5 retired the step queue kind) carrying stepId/stepName in the
 * payload, and execute in the combined flow handler. Waits are plain
 * delaySeconds continuations, which BullMQ parks in its delayed set; a
 * suspension enqueues its steps and waits as one parallel batch of jobs,
 * each an independent job here.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
): QueueInterface & {
  start(): Promise<void>;
  close(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
} {
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const queueName = `${prefix}flows`;

  const maxAttempts = config.maxAttempts ?? 5;
  const backoffType = config.backoffType ?? 'exponential';
  const backoffDelayMs = config.backoffDelayMs ?? 1000;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const stalledInterval = config.stalledInterval ?? 30_000;
  const maxStalledCount = config.maxStalledCount ?? 1;
  const idempotencyTtlMs = config.idempotencyTtlMs;

  // Reuse the full ioredis options (tls, username, path, sentinels, ...) so
  // rediss:// and ACL setups work for the queue half too; an allowlist here
  // would silently drop fields. BullMQ manages its own key prefixes and
  // rejects ioredis keyPrefix, so strip it; maxRetriesPerRequest: null is
  // required by BullMQ for blocking connections.
  // Auto-pipelining is a storage-side setting. BullMQ workers hold blocking
  // connections (BZPOPMIN and friends), where batching a blocking call
  // together with other commands would stall them behind it, so it is dropped
  // here rather than inherited.
  const {
    keyPrefix: _unsupportedByBullmq,
    enableAutoPipelining: _storageOnly,
    ...redisOptions
  } = redis.options;
  // Cast: bullmq's ConnectionOptions type doesn't allow retryStrategy: null,
  // though ioredis accepts it fine at runtime.
  const connectionOptions = {
    ...redisOptions,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;

  const bullQueue = new Queue<QueueJobData>(queueName, { connection: connectionOptions });
  let worker: Worker<QueueJobData> | undefined;

  const queue: QueueInterface['queue'] = async (name, message, opts) => {
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const delayMs = opts?.delaySeconds ? Math.max(0, opts.delaySeconds * 1000) : undefined;

    // Core treats queue() success as a durability guarantee, so add()
    // failures must propagate. BullMQ does NOT throw on dedup hits; the
    // addJob script returns the existing job id, so any rejection here is a
    // real failure (connection loss, OOM, ...) and swallowing it would strand
    // the run.
    await bullQueue.add(
      name,
      { queueName: name, message: serializeQueueMessage(message) },
      {
        jobId: messageId,
        delay: delayMs,
        attempts: maxAttempts,
        backoff: { type: backoffType, delay: backoffDelayMs },
        // BullMQ native deduplication. Without a ttl the dedup key lives
        // until the job completes or fails (BullMQ deletes it on
        // finalization), the release-on-completion semantics core relies on
        // when it re-enqueues pending steps with the same idempotencyKey on
        // every replay. A ttl is only applied when explicitly configured.
        ...(opts?.idempotencyKey && {
          deduplication: {
            id: opts.idempotencyKey,
            ...(idempotencyTtlMs !== undefined && { ttl: idempotencyTtlMs }),
          },
        }),
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    );

    return { messageId };
  };

  async function processJob(job: Job<QueueJobData>, token?: string): Promise<void> {
    const baseUrl = resolveBaseUrl(config);
    const url = createWorkflowUrl(baseUrl, { type: 'flow' });
    const messageId = job.id ?? `msg_${generateMessageId()}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': job.data.queueName,
        'x-vqs-message-id': messageId,
        'x-vqs-message-attempt': String(job.attemptsMade + 1),
      },
      body: job.data.message,
      signal: AbortSignal.timeout(httpTimeoutMs),
    });

    if (response.ok) return;

    const text = await response.text();

    // 503 with { timeoutSeconds } means "retry later without consuming an
    // attempt": defer the job via BullMQ's delayed queue. BullMQ requires
    // throwing DelayedError after moveToDelayed so the worker skips its
    // completion/failure machinery for this invocation.
    if (response.status === 503) {
      let timeoutSeconds: number | undefined;
      try {
        const parsed = JSON.parse(text) as { timeoutSeconds?: unknown };
        if (typeof parsed?.timeoutSeconds === 'number') {
          timeoutSeconds = parsed.timeoutSeconds;
        }
      } catch {
        // fall through to generic failure
      }
      if (timeoutSeconds !== undefined) {
        const delayMs = timeoutSeconds * 1000;
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
    }

    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const createQueueHandler: QueueInterface['createQueueHandler'] = (queueNamePrefix, handler) => {
    return async (req) => {
      const name = req.headers.get('x-vqs-queue-name') as ValidQueueName | null;
      const messageId = req.headers.get('x-vqs-message-id') as MessageId | null;
      const attemptStr = req.headers.get('x-vqs-message-attempt');

      if (!name || !messageId || !attemptStr || !req.body) {
        return Response.json({ error: 'Missing required headers or body' }, { status: 400 });
      }
      if (!name.startsWith(queueNamePrefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      const attempt = Number.parseInt(attemptStr, 10);

      try {
        const body = deserializeQueueMessage(await req.text());
        const result = await handler(body, { attempt, queueName: name, messageId });

        if (result && typeof result.timeoutSeconds === 'number') {
          return Response.json({ timeoutSeconds: result.timeoutSeconds }, { status: 503 });
        }
        return Response.json({ ok: true });
      } catch (error) {
        debug('queue handler error:', error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  const getDeploymentId: QueueInterface['getDeploymentId'] = async () => 'redis';

  async function startWorker() {
    if (worker) return;
    const concurrency = config.queueConcurrency || 10;

    worker = new Worker<QueueJobData>(queueName, processJob, {
      connection: connectionOptions,
      concurrency,
      stalledInterval,
      maxStalledCount,
      // Low drainDelay reduces idle pickup latency.
      drainDelay: 300,
    });

    worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });
    worker.on('error', (err) => {
      console.error('Worker error:', err);
    });

    await worker.waitUntilReady();
  }

  async function getQueueStats(): Promise<QueueStats> {
    const counts = await bullQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return {
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
    };
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    getQueueStats,
    async start() {
      await startWorker();
    },
    async close() {
      if (worker) {
        await worker.close();
        worker = undefined;
      }
      await bullQueue.close();
    },
  };
}
