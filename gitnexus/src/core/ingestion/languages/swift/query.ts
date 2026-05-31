/**
 * Tree-sitter query for Swift scope captures (RFC §5.1).
 *
 * Captures the structural skeleton the generic scope-resolution
 * pipeline consumes: scopes (module/class/function), declarations
 * (class-likes, methods, init, properties), imports, type bindings
 * (parameter annotations, property/field annotations, constructor
 * inference, receiver self), and references (call sites, member calls).
 *
 * Swift specifics that shape this query (all verified against
 * tree-sitter-swift 0.7.1 live s-expressions):
 *
 *   - `class`, `struct`, AND `extension` all parse to a single node
 *     type `class_declaration`. They are distinguished by the `name:`
 *     field node type: class/struct name is a bare `(type_identifier)`,
 *     while an extension's name field wraps the extended type in a
 *     `(user_type (type_identifier))`. The capture below grabs all
 *     three under `@scope.class` + `@declaration.class`; the captures
 *     orchestrator (`captures.ts`) re-tags extensions via the
 *     user_type discriminator so extension members hoist onto the
 *     extended type.
 *   - `protocol_declaration` is its own node; its bodyless method
 *     requirements are `protocol_function_declaration` (NOT
 *     `function_declaration`).
 *   - `init_declaration` has no `name:` field — identity is the `init`
 *     keyword. The captures layer synthesizes its `@declaration.name`.
 *   - Inside a `parameter`, BOTH the label and the type use the field
 *     name `name:` — disambiguate by child node type (simple_identifier
 *     = label, user_type = type). Parameter type bindings are therefore
 *     synthesized in `captures.ts`, not matched here.
 *   - A labeled call argument wraps its label in a dedicated
 *     `value_argument_label` node.
 *   - `self` is its own node `self_expression`; a `self.member()` call
 *     is `call_expression > navigation_expression(target: self_expression,
 *     suffix: navigation_suffix > simple_identifier)`.
 *   - `import_declaration` carries the module path as an `(identifier
 *     (simple_identifier)+)` — one `simple_identifier` per dotted
 *     segment. `@testable` and other attributes surface as a leading
 *     `(modifiers (attribute (user_type (type_identifier))))`.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Swift from 'tree-sitter-swift';

const SWIFT_SCOPE_QUERY = `
;; ── Scopes ──────────────────────────────────────────────────────────
(source_file) @scope.module

;; class / struct / extension all parse to class_declaration; the
;; captures orchestrator splits extensions out via the user_type
;; name discriminator.
(class_declaration) @scope.class
(protocol_declaration) @scope.class

(function_declaration) @scope.function
(protocol_function_declaration) @scope.function
(init_declaration) @scope.function
(deinit_declaration) @scope.function

;; ── Declarations — types ────────────────────────────────────────────
;; class / struct: name is a bare type_identifier.
(class_declaration
  name: (type_identifier) @declaration.name) @declaration.class

;; extension: name is (user_type (type_identifier)). Captured separately
;; so captures.ts can re-tag it as an extension of the wrapped type.
(class_declaration
  name: (user_type) @declaration.name) @declaration.extension

(protocol_declaration
  name: (type_identifier) @declaration.name) @declaration.interface

;; ── Declarations — methods / init / properties ──────────────────────
(function_declaration
  name: (simple_identifier) @declaration.name) @declaration.method

(protocol_function_declaration
  name: (simple_identifier) @declaration.name) @declaration.method

;; init has no name field — captures.ts synthesizes @declaration.name = "init".
(init_declaration) @declaration.constructor

(property_declaration
  name: (pattern
    bound_identifier: (simple_identifier) @declaration.name)) @declaration.property

;; ── Imports ─────────────────────────────────────────────────────────
;; Single anchor per import; the captures layer decomposes the module
;; path (and detects @testable) into @import.kind/source/name markers.
(import_declaration) @import.statement

;; ── Type bindings — property annotations: \`var owner: Owner\` ─────────
(property_declaration
  name: (pattern
    bound_identifier: (simple_identifier) @type-binding.name)
  (type_annotation
    (user_type (type_identifier) @type-binding.type))) @type-binding.annotation

;; ── Type bindings — stored / local-var constructor inference:
;; \`let p = Product(...)\` (constructor) and \`let u = getUser()\`
;; (free-call result; chain-follow resolves getUser → its return type).
;; property_declaration is the node for both class-level stored
;; properties AND let/var inside a function body. ───────────────────
(property_declaration
  name: (pattern
    bound_identifier: (simple_identifier) @type-binding.name)
  value: (call_expression
    (simple_identifier) @type-binding.type)) @type-binding.constructor

;; \`let u = await fetchUser()\` — unwrap the await wrapper to the call.
(property_declaration
  name: (pattern
    bound_identifier: (simple_identifier) @type-binding.name)
  value: (await_expression
    (call_expression
      (simple_identifier) @type-binding.type))) @type-binding.constructor

;; \`let r = try parseRepo()\` — unwrap the try wrapper to the call.
(property_declaration
  name: (pattern
    bound_identifier: (simple_identifier) @type-binding.name)
  value: (try_expression
    (call_expression
      (simple_identifier) @type-binding.type))) @type-binding.constructor

;; ── Optional binding anchors: if-let / guard-let. In tree-sitter-swift
;; 0.7.1 these are if_statement / guard_statement with a flat shape — a
;; \`bound_identifier:\` field for the name plus separate \`condition:\`
;; children (one of which is the bound value expression). A static .scm
;; pattern can't pair the name with the value across those sibling
;; condition fields, so we only ANCHOR the statement here and synthesize
;; the @type-binding.constructor in captures.ts (synthesizeOptionalBinding)
;; by walking the node. (A nonexistent if_let_binding node type would throw
;; TSQueryErrorNodeType and break the WHOLE query — do not reintroduce it.)
(if_statement
  bound_identifier: (simple_identifier)) @optional.binding
(guard_statement
  bound_identifier: (simple_identifier)) @optional.binding

;; NOTE: parameter-type bindings (\`func f(u: User)\`) and function
;; return-type bindings (\`func getUser() -> User\`) are NOT matched by
;; tree-sitter patterns here. Swift's grammar reuses the SAME \`name:\`
;; field for the function name, each parameter's label, AND the return
;; type, so a two-\`name:\`-field query cross-assigns and produces garbage
;; bindings (\`save: save\`). They are synthesized in code instead —
;; \`captures.ts\` reads the function node via
;; \`swiftMethodConfig.extractParameters\` / \`extractReturnType\`, which
;; handle the grammar correctly. (Mirrors how receiver + arity are
;; synthesized rather than queried.)

;; ── References — field reads: \`u.address\` (member access that is NOT a
;; call callee or assignment LHS). Emit-side filtering in captures.ts
;; drops call targets and write LHS so only genuine reads emit ACCESSES.
(navigation_expression
  target: (_) @reference.receiver
  suffix: (navigation_suffix
    suffix: (simple_identifier) @reference.name)) @reference.read.member

;; ── References — free calls: \`foo(...)\` ─────────────────────────────
(call_expression
  (simple_identifier) @reference.name) @reference.call.free

;; ── References — member / method calls: \`obj.method(...)\` ───────────
;; navigation_expression carries the receiver (target:) and the member
;; (suffix > navigation_suffix > simple_identifier). \`self\` is a
;; self_expression; other receivers are simple_identifier / nested
;; navigation_expression — capture the whole target as @reference.receiver.
(call_expression
  (navigation_expression
    target: (_) @reference.receiver
    suffix: (navigation_suffix
      suffix: (simple_identifier) @reference.name))) @reference.call.member

;; ── References — constructor calls handled via @reference.call.free
;; (a Swift \`Foo(...)\` is a call_expression with a simple_identifier
;; callee; pickConstructorOrClass in free-call fallback targets the
;; type's Constructor). No separate object_creation node in Swift.
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getSwiftParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Swift as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getSwiftScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Swift as Parameters<Parser['setLanguage']>[0], SWIFT_SCOPE_QUERY);
  }
  return _query;
}
