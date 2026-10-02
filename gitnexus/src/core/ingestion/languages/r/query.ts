/**
 * Tree-sitter query for R scope captures (RFC #909 Ring 3).
 *
 * R has no dedicated class syntax — R6 classes are `R6Class(...)` calls, S4/R5
 * classes are `setClass(...)`/`setRefClass(...)` calls — so this query mirrors
 * the shapes the legacy `R_QUERIES` (`tree-sitter-queries.ts`) already proved
 * queryable for structural extraction (the heritage shapes below have no
 * counterpart there), renamed onto the scope-resolution capture vocabulary
 * (`@scope.*`, `@declaration.*`, `@reference.*`, `@import.*`,
 * `@type-binding.*`).
 *
 * R specifics encoded here:
 *
 *   - A Class scope spans the ENTIRE `R6Class(...)`/`setClass(...)` call
 *     (the whole `binary_operator` for the `name <- R6Class(...)` shape),
 *     not just `public = list(...)` — the `inherit=`/`contains=` argument
 *     must fall inside the scope's range so the `@reference.inherits` sites
 *     resolve against the deriving class's own scope.
 *
 *   - `@declaration.function`/`@declaration.class` anchor on the WHOLE
 *     `name <- <rhs>` assignment (matching the legacy `@definition.*`
 *     anchors exactly), so `resolveDefGraphId`'s position-based (Function)
 *     and qualifiedName-keyed (Class) reconciliation lands on the SAME
 *     graph node the legacy extractor already created.
 *
 *   - `@declaration.method` anchors on the `name = function(...)` ARGUMENT
 *     inside `public =`/`private =`/`active =`/`methods = list(...)`.
 *
 *   - A def is owned by the innermost scope whose range EQUALS its anchor
 *     range (`scope-extractor.ts` Pass 2), and `resolveCallerGraphId` walks
 *     from a call site up to the first scope that owns a callable def. The
 *     blanket `(function_definition) @scope.function` is strictly narrower
 *     than the assignment/argument anchors, so on its own it never owns a
 *     def: every named function/method would be owned by the module or
 *     Class scope and every call in the file would be credited to the
 *     FIRST callable in it. So each named-callable anchor also gets a
 *     `@scope.function` on the SAME node, placed directly beside its
 *     `@declaration.*` pattern below (the two must stay in lockstep — a
 *     declaration anchor without a matching scope silently reverts that
 *     shape to first-callable attribution). The def's own binding still
 *     hoists to the PARENT scope (anchor range == scope range), so name
 *     lookup is unchanged. The blanket rule is kept: it still covers
 *     anonymous functions (`lapply(x, function(z) ...)`), which own nothing.
 *     Calls in a Class body outside any method (an R6 field default, a
 *     `setClass(validity = function...)` body) are credited to the Class.
 *
 *   - No `@declaration.qualified_name` is emitted for `@declaration.class`
 *     — R's legacy extractor has no `classExtractor`, so a Class node's
 *     `qualifiedName` today is the bare class-name text. Omitting the
 *     capture lets `buildDefFromDeclarationMatch` default `qualifiedName`
 *     to the bare name, matching the legacy node so `resolveDefGraphId`'s
 *     name-keyed fallback finds it.
 *
 *   - S4/setGeneric/setMethod declarations are deliberately NOT captured
 *     here — they are already produced by the legacy extractor via
 *     R_QUERIES, independent of scope-resolution, and none of the target
 *     scenarios needs a NEW declaration for them. Their inner
 *     `function_definition` bodies still get a `@scope.function` from the
 *     blanket rule below (an unnamed scope, harmless).
 *
 *   - `library()`/`require()` are wildcard imports (`@import.wildcard`) —
 *     every top-level name of the named local package becomes visible,
 *     unfiltered by NAMESPACE (see `rProvider.expandsWildcardTo`).
 *     `source()` is a side-effect import (`@import.side-effect`) — it
 *     establishes a file dependency but binds no name; cross-file free
 *     calls into a `source()`d file resolve via `allowGlobalFreeCallFallback`
 *     instead (`rScopeResolver`).
 *
 *   - `obj$method()` (the `extract_operator`, R's `$`) is a member call with
 *     an explicit receiver — the same shape as Ruby's `obj.method`.
 *     `Type$new(...)` is R6's constructor spelling: captured separately as
 *     `@type-binding.constructor` so `x <- Type$new(...)` types `x`.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import R from '@eagleoutice/tree-sitter-r';

/**
 * Exported for `value-ref-dispatchability.test.ts`-style whole-query readers.
 * Not part of the provider surface — nothing else should import it.
 */
