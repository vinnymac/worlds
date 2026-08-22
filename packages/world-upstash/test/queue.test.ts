import type { MessageId, QueuePayload, QueuePrefix, ValidQueueName } from '@workflow/world';
import { Client } from '@upstash/qstash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from '../src/util.js';
import { createQueue } from '../src/queue.js';

const QUEUE_NAME = '__wkf_workflow_test' as ValidQueueName;
const QUEUE_PREFIX = '__wkf_workflow_' as QueuePrefix;
const TARGET_URL = 'https://example.com/api/workflow';

interface PublishedBody {
  queueName: ValidQueueName;
  message: unknown;
  messageId: MessageId;
  deliveryCount?: number;
  republishCount?: number;
}

interface HandlerMeta {
  attempt: number;
  queueName: ValidQueueName;
  messageId: MessageId;
  requestId?: string;
}

function makeQueue() {
  const client = new Client({ token: 'test-token' });
  const publishSpy = vi
    .spyOn(client, 'publish')
    .mockResolvedValue({ messageId: 'qstash-msg-1', url: TARGET_URL });
  const queue = createQueue({
    client,
    token: 'test-token',
    targetUrl: TARGET_URL,
  });
  return { queue, publishSpy };
}

function publishedRequest(publishSpy: ReturnType<typeof makeQueue>['publishSpy'], call = 0) {
  const request = publishSpy.mock.calls[call][0];
  return {
    request,
    body: parse<PublishedBody>(String(request.body)),
  };
}

function deliveryRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('QStash queue', () => {
  describe('queue()', () => {
    it('passes opts.idempotencyKey through as the QStash deduplicationId', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
        idempotencyKey: 'step-abc',
      });

      const { request } = publishedRequest(publishSpy);
      expect(request.deduplicationId).toBe('step-abc');
    });

    it('does not set a deduplicationId when no idempotencyKey is provided', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      expect(request.deduplicationId).toBeUndefined();
    });

    it('round-trips Uint8Array message payloads through the queue body', async () => {
      const { queue, publishSpy } = makeQueue();
      const binary = new Uint8Array([1, 2, 3, 250]);
      await queue.queue(QUEUE_NAME, {
        runId: 'wrun_1',
        runInput: {
          input: [binary],
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          specVersion: 4,
        },
      } as QueuePayload);

      const { body } = publishedRequest(publishSpy);
      const message = body.message as { runInput: { input: unknown[] } };
      expect(message.runInput.input[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(message.runInput.input[0] as Uint8Array)).toEqual([1, 2, 3, 250]);
    });

    it('passes delaySeconds through as QStash delay', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, { delaySeconds: 30 });

      const { request } = publishedRequest(publishSpy);
      expect(request.delay).toBe(30);
    });

    it('defaults the QStash retry budget to 47 (48 total deliveries)', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      // 47 retries + 1 initial delivery = 48 = core's MAX_QUEUE_DELIVERIES.
      expect(request.retries).toBe(47);
    });

    it('honors a custom retries config on publish', async () => {
      const client = new Client({ token: 'test-token' });
      const publishSpy = vi
        .spyOn(client, 'publish')
        .mockResolvedValue({ messageId: 'qstash-msg-1', url: TARGET_URL });
      const queue = createQueue({
        client,
        token: 'test-token',
        targetUrl: TARGET_URL,
        retries: 10,
      });

      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      expect(request.retries).toBe(10);
    });
  });

  describe('createQueueHandler()', () => {
    it('reports a 1-based attempt derived from upstash-retried', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const calls: { message: unknown; meta: HandlerMeta }[] = [];
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (message, meta) => {
        calls.push({ message, meta });
      });

      let response = await httpHandler(deliveryRequest(String(request.body)));
      expect(response.status).toBe(200);
      expect(calls[0].message).toEqual({ runId: 'wrun_1' });
      expect(calls[0].meta.attempt).toBe(1);
      expect(calls[0].meta.queueName).toBe(QUEUE_NAME);

      response = await httpHandler(
        deliveryRequest(String(request.body), { 'upstash-retried': '2' }),
      );
      expect(response.status).toBe(200);
      expect(calls[1].meta.attempt).toBe(3);
    });

    it('republishes the message with the requested delay when the handler returns { timeoutSeconds }', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request, body } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => ({
        timeoutSeconds: 42,
      }));
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledTimes(2);
      const { request: republished, body: republishedBody } = publishedRequest(publishSpy, 1);
      expect(republished.delay).toBe(42);
      // The self-republish gets the same hard-failure retry budget.
      expect(republished.retries).toBe(47);
      // The redelivery must not be swallowed by QStash dedup
      expect(republished.deduplicationId).toBeUndefined();
      // Same logical message. No delivery *failed*, so the attempt counter
      // core sees stays put; only the soft-republish counter moves.
      expect(republishedBody.messageId).toBe(body.messageId);
      expect(republishedBody.message).toEqual({ runId: 'wrun_1' });
      expect(republishedBody.deliveryCount).toBe(0);
      expect(republishedBody.republishCount).toBe(1);
    });

    it('does not let timeoutSeconds republishes inflate attempt toward MAX_QUEUE_DELIVERIES', async () => {
      // Regression: core returns { timeoutSeconds: 0 } to mean "re-invoke me
      // with a fresh replay" (e.g. when the stateUpdatedAt precondition guard
      // exhausts its reloads under concurrent step completion). Counting those
      // as deliveries drove `attempt` past core's MAX_QUEUE_DELIVERIES (48),
      // which failed the run with "exceeded max deliveries (49/48)" even
      // though nothing had actually failed.
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const attempts: number[] = [];
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (_message, meta) => {
        attempts.push(meta.attempt);
        return { timeoutSeconds: 0 };
      });

      // Drive far more soft republishes than core's 48-delivery budget.
      let body = String(publishedRequest(publishSpy).request.body);
      for (let i = 0; i < 60; i++) {
        const response = await httpHandler(deliveryRequest(body));
        expect(response.status).toBe(200);
        body = String(publishedRequest(publishSpy, i + 1).request.body);
      }

      // Every delivery is the first real one; none of them failed.
      expect(attempts).toEqual(Array.from({ length: 60 }, () => 1));
      expect(parse<PublishedBody>(body).deliveryCount).toBe(0);
      expect(parse<PublishedBody>(body).republishCount).toBe(60);
    });

    it('still carries genuine failed deliveries across a timeoutSeconds republish', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const first = publishedRequest(publishSpy);

      const attempts: number[] = [];
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (_message, meta) => {
        attempts.push(meta.attempt);
        return { timeoutSeconds: 0 };
      });

      // QStash redelivered this message twice before it succeeded.
      await httpHandler(deliveryRequest(String(first.request.body), { 'upstash-retried': '2' }));
      const second = publishedRequest(publishSpy, 1);
      expect(attempts).toEqual([3]);
      // The two hard failures persist; the soft republish adds nothing.
      expect(second.body.deliveryCount).toBe(2);

      await httpHandler(deliveryRequest(String(second.request.body)));
      expect(attempts).toEqual([3, 3]);
      expect(publishedRequest(publishSpy, 2).body.deliveryCount).toBe(2);
    });

    it('fails the delivery once a message exceeds the soft-republish safety limit', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request, body } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => ({
        timeoutSeconds: 0,
      }));

      // A message already at the ceiling must not be republished again.
      const atLimit = stringify({ ...body, republishCount: 256 });
      const response = await httpHandler(deliveryRequest(atLimit));

      expect(response.status).toBe(500);
      // Only the original queue() publish; no further soft republish.
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(String(request.body)).toBeTruthy();
    });

    it('does not republish when the handler returns void', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => undefined);
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when the handler throws so QStash retries the delivery', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => {
        throw new Error('storage unavailable');
      });
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(500);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when the republish fails so the delivery is retried', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      publishSpy.mockRejectedValueOnce(new Error('qstash unavailable'));
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => ({
        timeoutSeconds: 5,
      }));
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(500);
    });

    it('round-trips Uint8Array payloads to the handler', async () => {
      const { queue, publishSpy } = makeQueue();
      const binary = new Uint8Array([9, 8, 7]);
      await queue.queue(QUEUE_NAME, {
        runId: 'wrun_1',
        runInput: {
          input: [binary],
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          specVersion: 4,
        },
      } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      let received: unknown;
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (message) => {
        received = message;
      });
      await httpHandler(deliveryRequest(String(request.body)));

      const payload = received as { runInput: { input: unknown[] } };
      expect(payload.runInput.input[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(payload.runInput.input[0] as Uint8Array)).toEqual([9, 8, 7]);
    });
  });
});

describe('loopback queue', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases the dedup reservation when delivery permanently fails', async () => {
    // The pump mirrors QStash dedup with an in-process Set. If it gives up on a
    // message without releasing the key, core's next re-enqueue of that same
    // step is silently swallowed and the run wedges forever. world-redis
    // releases its reservation on final drop for exactly this reason.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    // Keep the expected permanent-failure log out of the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const queue = createQueue({ queueMode: 'loopback', targetUrl: TARGET_URL });

    await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
      idempotencyKey: 'step-abc',
    });
    // Drain the pump's 5 attempts and their 1s linear backoffs.
    await vi.advanceTimersByTimeAsync(10_000);
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Core re-enqueues the same step on the next replay. It must not be dropped.
    await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
      idempotencyKey: 'step-abc',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('still collapses a duplicate enqueue while the delivery is in flight', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createQueue({ queueMode: 'loopback', targetUrl: TARGET_URL });

    await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
      idempotencyKey: 'step-abc',
    });
    await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
      idempotencyKey: 'step-abc',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
