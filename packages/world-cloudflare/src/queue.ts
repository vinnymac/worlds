import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowWorldError } from '@workflow/errors';
import { MessageId, type Queue, type QueuePayload, type ValidQueueName } from '@workflow/world';
import { parse, stringify } from '@fantasticfour/shared';
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

/**
 * How long a consumer-side dedup claim blocks other messages carrying the
 * same idempotencyKey. Stale claims (holder crashed or the message went to
 * the DLQ without releasing) are stolen after this window so replay
 * re-enqueues cannot be stranded forever.
 */
const DEDUP_CLAIM_STALE_MS = 15 * 60 * 1000;

export interface CloudflareQueueConfig {
  env: {
    WORKFLOW_QUEUE: CloudflareQueue;
    /**
     * Durable Object namespace used for consumer-side idempotency claims
     * (one claim DO per `claim:<queueName>:<idempotencyKey>`).
     */
    WORKFLOW_DB: InflightClaimNamespace;
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
  send(
    body: string,
    options?: { contentType?: 'text' | 'json'; delaySeconds?: number },
  ): Promise<void>;
}

/** Subset of the WorkflowRunDO RPC surface used for queue dedup claims. */
export interface InflightClaimStub {
  claimInflight(params: { messageId: string; staleMs: number }): Promise<{ claimed: boolean }>;
  releaseInflight(): Promise<void>;
}

export interface InflightClaimNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): InflightClaimStub;
}

/**
 * Wire format for messages on the Cloudflare Queue (and the HTTP push from a
 * queue consumer Worker to the workflow endpoint). Serialized with the shared
 * tagged-JSON codec so binary payloads (`runInput.input` at spec >= 3 is a
 * Uint8Array) survive the round-trip — plain JSON.stringify would mangle them.
 */
interface QueueEnvelope {
  messageId: string;
  queueName: ValidQueueName;
  message: QueuePayload;
  idempotencyKey?: string;
  timestamp: number;
}

interface PumpEnvelope {
  messageId: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
  idempotencyKey?: string;
}

/** v5 has a single queue kind; flow is the only pathname. */
type Pathname = 'flow';
const QUEUE_PATHNAME = 'flow';

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
 *
 * Mirrors world-local's idempotency semantics: messages are deduplicated on
 * `idempotencyKey` while a message with the same key is in flight, and the
 * key is released only when the message is fully handled (success or drop).
 */
