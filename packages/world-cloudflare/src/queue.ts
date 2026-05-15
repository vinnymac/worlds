import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowWorldError } from '@workflow/errors';
import {
  MessageId,
  type Queue,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { debug } from './util.js';

/**
 * HTTP status codes that indicate permanent (non-retryable) failures.
 * Messages with these errors are acked immediately to avoid wasting retry budget.
 *
 * - 404: Resource not found (e.g., run was deleted)
 * - 409: Conflict (e.g., duplicate event that can't be replayed)
 * - 410: Gone (e.g., run was already terminal)
 * - 422: Unprocessable entity (e.g., invalid payload structure)
 */
const PERMANENT_ERROR_STATUSES = new Set([404, 409, 410, 422]);

function isPermanentError(err: unknown): boolean {
  if (err instanceof WorkflowWorldError && err.status !== undefined) {
    return PERMANENT_ERROR_STATUSES.has(err.status);
  }
  return false;
}

/** Caps at 60 seconds. */
function computeBackoff(attempt: number): number {
  return Math.min(60, 2 ** attempt);
}

export interface CloudflareQueueConfig {
  env: {
    WORKFLOW_QUEUE: CloudflareQueue;
  };
  deploymentId: string;
  /**
   * Base URL the in-process test pump uses to dispatch jobs back to the user's
   * HTTP server in test mode. Has no effect in production (Cloudflare Queues
   * is push-based).
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

interface CloudflareQueue {
  send(message: unknown, options?: { contentType?: string }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
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

function resolveBaseUrl(config: CloudflareQueueConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * In-process test pump. Replaces the previous `@workflow/world-local` fallback.
 * Holds two in-memory FIFOs and HTTP-dispatches envelopes to the user's server
 * at `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 */
function createTestPump(config: CloudflareQueueConfig) {
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
        `[world-cloudflare test pump] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
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
        console.error(`[world-cloudflare test pump] dispatch error on ${pathname}:`, err);
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

export function createQueue(config: CloudflareQueueConfig): Queue & { start(): Promise<void> } {
  const { env, deploymentId } = config;

  const generateMessageId = monotonicFactory();
  const testPump = createTestPump(config);

  function isTestMode(): boolean {
    return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  }

  return {
    async queue(queueName, message, opts) {
      if (isTestMode()) {
        const queuePrefix = parseQueuePrefix(queueName);
        const messageId = MessageId.parse(`msg_${generateMessageId()}`);
        testPump.push(QUEUE_PATHNAMES[queuePrefix], {
          messageId,
          queueName,
          attempt: 1,
          message,
        });
        return { messageId };
      }

      // Production: Cloudflare Queue.
      const wrappedMessage = {
        queueName,
        message,
        idempotencyKey: opts?.idempotencyKey,
        timestamp: Date.now(),
      };

      await env.WORKFLOW_QUEUE.send(wrappedMessage);

      const messageId = MessageId.parse(`msg_${opts?.idempotencyKey || Date.now().toString()}`);
      return { messageId };
    },

    createQueueHandler(queueNamePrefix, handler) {
      if (isTestMode()) {
        // Test mode: x-vqs-* dialect, matches the in-process pump and
        // @workflow/world-testing's mounted routes.
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

      // Production: Cloudflare Queues delivery wire format.
      return async (req: Request) => {
        const retryCount = Number.parseInt(req.headers.get('CF-Queue-Retry-Count') || '0', 10);

        try {
          const body = (await req.json()) as unknown;

          if (
            typeof body !== 'object' ||
            body === null ||
            !('queueName' in body) ||
            !('message' in body)
          ) {
            return new Response('Invalid message format', { status: 400 });
          }

          interface QueueMessage {
            queueName: string;
            message: unknown;
            idempotencyKey?: string;
          }

          const { queueName, message, idempotencyKey } = body as QueueMessage;

          if (!queueName?.startsWith(queueNamePrefix)) {
            return new Response('Invalid queue', { status: 400 });
          }

          const attempt = retryCount + 1;

          const messageIdStr =
            req.headers.get('CF-Queue-Message-Id') || `msg_${idempotencyKey || Date.now()}`;

          await handler(message, {
            attempt,
            queueName: queueName as ValidQueueName,
            messageId: MessageId.parse(messageIdStr),
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          // Permanent vs transient distinction. Permanent errors ack to skip retries.
          if (isPermanentError(error)) {
            const status = (error as WorkflowWorldError).status;
            debug('[Cloudflare Queue Handler] Permanent error, acking message:', {
              status,
              error: String(error),
            });
            return new Response(JSON.stringify({ error: String(error), permanent: true }), {
              status: 200,
            });
          }

          const backoffSeconds = computeBackoff(retryCount);
          debug('[Cloudflare Queue Handler] Transient error, will retry:', {
            error: String(error),
            backoffSeconds,
          });
          return new Response(
            JSON.stringify({
              error: String(error),
              retryAfter: backoffSeconds,
            }),
            {
              status: 500,
              headers: { 'Retry-After': String(backoffSeconds) },
            },
          );
        }
      };
    },

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTestMode()) {
        await testPump.start();
      }
      // Production: Cloudflare Queues is push-based, nothing to start.
    },
  };
}
