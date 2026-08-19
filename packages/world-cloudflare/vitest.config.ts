import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      'test/real-workers.test.ts', // Workers-specific tests (use test:workers)
      // test/spec.test.ts is excluded because it does not currently work, not
      // as a policy choice. It calls createTestSuite() with a world factory
      // closure, but the signature is createTestSuite(pkgName: string): the
      // harness spawns a Node child process and resolves the world by package
      // name from WORKFLOW_TARGET_WORLD, so a closure cannot reach it and the
      // server handshake never arrives ("Server did not start correctly").
      // Making it run needs world-cloudflare to be constructible by getWorld()
      // in plain Node against a mock DO env -- real work, not a config flip.
      // See the conformance-gap follow-up before deleting or re-enabling.
      'test/spec.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
  },
});
