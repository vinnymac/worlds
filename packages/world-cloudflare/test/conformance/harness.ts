/**
 * Conformance-suite entry for `@workflow/world-testing`.
 *
 * The suite spawns a plain Node server and loads the World named by
 * `WORKFLOW_TARGET_WORLD`, calling `createWorld()` with no arguments. A
 * Cloudflare World cannot build its own Durable Object, KV, and Queue bindings
 * in Node, so this entry supplies the in-memory bindings from `test-mocks`.
 * The mock Durable Object runs the same `applyEvent` transaction core as the
 * real `WorkflowRunDO`, and serializes calls per run the way a Durable Object
 * does. Queue delivery goes through the World's in-process test pump, which is
 * active because the spawned server inherits `VITEST`.
 */
import { createCloudflareWorld } from '../../src/index.js';
import { createMockEnv } from '../../src/test-mocks.js';

export function createWorld() {
  return createCloudflareWorld({ env: createMockEnv() });
}
