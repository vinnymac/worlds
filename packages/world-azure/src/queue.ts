import { setTimeout as delay } from 'node:timers/promises';
import type { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';
import type { Queue } from '@workflow/world';
import {
  MessageId,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

interface ServiceBusConfig {
  client?: ServiceBusClient;
  queueName?: string;
  deploymentId: string;
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
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
}

type Pathname = 'flow' | 'step';

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, Pathname>;

function resolveBaseUrl(config: ServiceBusConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * In-process test pump used when no Service Bus client is configured. Replaces
 * the previous `@workflow/world-local` fallback. Two in-memory FIFOs feed an
 * HTTP dispatcher that targets `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 */
function createTestPump(config: ServiceBusConfig) {
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
        console.error(`[world-azure test pump] dispatch error on ${pathname}:`, err);
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

export function createQueue(config: ServiceBusConfig): Queue & {
  start(): Promise<void>;
  processAllQueuedTasks?: () => Promise<void>;
} {
  const { client, queueName = 'workflow-queue', deploymentId } = config;

  const generateMessageId = monotonicFactory();
  const testPump = createTestPump(config);

  // Test mode is determined once at construction time *and* re-evaluated per-call,
  // matching the previous behaviour where tests could mutate env after createQueue.
  function isTestMode(): boolean {
    return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;
  }

  const isTestAtConstruct = isTestMode();

  let sender: ServiceBusSender | undefined;
  if (client && !isTestAtConstruct) {
    sender = client.createSender(queueName);
  }

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

    // Production: Service Bus delivery wire format.
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

        const deliveryCount = req.headers.get('X-ServiceBus-DeliveryCount') || '0';
        const attempt = Number.parseInt(deliveryCount, 10) + 1;
        const messageId = req.headers.get('X-ServiceBus-MessageId') || Date.now().toString();

        await handler(message, {
          attempt,
          queueName: receivedQueueName,
          messageId: MessageId.parse(`msg_${messageId}`),
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

      // Production: Service Bus.
      if (!sender) {
        throw new Error('Service Bus sender not initialized');
      }

      const messageIdValue = opts?.idempotencyKey || `msg_${Date.now()}`;

      // Extract runId for session-based ordering.
      // https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions
      const messageRunId =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).runId
          : undefined;

      await sender.sendMessages({
        body: message,
        messageId: messageIdValue,
        sessionId: typeof messageRunId === 'string' ? messageRunId : undefined,
        subject: name,
        applicationProperties: {
          queueName: name,
          deploymentId,
        },
      });

      return { messageId: MessageId.parse(`msg_${messageIdValue}`) };
    },

    createQueueHandler,

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTestAtConstruct) {
        await testPump.start();
      }
      // Production: Service Bus is push-based via receivers / Azure Functions triggers.
    },
  };
}
