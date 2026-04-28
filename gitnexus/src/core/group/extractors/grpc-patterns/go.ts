import Go from 'tree-sitter-go';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Go gRPC plugin. Detects:
 *   - Provider: `pb.RegisterXxxServer(...)` calls
 *   - Provider: `pb.UnimplementedXxxServer` embedded in a struct
 *   - Consumer: `pb.NewXxxClient(conn)` calls
 */

const REGISTER_RE = /^Register(\w+)Server$/;
const UNIMPLEMENTED_RE = /^Unimplemented(\w+)Server$/;
const NEW_CLIENT_RE = /^New(\w+)Client$/;

// Any `xxx.<fn>(...)` call — plugin filters the field identifier text.
const SELECTOR_CALL_PATTERNS = compilePatterns({
  name: 'go-grpc-selector-call',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            field: (field_identifier) @fn))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Any `qualified_type` used as a struct field — for `pb.UnimplementedXxxServer`.
const STRUCT_EMBEDDING_PATTERNS = compilePatterns({
  name: 'go-grpc-struct-embedding',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (struct_type
          (field_declaration_list
            (field_declaration
              type: (qualified_type
                name: (type_identifier) @field_type))))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const GO_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'go-grpc',
  language: Go,
  scan(tree) {
    const out: GrpcDetection[] = [];

    for (const match of runCompiledPatterns(SELECTOR_CALL_PATTERNS, tree)) {
      const fnNode = match.captures.fn;
      if (!fnNode) continue;
      const fnText = fnNode.text;

      const registerMatch = REGISTER_RE.exec(fnText);
      if (registerMatch) {
        out.push({
          role: 'provider',
          serviceName: registerMatch[1],
          symbolName: fnText,
          source: 'go_register',
          confidenceWithProto: 0.8,
          confidenceWithoutProto: 0.65,
        });
        continue;
      }

      const newClientMatch = NEW_CLIENT_RE.exec(fnText);
      if (newClientMatch) {
        out.push({
          role: 'consumer',
          serviceName: newClientMatch[1],
          symbolName: fnText,
          source: 'go_client',
          confidenceWithProto: 0.75,
          confidenceWithoutProto: 0.55,
        });
        continue;
      }
    }

    for (const match of runCompiledPatterns(STRUCT_EMBEDDING_PATTERNS, tree)) {
      const fieldNode = match.captures.field_type;
      if (!fieldNode) continue;
      const unimpl = UNIMPLEMENTED_RE.exec(fieldNode.text);
      if (!unimpl) continue;
      out.push({
        role: 'provider',
        serviceName: unimpl[1],
        symbolName: fieldNode.text,
        source: 'go_unimplemented',
        confidenceWithProto: 0.8,
        confidenceWithoutProto: 0.65,
      });
    }

    return out;
  },
};
