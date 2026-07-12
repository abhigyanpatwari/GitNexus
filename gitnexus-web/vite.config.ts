import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require('../gitnexus/package.json');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Copy selected `tree-sitter-wasms` binaries into `public/wasm/` so
 * `resolveWasmUrl()` assets are available in dev and production builds.
 * Includes Solidity (`tree-sitter-solidity.wasm`) for Phase 4.
 */
function copyTreeSitterWasmPlugin(): Plugin {
  const outDir = path.resolve(__dirname, 'public/wasm');
  const sourceDir = path.resolve(__dirname, 'node_modules/tree-sitter-wasms/out');
  // Keep this list aligned with WASM_GRAMMAR_FILES (+ TSX) in wasm-grammars.ts.
  const files = [
    'tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-java.wasm',
    'tree-sitter-c.wasm',
    'tree-sitter-cpp.wasm',
    'tree-sitter-c_sharp.wasm',
    'tree-sitter-go.wasm',
    'tree-sitter-ruby.wasm',
    'tree-sitter-rust.wasm',
    'tree-sitter-php.wasm',
    'tree-sitter-kotlin.wasm',
    'tree-sitter-swift.wasm',
    'tree-sitter-dart.wasm',
    'tree-sitter-vue.wasm',
    'tree-sitter-solidity.wasm',
  ];

  const sync = () => {
    if (!fs.existsSync(sourceDir)) {
      console.warn(
        `[vite] tree-sitter-wasms not found at ${sourceDir} — skip WASM copy (Solidity browser grammar unavailable)`,
      );
      return;
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      const src = path.join(sourceDir, file);
      if (!fs.existsSync(src)) {
        console.warn(`[vite] missing WASM grammar: ${file}`);
        continue;
      }
      fs.copyFileSync(src, path.join(outDir, file));
    }
  };

  return {
    name: 'copy-tree-sitter-wasm',
    buildStart() {
      sync();
    },
    configureServer() {
      sync();
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyTreeSitterWasmPlugin()],
  define: {
    __REQUIRED_NODE_VERSION__: JSON.stringify(gitnexusPkg.engines.node.replace(/[>=^~\s]/g, '')),
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
