import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from '@fantasticfour/shared';
import type { Firestore } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import type { Queue } from '@workflow/world';
import { MessageId, parseQueueName, type QueuePayload, type ValidQueueName } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { debug } from './util.js';

interface CloudTasksConfig {
  client?: CloudTasksClient;
  firestore?: Firestore;
  project: string;
  location: string;
  queueName: string;
  targetUrl: string;
  deploymentId: string;
  /**
   * Base URL the in-process test pump uses to dispatch jobs back to the user's
   * HTTP server in test mode. Has no effect in production (Cloud Tasks is
   * push-based).
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;
  /** Per-job HTTP request timeout (ms) for the test pump. Default: 300_000 */
  httpTimeoutMs?: number;
  /** Maximum retry attempts in the test pump before dropping a job. Default: 5 */
  maxAttempts?: number;
  /** Base backoff delay (ms) for test pump retries. Default: 1000 */
  backoffDelayMs?: number;
}

interface PumpEnvelope {
  messageId: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
  /** Dedup key held while the message is inflight (queued, dispatching, or backing off). */
  idempotencyKey?: string;
}

/** v5 has a single queue kind; flow is the only pathname. */
type Pathname = 'flow';
const QUEUE_PATHNAME = 'flow';

/**
 * How long processed-task dedup markers stay relevant. Cloud Tasks only
 * deduplicates task names for ~1h after completion, so 24h of marker
 * retention is comfortably conservative. Configure a Firestore TTL policy
 * on `processed_tasks.expiresAt` to garbage-collect markers.
 */
const PROCESSED_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sanitize a string for use as a Cloud Tasks task name.
 * Cloud Tasks names allow [a-zA-Z0-9_-] up to 500 chars.
 */
function sanitizeTaskName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 500);
}

/**
 * gRPC status code 6 (ALREADY_EXISTS) — Cloud Tasks rejects a duplicate task
 * name within ~1h of completion, which is our dedup signal.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const error = err as { code?: number; message?: string };
    return error.code === 6 || (error.message?.includes('ALREADY_EXISTS') ?? false);
  }
  return false;
}

function resolveBaseUrl(config: CloudTasksConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * In-process test pump used when no Cloud Tasks client is configured. Replaces
 * the previous `@workflow/world-local` fallback. Two in-memory FIFOs feed an
 * HTTP dispatcher that targets `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 */
