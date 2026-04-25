import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require('../gitnexus/package.json');

export default defineConfig({
  plugins: [react()],
  define: {
    __REQUIRED_NODE_VERSION__: JSON.stringify(gitnexusPkg.engines.node.replace(/[>=^~\s]/g, '')),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(
        __dirname,
        'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs',
      ),
      mermaid: path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/workers/**', // Web workers (require worker env)
        'src/core/lbug/**', // WASM (requires SharedArrayBuffer)
        'src/core/tree-sitter/**', // WASM (requires tree-sitter binaries)
        'src/core/embeddings/**', // WASM (requires ML model)
        'src/main.tsx', // Entry point
        'src/vite-env.d.ts', // Type declarations
      ],
      // Thresholds set to the post-vitest-4 baseline (AST-aware remapping
      // measures coverage more accurately than the old istanbul-style mapping,
      // so the same 220 tests now report slightly lower percentages). These
      // are soft floors for regression detection, not coverage targets.
      thresholds: {
        statements: 9,
        branches: 4,
        functions: 7,
        lines: 9,
      },
    },
  },
});
