import { setTimeout as delay } from 'node:timers/promises';
import type { Firestore } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import type { Queue } from '@workflow/world';
import {
  MessageId,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
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
}

type Pathname = 'flow' | 'step';

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, Pathname>;

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

  const queues: Record<Pathname, PumpEnvelope[]> = { flow: [], step: [] };
  const wakers: Record<Pathname, Array<() => void>> = { flow: [], step: [] };
  let running = false;

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

  async function dispatch(envelope: PumpEnvelope, pathname: Pathname): Promise<void> {
    const url = `${resolveBaseUrl(config)}/.well-known/workflow/v1/${pathname}`;
    const response = await fetch(url, {
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

    if (response.ok) return;

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

    if (envelope.attempt < maxAttempts) {
      const next: PumpEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
      const backoff = baseBackoffMs * 2 ** (next.attempt - 1);
      void delay(backoff).then(() => enqueue(pathname, next));
    } else {
      console.error(
        `[world-firestore-tasks test pump] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
      );
    }
  }

  async function loop(pathname: Pathname) {
    while (running) {
      const envelope = await take(pathname);
      if (!envelope) continue;
      try {
        await dispatch(envelope, pathname);
      } catch (err) {
        console.error(`[world-firestore-tasks test pump] dispatch error on ${pathname}:`, err);
      }
    }
  }

  return {
    push(pathname: Pathname, envelope: PumpEnvelope) {
      enqueue(pathname, envelope);
    },
    async start() {
      if (running) return;
      running = true;
      void loop('flow');
      void loop('step');
    },
    stop() {
      running = false;
      for (const list of Object.values(wakers)) for (const w of list) w();
    },
  };
}

function parseQueuePrefix(name: ValidQueueName): QueuePrefix {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const p of prefixes) {
    if (name.startsWith(p)) return p;
  }
  throw new Error(`Invalid queue name: ${name}`);
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
    }

    // Production: Cloud Tasks delivery wire format with Firestore-backed
    // idempotent-consumer guard (Cloud Tasks is at-least-once).
    return async (req: Request) => {
      try {
        const url = new URL(req.url);
        const receivedQueueName = url.pathname.split('/').pop() as
          | `__wkf_workflow_${string}`
          | `__wkf_step_${string}`;

        if (!receivedQueueName.startsWith(queueNamePrefix)) {
          return new Response('Invalid queue', { status: 400 });
        }

        const message = await req.json();

        const taskName = req.headers.get('X-CloudTasks-TaskName') || '';
        const taskId = taskName.split('/').pop() || Date.now().toString();
        const attemptStr = req.headers.get('X-CloudTasks-TaskExecutionCount') || '0';
        const attempt = Number.parseInt(attemptStr, 10) + 1;

        if (firestore && taskName) {
          const wasProcessed = await firestore.runTransaction(async (tx) => {
            const ref = firestore.collection('processed_tasks').doc(sanitizeTaskName(taskId));
            const snap = await tx.get(ref);
            if (snap.exists) return true;

            tx.set(ref, {
              taskName,
              processedAt: new Date(),
            });
            return false;
          });

          if (wasProcessed) {
            debug('duplicate task delivery, ignoring', { taskName, taskId });
            return new Response('OK', { status: 200 });
          }
        }

        await handler(message, {
          attempt,
          queueName: receivedQueueName,
          messageId: MessageId.parse(`msg_${taskId}`),
        });

        return new Response('OK', { status: 200 });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
      }
    };
  };

  return {
    async queue(name, message, opts) {
      if (isTestMode()) {
        const queuePrefix = parseQueuePrefix(name);
        const messageId = MessageId.parse(`msg_${generateMessageId()}`);
        testPump.push(QUEUE_PATHNAMES[queuePrefix], {
          messageId,
          queueName: name,
          attempt: 1,
          message,
        });
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
          body: Buffer.from(JSON.stringify(message)).toString('base64'),
        },
        name: sanitizedKey
          ? client.taskPath(project, location, queueName, sanitizedKey)
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
