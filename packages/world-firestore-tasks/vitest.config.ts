import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120000, // 120 seconds for slow emulator environments
    hookTimeout: 30000, // 30 seconds for beforeEach/afterEach hooks that clear data
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
  },
});
