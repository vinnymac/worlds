import { setTimeout as delay } from 'node:timers/promises';
import type { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';
import { ServiceBusAdministrationClient } from '@azure/service-bus';
import type { Queue, QueueOptions } from '@workflow/world';
import {
  MessageId,
  parseQueueName,
  type QueueKind,
  type QueuePayload,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';

interface ServiceBusConfig {
  client?: ServiceBusClient;
  queueName?: string;
  deploymentId: string;
  /**
   * Service Bus connection string, used by start() to provision/verify the
   * queue via ServiceBusAdministrationClient. When only a client is injected
   * the queue configuration cannot be introspected.
   */
  connectionString?: string;
  /**
   * Base URL the in-process test pump uses to dispatch jobs back to the user's
   * HTTP server in test mode. Has no effect in production (Service Bus is
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
  idempotencyKey?: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
}

type Pathname = 'flow' | 'step';

const QUEUE_PATHNAMES = {
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, Pathname>;

/** Dedup window for Service Bus duplicate detection (ISO 8601 duration). */
const DUPLICATE_DETECTION_WINDOW = 'PT15M';

function resolveBaseUrl(config: ServiceBusConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * Extract the run id from a queue payload for session-based ordering.
 * Workflow messages carry `runId`, step messages carry `workflowRunId`.
 * https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions
 */
function extractRunId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { runId, workflowRunId } = message as Record<string, unknown>;
  if (typeof runId === 'string') return runId;
  if (typeof workflowRunId === 'string') return workflowRunId;
  return undefined;
}

/**
 * In-process test pump used when no Service Bus client is configured. Replaces
 * the previous `@workflow/world-local` fallback. Two in-memory FIFOs feed an
 * HTTP dispatcher that targets `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 *
 * Message bodies round-trip through the shared tagged-JSON codec so binary
 * payloads (e.g. the CBOR-transport `runInput.input` on workflow messages)
 * survive the queue intact.
 */
function createTestPump(config: ServiceBusConfig) {
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const maxAttempts = config.maxAttempts ?? 5;
  const baseBackoffMs = config.backoffDelayMs ?? 1000;

  const queues: Record<Pathname, PumpEnvelope[]> = { flow: [], step: [] };
  const wakers: Record<Pathname, Array<() => void>> = { flow: [], step: [] };
  /**
   * In-flight messages by idempotency key: enqueueing the same key while a
   * prior message is still being processed returns the original messageId
   * instead of queueing a duplicate (matching world-local semantics).
   */
  const inflightKeys = new Map<string, string>();
  let running = false;

  function settle(envelope: PumpEnvelope) {
    if (envelope.idempotencyKey) {
      inflightKeys.delete(envelope.idempotencyKey);
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

    if (envelope.attempt < maxAttempts) {
      const next: PumpEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
      const backoff = baseBackoffMs * 2 ** (next.attempt - 1);
      void delay(backoff).then(() => enqueue(pathname, next));
    } else {
      settle(envelope);
      console.error(
        `[world-azure test pump] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
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
        settle(envelope);
        console.error(`[world-azure test pump] dispatch error on ${pathname}:`, err);
      }
    }
  }

  return {
    /**
     * Register + enqueue a message. Returns the previously registered
     * messageId when the idempotency key is already in flight.
     */
    push(pathname: Pathname, envelope: PumpEnvelope, delaySeconds?: number): string {
      if (envelope.idempotencyKey) {
        const existing = inflightKeys.get(envelope.idempotencyKey);
        if (existing) return existing;
        inflightKeys.set(envelope.idempotencyKey, envelope.messageId);
      }
      if (delaySeconds && delaySeconds > 0) {
        void delay(delaySeconds * 1000).then(() => enqueue(pathname, envelope));
      } else {
        enqueue(pathname, envelope);
      }
      return envelope.messageId;
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

export function createQueue(config: ServiceBusConfig): Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
} {
  const { client, queueName = 'workflow-queue', deploymentId } = config;

  const generateMessageId = monotonicFactory();
  const testPump = createTestPump(config);

  // Test mode is decided once at construction so that queue(), the handler
  // factory, and start() can never disagree about which transport is active.
  const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;

  let sender: ServiceBusSender | undefined;
  if (client && !isTest) {
    sender = client.createSender(queueName);
  }

  /**
   * Send a message to Service Bus. `idempotencyKey` maps to the Service Bus
   * messageId, which deduplicates only when the queue has duplicate detection
   * enabled — start() provisions/verifies that. The fallback id is a ULID so
   * distinct messages can never collide (Date.now() ties within a millisecond
   * would be silently dropped by duplicate detection).
   */
  async function sendToServiceBus(
    name: ValidQueueName,
    message: QueuePayload,
    opts?: Pick<QueueOptions, 'idempotencyKey' | 'delaySeconds'>,
  ): Promise<MessageId> {
    if (!sender) {
      throw new Error('Service Bus sender not initialized');
    }

    const messageIdValue = opts?.idempotencyKey || `msg_${generateMessageId()}`;
    const messageRunId = extractRunId(message);

    await sender.sendMessages({
      // Tagged-JSON body so Uint8Array payloads (CBOR queue transport)
      // round-trip through the queue intact.
      body: stringify(message),
      messageId: messageIdValue,
      sessionId: messageRunId,
      subject: name,
      ...(opts?.delaySeconds && opts.delaySeconds > 0
        ? { scheduledEnqueueTimeUtc: new Date(Date.now() + opts.delaySeconds * 1000) }
        : {}),
      applicationProperties: {
        queueName: name,
        deploymentId,
      },
    });

    return MessageId.parse(
      messageIdValue.startsWith('msg_') ? messageIdValue : `msg_${messageIdValue}`,
    );
  }

  const createQueueHandler: Queue['createQueueHandler'] = (queueNamePrefix, handler) => {
    if (isTest) {
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

    // Production: Service Bus delivery wire format.
    return async (req: Request) => {
      try {
        const url = new URL(req.url);
        const receivedQueueName = url.pathname.split('/').pop() as ValidQueueName;

        if (!receivedQueueName.startsWith(queueNamePrefix)) {
          return new Response('Invalid queue', { status: 400 });
        }

        const message = parse<QueuePayload>(await req.text());

        const deliveryCount = req.headers.get('X-ServiceBus-DeliveryCount') || '0';
        const attempt = Number.parseInt(deliveryCount, 10) + 1;
        const messageId = req.headers.get('X-ServiceBus-MessageId') || generateMessageId();

        const result = await handler(message, {
          attempt,
          queueName: receivedQueueName,
          messageId: MessageId.parse(`msg_${messageId}`),
        });

        // { timeoutSeconds } is the runtime's suspension/deferral signal
        // (sleep(), TooEarlyError). Re-enqueue the payload with a scheduled
        // delivery time before acking, otherwise the run would never resume.
        // The re-enqueue uses a fresh messageId so duplicate detection does
        // not swallow the deliberate redelivery.
        if (result && typeof result.timeoutSeconds === 'number') {
          await sendToServiceBus(receivedQueueName, message, {
            delaySeconds: result.timeoutSeconds,
          });
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
      }
    };
  };

  return {
    async queue(name, message, opts) {
      if (isTest) {
        const { kind } = parseQueueName(name);
        const messageId = MessageId.parse(`msg_${generateMessageId()}`);
        const effectiveId = testPump.push(
          QUEUE_PATHNAMES[kind],
          {
            messageId,
            idempotencyKey: opts?.idempotencyKey,
            queueName: name,
            attempt: 1,
            message,
          },
          opts?.delaySeconds,
        );
        return { messageId: MessageId.parse(effectiveId) };
      }

      const messageId = await sendToServiceBus(name, message, opts);
      return { messageId };
    },

    createQueueHandler,

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTest) {
        await testPump.start();
        return;
      }

      // Production: Service Bus is push-based via receivers / Azure Functions
      // triggers. Idempotency keys only deduplicate when the queue was created
      // with duplicate detection, so provision/verify it here.
      if (config.connectionString) {
        const admin = new ServiceBusAdministrationClient(config.connectionString);
        if (await admin.queueExists(queueName)) {
          const info = await admin.getQueue(queueName);
          if (!info.requiresDuplicateDetection) {
            throw new Error(
              `[world-azure] Service Bus queue "${queueName}" does not have duplicate detection enabled. ` +
                'Idempotency keys cannot deduplicate messages on this queue — recreate it with ' +
                'requiresDuplicateDetection=true (duplicate detection cannot be enabled after creation).',
            );
          }
        } else {
          await admin.createQueue(queueName, {
            requiresDuplicateDetection: true,
            duplicateDetectionHistoryTimeWindow: DUPLICATE_DETECTION_WINDOW,
          });
        }
      } else {
        console.warn(
          `[world-azure] Cannot verify duplicate detection on Service Bus queue "${queueName}" ` +
            '(no connection string available for the administration client). Ensure the queue was ' +
            'created with requiresDuplicateDetection=true, or idempotency keys will not deduplicate.',
        );
      }
    },

    async close() {
      testPump.stop();
      if (sender) {
        await sender.close();
      }
    },
  };
}
