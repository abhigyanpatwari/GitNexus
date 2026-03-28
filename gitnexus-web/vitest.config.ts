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
      thresholds: {
        statements: 10,
        branches: 10,
        functions: 10,
        lines: 10,
      },
    },
  },
});