function createTestPump(config: CloudflareQueueConfig) {
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const maxAttempts = config.maxAttempts ?? 5;
  const baseBackoffMs = config.backoffDelayMs ?? 1000;

  const queues: Record<Pathname, PumpEnvelope[]> = { flow: [] };
  const wakers: Record<Pathname, Array<() => void>> = { flow: [] };
  /** Inflight messageIds by idempotencyKey (world-local queue.js semantics). */
  const inflightMessages = new Map<string, MessageId>();
  let running = false;

  function release(envelope: PumpEnvelope) {
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
      body: stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });

    if (response.ok) {
      release(envelope);
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
        // Same message re-delivered later: the idempotency key stays claimed.
        void delay(timeoutSeconds * 1000).then(() => enqueue(pathname, envelope));
        return;
      }
    }

    if (envelope.attempt < maxAttempts) {
      const next: PumpEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
      const backoff = baseBackoffMs * 2 ** (next.attempt - 1);
      void delay(backoff).then(() => enqueue(pathname, next));
    } else {
      release(envelope);
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
        release(envelope);
        console.error(`[world-cloudflare test pump] dispatch error on ${pathname}:`, err);
      }
    }
  }

  return {
    /** Returns the inflight messageId when the key is already claimed. */
    inflight(idempotencyKey: string | undefined): MessageId | undefined {
      return idempotencyKey ? inflightMessages.get(idempotencyKey) : undefined;
    },
    push(pathname: Pathname, envelope: PumpEnvelope, delaySeconds?: number) {
      if (envelope.idempotencyKey) {
        inflightMessages.set(envelope.idempotencyKey, MessageId.parse(envelope.messageId));
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

export function createQueue(config: CloudflareQueueConfig): Queue & { start(): Promise<void> } {
  const { env, deploymentId } = config;

  const generateMessageId = monotonicFactory();
  const testPump = createTestPump(config);

  function isTestMode(): boolean {
    return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  }

  const getClaimStub = (queueName: string, idempotencyKey: string): InflightClaimStub => {
    const id = env.WORKFLOW_DB.idFromName(`claim:${queueName}:${idempotencyKey}`);
    return env.WORKFLOW_DB.get(id);
  };

  return {
    async queue(queueName, message, opts) {
      if (isTestMode()) {
        // Dedup on idempotencyKey while a message with the same key is in
        // flight — core re-enqueues every still-pending step on every replay
        // with idempotencyKey = stepId and relies on queue-level dedup.
        const existing = testPump.inflight(opts?.idempotencyKey);
        if (existing) {
          return { messageId: existing };
        }
        const messageId = MessageId.parse(`msg_${generateMessageId()}`);
        testPump.push(
          QUEUE_PATHNAME,
          {
            messageId,
            queueName,
            attempt: 1,
            message,
            idempotencyKey: opts?.idempotencyKey,
          },
          opts?.delaySeconds,
        );
        return { messageId };
      }

      // Production: Cloudflare Queue. Cloudflare Queues does no content
      // dedup, so the idempotencyKey travels in the envelope and is claimed
      // consumer-side before the handler runs (see createQueueHandler).
      const messageId = MessageId.parse(`msg_${generateMessageId()}`);
      const envelope: QueueEnvelope = {
        messageId,
        queueName,
        message,
        idempotencyKey: opts?.idempotencyKey,
        timestamp: Date.now(),
      };

      await env.WORKFLOW_QUEUE.send(stringify(envelope), {
        contentType: 'text',
        delaySeconds: opts?.delaySeconds,
      });

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
            // Tagged-JSON codec: revives Uint8Array payloads (runInput.input).
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

      // Production: Cloudflare Queues delivery wire format. The consumer
      // Worker forwards each queue message body (the tagged-JSON envelope) to
      // this handler and maps the response onto message.ack() / .retry():
      // - 2xx  -> ack
      // - 503 with Retry-After -> retry({ delaySeconds: retryAfter })
      // - other non-2xx -> retry (with Retry-After backoff when present)
      return async (req: Request) => {
        const retryCount = Number.parseInt(req.headers.get('CF-Queue-Retry-Count') || '0', 10);

        let claimStub: InflightClaimStub | undefined;
        try {
          const body = parse<unknown>(await req.text());

          if (
            typeof body !== 'object' ||
            body === null ||
            !('queueName' in body) ||
            !('message' in body)
          ) {
            return new Response('Invalid message format', { status: 400 });
          }

          const envelope = body as Partial<QueueEnvelope> & {
            queueName: string;
            message: unknown;
          };
          const { queueName, message, idempotencyKey } = envelope;

          if (!queueName?.startsWith(queueNamePrefix)) {
            return new Response('Invalid queue', { status: 400 });
          }

          const attempt = retryCount + 1;

          const messageIdStr =
            req.headers.get('CF-Queue-Message-Id') ||
            envelope.messageId ||
            `msg_${idempotencyKey || Date.now()}`;

          // Consumer-side dedup: claim the idempotencyKey before invoking the
          // handler. A redelivery of the SAME message re-enters its own
          // claim; a DIFFERENT message with the same key (replay re-enqueue
          // racing an inflight step) is acked without executing.
          if (idempotencyKey) {
            claimStub = getClaimStub(queueName, idempotencyKey);
            const { claimed } = await claimStub.claimInflight({
              messageId: messageIdStr,
              staleMs: DEDUP_CLAIM_STALE_MS,
            });
            if (!claimed) {
              debug('[Cloudflare Queue Handler] Duplicate message, acking without execution:', {
                queueName,
                idempotencyKey,
                messageId: messageIdStr,
              });
              return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });
            }
          }

          const result = await handler(message, {
            attempt,
            queueName: queueName as ValidQueueName,
            messageId: MessageId.parse(messageIdStr),
          });

          // { timeoutSeconds } means "do NOT ack; redeliver after N seconds"
          // (retryable step errors, ThrottleError deferral). The claim stays
          // held so duplicates are still fenced during the wait.
          if (result && typeof result.timeoutSeconds === 'number') {
            debug('[Cloudflare Queue Handler] Handler requested redelivery:', {
              timeoutSeconds: result.timeoutSeconds,
            });
            return new Response(JSON.stringify({ timeoutSeconds: result.timeoutSeconds }), {
              status: 503,
              headers: { 'Retry-After': String(result.timeoutSeconds) },
            });
          }

          // Release the claim ONLY on successful completion.
          if (claimStub) {
            await claimStub.releaseInflight();
          }

          return new Response('OK', { status: 200 });
        } catch (error) {
          // Permanent vs transient distinction. Permanent errors ack to skip
          // retries; the message is finished, so its claim is released too.
          if (isPermanentError(error)) {
            const status = (error as WorkflowWorldError).status;
            debug('[Cloudflare Queue Handler] Permanent error, acking message:', {
              status,
              error: String(error),
            });
            if (claimStub) {
              await claimStub.releaseInflight();
            }
            return new Response(JSON.stringify({ error: String(error), permanent: true }), {
              status: 200,
            });
          }

          // Transient: keep the claim (the same message redelivers and
          // re-enters it) and signal a retry.
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
