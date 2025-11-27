import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      'test/real-workers.test.ts', // Exclude Workers-specific tests (use test:workers)
      'test/spec.test.ts', // Exclude - World Testing HTTP server not applicable to Workers runtime
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
  },
});
