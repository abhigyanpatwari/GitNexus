import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
// `tree-sitter-kotlin` is a vendored grammar (loaded from vendor/ by absolute
// path, never node_modules — vendored-grammars.ts / #2111) that may be absent on
// a platform without a matching prebuild. Loaded lazily + guarded via parser-loader
// rather than statically imported: this module is pulled onto the main thread
// eagerly by the scope-resolution registry and the language-provider index, so
// a top-level `import Kotlin from 'tree-sitter-kotlin'` would throw
// ERR_MODULE_NOT_FOUND at module-load and crash `analyze` even for repos with no
// Kotlin files (#2091, #2093). The grammar is only ever needed in the getters.
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';

const KOTLIN_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(class_declaration) @scope.class
(object_declaration) @scope.class
(companion_object) @scope.class
(function_declaration) @scope.function

;; Secondary-constructor body scope (issue #1919 review CF1). A
;; secondary constructor's "constructor(...) { ... }" body executes statements
;; just like a method body, so it must be its OWN Function scope — otherwise a
;; call inside the body resolves its caller anchor up to the enclosing Class
;; scope (the class's Class def), mis-attributing the CALLS edge to the class
;; rather than the Constructor. The matching @declaration.constructor is
;; synthesized in captures.ts (synthesizeKotlinSecondaryConstructorDeclarations)
;; so this scope owns a Constructor def keyed to the structure-phase node id.
(secondary_constructor) @scope.function

;; Companion-object marker (issue #1756 / U4). Side-channel capture that
;; lets populateCompanionMembersOnEnclosingClass distinguish a companion
;; Class scope from a regular Class scope without inspecting ownedDefs.
;; Anonymous companions AND companions containing nested classes both
;; look like regular classes through the old ownedDefs-based heuristic;
;; the marker lifts the distinction up to the parser layer where it is
;; unambiguous (any companion_object AST node is a companion, full
;; stop). Consumed by markCompanionScope / isCompanionScope in
;; captures.ts / companion-scopes.ts. The scope-extractor ignores the
;; "companion" suffix (no ScopeKind mapping), so this rule contributes
;; no Scope record of its own — the existing (companion_object)
;; @scope.class rule still creates the Class scope.
(companion_object) @scope.companion

;; Smart-cast narrowing scopes (RFC #909 Ring 3, issue #1758).
;; Each is-test arm body and each if-then body becomes its own Block
;; scope so synthesized narrowed type-bindings (see captures.ts
;; synthesizeKotlinSmartCastBindings) shadow the outer parameter
;; binding for calls inside the body — without leaking across arms.
(when_entry
  (when_condition (type_test))
  (control_structure_body) @scope.block)

(if_expression
  (check_expression)
  (control_structure_body) @scope.block)

;; Lambda body scope (issue #1757). Each lambda_literal becomes its
;; own Block scope so synthesized lambda-parameter and implicit-'it'
;; type-bindings (see captures.ts synthesizeKotlinLambdaBindings) stay
;; inside the lambda — they must not leak to the enclosing function
;; scope and must shadow same-named outer bindings (val it = "outer";
;; users.forEach { it.save() } — inner 'it' is the lambda's, not the
;; outer String).
;;
;; Lambdas appear inside call_suffix for trailing-lambda syntax
;; (list.forEach { it.foo() }) and inside value_arguments for
;; explicit-paren syntax (list.forEach({ x -> x.foo() })); both AST
;; positions produce the same lambda_literal subtree, so a single
;; capture suffices.
;;
;; Uses @scope.block (not @scope.function) to match the smart-cast
;; precedent (#1758) — keeps narrowed/lambda bindings scope-local
;; without the auto-hoist semantics of Function scopes.
(lambda_literal) @scope.block

;; Declarations — types
(class_declaration
  "interface"
  (type_identifier) @declaration.name) @declaration.interface

(class_declaration
  "class"
  (type_identifier) @declaration.name) @declaration.class

(object_declaration
  (type_identifier) @declaration.name) @declaration.class

(companion_object
  (type_identifier) @declaration.name) @declaration.class

(type_alias
  (type_identifier) @declaration.name) @declaration.type_alias

;; Declarations — functions / methods / properties
(function_declaration
  (simple_identifier) @declaration.name) @declaration.function

(property_declaration
  (variable_declaration
    (simple_identifier) @declaration.name)) @declaration.property

(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @declaration.name) @declaration.property

;; Imports
(import_header) @import.statement

;; Type bindings — parameters
(parameter
  (simple_identifier) @type-binding.name
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.parameter

;; Type bindings — property / local annotations
(property_declaration
  (variable_declaration
    (simple_identifier) @type-binding.name
    [(user_type) (nullable_type) (function_type)] @type-binding.type)) @type-binding.annotation

(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @type-binding.name
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.annotation

;; Type bindings — constructor-inferred val user = User(...)
(property_declaration
  (variable_declaration
    (simple_identifier) @type-binding.name)
  (call_expression
    (simple_identifier) @type-binding.type)) @type-binding.constructor

;; Type bindings — return annotations after function parameters
(function_declaration
  (simple_identifier) @type-binding.name
  (function_value_parameters)
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.return

;; References — callable references ("::method", "Type::new", "obj::m") — F47.
;; A "callable_reference" references a function/constructor as a value (no
;; call_suffix), so the registry-primary call path never saw it. Real-parse
;; (issue #1919) shows the canonical shape inside a function body is:
;;   "::topLevelFn"   -> (callable_reference :: (simple_identifier))   member only
;;   "String::length" -> (callable_reference (type_identifier) :: (simple_identifier))
;;   "obj::method"    -> (callable_reference (type_identifier) :: (simple_identifier))
;;   "Type::new"      -> (callable_reference (type_identifier) :: (simple_identifier))
;; The receiver (real type OR object) is always a "type_identifier"; the
;; referenced member is the LAST "simple_identifier". One rule with an
;; optional receiver and an end-anchored member covers all four forms with
;; exactly one match per callable_reference (no sibling-branch double-match).
;; (NOTE: a qualified "A.B::m" parses as a nested navigation_expression, not a
;; callable_reference, and is already captured by the read.member rule below.)
;; emitKotlinScopeCaptures rewrites this into a free/member call reference.
(callable_reference
  (type_identifier)? @reference.receiver
  (simple_identifier) @reference.name
  .) @reference.callable

;; References — direct calls / constructor syntax
(call_expression
  (simple_identifier) @reference.name) @reference.call.free

;; References — member calls: obj.method()
(call_expression
  (navigation_expression
    (_) @reference.receiver
    (navigation_suffix
      (simple_identifier) @reference.name))) @reference.call.member

;; References — property writes
(assignment
  (directly_assignable_expression
    (_) @reference.receiver
    (navigation_suffix
      (simple_identifier) @reference.name))
  (_)) @reference.write.member

;; References — property reads
(navigation_expression
  (_) @reference.receiver
  (navigation_suffix
    (simple_identifier) @reference.name)) @reference.read.member
`;

let parser: Parser | null = null;
let query: Parser.Query | null = null;

export function getKotlinParser(): Parser {
  if (parser === null) {
    parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Kotlin) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return parser;
}

export function getKotlinScopeQuery(): Parser.Query {
  if (query === null) {
    query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Kotlin) as Parameters<Parser['setLanguage']>[0],
      KOTLIN_SCOPE_QUERY,
    );
  }
  return query;
}
