import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Java gRPC plugin. Detects:
 *   - Provider: classes extending `XxxServiceGrpc.XxxServiceImplBase`
 *     (with or without a `@GrpcService` annotation; the annotation
 *     only affects confidence labelling in the original regex version
 *     — here we emit a single detection per class and pick the source
 *     label based on whether the annotation is present).
 *   - Consumer: `XxxServiceGrpc.newBlockingStub(ch)` /
 *     `XxxServiceGrpc.newStub(ch)` calls.
 */

const IMPL_BASE_RE = /^(\w+)ImplBase$/;
const GRPC_SUFFIX_RE = /^(\w+)Grpc$/;

// Classes extending `ScopedType.ScopedType` where the inner name ends
// in ImplBase. Covers `XxxServiceGrpc.XxxServiceImplBase`.
// Note: tree-sitter-java's `scoped_type_identifier` exposes its two
// segments as positional `type_identifier` children, NOT as named
// `scope:`/`name:` fields. We match positionally here and rely on the
// grammar's left-to-right ordering: first child = outer, second = inner.
const SCOPED_IMPL_BASE_PATTERNS = compilePatterns({
  name: 'java-grpc-scoped-impl-base',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          name: (identifier) @class_name
          superclass: (superclass
            (scoped_type_identifier
              (type_identifier) @outer
              (type_identifier) @inner (#match? @inner "ImplBase$")))) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Classes extending a simple `XxxImplBase` identifier (no scope).
const PLAIN_IMPL_BASE_PATTERNS = compilePatterns({
  name: 'java-grpc-plain-impl-base',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          name: (identifier) @class_name
          superclass: (superclass
            (type_identifier) @plain_type (#match? @plain_type "ImplBase$"))) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// gRPC stub factories: `XxxGrpc.newStub(ch)` / `XxxGrpc.newBlockingStub(ch)`.
const STUB_PATTERNS = compilePatterns({
  name: 'java-grpc-stub',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @grpc_cls
          name: (identifier) @method (#match? @method "^new(Blocking)?Stub$"))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

/**
 * Check whether a `class_declaration` node has a `@GrpcService`
 * annotation in its modifiers list. In tree-sitter-java, class-level
 * annotations live under `(class_declaration (modifiers (marker_annotation|annotation)))`.
 */
function hasGrpcServiceAnnotation(classNode: Parser.SyntaxNode): boolean {
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (!child || child.type !== 'modifiers') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const mod = child.namedChild(j);
      if (!mod) continue;
      if (mod.type !== 'marker_annotation' && mod.type !== 'annotation') continue;
      const nameNode = mod.childForFieldName('name');
      if (nameNode?.text === 'GrpcService') return true;
    }
  }
  return false;
}

/**
 * Given the inner type_identifier text like `AuthServiceImplBase`,
 * return the service name (`AuthService`), or null if the text
 * doesn't end in `ImplBase`.
 */
function extractServiceFromImplBase(text: string): string | null {
  const m = IMPL_BASE_RE.exec(text);
  if (!m) return null;
  // Strip a trailing `Grpc` on the service name too — the original
  // regex replaces `Grpc$` on the extracted prefix.
  return m[1].replace(/Grpc$/, '');
}

export const JAVA_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'java-grpc',
  language: Java,
  scan(tree) {
    const out: GrpcDetection[] = [];
    const emittedClassIds = new Set<number>();

    // ─── Providers: scoped form (`...Grpc.XxxImplBase`) ─────────────
    for (const match of runCompiledPatterns(SCOPED_IMPL_BASE_PATTERNS, tree)) {
      const classNode = match.captures.class;
      const innerNode = match.captures.inner;
      if (!classNode || !innerNode) continue;
      const serviceName = extractServiceFromImplBase(innerNode.text);
      if (!serviceName) continue;
      emittedClassIds.add(classNode.id);
      const annotated = hasGrpcServiceAnnotation(classNode);
      out.push({
        role: 'provider',
        serviceName,
        symbolName: serviceName,
        source: annotated ? 'java_grpc_service' : 'java_impl_base',
        confidenceWithProto: 0.8,
        confidenceWithoutProto: 0.65,
      });
    }

    // ─── Providers: plain form (`XxxImplBase`) ──────────────────────
    for (const match of runCompiledPatterns(PLAIN_IMPL_BASE_PATTERNS, tree)) {
      const classNode = match.captures.class;
      const plainNode = match.captures.plain_type;
      if (!classNode || !plainNode) continue;
      if (emittedClassIds.has(classNode.id)) continue;
      const serviceName = extractServiceFromImplBase(plainNode.text);
      if (!serviceName) continue;
      emittedClassIds.add(classNode.id);
      const annotated = hasGrpcServiceAnnotation(classNode);
      out.push({
        role: 'provider',
        serviceName,
        symbolName: serviceName,
        source: annotated ? 'java_grpc_service' : 'java_impl_base',
        confidenceWithProto: 0.8,
        confidenceWithoutProto: 0.65,
      });
    }

    // ─── Consumers: `XxxGrpc.newBlockingStub(...)` / `newStub(...)` ─
    for (const match of runCompiledPatterns(STUB_PATTERNS, tree)) {
      const grpcClsNode = match.captures.grpc_cls;
      if (!grpcClsNode) continue;
      const grpcMatch = GRPC_SUFFIX_RE.exec(grpcClsNode.text);
      if (!grpcMatch) continue;
      const serviceName = grpcMatch[1];
      out.push({
        role: 'consumer',
        serviceName,
        symbolName: `${serviceName}Stub`,
        source: 'java_stub',
        confidenceWithProto: 0.75,
        confidenceWithoutProto: 0.55,
      });
    }

    return out;
  },
};
