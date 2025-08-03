import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es'
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: {
      allow: ['..']
    },
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    },
    hmr: {
      overlay: false
    }
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
      defaultIsModuleExports: true
    }
  },
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      'node:async_hooks': path.resolve(__dirname, 'src/lib/polyfills.ts'),
      'async_hooks': path.resolve(__dirname, 'src/lib/polyfills.ts')
    }
  },
  optimizeDeps: {
    exclude: ['@langchain/langgraph'],
    include: [
      'camelcase', 
      'decamelize', 
      'ansi-styles',
      'chalk',
      'supports-color',
      'p-queue',
      'p-retry',
      'semver',
      'base64-js',
      'num-sort',
      'binary-search',
      'js-tiktoken',
      'uuid',
      'ms',
      'retry',
      'p-timeout',
      'p-finally',
      'eventemitter3',
      'web-tree-sitter',
      'comlink'
    ],
    force: true,
    holdUntilCrawlEnd: true
  }
})