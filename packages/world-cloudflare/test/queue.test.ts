import type { ValidQueueName } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from '../src/queue.js';

describe('Queue (Cloudflare Queues integration)', () => {
  let mockQueue: any;
  let mockEnv: any;
  let queue: ReturnType<typeof createQueue>;

  // Save original env vars
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // Set up mock Cloudflare Queue
    mockQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };

    mockEnv = {
      WORKFLOW_QUEUE: mockQueue,
    };
  });

  afterEach(() => {
    // Restore env vars
    process.env.VITEST = originalVitest;
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  describe('queue() - Production Mode', () => {
    beforeEach(() => {
      // Ensure production mode
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should queue messages via Cloudflare Queue', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const message = { data: 'test-message' };

      const result = await queue.queue(queueName, message);

      // Should call Cloudflare Queue
      expect(mockQueue.send).toHaveBeenCalledOnce();
      expect(mockQueue.send).toHaveBeenCalledWith({
        queueName,
        message,
        idempotencyKey: undefined,
        timestamp: expect.any(Number),
      });

      // Should return message ID
      expect(result.messageId).toBeDefined();
      expect(result.messageId).toMatch(/^msg_/);
    });

    it('should include idempotency key in message', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const message = { data: 'test' };
      const idempotencyKey = 'unique-key-123';

      await queue.queue(queueName, message, { idempotencyKey });

      expect(mockQueue.send).toHaveBeenCalledWith({
        queueName,
        message,
        idempotencyKey,
        timestamp: expect.any(Number),
      });
    });

    it('should generate message ID from idempotency key', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const idempotencyKey = 'custom-key';

      const result = await queue.queue(queueName, {}, { idempotencyKey });

      expect(result.messageId).toBe(`msg_${idempotencyKey}`);
    });

    it('should generate message ID from timestamp if no idempotency key', async () => {
      const queueName = 'test-queue' as ValidQueueName;

      const result = await queue.queue(queueName, {});

      expect(result.messageId).toMatch(/^msg_\d+$/);
    });

    it('should handle complex message payloads', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const message = {
        nested: {
          object: {
            with: ['arrays', 'and', 'strings'],
          },
        },
        number: 42,
        boolean: true,
      };

      await queue.queue(queueName, message);

      expect(mockQueue.send).toHaveBeenCalledWith(
        expect.objectContaining({
          message,
        })
      );
    });
  });

  describe('queue() - Test Mode', () => {
    beforeEach(() => {
      // Set test mode BEFORE creating queue
      process.env.VITEST = 'true';
    });

    it('should not call Cloudflare Queue in test mode', async () => {
      // Create queue in test mode
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });

      // Register handler for embedded world
      queue.createQueueHandler('test:', vi.fn());

      const queueName = 'test:queue' as ValidQueueName;
      const message = { data: 'test' };

      // Attempt to queue - embedded world will handle it
      try {
        await queue.queue(queueName, message);
      } catch (_err) {
        // Embedded world may throw if no handler, that's OK for this test
        // We're just verifying Cloudflare Queue wasn't called
      }

      // Main assertion: Cloudflare Queue should NOT be called
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it('should detect test mode from NODE_ENV', async () => {
      // Reset VITEST and use NODE_ENV instead
      delete process.env.VITEST;
      process.env.NODE_ENV = 'test';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });

      queue.createQueueHandler('test:', vi.fn());

      try {
        await queue.queue('test:queue' as ValidQueueName, { data: 'test' });
      } catch (_err) {
        // Ignore errors from embedded world
      }

      // Main assertion: Cloudflare Queue should NOT be called
      expect(mockQueue.send).not.toHaveBeenCalled();
    });
  });

  describe('createQueueHandler() - Production Mode', () => {
    beforeEach(() => {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should create handler function', () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      expect(typeof queueHandler).toBe('function');
    });

    it('should invoke handler with correct message', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          queueName: 'workflow:test-queue',
          message: { data: 'test-data' },
        }),
      });

      const response = await queueHandler(request);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        { data: 'test-data' },
        expect.objectContaining({
          queueName: 'workflow:test-queue',
          attempt: 1,
          messageId: expect.stringMatching(/^msg_/),
        })
      );
    });

    it('should extract retry count from headers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        headers: {
          'CF-Queue-Retry-Count': '2',
        },
        body: JSON.stringify({
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
        }),
      });

      await queueHandler(request);

      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          attempt: 3, // Retry count 2 + 1 = attempt 3
        })
      );
    });

    it('should use message ID from headers if available', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        headers: {
          'CF-Queue-Message-Id': 'msg_cloudflare_123',
        },
        body: JSON.stringify({
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
        }),
      });

      await queueHandler(request);

      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          messageId: 'msg_cloudflare_123',
        })
      );
    });

    it('should use idempotency key for message ID if no header', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'custom-key',
        }),
      });

      await queueHandler(request);

      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          messageId: 'msg_custom-key',
        })
      );
    });

    it('should reject messages with invalid queue name prefix', async () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          queueName: 'invalid:test-queue', // Wrong prefix
          message: { data: 'test' },
        }),
      });

      const response = await queueHandler(request);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid queue');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should reject malformed message body', async () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          // Missing queueName and message
          invalid: 'data',
        }),
      });

      const response = await queueHandler(request);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid message format');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
        }),
      });

      const response = await queueHandler(request);

      expect(response.status).toBe(500);
      const errorBody = await response.json();
      expect(errorBody.error).toContain('Handler error');
    });

    it('should accept queue names with exact prefix match', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const request = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          queueName: 'workflow:my-queue',
          message: { data: 'test' },
        }),
      });

      const response = await queueHandler(request);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('createQueueHandler() - Test Mode', () => {
    beforeEach(() => {
      process.env.VITEST = 'true';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should use embedded world handler in test mode', () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      // In test mode, returns embedded world's handler
      expect(typeof queueHandler).toBe('function');
    });
  });

  describe('getDeploymentId()', () => {
    beforeEach(() => {
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'custom-deployment-123',
      });
    });

    it('should return configured deployment ID', async () => {
      const deploymentId = await queue.getDeploymentId();

      expect(deploymentId).toBe('custom-deployment-123');
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should exist and be callable', async () => {
      await expect(queue.start()).resolves.toBeUndefined();
    });

    it('should not throw errors', async () => {
      await queue.start();
      await queue.start(); // Multiple calls should be safe
    });
  });
});
