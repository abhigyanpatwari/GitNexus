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
 *   - Containers (struct/enum/union/opaque) are anonymous nodes bound by the
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
(opaque_declaration) @scope.class
(function_declaration) @scope.function
(test_declaration) @scope.function
(block) @scope.block

;; Declarations — functions (relabeled @declaration.method inside containers
;; by emitZigScopeCaptures, mirroring the provider's labelOverride)
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Declarations — named tests. Same naming rule as ZIG_QUERIES: the string
;; node WITH quotes, so the def joins the graph node and never collides with
;; a same-named fn. Anonymous / decl-form tests are scopes without a def.
(test_declaration
  (string) @declaration.name) @declaration.function

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
;; opaque {} is a fieldless container that may own methods — Struct, as in
;; ZIG_QUERIES (see the rationale there).
(variable_declaration
  (identifier) @declaration.name
  (opaque_declaration) @declaration.struct)

;; Declarations — generic type constructors. \`fn List(comptime T: type) type
;; { return struct {…}; }\` is Zig's only spelling of a generic type; the
;; returned container is anonymous in the grammar but every reader (and every
;; caller: \`List(u8)\`) names it after the function. Anchor on the container
;; so the def sits in its own class scope; the name binding is hoisted to the
;; MODULE scope by \`zigBindingScopeFor\` (not the fn body, where the name
;; would be invisible to callers) and coexists with the Function def of the
;; same name — \`List\` really is both a callable and a type.
((function_declaration
  name: (identifier) @declaration.name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (struct_declaration) @declaration.struct))))
  (#eq? @_ret "type"))
((function_declaration
  name: (identifier) @declaration.name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (union_declaration) @declaration.union))))
  (#eq? @_ret "type"))
((function_declaration
  name: (identifier) @declaration.name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (enum_declaration) @declaration.enum))))
  (#eq? @_ret "type"))

;; Declarations — container fields (struct fields, enum/union variants).
;; The #not-eq? guard drops the MISSING placeholder identifier tree-sitter-zig
;; recovers for an empty container body (see ZIG_QUERIES).
((container_field
  name: (identifier) @declaration.name) @declaration.field
  (#not-eq? @declaration.name ""))

;; Declarations — const/var bindings (import/container groups filtered in TS).
;; The \`.\` anchor pins the FIRST named child: without it the pattern also
;; matched the initializer of \`const first = target;\`, minting a phantom
;; local named \`target\` that shadowed the real callee for every later
;; reference in the block. The literal keyword is load-bearing too:
;; tree-sitter-zig 1.1.2 parses statement assignments (\`x = 5;\`, \`x += 1;\`,
;; \`_ = expr;\`) as \`variable_declaration\` WITHOUT a keyword child, and
;; without the keyword every assignment and every discard minted a phantom
;; local (one \`_\` per statement).
(variable_declaration
  "const" . (identifier) @declaration.name) @declaration.variable
(variable_declaration
  "var" . (identifier) @declaration.name) @declaration.variable

;; Imports — const x = @import("...") / var x = @import("..."). Keyword-gated
;; like every binding rule: a keyword-less \`x = @import("...")\` is a
;; statement (see the side-effect rule below), not a binding.
(variable_declaration
  "const" . (identifier) @import.name
  (builtin_function
    (builtin_identifier) @_builtin
    (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.statement
(variable_declaration
  "var" . (identifier) @import.name
  (builtin_function
    (builtin_identifier) @_builtin
    (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.statement

;; Imports — const X = @import("...").X : a NAMED import of one member. The
;; local name is whatever the user chose (\`const Alloc = @import("std").mem;\`
;; is a rename), the imported name is the member. Deeper chains
;; (\`@import("std").mem.Allocator\`) bind the innermost member — the file
;; edge is what matters; a member-of-a-member resolves through the namespace
;; later or not at all.
(variable_declaration
  "const" . (identifier) @import.name
  (field_expression
    object: (builtin_function
      (builtin_identifier) @_builtin
      (arguments (string) @import.source))
    member: (identifier) @import.imported)
  (#eq? @_builtin "@import")) @import.statement
(variable_declaration
  "const" . (identifier) @import.name
  (field_expression
    object: (field_expression
      object: (builtin_function
        (builtin_identifier) @_builtin
        (arguments (string) @import.source)))
    member: (identifier) @import.imported)
  (#eq? @_builtin "@import")) @import.statement

;; Imports — a keyword-less \`<ident> = @import("...");\` statement
;; (\`_ = @import("all_tests.zig");\` in a test block, the refAllDecls
;; idiom): tree-sitter-zig reuses \`variable_declaration\` for assignments, so
;; the shape is a declaration minus the keyword. It references the file
;; without binding a name — a side-effect import. Tree-sitter queries cannot
;; say "no keyword child", so this rule matches the keyword-bearing shapes
;; too; \`emitZigScopeCaptures\` keeps it only when \`isZigKeywordDeclaration\`
;; is false (the keyword shapes are the binding rules above).
(variable_declaration
  . (identifier)
  (builtin_function
    (builtin_identifier) @_builtin
    (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.side-effect

;; Aliases of a namespace member — const Counter = counter.Counter; where
;; \`counter\` is an @import binding of THIS file. The query cannot know which
;; identifiers are import bindings, so it captures every one-level member
;; alias and \`emitZigScopeCaptures\` promotes the ones whose object is a
;; known @import to a named import (same fact as \`const Counter =
;; @import("counter.zig").Counter;\`); the rest stay ordinary variables.
;; Deeper chains (\`std.mem.Allocator\`) bind the innermost member off the
;; leftmost namespace.
(variable_declaration
  "const" . (identifier) @alias.name
  (field_expression
    object: (identifier) @alias.namespace
    member: (identifier) @alias.member) .) @alias.statement
(variable_declaration
  "const" . (identifier) @alias.name
  (field_expression
    object: (field_expression
      object: (identifier) @alias.namespace)
    member: (identifier) @alias.member) .) @alias.statement

;; Imports — pub usingnamespace @import("..."); : every pub decl of the target
;; becomes a decl of this container (removed from the language in 0.15, still
;; everywhere in 0.11–0.14 code). Modelled as a wildcard import.
(using_namespace_declaration
  (builtin_function
    (builtin_identifier) @_builtin
    (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.wildcard

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

;; Type bindings — generic instantiation literal: const l = List(u8){ ... }.
;; The callee is the type constructor; \`normalizeZigTypeName\` drops the
;; comptime argument list so \`List(u8)\` looks up \`List\`.
(variable_declaration
  (identifier) @type-binding.name
  (struct_initializer
    (call_expression) @type-binding.type)) @type-binding.constructor

;; Type bindings — declared type: var x: T = …; const x: T = .init(…);
;; The annotation is the ONLY type source for \`= undefined\` and for 0.14+
;; decl literals (\`.init\`, \`.empty\`), which are the idiomatic
;; constructors in current std. Ranked below constructor inference by the
;; shared resolver (source 'annotation'), so a literal on the right still
;; wins when both are present.
(variable_declaration
  . (identifier) @type-binding.name
  type: (_) @type-binding.type) @type-binding.annotation

;; Type bindings — call-return inference: var c = Counter.init(); (Rust's
;; \`let x = Foo::new()\` twin). The receiver of the call is the type when it
;; names a container (\`Counter\`, \`mod.Counter\`, \`List(u8)\`); when it is a
;; value (\`std.mem\`, \`self.items\`) the lookup finds no container and
;; declines, exactly as Rust's does. Keyword-gated: \`_ = e.top();\` is an
;; assignment (same node type), not a binding of \`_\`.
(variable_declaration
  "const" . (identifier) @type-binding.name
  (call_expression
    function: (field_expression
      object: (_) @type-binding.type)) .) @type-binding.call-return
(variable_declaration
  "var" . (identifier) @type-binding.name
  (call_expression
    function: (field_expression
      object: (_) @type-binding.type)) .) @type-binding.call-return

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
