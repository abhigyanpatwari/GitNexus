import * as path from 'node:path';
import type { HttpLanguagePlugin } from './types.js';
import { JAVA_HTTP_PLUGIN } from './java.js';
import { GO_HTTP_PLUGIN } from './go.js';
import { PYTHON_HTTP_PLUGIN } from './python.js';
import { PHP_HTTP_PLUGIN } from './php.js';
import { JAVASCRIPT_HTTP_PLUGIN, TYPESCRIPT_HTTP_PLUGIN, TSX_HTTP_PLUGIN } from './node.js';

export type { HttpDetection, HttpLanguagePlugin, HttpRole } from './types.js';

/**
 * File-extension → HTTP language plugin registry. The top-level
 * orchestrator (`http-route-extractor.ts`) looks up the plugin for each
 * file it visits and delegates the tree-sitter scanning to the plugin.
 *
 * Keys are lowercase extensions including the leading dot. To add a
 * new language, drop a `http-patterns/<lang>.ts` that exports a
 * `HttpLanguagePlugin`, import it here and register the extension(s).
 * No edits to `http-route-extractor.ts` are required.
 */
const REGISTRY: Record<string, HttpLanguagePlugin> = {
  '.java': JAVA_HTTP_PLUGIN,
  '.go': GO_HTTP_PLUGIN,
  '.py': PYTHON_HTTP_PLUGIN,
  '.php': PHP_HTTP_PLUGIN,
  '.js': JAVASCRIPT_HTTP_PLUGIN,
  '.jsx': JAVASCRIPT_HTTP_PLUGIN,
  '.ts': TYPESCRIPT_HTTP_PLUGIN,
  '.tsx': TSX_HTTP_PLUGIN,
};

/**
 * Glob for files worth scanning for HTTP routes. Kept alongside the
 * registry so adding a new language widens the glob in one edit.
 *
 * `.vue` / `.svelte` files are intentionally omitted for the source-scan
 * path — they need their own grammar-aware extraction and the existing
 * regex fallback for them was never very accurate. The graph-assisted
 * Strategy A still handles them via the ingestion pipeline.
 */
export const HTTP_SCAN_GLOB = '**/*.{ts,tsx,js,jsx,java,go,py,php}';

/**
 * Return the HTTP plugin registered for the given file's extension,
 * or `undefined` if the extension is not registered.
 */
export function getPluginForFile(rel: string): HttpLanguagePlugin | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
