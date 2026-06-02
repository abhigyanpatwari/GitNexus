/**
 * The Dart scope-capture tree-sitter query (`DART_SCOPE_QUERY`) plus lazy
 * `Parser`/`Query` singletons. Mirror of `languages/swift/query.ts`.
 *
 * Verified against tree-sitter-dart 1.0.0 (UserNobody14, commit 80e23c07,
 * ABI 14) — every node type below also appears in the legacy `DART_QUERIES`,
 * which is validated against the same grammar.
 *
 * NOTE: This query intentionally covers ONLY the constructs that map cleanly
 * to a single node + the suffix-driven scope-extractor vocabulary:
 *   - `@scope.module` / `@scope.class` (type bodies)
 *   - `@declaration.{class,trait,enum,function,method,constructor,property}`
 *   - `@import.source`
 *
 * The hard parts are synthesized in `captures.ts` instead of queried, because
 * Dart's grammar can't express them as a single node:
 *   - Function/method SCOPES — `function_signature` and `function_body` are
 *     SIBLINGS, so the Function scope must span both (range composition).
 *   - Calls / member reads — Dart's postfix `identifier (selector …)` chains
 *     have no `call_expression` node; the receiver is a sibling run.
 *   - Heritage references (`extends`/`implements`/`with`).
 *   - Parameter / return / receiver type bindings and arity metadata.
 */

import Parser from 'tree-sitter';
import Dart from 'tree-sitter-dart';

const DART_SCOPE_QUERY = `
; ── Scopes ───────────────────────────────────────────────────────────────────
(program) @scope.module
(class_definition) @scope.class
(mixin_declaration) @scope.class
(extension_declaration) @scope.class
(enum_declaration) @scope.class

; ── Declarations — types ─────────────────────────────────────────────────────
(class_definition name: (identifier) @declaration.name) @declaration.class
(mixin_declaration (identifier) @declaration.name) @declaration.trait
(extension_declaration name: (identifier) @declaration.name) @declaration.class
(enum_declaration name: (identifier) @declaration.name) @declaration.enum

; ── Declarations — top-level functions (parent is program, not method) ───────
(program
  (function_signature
    name: (identifier) @declaration.name) @declaration.function)

; ── Declarations — methods (inside class/mixin/extension bodies) ─────────────
(method_signature
  (function_signature
    name: (identifier) @declaration.name)) @declaration.method

; ── Declarations — abstract methods (bodyless) ───────────────────────────────
(declaration
  (function_signature
    name: (identifier) @declaration.name)) @declaration.method

; ── Declarations — constructors ──────────────────────────────────────────────
(constructor_signature
  name: (identifier) @declaration.name) @declaration.constructor

; ── Declarations — getters / setters (Property, like the legacy DAG) ─────────
(method_signature
  (getter_signature
    name: (identifier) @declaration.name)) @declaration.property
(method_signature
  (setter_signature
    name: (identifier) @declaration.name)) @declaration.property

; ── Declarations — class fields ──────────────────────────────────────────────
(declaration
  (type_identifier)
  (initialized_identifier_list
    (initialized_identifier
      . (identifier) @declaration.name))) @declaration.property
(declaration
  (nullable_type)
  (initialized_identifier_list
    (initialized_identifier
      . (identifier) @declaration.name))) @declaration.property

; ── Imports / re-exports ─────────────────────────────────────────────────────
(import_or_export
  (library_import
    (import_specification
      (configurable_uri) @import.source))) @import.statement
(import_or_export
  (library_export
    (configurable_uri) @import.source)) @import.statement
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getDartParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Dart as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getDartScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Dart as Parameters<Parser['setLanguage']>[0], DART_SCOPE_QUERY);
  }
  return _query;
}
