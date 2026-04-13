import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type CompiledPatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Node.js / TypeScript gRPC plugin family. Detects:
 *   - Provider: NestJS `@GrpcMethod('Service', 'Method')` decorators
 *   - Consumer: NestJS `@GrpcClient(...) readonly x!: XxxServiceClient`
 *   - Consumer: `client.getService<X>('AuthService')`
 *   - Consumer: `new XxxServiceClient(...)` (generated client constructor)
 *   - Consumer: `new foo.bar.Xxx(...)` when the file uses
 *     `loadPackageDefinition` (gRPC dynamic proto loader)
 *
 * As with the HTTP `node.ts`, pattern sources are defined once and
 * compiled against three grammar variants (JS / TS / TSX) because
 * `Parser.Query` is not portable across grammar objects.
 */

const SERVICE_CLIENT_RE = /^(\w+Service)Client$/;
const CAPITALIZED_SERVICE_RE = /^[A-Z]\w+$/;

// @GrpcMethod('Service', 'Method')
const GRPC_METHOD_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#eq? @dec "GrpcMethod")
        arguments: (arguments
          . [(string) (template_string)] @service
          . [(string) (template_string)] @method)))
  `,
};

// @GrpcClient(...) standalone decorator — the plugin walks to the next
// sibling (a field definition) to read its type annotation.
const GRPC_CLIENT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#eq? @dec "GrpcClient"))) @grpc_client_decorator
  `,
};

// `.getService<X>('AuthService')` / `.getService('AuthService')`
const GET_SERVICE_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        property: (property_identifier) @method (#eq? @method "getService"))
      arguments: (arguments . [(string) (template_string)] @service))
  `,
};

// `new XxxServiceClient(...)` — bare identifier constructor.
const NEW_SIMPLE_CTOR_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (new_expression
      constructor: (identifier) @ctor)
  `,
};

// `new foo.bar.XxxService(...)` — qualified constructor.
const NEW_QUALIFIED_CTOR_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (new_expression
      constructor: (member_expression
        property: (property_identifier) @ctor))
  `,
};

// Detect whether the file uses `loadPackageDefinition` (gRPC dynamic
// proto loader). Matches either a bare call or an `obj.loadPackageDefinition(...)`
// call. Plugin gates the qualified-constructor consumer on this —
// structural check avoids materializing `tree.rootNode.text` for every file.
const LOAD_PACKAGE_DEFINITION_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: [
        (identifier) @fn (#eq? @fn "loadPackageDefinition")
        (member_expression property: (property_identifier) @fn (#eq? @fn "loadPackageDefinition"))
      ])
  `,
};

interface NodeGrpcPatternBundle {
  grpcMethod: CompiledPatterns<Record<string, never>>;
  grpcClient: CompiledPatterns<Record<string, never>>;
  getService: CompiledPatterns<Record<string, never>>;
  newSimpleCtor: CompiledPatterns<Record<string, never>>;
  newQualifiedCtor: CompiledPatterns<Record<string, never>>;
  loadPackageDefinition: CompiledPatterns<Record<string, never>>;
}

function compileBundle(language: unknown, name: string): NodeGrpcPatternBundle {
  const mk = (spec: PatternSpec<Record<string, never>>, suffix: string) =>
    compilePatterns({
      name: `${name}-${suffix}`,
      language,
      patterns: [spec],
    } satisfies LanguagePatterns<Record<string, never>>);
  return {
    grpcMethod: mk(GRPC_METHOD_SPEC, 'grpc-method'),
    grpcClient: mk(GRPC_CLIENT_SPEC, 'grpc-client'),
    getService: mk(GET_SERVICE_SPEC, 'get-service'),
    newSimpleCtor: mk(NEW_SIMPLE_CTOR_SPEC, 'new-simple-ctor'),
    newQualifiedCtor: mk(NEW_QUALIFIED_CTOR_SPEC, 'new-qualified-ctor'),
    loadPackageDefinition: mk(LOAD_PACKAGE_DEFINITION_SPEC, 'load-package-definition'),
  };
}

const JAVASCRIPT_BUNDLE = compileBundle(JavaScript, 'javascript-grpc');
const TYPESCRIPT_BUNDLE = compileBundle(TypeScript.typescript, 'typescript-grpc');
const TSX_BUNDLE = compileBundle(TypeScript.tsx, 'tsx-grpc');

/**
 * Given a `@GrpcClient(...)` decorator node, find the type annotation
 * text of the field it decorates (e.g. `AuthServiceClient`).
 *
 * In tree-sitter-typescript, decorators on class fields can appear in
 * two configurations:
 *   - As a CHILD of `public_field_definition` alongside the field's
 *     type annotation (the common case for NestJS `@GrpcClient`).
 *   - As a SIBLING of the field in `class_body` (for method
 *     decorators, but kept for resilience against grammar variants).
 * We walk the parent container and search for a type annotation.
 */
function resolveGrpcClientFieldType(decoratorNode: Parser.SyntaxNode): string | null {
  const parent = decoratorNode.parent;
  if (!parent) return null;

  // Case 1: decorator is a child of the field definition — search
  // the parent itself (which is the field definition) for a
  // type_annotation child.
  if (parent.type === 'public_field_definition' || parent.type.endsWith('field_definition')) {
    return findFirstTypeAnnotationText(parent);
  }

  // Case 2: decorator is a sibling of the field in a class_body — walk
  // forward through subsequent siblings until we find a node containing
  // a type annotation.
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && child.id === decoratorNode.id) {
      for (let j = i + 1; j < parent.namedChildCount; j++) {
        const next = parent.namedChild(j);
        if (!next) continue;
        if (next.type === 'decorator') continue;
        const typeText = findFirstTypeAnnotationText(next);
        if (typeText) return typeText;
        return null;
      }
      return null;
    }
  }
  return null;
}

