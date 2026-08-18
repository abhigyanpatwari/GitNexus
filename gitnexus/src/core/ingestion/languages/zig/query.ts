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
;; recovers for an empty container body (see ZIG_QUERIES). The optional
;; \`type:\` (absent on enum variants) is captured as @declaration.field-type:
;; \`emitZigScopeCaptures\` turns it into a @type-binding.field on the
;; container's Class scope so \`self.session.name()\` can walk the field's
;; type (Rust/Go parity — see the F5 block in captures.ts).
((container_field
  name: (identifier) @declaration.name
  type: (_)? @declaration.field-type) @declaration.field
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

;; Imports — \`@import("...")\` in ANY other position: a tuple element
;; (\`pub const Interfaces = .{ @import("a.zig"), @import("b.zig") }\`, the
;; JS-API registration table), a call argument (\`event.is(@import("x.zig"))\`),
;; a comparison operand (\`T == @import("x.zig").T\`), the receiver of a
;; member call (\`try @import("dump.zig").root(...)\`), a 3-deep member chain…
;; Every one of them is a file dependency; only the const/var/usingnamespace
;; shapes above bind a name. This rule matches EVERY \`@import\` builtin, the
;; bound shapes included — \`emitZigScopeCaptures\` drops the matches whose
;; string node a binding rule (or the keyword-less side-effect rule) already
;; claimed, so a bound import is never doubled, and emits the rest as
;; side-effect imports (file edge, no binding) — except the member-call
;; receiver, which becomes a namespace import keyed by its own source text so
;; the call resolves into the imported module (see the emitter).
((builtin_function
  (builtin_identifier) @_builtin
  (arguments (string) @import.source))
  (#eq? @_builtin "@import")) @import.inline

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

;; Type bindings — value inference (F6): const t = <value>; where <value> is a
;; call (\`Counter.init()\`, \`makeThing()\`, \`node.asElement()\`), possibly
;; wrapped in \`try\` / \`catch …\` / \`… orelse …\` / parentheses — the shape of
;; nearly every Zig constructor call (\`const p = try Page.init(…)\`). The
;; query only pins the declaration; \`emitZigScopeCaptures\` unwraps the
;; wrappers and rewrites \`@type-binding.type\` to the type source (see
;; \`zigCallReturnTypeOf\`). Keyword-gated: \`_ = e.top();\` is an assignment
;; (same node type), not a binding of \`_\`. Rust's twin is
;; \`let x = Foo::new()\` / \`let x = foo().await\`.
(variable_declaration
  "const" . (identifier) @type-binding.name
  (_) @type-binding.value .) @type-binding.call-return
(variable_declaration
  "var" . (identifier) @type-binding.name
  (_) @type-binding.value .) @type-binding.call-return

;; Type bindings — return-type annotation (F6): \`fn make() !*Thing\` binds
;; \`make ↦ Thing\` in the enclosing scope (Module for free fns, the container's
;; Class scope for methods — that is where the compound resolver reads a
;; method's return type for \`node.asElement()\`), so \`const t = makeThing()\`
;; chains to \`Thing\`. Rust: \`(function_item … return_type:) @type-binding.return\`.
;; \`emitZigScopeCaptures\` drops builtin / \`type\` returns (a \`List ↦ type\`
;; binding would hijack the \`List(u8){}\` constructor chain).
(function_declaration
  name: (identifier) @type-binding.name
  type: (_) @type-binding.type) @type-binding.return

;; Type bindings — aliases (F5 field-access aliases + F7 type aliases):
;; \`const page = self.page;\` (F5: the RHS path is kept verbatim as the
;; "type", the compound resolver's member-alias branch re-resolves it as a
;; receiver chain — head \`self\` → class → field type), \`const LocalAlias = Local;\`,
;; \`const Proto = HtmlElement;\`, \`const T2 = Thing;\` (alias of an alias /
;; import), \`const B = util.List(u8);\` (an INSTANTIATED generic type
;; constructor). Zig has no \`type X = Y\` syntax — a type alias is a const
;; whose value is a type expression, and it stays a Const in the graph. What
;; must change is the scope side: bind the alias NAME to the value's type
;; text (Rust's \`let x = y\` / JS's \`const B = Foo\` \`@type-binding.alias\`,
;; source 'assignment-inferred'), so \`LocalAlias.mk()\` types through Case 4,
;; \`B.init()\` / \`x: B\` / \`B{}\` through Case 3 once \`normalizeZigTypeName\`
;; drops the comptime arguments (\`util.List(u8)\` → \`util.List\`), and every
;; binding that names the alias (\`var l = LocalAlias.mk()\`, \`var x: B\`) is
;; chained to the target by the shared \`followChainedRef\` /
;; \`followChainPostFinalize\`. The identifier / member shapes take \`var\` too:
;; \`var node = orig_node;\` is the same value alias as Rust's \`let x = y\`
;; and chains to the type of \`orig_node\` (a Zig type is comptime and never
;; \`var\`, so the type-alias reading only ever applies to \`const\`). The
;; call shape is \`const\`-only and kept only when the callee's last
;; identifier is TitleCase — see \`emitZigScopeCaptures\` (a value call
;; \`const t = util.makeThing()\` belongs to the call-return rules above and
;; must not receive a competing binding). A promoted namespace-member alias
;; (\`const Counter = counter.Counter;\` → named import) is skipped there too:
;; the import binding already carries the type.
(variable_declaration
  "const" . (identifier) @type-binding.name
  (identifier) @type-binding.type .) @type-binding.alias
(variable_declaration
  "var" . (identifier) @type-binding.name
  (identifier) @type-binding.type .) @type-binding.alias
(variable_declaration
  "const" . (identifier) @type-binding.name
  (field_expression) @type-binding.type .) @type-binding.alias
(variable_declaration
  "var" . (identifier) @type-binding.name
  (field_expression) @type-binding.type .) @type-binding.alias
(variable_declaration
  "const" . (identifier) @type-binding.name
  (call_expression) @type-binding.type .) @type-binding.alias

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
