import * as path from 'node:path';
import type { CompiledPatterns } from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';
import { JAVA_TOPIC_PROVIDER } from './java.js';
import { GO_TOPIC_PROVIDER } from './go.js';
import { PYTHON_TOPIC_PROVIDER } from './python.js';
import {
  JAVASCRIPT_TOPIC_PROVIDER,
  TYPESCRIPT_TOPIC_PROVIDER,
  TSX_TOPIC_PROVIDER,
} from './node.js';

export type { TopicMeta, Broker } from './types.js';

/**
 * File-extension → compiled-plugin registry for topic extraction. The
 * top-level orchestrator (`topic-extractor.ts`) looks up the plugin for
 * each file it visits and delegates the scanning to `tree-sitter-scanner`.
 *
 * Keys are lowercase extensions including the leading dot. To add a new
 * language, drop a `topic-patterns/<lang>.ts` that exports a compiled
 * provider, import it here and register the extension(s). No edits to
 * `topic-extractor.ts` are required.
 */
const REGISTRY: Record<string, CompiledPatterns<TopicMeta>> = {
  '.java': JAVA_TOPIC_PROVIDER,
  '.go': GO_TOPIC_PROVIDER,
  '.py': PYTHON_TOPIC_PROVIDER,
  '.js': JAVASCRIPT_TOPIC_PROVIDER,
  '.jsx': JAVASCRIPT_TOPIC_PROVIDER,
  '.ts': TYPESCRIPT_TOPIC_PROVIDER,
  '.tsx': TSX_TOPIC_PROVIDER,
};

/**
 * Glob pattern for files worth scanning. Kept here so adding a new
 * language to the registry also widens the glob automatically via a
 * single edit.
 */
export const TOPIC_SCAN_GLOB = '**/*.{ts,tsx,js,jsx,java,go,py}';

/**
 * Return the compiled provider registered for the given file's
 * extension, or `undefined` if the extension is not registered.
 */
export function getProviderForFile(rel: string): CompiledPatterns<TopicMeta> | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
