import { createTestSuite } from '@workflow/world-testing';
import { beforeAll, test } from 'vitest';
import { createWorld } from '../src/index.js';
import { createMockEnv } from '../src/test-mocks.js';

// Test the actual Cloudflare world implementation
// Uses mocked Cloudflare APIs but tests real routing logic
test('smoke', () => {});

beforeAll(() => {
  // Set test mode to ensure embedded world is used for orchestration
  process.env.VITEST = 'true';
});

// Test the Cloudflare world implementation
// In test mode, this uses the in-process test pump for queue dispatch but
// goes through the real storage / streamer code against the shared mocks.
createTestSuite(() =>
  createWorld({
    env: createMockEnv(),
    deploymentId: 'test-deployment',
  }),
);