function createTestPump(config: CloudTasksConfig) {
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const maxAttempts = config.maxAttempts ?? 5;
  const baseBackoffMs = config.backoffDelayMs ?? 1000;

  const queues: Record<Pathname, PumpEnvelope[]> = { flow: [] };
  const wakers: Record<Pathname, Array<() => void>> = { flow: [] };
  let running = false;

  /**
   * Inflight messages by idempotency key. The runtime re-enqueues pending
   * steps on every workflow replay with `idempotencyKey: stepId` and relies
   * on the queue to dedupe — without this, a step gets delivered (and
   * executed) concurrently multiple times, appending duplicate step events
   * that corrupt the event log on replay.
   */
  const inflightMessages = new Map<string, string>();

  function settle(envelope: PumpEnvelope) {
    if (envelope.idempotencyKey) {
      inflightMessages.delete(envelope.idempotencyKey);
    }
  }

  function enqueue(pathname: Pathname, envelope: PumpEnvelope) {
    queues[pathname].push(envelope);
    wakers[pathname].shift()?.();
  }

  async function take(pathname: Pathname): Promise<PumpEnvelope | null> {
    const existing = queues[pathname].shift();
    if (existing) return existing;
    return new Promise((resolve) => {
      wakers[pathname].push(() => resolve(queues[pathname].shift() ?? null));
    });
  }

  /**
   * Retry a failed delivery with exponential backoff, or drop it once
   * maxAttempts is exhausted. Fetch-level exceptions (connection refused,
   * timeouts) take this path too — a transient network error must not
   * permanently swallow the message.
   */
  function retryOrDrop(envelope: PumpEnvelope, pathname: Pathname, reason: string) {
    if (envelope.attempt < maxAttempts) {
      const next: PumpEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
      const backoff = baseBackoffMs * 2 ** (next.attempt - 1);
      void delay(backoff).then(() => enqueue(pathname, next));
    } else {
      settle(envelope);
      console.error(
        `[world-firestore-tasks test pump] dropping ${envelope.messageId} after ${envelope.attempt} attempts: ${reason}`,
      );
    }
  }

  async function dispatch(envelope: PumpEnvelope, pathname: Pathname): Promise<void> {
    const url = `${resolveBaseUrl(config)}/.well-known/workflow/v1/${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': envelope.queueName,
          'x-vqs-message-id': envelope.messageId,
          'x-vqs-message-attempt': String(envelope.attempt),
        },
        // Tagged-JSON transport: preserves Uint8Array payloads (runInput)
        // across the queue boundary, required for SPEC_VERSION_CURRENT.
        body: stringify(envelope.message),
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
    } catch (err) {
      retryOrDrop(envelope, pathname, `fetch error: ${String(err)}`);
      return;
    }

    if (response.ok) {
      settle(envelope);
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
      const timeoutSeconds = (parsed as { timeoutSeconds?: number } | null)?.timeoutSeconds;
      if (typeof timeoutSeconds === 'number') {
        void delay(timeoutSeconds * 1000).then(() => enqueue(pathname, envelope));
        return;
      }
    }

    retryOrDrop(envelope, pathname, `HTTP ${response.status}: ${text}`);
  }

  async function loop(pathname: Pathname) {
    while (running) {
      const envelope = await take(pathname);
      if (!envelope) continue;
      try {
        await dispatch(envelope, pathname);
      } catch (err) {
        // dispatch handles fetch errors itself; anything reaching here is a
        // bug in the pump. Re-queue rather than silently dropping.
        console.error(`[world-firestore-tasks test pump] dispatch error on ${pathname}:`, err);
        retryOrDrop(envelope, pathname, `pump error: ${String(err)}`);
      }
    }
  }

  return {
    getInflight(idempotencyKey: string): string | undefined {
      return inflightMessages.get(idempotencyKey);
    },
    push(pathname: Pathname, envelope: PumpEnvelope, delaySeconds?: number) {
      if (envelope.idempotencyKey) {
        inflightMessages.set(envelope.idempotencyKey, envelope.messageId);
      }
      if (delaySeconds && delaySeconds > 0) {
        void delay(delaySeconds * 1000).then(() => enqueue(pathname, envelope));
      } else {
        enqueue(pathname, envelope);
      }
    },
    async start() {
      if (running) return;
      running = true;
      void loop('flow');
    },
    stop() {
      running = false;
      for (const list of Object.values(wakers)) for (const w of list) w();
    },
  };
}

export function createQueue(config: CloudTasksConfig): Queue & {
  start(): Promise<void>;
  processAllQueuedTasks?: () => Promise<void>;
} {
  const { client, firestore, project, location, queueName, targetUrl, deploymentId } = config;

  const generateMessageId = monotonicFactory();
  const testPump = createTestPump(config);

  function isTestMode(): boolean {
    return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;
  }

  const isTestAtConstruct = isTestMode();
  const parent = client?.queuePath(project, location, queueName);

  const createQueueHandler: Queue['createQueueHandler'] = (queueNamePrefix, handler) => {
    if (isTestAtConstruct) {
      return async (req: Request) => {
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
    }

    // Production: Cloud Tasks delivery wire format with Firestore-backed
    // idempotent-consumer guard (Cloud Tasks is at-least-once).
    return async (req: Request) => {
      try {
        const url = new URL(req.url);
        const receivedQueueName = url.pathname.split('/').pop() as ValidQueueName;

        if (!receivedQueueName.startsWith(queueNamePrefix)) {
          return new Response('Invalid queue', { status: 400 });
        }

        const message = parse<unknown>(await req.text());

        const taskName = req.headers.get('X-CloudTasks-TaskName') || '';
        const taskId = taskName.split('/').pop() || Date.now().toString();
        const attemptStr = req.headers.get('X-CloudTasks-TaskExecutionCount') || '0';
        const attempt = Number.parseInt(attemptStr, 10) + 1;

        // Dedup check only — the marker is written AFTER the handler
        // succeeds. Writing it up front would permanently swallow the
        // message when the handler fails: Cloud Tasks redelivers, the guard
        // sees the marker, and acks without running the handler.
        const processedRef =
          firestore && taskName
            ? firestore.collection('processed_tasks').doc(sanitizeTaskName(taskId))
            : undefined;
        if (processedRef) {
          const snap = await processedRef.get();
          if (snap.exists) {
            debug('duplicate task delivery, ignoring', { taskName, taskId });
            return new Response('OK', { status: 200 });
          }
        }

        const result = await handler(message, {
          attempt,
          queueName: receivedQueueName,
          messageId: MessageId.parse(`msg_${taskId}`),
        });

        // { timeoutSeconds } is core's retry/sleep signal: the message must
        // be redelivered after the delay (workflow suspension, step retry
        // backoff, TooEarlyError). Schedule a fresh task — an unnamed task
        // is not subject to name-based dedup, and the original delivery can
        // safely be acked below.
        if (result && typeof result.timeoutSeconds === 'number') {
          if (!client) throw new Error('Cloud Tasks client not initialized');
          const delaySeconds = Math.max(0, Math.ceil(result.timeoutSeconds));
          await client.createTask({
            parent,
            task: {
              httpRequest: {
                url: req.url,
                httpMethod: 'POST' as const,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(stringify(message)).toString('base64'),
              },
              scheduleTime: {
                seconds: Math.floor(Date.now() / 1000) + delaySeconds,
              },
            },
          });
        }

        // Mark this delivery processed only now that the handler (and any
        // redelivery scheduling) has succeeded, so failed deliveries retry.
        if (processedRef) {
          await processedRef.set({
            taskName,
            processedAt: new Date(),
            expiresAt: new Date(Date.now() + PROCESSED_TASK_TTL_MS),
          });
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        // Non-2xx → Cloud Tasks redelivers with backoff. The processed_tasks
        // marker was not written, so the retry will run the handler again.
        return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
      }
    };
  };

  return {
    async queue(name, message, opts) {
      if (isTestMode()) {
        void parseQueueName(name);
        if (opts?.idempotencyKey) {
          const existing = testPump.getInflight(opts.idempotencyKey);
          if (existing) {
            return { messageId: MessageId.parse(existing) };
          }
        }
        const messageId = MessageId.parse(`msg_${generateMessageId()}`);
        testPump.push(
          QUEUE_PATHNAME,
          {
            messageId,
            queueName: name,
            attempt: 1,
            message,
            idempotencyKey: opts?.idempotencyKey,
          },
          opts?.delaySeconds,
        );
        return { messageId };
      }

      // Production: Cloud Tasks. Sanitized idempotency key doubles as task
      // name for dedup (ALREADY_EXISTS = dedup hit within ~1h of completion).
      if (!client) throw new Error('Cloud Tasks client not initialized');

      const sanitizedKey = opts?.idempotencyKey ? sanitizeTaskName(opts.idempotencyKey) : undefined;
      const task = {
        httpRequest: {
          url: `${targetUrl}/queue/${name}`,
          httpMethod: 'POST' as const,
          headers: { 'Content-Type': 'application/json' },
          // Tagged-JSON transport: preserves Uint8Array payloads (runInput)
          // across the queue boundary, required for SPEC_VERSION_CURRENT.
          body: Buffer.from(stringify(message)).toString('base64'),
        },
        name: sanitizedKey
          ? client.taskPath(project, location, queueName, sanitizedKey)
          : undefined,
        scheduleTime: opts?.delaySeconds
          ? { seconds: Math.floor(Date.now() / 1000) + opts.delaySeconds }
          : undefined,
      };

      try {
        const [response] = await client.createTask({ parent, task });

        // projects/PROJECT/locations/LOCATION/queues/QUEUE/tasks/TASK_ID
        const taskId = (response.name || '').split('/').pop() || '';
        const messageId = MessageId.parse(`msg_${taskId}`);

        return { messageId };
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          debug('duplicate task name (dedup hit)', { idempotencyKey: opts?.idempotencyKey });
          const messageId = MessageId.parse(`msg_${sanitizedKey || 'dedup'}`);
          return { messageId };
        }
        throw err;
      }
    },

    createQueueHandler,

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTestAtConstruct) {
        await testPump.start();
      }
      // Production: Cloud Tasks is push-based, nothing to start.
    },
  };
}
