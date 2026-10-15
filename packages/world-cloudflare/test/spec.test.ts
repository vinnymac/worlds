import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestSuite } from '@workflow/world-testing';
// Opt-in suite: it asserts the world honours WORKFLOW_MAX_EVENTS via
// EventResult.maxEvents.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { beforeAll, test } from 'vitest';

// The suite spawns a Node server that loads `WORKFLOW_TARGET_WORLD` and calls
// its `createWorld()` with no arguments. test/conformance/harness.ts supplies
// the Durable Object, KV, and Queue bindings from the in-memory mocks, which
// run the production `applyEvent` core; it is bundled to plain JS first so the
// server can import it. Real workerd coverage is in test/real-workers.test.ts.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = join(packageDir, '.conformance', 'harness.js');

beforeAll(() => {
  execFileSync('pnpm', ['exec', 'tsdown', '--config', 'tsdown.conformance.config.ts'], {
    cwd: packageDir,
    stdio: 'ignore',
  });
}, 60_000);

test('smoke', () => {});
createTestSuite(harness);
eventLimit(harness);
