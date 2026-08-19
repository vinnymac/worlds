import { test } from 'vitest';

// The shared conformance suite takes a package name and boots a Node server
// that imports that world itself:
//
//   createTestSuite(pkgName: string)  ->  startServer({ world: pkgName })
//
// There is no seam for injecting a pre-built world, so it cannot supply the
// Durable Object, Queue, and KV bindings `createWorld` needs. Every other world
// passes its own package name; this file passed a factory instead, which
// typechecked only because tests were excluded from `pnpm typecheck` -- the
// suite silently never ran here.
//
// Real Cloudflare coverage lives in test/real-workers.test.ts, which exercises
// actual workerd via @cloudflare/vitest-pool-workers, plus the storage, queue,
// and streamer suites in this directory.
test.todo(
  'conformance suite needs a world-injection seam in @workflow/world-testing to run against workerd',
);
