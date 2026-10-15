import { defineConfig } from 'tsdown';

// Bundles the conformance harness into plain JS that the suite's spawned Node
// server can import. Output is gitignored and rebuilt by test/spec.test.ts.
export default defineConfig({
  entry: { harness: 'test/conformance/harness.ts' },
  format: 'esm',
  dts: false,
  sourcemap: false,
  clean: true,
  outDir: '.conformance',
  outExtensions: () => ({ js: '.js' }),
});
