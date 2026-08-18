import Parser from 'tree-sitter';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/**
 * Zig scope-resolution query (RFC #909 Ring 3).
 *
 * The grammar is an optionalDependency (`@tree-sitter-grammars/tree-sitter-zig`),
 * so the language module is required lazily and `getZigParser` /
 * `getZigScopeQuery` throw only when actually invoked without the grammar
 * installed. That is safe: the parse pipeline filters `.zig` files through
 * `parser-loader.isLanguageAvailable` before any scope extraction runs.
 *
 * Zig specifics encoded here:
 *   - Containers (struct/enum/union) are anonymous nodes bound by the
 *     enclosing `variable_declaration`; declarations capture the binding
 *     identifier from the wrapper.
 *   - `@import` is a builtin call, not import-statement syntax; the
 *     `#eq?` predicate keeps other builtins (@sizeOf, @as, …) out.
 *   - A plain `(variable_declaration (identifier))` rule would also match
 *     container and import bindings — `emitZigScopeCaptures` filters those
 *     groups out so a name binds exactly once.
 */
const ZIG_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(struct_declaration) @scope.class
(enum_declaration) @scope.class
(union_declaration) @scope.class
(function_declaration) @scope.function
(block) @scope.block

;; Declarations — functions (relabeled @declaration.method inside containers
;; by emitZigScopeCaptures, mirroring the provider's labelOverride)
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Declarations — containers. The binding name lives on the wrapper
;; variable_declaration, but the ANCHOR is the container node itself so its
;; range equals the @scope.class range: the extractor then attaches the def
;; to the class scope (walkers.populateClassOwnedMembers expects the
;; class-like def among the class scope's ownedDefs) and auto-hoists the
;; name binding to the parent scope.
(variable_declaration
  (identifier) @declaration.name
  (struct_declaration) @declaration.struct)
(variable_declaration
  (identifier) @declaration.name
  (enum_declaration) @declaration.enum)
(variable_declaration
  (identifier) @declaration.name
  (union_declaration) @declaration.union)

;; Declarations — container fields (struct fields, enum/union variants)
(container_field
  name: (identifier) @declaration.name) @declaration.field

;; Declarations — const/var bindings (import/container groups filtered in TS).
;; The \`.\` anchor pins the FIRST named child: without it the pattern also
;; matched the initializer of \`const first = target;\`, minting a phantom
;; local named \`target\` that shadowed the real callee for every later
;; reference in the block.
(variable_declaration
  . (identifier) @declaration.name) @declaration.variable

;; Imports — const x = @import("...")
(variable_declaration
  (identifier) @import.name
  (builtin_function
    (builtin_identifier) @_builtin
    (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.statement

;; Type bindings — parameter annotations (incl. self: *T receivers)
(parameter
  name: (identifier) @type-binding.name
  type: (_) @type-binding.type) @type-binding.parameter

;; Type bindings — constructor inference: const p = T{ ... }
(variable_declaration
  (identifier) @type-binding.name
  (struct_initializer
    (identifier) @type-binding.type)) @type-binding.constructor

;; Type bindings — qualified constructor: const p = mod.T{ ... }. The whole
;; field_expression is captured so the dotted text "mod.T" survives —
;; receiver dispatch resolves the namespace prefix through the import
;; binding (emitReceiverBoundCalls Case 3).
(variable_declaration
  (identifier) @type-binding.name
  (struct_initializer
    (field_expression) @type-binding.type)) @type-binding.constructor

;; References — free calls: foo(...)
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; References — member calls: obj.method(...) / mod.fn(...)
(call_expression
  function: (field_expression
    object: (_) @reference.receiver
    member: (identifier) @reference.name)) @reference.call.member

;; References — constructor uses: T{ ... }
(struct_initializer
  (identifier) @reference.name) @reference.call.constructor
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

function getZigLanguage(): Parameters<Parser['setLanguage']>[0] {
  return _require('@tree-sitter-grammars/tree-sitter-zig');
}

export function getZigParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(getZigLanguage());
  }
  return _parser;
}

export function getZigScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(getZigLanguage(), ZIG_SCOPE_QUERY);
  }
  return _query;
}
