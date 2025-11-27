import { createTestSuite } from '@workflow/world-testing';
import { beforeAll, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';

// Test the actual Cloudflare world implementation
// Uses mocked Cloudflare APIs but tests real routing logic
test('smoke', () => {});

// Mock Cloudflare environment
const mockQueue = {
  send: vi.fn().mockResolvedValue(undefined),
  sendBatch: vi.fn().mockResolvedValue(undefined),
};

const mockStreamDO = {
  fetch: vi.fn(async () => new Response('OK', { status: 200 })),
};

const mockWorkflowDB = {
  idFromName: vi.fn((name: string) => ({ toString: () => name })),
  get: vi.fn(() => ({
    getRun: vi.fn().mockResolvedValue(null),
    createRun: vi.fn().mockResolvedValue({
      runId: 'test-run',
      status: 'pending',
      createdAt: new Date(),
    }),
    updateRun: vi.fn(),
    createStep: vi.fn(),
    getStep: vi.fn(),
    updateStep: vi.fn(),
    listSteps: vi.fn().mockResolvedValue({ data: [] }),
    createEvent: vi.fn(),
    listEvents: vi.fn().mockResolvedValue({ data: [] }),
    createHook: vi.fn(),
    listHooks: vi.fn().mockResolvedValue({ data: [] }),
  })),
};

const mockEnv = {
  WORKFLOW_QUEUE: mockQueue,
  WORKFLOW_STREAMS: {
    idFromName: vi.fn((name: string) => ({ toString: () => name })),
    get: vi.fn(() => mockStreamDO),
  },
  WORKFLOW_DB: mockWorkflowDB,
};

beforeAll(() => {
  // Set test mode to ensure embedded world is used for orchestration
  process.env.VITEST = 'true';
});

// Test the Cloudflare world implementation
// In test mode, this uses embedded world internally but goes through
// our Cloudflare-specific routing and configuration
createTestSuite(() =>
  createWorld({
    env: mockEnv,
    deploymentId: 'test-deployment',
  })
);
