import * as path from 'node:path';
import type { GrpcLanguagePlugin } from './types.js';
import { GO_GRPC_PLUGIN } from './go.js';
import { JAVA_GRPC_PLUGIN } from './java.js';
import { PYTHON_GRPC_PLUGIN } from './python.js';
import { JAVASCRIPT_GRPC_PLUGIN, TYPESCRIPT_GRPC_PLUGIN, TSX_GRPC_PLUGIN } from './node.js';

export type { GrpcDetection, GrpcLanguagePlugin, GrpcRole } from './types.js';

/**
 * File-extension → gRPC language plugin registry. Mirrors the shape
 * of `http-patterns/index.ts` and `topic-patterns/index.ts`.
 *
 * To add a new language drop a `grpc-patterns/<lang>.ts` exporting a
 * `GrpcLanguagePlugin`, import + register it here, and widen
 * `GRPC_SCAN_GLOB` if needed. No edits to `grpc-extractor.ts` required.
 */
const REGISTRY: Record<string, GrpcLanguagePlugin> = {
  '.go': GO_GRPC_PLUGIN,
  '.java': JAVA_GRPC_PLUGIN,
  '.py': PYTHON_GRPC_PLUGIN,
  '.js': JAVASCRIPT_GRPC_PLUGIN,
  '.jsx': JAVASCRIPT_GRPC_PLUGIN,
  '.ts': TYPESCRIPT_GRPC_PLUGIN,
  '.tsx': TSX_GRPC_PLUGIN,
};

/**
 * Glob for source files worth scanning for gRPC server/client patterns.
 * `.proto` files are handled directly by the orchestrator's in-tree
 * string-sanitizing parser (no `tree-sitter-proto` grammar is
 * installed).
 */
export const GRPC_SCAN_GLOB = '**/*.{go,java,py,ts,tsx,js,jsx}';

/**
 * Return the gRPC plugin registered for the given file's extension,
 * or `undefined` if the extension is not registered.
 */
export function getPluginForFile(rel: string): GrpcLanguagePlugin | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
