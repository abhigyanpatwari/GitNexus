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
  // Production build — split heavy vendor chunks so the initial bundle stays small
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // LLM / LangChain (~500 KB) — only loaded when agent initializes
          'vendor-langchain': [
            'langchain',
            '@langchain/core',
            '@langchain/anthropic',
            '@langchain/openai',
            '@langchain/google-genai',
            '@langchain/ollama',
            '@langchain/langgraph',
          ],
          // Graph rendering (~400 KB)
          'vendor-graph': [
            'sigma',
            'graphology',
            'graphology-layout-forceatlas2',
            'graphology-layout-noverlap',
            'graphology-layout-force',
            '@sigma/edge-curve',
          ],
          // Mermaid diagrams (~300 KB) — lazy-loaded on first diagram render
          'vendor-mermaid': ['mermaid'],
          // Syntax highlighting (~150 KB)
          'vendor-syntax': [
            'react-syntax-highlighter',
          ],
          // Isomorphic-git + FS (~300 KB) — only used during git clone
          'vendor-git': ['isomorphic-git', '@isomorphic-git/lightning-fs'],
          // HuggingFace Transformers (~600 KB) — only used for embeddings
          'vendor-ml': ['@huggingface/transformers'],
          // Markdown rendering stack
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          // React core
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
  // Worker configuration
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
