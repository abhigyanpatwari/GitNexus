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
 */

const ADD_SERVICER_RE = /^add_(\w+)Servicer_to_server$/;
const STUB_RE = /^(\w+)Stub$/;
/** Reserved names that would produce garbage service names. */
const STUB_IGNORE = new Set(['Mock', 'Test', 'Fake', 'Stub']);

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
