import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require('../gitnexus/package.json');

const nodeModulePattern = (packages: string[]) =>
  new RegExp(`node_modules[\\\\/](${packages.join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __REQUIRED_NODE_VERSION__: JSON.stringify(gitnexusPkg.engines.node.replace(/[>=^~\s]/g, '')),
  },
  build: {
    // Mermaid and the markdown/unified stack both contain tightly-coupled
    // module graphs. Keeping markdown together avoids startup-time circular
    // chunk evaluation crashes, while this budget still flags genuinely large
    // app/vendor regressions.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: nodeModulePattern(['react', 'react-dom', 'scheduler']),
              priority: 100,
            },
            {
              name: 'graph-vendor',
              test: nodeModulePattern([
                '@sigma',
                'sigma',
                'graphology',
                'graphology-.*',
                'three',
                'd3',
                'd3-.*',
                'mnemonist',
                'pandemonium',
              ]),
              priority: 90,
              maxSize: 450 * 1024,
            },
            {
              name: 'mermaid-vendor',
              test: nodeModulePattern(['mermaid', 'dompurify', 'katex']),
              priority: 85,
            },
            {
              name: 'markdown-vendor',
              test: nodeModulePattern([
                'react-markdown',
                'react-syntax-highlighter',
                'remark-gfm',
                'remark-.*',
                'rehype-.*',
                'unified',
                'micromark',
                'mdast-.*',
                'hast-.*',
                'lowlight',
                'highlight\\.js',
              ]),
              priority: 80,
            },
            {
              name: 'llm-vendor',
              test: nodeModulePattern(['@langchain', 'langchain', 'zod']),
              priority: 75,
              maxSize: 450 * 1024,
            },
            {
              name: 'icons-vendor',
              test: nodeModulePattern(['lucide-react']),
              priority: 70,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
              maxSize: 450 * 1024,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
      'gitnexus-shared': path.resolve(__dirname, '../gitnexus-shared/src/index.ts'),
      // Fix for Rollup failing to resolve this deep import from @langchain/anthropic
      '@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(
        __dirname,
        'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs',
      ),
      // Fix for mermaid d3-color prototype crash on Vercel (known issue with mermaid 10.9.0+ and Vite)
      mermaid: path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  server: {
    // Allow serving files from node_modules
    fs: {
      allow: ['..'],
    },
  },
});
