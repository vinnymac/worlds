import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/packaging/**/*.test.ts'],
    // Packing ten workspaces and spawning a Node probe each is slow by nature.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
