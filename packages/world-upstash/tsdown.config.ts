import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
