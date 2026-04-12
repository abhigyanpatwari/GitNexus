import { createRequire } from 'node:module';
import {
  compilePatterns,
  runCompiledPatterns,
  type CompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Protobuf (.proto) tree-sitter plugin for gRPC contract extraction.
 *
 * Uses `tree-sitter-proto` (coder3101/tree-sitter-proto) as an
 * optionalDependency — if the grammar is not installed (e.g. native
 * compilation failed on an unusual platform), the plugin exports
 * `null` and the orchestrator falls back to the existing manual
 * string-sanitizing parser.
 *
 * The grammar is vendored in `vendor/tree-sitter-proto/` with
 * parser.c regenerated against tree-sitter-cli 0.24 (ABI version 14)
 * so it is compatible with the project's tree-sitter 0.25 runtime.
 */

const _require = createRequire(import.meta.url);
let ProtoGrammar: unknown = null;
try {
  ProtoGrammar = _require('tree-sitter-proto');
} catch {
  // Grammar not installed — PROTO_GRPC_PLUGIN will be null.
}

let PACKAGE_PATTERNS: CompiledPatterns<Record<string, never>> | null = null;
let SERVICE_PATTERNS: CompiledPatterns<Record<string, never>> | null = null;

if (ProtoGrammar) {
  try {
    // Validate that the grammar actually loads end-to-end: compile queries
    // AND parse + walk a trivial proto file. tree-sitter's internal
    // `initializeLanguageNodeClasses` can fail with a TDZ error in some
    // test runners (vitest forks) when SyntaxNode isn't fully initialized
    // yet. Catching that here ensures `PROTO_GRPC_PLUGIN` stays null and
    // the orchestrator falls back to the manual parser.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _Parser = _require('tree-sitter') as any;
    // Smoke-test: parse + setLanguage to verify the grammar is
    // end-to-end compatible with this tree-sitter runtime.
    const _testParser = new _Parser();
    _testParser.setLanguage(ProtoGrammar);
    _testParser.parse('service X { rpc Y (R) returns (R); }');

    PACKAGE_PATTERNS = compilePatterns({
      name: 'proto-package',
      language: ProtoGrammar,
      patterns: [
        {
          meta: {},
          query: `(package (full_ident) @pkg)`,
        },
      ],
    } satisfies LanguagePatterns<Record<string, never>>);

    SERVICE_PATTERNS = compilePatterns({
      name: 'proto-service',
      language: ProtoGrammar,
      patterns: [
        {
          meta: {},
          query: `
            (service
              (service_name) @service_name
              (rpc
                (rpc_name) @rpc_name))
          `,
        },
      ],
    } satisfies LanguagePatterns<Record<string, never>>);
  } catch {
    // Compilation failed (grammar ABI mismatch?) — fall back to null.
    PACKAGE_PATTERNS = null;
    SERVICE_PATTERNS = null;
    ProtoGrammar = null;
  }
}

function buildPlugin(): GrpcLanguagePlugin | null {
  if (!ProtoGrammar || !PACKAGE_PATTERNS || !SERVICE_PATTERNS) return null;
  const pkgPatterns = PACKAGE_PATTERNS;
  const svcPatterns = SERVICE_PATTERNS;

  return {
    name: 'proto-grpc',
    language: ProtoGrammar,
    scan(tree) {
      const out: GrpcDetection[] = [];

      // Extract `package` declaration (first match wins).
      let pkg = '';
      for (const match of runCompiledPatterns(pkgPatterns, tree)) {
        const pkgNode = match.captures.pkg;
        if (pkgNode) {
          pkg = pkgNode.text;
          break;
        }
      }

      // Extract `service → rpc` pairs. The query returns one match per
      // (service, rpc) combination thanks to the nested structure.
      for (const match of runCompiledPatterns(svcPatterns, tree)) {
        const serviceNode = match.captures.service_name;
        const rpcNode = match.captures.rpc_name;
        if (!serviceNode || !rpcNode) continue;
        const serviceName = serviceNode.text;
        const methodName = rpcNode.text;
        out.push({
          role: 'provider',
          serviceName,
          symbolName: `${serviceName}.${methodName}`,
          source: 'proto',
          methodName,
          // Proto definitions are the canonical source of truth — always
          // high confidence regardless of cross-referencing.
          confidenceWithProto: 0.85,
          confidenceWithoutProto: 0.85,
        });
      }

      return out;
    },
  };
}

/**
 * The proto plugin, or `null` if tree-sitter-proto is not available.
 * The orchestrator checks this at import time and decides whether to
 * use the tree-sitter path or the fallback manual parser.
 */
export const PROTO_GRPC_PLUGIN: GrpcLanguagePlugin | null = buildPlugin();

/** The package declaration text from a proto file's tree. */
export function extractPackageFromTree(tree: import('tree-sitter').Tree): string {
  if (!PACKAGE_PATTERNS) return '';
  for (const match of runCompiledPatterns(PACKAGE_PATTERNS, tree)) {
    const pkgNode = match.captures.pkg;
    if (pkgNode) return pkgNode.text;
  }
  return '';
}
