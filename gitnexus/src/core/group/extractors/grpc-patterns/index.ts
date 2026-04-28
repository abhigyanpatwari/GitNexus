import * as path from 'node:path';
import type { GrpcLanguagePlugin } from './types.js';
import { GO_GRPC_PLUGIN } from './go.js';
import { JAVA_GRPC_PLUGIN } from './java.js';
import { PYTHON_GRPC_PLUGIN } from './python.js';
import { JAVASCRIPT_GRPC_PLUGIN, TYPESCRIPT_GRPC_PLUGIN, TSX_GRPC_PLUGIN } from './node.js';
import { PROTO_GRPC_PLUGIN } from './proto.js';

export type { GrpcDetection, GrpcLanguagePlugin, GrpcRole } from './types.js';
export { PROTO_GRPC_PLUGIN, extractPackageFromTree } from './proto.js';

/**
 * File-extension → gRPC language plugin registry. Mirrors the shape
 * of `http-patterns/index.ts` and `topic-patterns/index.ts`.
 *
 * `.proto` files are registered only when `tree-sitter-proto` is
 * available (it's an optionalDependency). When absent, the orchestrator
 * falls back to the built-in manual proto parser.
 */
const REGISTRY: Record<string, GrpcLanguagePlugin> = {
  '.go': GO_GRPC_PLUGIN,
  '.java': JAVA_GRPC_PLUGIN,
  '.py': PYTHON_GRPC_PLUGIN,
  '.js': JAVASCRIPT_GRPC_PLUGIN,
  '.jsx': JAVASCRIPT_GRPC_PLUGIN,
  '.ts': TYPESCRIPT_GRPC_PLUGIN,
  '.tsx': TSX_GRPC_PLUGIN,
  ...(PROTO_GRPC_PLUGIN ? { '.proto': PROTO_GRPC_PLUGIN } : {}),
};

/**
 * Glob for source files worth scanning for gRPC server/client patterns.
 * Includes `.proto` when the grammar is available.
 */
export const GRPC_SCAN_GLOB = PROTO_GRPC_PLUGIN
  ? '**/*.{go,java,py,ts,tsx,js,jsx,proto}'
  : '**/*.{go,java,py,ts,tsx,js,jsx}';

/**
 * Whether the tree-sitter proto plugin is available. The orchestrator
 * uses this to decide between the tree-sitter path and the fallback
 * manual parser for `.proto` files.
 */
export const hasProtoPlugin = PROTO_GRPC_PLUGIN !== null;

/**
 * Return the gRPC plugin registered for the given file's extension,
 * or `undefined` if the extension is not registered.
 */
export function getPluginForFile(rel: string): GrpcLanguagePlugin | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