export const R_SCOPE_QUERY = `
;; ── Scopes ───────────────────────────────────────────────────────────────

(program) @scope.module

(function_definition) @scope.function

;; R6 class via namespace call (ClassName <- R6::R6Class(...)) — the scope
;; spans the WHOLE assignment, including inherit=, so heritage sites resolve
;; inside the deriving class's own scope.
(binary_operator
  lhs: (identifier)
  rhs: (call
    function: (namespace_operator
      rhs: (identifier) @_r6ns_scope
      (#match? @_r6ns_scope "^R6Class$")))) @scope.class

;; R6 class via bare call (ClassName <- R6Class(...))
(binary_operator
  lhs: (identifier)
  rhs: (call
    function: (identifier) @_r6bare_scope
    (#match? @_r6bare_scope "^R6Class$"))) @scope.class

;; S4/R5 class (setClass(...) / setRefClass(...)) — scope spans the whole call.
(call
  function: (identifier) @_s4_scope
  (#match? @_s4_scope "^(setClass|setRefClass)$")) @scope.class

;; ── Declarations — functions ──────────────────────────────────────────────

(binary_operator
  lhs: (identifier) @declaration.name
  rhs: (function_definition)) @declaration.function

;; Function scope on the SAME assignment node as the declaration above, so the
;; def is owned by its own scope (and calls inside the body attribute to it).
;; This pattern and the \`@declaration.function\` pattern above must stay in
;; lockstep — identical structure, identical anchor node (see file header).
(binary_operator
  lhs: (identifier)
  rhs: (function_definition)) @scope.function

;; ── Declarations — classes (name only; no qualified_name, see file header) ─
;;
;; The setClass/setRefClass declaration and the source/library/require imports
;; below capture EVERY string (imports: identifier or string) argument of the call.
;; \`emitRScopeCaptures\` keeps only the one that names the class or import
;; (\`isRNonNamingScopeMatch\`): the argument spelled with the first formal, else the
;; first unnamed one, so a leading comment or a named \`lib.loc =\` / \`local =\` does
;; not change the answer. A query-level anchor cannot skip an unbounded run of
;; leading comments and named arguments without a repeated sibling group, which
;; is quadratic in the argument count on every call.

(binary_operator
  lhs: (identifier) @declaration.name
  rhs: (call
    function: (namespace_operator
      rhs: (identifier) @_r6ns_decl
      (#match? @_r6ns_decl "^R6Class$")))) @declaration.class

(binary_operator
  lhs: (identifier) @declaration.name
  rhs: (call
    function: (identifier) @_r6bare_decl
    (#match? @_r6bare_decl "^R6Class$"))) @declaration.class

(call
  function: (identifier) @_s4_decl
  (#match? @_s4_decl "^(setClass|setRefClass)$")
  arguments: (arguments
    (argument
      value: (string
        content: (string_content) @declaration.name)))) @declaration.class

;; ── Declarations — R6/R5 methods ──────────────────────────────────────────

;; R6 methods via namespace call (inside public/private/active = list(...))
(binary_operator
  lhs: (identifier) @_class1
  rhs: (call
    function: (namespace_operator
      rhs: (identifier) @_r6ns_m
      (#match? @_r6ns_m "^R6Class$"))
    arguments: (arguments
      (argument
        name: (identifier) @_section1
        (#match? @_section1 "^(public|private|active)$")
        value: (call
          function: (identifier) @_listfn1
          (#match? @_listfn1 "^list$")
          arguments: (arguments
            (argument
              name: (identifier) @declaration.name
              value: (function_definition)) @declaration.method))))))

;; R6 methods via bare call (inside public/private/active = list(...))
(binary_operator
  lhs: (identifier) @_class2
  rhs: (call
    function: (identifier) @_r6bare_m
    (#match? @_r6bare_m "^R6Class$")
    arguments: (arguments
      (argument
        name: (identifier) @_section2
        (#match? @_section2 "^(public|private|active)$")
        value: (call
          function: (identifier) @_listfn2
          (#match? @_listfn2 "^list$")
          arguments: (arguments
            (argument
              name: (identifier) @declaration.name
              value: (function_definition)) @declaration.method))))))

;; R5 methods (inside setRefClass(... methods = list(...)))
(binary_operator
  lhs: (identifier) @_class3
  rhs: (call
    function: (identifier) @_refFn_m
    (#match? @_refFn_m "^setRefClass$")
    arguments: (arguments
      (argument
        name: (identifier) @_methods3
        (#match? @_methods3 "^methods$")
        value: (call
          function: (identifier) @_listfn3
          (#match? @_listfn3 "^list$")
          arguments: (arguments
            (argument
              name: (identifier) @declaration.name
              value: (function_definition)) @declaration.method))))))

;; Function scope on the SAME \`name = function(...)\` argument node that the
;; three \`@declaration.method\` patterns above anchor on, so each R6/R5 method
;; def is owned by its own Function scope (a child of the Class scope) rather
;; than by the Class scope. Deliberately generic — any named function-valued
;; argument — so it cannot drift from the three long nesting patterns above; it
;; is inert for non-method arguments (\`FUN = function...\`, \`error = function(e)\`
;; own no defs, and calls inside them walk up to the enclosing callable). The
;; declaration patterns above and this pattern must stay in lockstep.
(argument
  name: (identifier)
  value: (function_definition)) @scope.function

;; ── Imports ────────────────────────────────────────────────────────────────

;; source("path.R") — side-effect: establishes a file dependency, binds no name.
(call
  function: (identifier) @_srcfn
  (#match? @_srcfn "^source$")
  arguments: (arguments
    (argument
      value: [(identifier) (string)] @import.source))) @import.side-effect

;; library("pkg") / require("pkg") — wildcard: every top-level name of the
;; named local package becomes visible (rProvider.expandsWildcardTo).
(call
  function: (identifier) @_libfn
  (#match? @_libfn "^(library|require)$")
  arguments: (arguments
    (argument
      value: [(identifier) (string)] @import.source))) @import.wildcard

;; ── Type bindings — R6 constructor (x <- Type$new(...)) ───────────────────

(binary_operator
  lhs: (identifier) @type-binding.name
  rhs: (call
    function: (extract_operator
      lhs: (identifier) @type-binding.type
      rhs: (identifier) @_newfn
      (#match? @_newfn "^new$")))) @type-binding.constructor

;; ── References — heritage: R6 inherit= ────────────────────────────────────

(binary_operator
  lhs: (identifier)
  rhs: (call
    function: (namespace_operator
      rhs: (identifier) @_r6ns_h
      (#match? @_r6ns_h "^R6Class$"))
    arguments: (arguments
      (argument
        name: (identifier) @_inh1
        (#match? @_inh1 "^inherit$")
        value: (identifier) @reference.inherits))))

(binary_operator
  lhs: (identifier)
  rhs: (call
    function: (identifier) @_r6bare_h
    (#match? @_r6bare_h "^R6Class$")
    arguments: (arguments
      (argument
        name: (identifier) @_inh2
        (#match? @_inh2 "^inherit$")
        value: (identifier) @reference.inherits))))

;; ── References — heritage: S4 contains= (single parent, incl. "VIRTUAL") ──

(call
  function: (identifier) @_s4h1
  (#match? @_s4h1 "^(setClass|setRefClass)$")
  arguments: (arguments
    (argument
      name: (identifier) @_contains1
      (#match? @_contains1 "^(contains|CONTAINS)$")
      value: (string
        content: (string_content) @reference.inherits))))

;; ── References — heritage: S4 contains=c(...) (multiple parents) ──────────

(call
  function: (identifier) @_s4h2
  (#match? @_s4h2 "^(setClass|setRefClass)$")
  arguments: (arguments
    (argument
      name: (identifier) @_contains2
      (#match? @_contains2 "^(contains|CONTAINS)$")
      value: (call
        function: (identifier) @_cfn2
        (#match? @_cfn2 "^c$")
        arguments: (arguments
          (argument
            value: (string
              content: (string_content) @reference.inherits)))))))

;; ── References — calls ────────────────────────────────────────────────────

;; Free calls: foo(x)
(call
  function: (identifier) @reference.name) @reference.call.free

;; Namespaced calls: pkg::func() and pkg:::func(). The whole namespace_operator
;; is captured as the qualified name so the qualifier survives the parse cache.
(call
  function: (namespace_operator
    rhs: (identifier) @reference.name) @reference.qualified-name) @reference.call.free

;; Member calls via $: obj$method()
(call
  function: (extract_operator
    lhs: (identifier) @reference.receiver
    rhs: (identifier) @reference.name)) @reference.call.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getRParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getRScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(R as Parameters<Parser['setLanguage']>[0], R_SCOPE_QUERY);
  }
  return _query;
}
