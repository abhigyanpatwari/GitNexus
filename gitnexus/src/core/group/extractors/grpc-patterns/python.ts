import type Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Python gRPC plugin. Detects:
 *   - Provider: `add_XxxServicer_to_server(...)` calls (bare identifier
 *     or qualified attribute form `auth_pb2_grpc.add_XxxServicer_to_server`)
 *   - Consumer: `XxxStub(channel)` calls (bare or `auth_pb2_grpc.XxxStub`)
 *     in a file that imports gRPC, unless the file defines `XxxStub`
 *     itself. Test doubles are often named like stubs (`class _RepoStub:`).
 */

const ADD_SERVICER_RE = /^add_(\w+)Servicer_to_server$/;
const STUB_RE = /^(\w+)Stub$/;
/** Reserved names that would produce garbage service names. */
const STUB_IGNORE = new Set(['Mock', 'Test', 'Fake', 'Stub']);

/**
 * A part of an imported name that shows the file uses gRPC: the `grpc` or
 * `grpclib` package, or a generated module (`auth_pb2_grpc`, or `auth_grpc`
 * from grpclib).
 */
const isGrpcModulePart = (part: string): boolean =>
  part === 'grpc' || part === 'grpclib' || part.endsWith('_grpc');

const IMPORT_PATTERNS = compilePatterns({
  name: 'python-grpc-import',
  language: Python,
  patterns: [
    { meta: {}, query: '(import_statement) @import' },
    { meta: {}, query: '(import_from_statement) @import' },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const CLASS_PATTERNS = compilePatterns({
  name: 'python-grpc-class',
  language: Python,
  patterns: [{ meta: {}, query: '(class_definition name: (identifier) @name)' }],
} satisfies LanguagePatterns<Record<string, never>>);

/** Whether any import of the file, at top level or in a function, is a gRPC one. */
function importsGrpc(tree: Parser.Tree): boolean {
  return runCompiledPatterns(IMPORT_PATTERNS, tree).some(({ captures }) =>
    captures.import
      ?.descendantsOfType('dotted_name')
      .some((name) => name.namedChildren.some((part) => isGrpcModulePart(part.text))),
  );
}

function definedClassNames(tree: Parser.Tree): Set<string> {
  const names = new Set<string>();
  for (const { captures } of runCompiledPatterns(CLASS_PATTERNS, tree)) {
    if (captures.name) names.add(captures.name.text);
  }
  return names;
}

// Any call whose target is either a bare identifier or an attribute
// access (`obj.method`). The plugin filters the function name in JS.
const CALL_PATTERNS = compilePatterns({
  name: 'python-grpc-call',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: [
            (identifier) @fn
            (attribute attribute: (identifier) @fn)
          ])
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const PYTHON_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'python-grpc',
  language: Python,
  scan(tree) {
    const out: GrpcDetection[] = [];
    // Read only once a call is named like a stub.
    let grpcFile: boolean | undefined;
    let fileClasses: Set<string> | undefined;
    for (const match of runCompiledPatterns(CALL_PATTERNS, tree)) {
      const fnNode = match.captures.fn;
      if (!fnNode) continue;
      const fnText = fnNode.text;

      const addServicer = ADD_SERVICER_RE.exec(fnText);
      if (addServicer) {
        out.push({
          role: 'provider',
          serviceName: addServicer[1],
          symbolName: fnText,
          source: 'python_servicer',
          confidenceWithProto: 0.8,
          confidenceWithoutProto: 0.65,
        });
        continue;
      }

      const stubMatch = STUB_RE.exec(fnText);
      if (stubMatch && !STUB_IGNORE.has(stubMatch[1])) {
        grpcFile ??= importsGrpc(tree);
        fileClasses ??= definedClassNames(tree);
        // A generated stub is imported from its gRPC module, not defined here.
        if (!grpcFile || fileClasses.has(fnText)) continue;
        out.push({
          role: 'consumer',
          serviceName: stubMatch[1],
          symbolName: fnText,
          source: 'python_stub',
          confidenceWithProto: 0.75,
          confidenceWithoutProto: 0.55,
        });
      }
    }
    return out;
  },
};
