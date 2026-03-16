import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    // Copy lbug-wasm worker file to assets folder for production
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js',
          dest: 'assets'
        }
      ]
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Fix for Rollup failing to resolve this deep import from @langchain/anthropic
      '@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(__dirname, 'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs'),
      // Fix for mermaid d3-color prototype crash on Vercel (known issue with mermaid 10.9.0+ and Vite)
      'mermaid': path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  // Polyfill Buffer for isomorphic-git (Node.js API needed in browser)
  define: {
    global: 'globalThis',
  },
  // Optimize deps - exclude lbug-wasm from pre-bundling (it has WASM files)
  optimizeDeps: {
    exclude: ['@ladybugdb/wasm-core'],
    include: ['buffer'],
  },
  // Required for LadybugDB WASM (SharedArrayBuffer needs Cross-Origin Isolation)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow serving files from node_modules
    fs: {
      allow: ['..'],
    },
  },
  // Also set for preview/production builds
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Worker configuration
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
