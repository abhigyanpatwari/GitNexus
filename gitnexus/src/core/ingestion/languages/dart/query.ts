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
import { SupportedLanguages } from 'gitnexus-shared';
// `tree-sitter-dart` is an optional/vendored grammar that may be absent on a
// default install. Loaded lazily + guarded via parser-loader rather than
// statically imported: this module is pulled onto the main thread eagerly by
// the scope-resolution registry and the language-provider index, so a top-level
// `import Dart from 'tree-sitter-dart'` would throw ERR_MODULE_NOT_FOUND at
// module-load and crash `analyze` even for repos with no Dart files (#2091,
// #2093). The grammar is only ever needed inside the lazy getters below.
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';

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

; ── Declarations — type aliases (old-style + new-style function typedefs) ────
; Both forms parse as type_alias; the name position differs, and a generic
; <T> parameter list intervenes for the generic variants. Per #1919 review CF2,
; a generic type_parameters node sits between the name and the next anchor, so
; the non-generic adjacency patterns silently drop the generic forms. Four
; standalone patterns (NOT one alternation — the tree-sitter 0.21 hazard drops
; sibling branches) keep the name capture unambiguous and single-match per form:
;   non-generic old-style  typedef int Cmp(int a, int b);
;       children: return-type, NAME, formal_parameter_list
;   generic old-style      typedef int Cmp<T>(T a, T b);          (CF2)
;       children: return-type, NAME, type_parameters, formal_parameter_list
;   non-generic new-style  typedef Pred = bool Function(int);
;       children: NAME, "=", function_type
;   generic new-style      typedef Mapper<T> = T Function(T);
;       children: NAME, type_parameters, "=", function_type
; The alias name is the type_identifier immediately before the param list (old)
; or before "=" (new); for the generic forms it is the one immediately before
; the intervening type_parameters. Mirrors Kotlin's @declaration.type_alias
; rule; the generic scope-extractor maps "type_alias" → TypeAlias.
(type_alias
  (type_identifier) @declaration.name
  .
  (formal_parameter_list)) @declaration.type_alias
(type_alias
  (type_identifier) @declaration.name
  .
  (type_parameters)
  .
  (formal_parameter_list)) @declaration.type_alias
(type_alias
  (type_identifier) @declaration.name
  .
  "=") @declaration.type_alias
(type_alias
  (type_identifier) @declaration.name
  .
  (type_parameters)
  .
  "=") @declaration.type_alias

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
    _parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Dart) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return _parser;
}

export function getDartScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Dart) as Parameters<Parser['setLanguage']>[0],
      DART_SCOPE_QUERY,
    );
  }
  return _query;
}
