import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Durable Object classes. The world reaches them over `env.WORKFLOW_DB`
    // RPC, so only a consumer's own entrypoint can register them.
    worker: 'src/worker.ts',
  },
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
