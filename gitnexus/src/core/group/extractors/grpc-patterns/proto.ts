import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../tree-sitter/vendored-grammars.js';
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
 * Uses `tree-sitter-proto` (coder3101/tree-sitter-proto), loaded from
 * `vendor/` by absolute path (NEVER copied into node_modules — see
 * vendored-grammars.ts / #2111). If the grammar's binding cannot be loaded
 * (e.g. no prebuild for an unusual platform), the plugin exports `null` and the
 * orchestrator falls back to the existing manual string-sanitizing parser.
 *
 * The upstream-generated grammar is vendored in `vendor/tree-sitter-proto/`.
 */

// Only for `tree-sitter` (a real npm dependency) in the smoke-test below;
// the vendored grammar goes through requireVendoredGrammar (never a bare
// `_require('tree-sitter-proto')`, which would force a node_modules copy — #2111).
const _require = createRequire(import.meta.url);
let ProtoGrammar: Parser.Language | null = null;
try {
  const grammar = requireVendoredGrammar('tree-sitter-proto');
  // node-tree-sitter 0.25.1 derives JS subclass names from nodeTypeInfo.
  // Protobuf's named `syntax` node becomes `class SyntaxNode extends
  // SyntaxNode`, which throws in setLanguage. Omit only its subclass metadata
  // on a private wrapper: the native node, queries, and childForFieldName()
  // still work through the base SyntaxNode API. Do not alter upstream sources
  // or the shared grammar's metadata. Remove when node-tree-sitter fixes the
  // subclass-name collision.
  ProtoGrammar = {
    ...grammar,
    nodeTypeInfo: grammar.nodeTypeInfo.filter((node) => !(node.named && node.type === 'syntax')),
  };
} catch {
  // Grammar not installed — PROTO_GRPC_PLUGIN will be null.
}

let PACKAGE_PATTERNS: CompiledPatterns<Record<string, never>> | null = null;
let SERVICE_PATTERNS: CompiledPatterns<Record<string, never>> | null = null;

if (ProtoGrammar) {
  try {
    // Validate that the grammar actually loads end-to-end: compile queries
    // AND parse + walk a trivial proto file. Keep the manual fallback for
    // platforms where the native grammar cannot initialize.
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