/**
 * Recursively search `node` for the first `type_annotation` child and
 * return the text of its inner `type_identifier`, or null. Handles
 * both `public_field_definition` and its variants.
 */
function findFirstTypeAnnotationText(node: Parser.SyntaxNode): string | null {
  if (node.type === 'type_annotation') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'type_identifier') return child.text;
    }
    return null;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = findFirstTypeAnnotationText(child);
    if (found) return found;
  }
  return null;
}

function scanBundle(bundle: NodeGrpcPatternBundle, tree: Parser.Tree): GrpcDetection[] {
  const out: GrpcDetection[] = [];

  // ─── Provider: @GrpcMethod('Service', 'Method') ──────────────────
  for (const match of runCompiledPatterns(bundle.grpcMethod, tree)) {
    const svcNode = match.captures.service;
    const methodNode = match.captures.method;
    if (!svcNode || !methodNode) continue;
    const svc = unquoteLiteral(svcNode.text);
    const mth = unquoteLiteral(methodNode.text);
    if (!svc || !mth) continue;
    out.push({
      role: 'provider',
      serviceName: svc,
      symbolName: `${svc}.${mth}`,
      source: 'ts_grpc_method',
      methodName: mth,
      // @GrpcMethod hard-coded confidence 0.8 in the original code
      // regardless of whether the proto map has a match.
      confidenceWithProto: 0.8,
      confidenceWithoutProto: 0.8,
    });
  }

  // ─── Consumer: @GrpcClient() field with XxxServiceClient type ────
  for (const match of runCompiledPatterns(bundle.grpcClient, tree)) {
    const decoratorNode = match.captures.grpc_client_decorator;
    if (!decoratorNode) continue;
    const typeText = resolveGrpcClientFieldType(decoratorNode);
    if (!typeText) continue;
    const svcMatch = SERVICE_CLIENT_RE.exec(typeText);
    if (!svcMatch) continue;
    const serviceName = svcMatch[1];
    out.push({
      role: 'consumer',
      serviceName,
      symbolName: `${serviceName}Client`,
      source: 'ts_grpc_client_decorator',
      confidenceWithProto: 0.75,
      confidenceWithoutProto: 0.55,
    });
  }

  // ─── Consumer: client.getService<X>('Service') ───────────────────
  for (const match of runCompiledPatterns(bundle.getService, tree)) {
    const svcNode = match.captures.service;
    if (!svcNode) continue;
    const svc = unquoteLiteral(svcNode.text);
    if (!svc) continue;
    out.push({
      role: 'consumer',
      serviceName: svc,
      symbolName: `${svc}Client`,
      source: 'ts_client_grpc_get_service',
      confidenceWithProto: 0.75,
      confidenceWithoutProto: 0.55,
    });
  }

  // ─── Consumer: new XxxServiceClient(...) ─────────────────────────
  for (const match of runCompiledPatterns(bundle.newSimpleCtor, tree)) {
    const ctorNode = match.captures.ctor;
    if (!ctorNode) continue;
    const svcMatch = SERVICE_CLIENT_RE.exec(ctorNode.text);
    if (!svcMatch) continue;
    const serviceName = svcMatch[1];
    out.push({
      role: 'consumer',
      serviceName,
      symbolName: `${serviceName}Client`,
      source: 'ts_generated_client',
      confidenceWithProto: 0.75,
      confidenceWithoutProto: 0.55,
    });
  }

  // ─── Consumer: loadPackageDefinition dynamic proto loader ────────
  // Only emit when the file uses loadPackageDefinition, otherwise a
  // generic `new foo.bar.Something()` in unrelated code would falsely
  // register as a gRPC consumer. Check structurally via a dedicated
  // query — avoids materializing `tree.rootNode.text` for the whole
  // file (expensive on large files).
  const usesLoadPackage = runCompiledPatterns(bundle.loadPackageDefinition, tree).length > 0;
  if (usesLoadPackage) {
    for (const match of runCompiledPatterns(bundle.newQualifiedCtor, tree)) {
      const ctorNode = match.captures.ctor;
      if (!ctorNode) continue;
      if (!CAPITALIZED_SERVICE_RE.test(ctorNode.text)) continue;
      out.push({
        role: 'consumer',
        serviceName: ctorNode.text,
        symbolName: `${ctorNode.text}Client`,
        source: 'ts_load_package_definition',
        confidenceWithProto: 0.75,
        confidenceWithoutProto: 0.55,
      });
    }
  }

  return out;
}

export const JAVASCRIPT_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'javascript-grpc',
  language: JavaScript,
  scan: (tree) => scanBundle(JAVASCRIPT_BUNDLE, tree),
};

export const TYPESCRIPT_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'typescript-grpc',
  language: TypeScript.typescript,
  scan: (tree) => scanBundle(TYPESCRIPT_BUNDLE, tree),
};

export const TSX_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'tsx-grpc',
  language: TypeScript.tsx,
  scan: (tree) => scanBundle(TSX_BUNDLE, tree),
};
