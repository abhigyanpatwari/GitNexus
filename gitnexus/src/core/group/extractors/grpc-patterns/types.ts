import type Parser from 'tree-sitter';

/**
 * Shared types for the grpc-extractor language plugins.
 *
 * Each plugin lives in its own file (java.ts, go.ts, ...) and owns the
 * tree-sitter grammar import + query sources. The top-level
 * `grpc-extractor.ts` orchestrator only knows about this type module
 * and the plugin registry (`./index.ts`). It MUST NOT import any
 * grammar or query text directly.
 */

export type GrpcRole = 'provider' | 'consumer';

/**
 * One raw gRPC detection produced by a plugin's `scan()` function. The
 * orchestrator uses the proto map to resolve the full package-qualified
 * contract id and choose a confidence based on whether the proto was
 * found.
 *
 * Most patterns produce service-level detections; `TS @GrpcMethod` is
 * the only pattern that captures an explicit `methodName`, producing
 * a method-level contract (`grpc::pkg.Service/Method`).
 */
export interface GrpcDetection {
  role: GrpcRole;
  /** Short service name, e.g. `"AuthService"`. */
  serviceName: string;
  /** Symbol name emitted into the contract's symbolRef. */
  symbolName: string;
  /** Metadata source label (goes into `meta.source`). */
  source: string;
  /** Explicit method name; set only by TS `@GrpcMethod`. */
  methodName?: string;
  /** Confidence when the proto map resolves the service. */
  confidenceWithProto: number;
  /** Confidence when the proto map has no entry. */
  confidenceWithoutProto: number;
  /**
   * Optional. Fully-qualified proto package the detection's service
   * belongs to (e.g. `cn.unipus.ucf.admin.proto.client.service`),
   * derived directly from the source file's import statements when
   * available. When set, the orchestrator uses this package to build
   * the contract id INSTEAD of consulting the per-repo proto map —
   * letting consumer repos that don't carry `.proto` files (the
   * client-jar architecture used by most Java gRPC microservices)
   * still emit a fully-qualified contract id that matches the
   * provider repo's contract id verbatim.
   */
  protoPackage?: string;
}

/**
 * One language-scoped gRPC plugin. Plugins own the tree-sitter grammar
 * and a `scan(tree)` function that returns zero or more
 * `GrpcDetection`s. The plugin is free to run multiple compiled query
 * bundles and walk the AST to cross-reference captures.
 *
 * `language` is typed `unknown` for the same reason as in
 * `tree-sitter-scanner.ts`.
 */
export interface GrpcLanguagePlugin {
  name: string;
  language: unknown;
  scan(tree: Parser.Tree): GrpcDetection[];
}
