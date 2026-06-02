import * as path from 'node:path';
import { isBladeTemplateFilename } from 'gitnexus-shared';
import type { HttpLanguagePlugin } from './types.js';
import { JAVA_HTTP_PLUGIN } from './java.js';
import { KOTLIN_HTTP_PLUGIN } from './kotlin.js';
import { GO_HTTP_PLUGIN } from './go.js';
import { PYTHON_HTTP_PLUGIN } from './python.js';
import { PHP_HTTP_PLUGIN } from './php.js';
import { JAVASCRIPT_HTTP_PLUGIN, TYPESCRIPT_HTTP_PLUGIN, TSX_HTTP_PLUGIN } from './node.js';

export type {
  HttpDetection,
  HttpFileDetections,
  HttpLanguagePlugin,
  HttpRole,
  HttpScanInput,
} from './types.js';

/**
 * File-extension → HTTP language plugin registry. The top-level
 * orchestrator (`http-route-extractor.ts`) looks up the plugin for each
 * file it visits and delegates the tree-sitter scanning to the plugin.
 *
 * Keys are lowercase extensions including the leading dot. To add a
 * new language, drop a `http-patterns/<lang>.ts` that exports a
 * `HttpLanguagePlugin`, import it here and register the extension(s).
 * No edits to `http-route-extractor.ts` are required.
 *
 * Optional grammar plugins (e.g. `kotlin.ts`, which depends on the
 * optionalDependency `tree-sitter-kotlin`) export `null` when the
 * native binding is unavailable; we skip registration in that case so
 * a missing optional grammar never crashes the orchestrator.
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

if (KOTLIN_HTTP_PLUGIN) {
  REGISTRY['.kt'] = KOTLIN_HTTP_PLUGIN;
  REGISTRY['.kts'] = KOTLIN_HTTP_PLUGIN;
}

/**
 * Glob for files worth scanning for HTTP routes. Kept alongside the
 * registry so adding a new language widens the glob in one edit.
 *
 * `.kt`/`.kts` are always present in the glob even when the optional
 * `tree-sitter-kotlin` grammar isn't installed — `getPluginForFile`
 * will return `undefined` for those files in that case, so the
 * orchestrator simply skips them at scan time without erroring.
 *
 * `.vue` / `.svelte` files are intentionally omitted for the source-scan
 * path — they need their own grammar-aware extraction and the existing
 * regex fallback for them was never very accurate. The graph-assisted
 * Strategy A still handles them via the ingestion pipeline.
 */
export const HTTP_SCAN_GLOB = '**/*.{ts,tsx,js,jsx,java,kt,kts,go,py,php}';

/**
 * Return the HTTP plugin registered for the given file's extension,
 * or `undefined` if the extension is not registered.
 */
export function getPluginForFile(rel: string): HttpLanguagePlugin | undefined {
  if (isBladeTemplateFilename(rel)) return undefined;
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
