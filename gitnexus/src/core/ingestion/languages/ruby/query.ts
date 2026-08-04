/**
 * Tree-sitter query for Ruby scope captures (U1 scope-resolution migration).
 *
 * Captures the structural skeleton the generic scope-resolution pipeline
 * consumes: scopes (program/class/module/method/block), declarations
 * (class, module, method, singleton_method, variable), imports
 * (require/require_relative/load), type bindings (constructor-inferred
 * locals via `.new`), and references (free calls, member calls).
 *
 * Ruby specifics that shape this query:
 *
 *   - Ruby modules are class-like scopes (they hold methods and can be
 *     mixed in via include/extend/prepend).
 *
 *   - `singleton_method` (`def self.foo`) is a class-level method
 *     declaration, captured as @scope.function + @declaration.function.
 *
 *   - Ruby has no static type annotations. Constructor inference via
 *     `x = User.new` is handled here; YARD `@param`/`@return` comments
 *     are handled programmatically in captures.ts.
 *
 *   - In Ruby, field access IS a method call (attr_reader generates
 *     methods). Member calls cover both method calls and field reads.
 *
 *   - `require`, `require_relative`, and `load` are plain method calls
 *     in the grammar — matched by name via `#match?`.
 *
 *   - `do_block` and `block` (`{ }`) are both block scopes that can
 *     introduce closures.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';

const RUBY_SCOPE_QUERY = `
;; ── Scopes ───────────────────────────────────────────────────────────────

(program) @scope.module

(class) @scope.class
(module) @scope.class

(method) @scope.function
(singleton_method) @scope.function

(do_block) @scope.block
(block) @scope.block

;; ── Declarations — class ─────────────────────────────────────────────────

(class
  name: (constant) @declaration.name) @declaration.class

;; class Foo::Bar — namespaced class definition
(class
  name: (scope_resolution
    name: (constant) @declaration.name)) @declaration.class

;; ── Declarations — module (labeled Trait for class-like registry lookup) ─

(module
  name: (constant) @declaration.name) @declaration.trait

;; module Baz::Qux — namespaced module definition
(module
  name: (scope_resolution
    name: (constant) @declaration.name)) @declaration.trait

;; ── Declarations — method (instance) ─────────────────────────────────────

(method
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations — singleton method (class-level: def self.foo) ──────────

(singleton_method
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations — closure bound to a local ──────────────────────────────
;;
;; handler = ->(x) { target(x) } / lambda { |x| ... } / proc { |x| ... }
;;
;; Anchor discipline (same contract as javascript/query.ts): @declaration.function
;; sits on the INNER (block), NOT on the assignment wrapper and NOT on the
;; (lambda) node — the block is what carries @scope.block above, so anchoring
;; there aligns anchor.range with the scope range. That alignment is what lets
;; pickCallerCallableDef accept a Block-kind scope as a callable boundary.
;; do_block/block stay @scope.block deliberately — do NOT re-kind them.
;;
;; The call forms are restricted to lambda/proc by name. An unrestricted
;; (call block: (block)) would match ANY method call with a block, so
;; mapped = items.map { |i| ... } would wrongly declare mapped a callable.
;; Separate #eq? patterns rather than one #match? alternation: alternation
;; predicates are a known hazard on this tree-sitter line.
;; BOTH block forms in every pattern. do...end produces (do_block), braces
;; produce (block), and do/end is the dominant MULTI-LINE style — covering only
;; braces left lambda-do-end with a Block scope owning nothing, so its
;; calls fell through to the enclosing method. @scope.block above already covers
;; both, so the two channels now agree.
;;
;; The !receiver constraint is load-bearing: without it #eq? tests the method
;; NAME only, so MyMod.lambda {...} / obj.proc {...} would be captured as
;; closure bindings. Verified against the grammar: with !receiver those are
;; rejected while bare lambda/proc still match.
(assignment
  left: (identifier) @declaration.name
  right: (lambda body: [(block) (do_block)] @declaration.function))

(assignment
  left: (identifier) @declaration.name
  right: (call
    !receiver
    method: (identifier) @_lambda-kw
    block: [(block) (do_block)] @declaration.function)
  (#eq? @_lambda-kw "lambda"))

(assignment
  left: (identifier) @declaration.name
  right: (call
    !receiver
    method: (identifier) @_proc-kw
    block: [(block) (do_block)] @declaration.function)
  (#eq? @_proc-kw "proc"))

;; Proc.new { ... } / Proc.new do ... end — the explicit constructor form.
;; Receiver IS required here and must be the Proc constant, so this cannot
;; collide with the bare-call patterns above.
(assignment
  left: (identifier) @declaration.name
  right: (call
    receiver: (constant) @_proc-const
    method: (identifier) @_new-kw
    block: [(block) (do_block)] @declaration.function)
  (#eq? @_proc-const "Proc")
  (#eq? @_new-kw "new"))

;; ── Declarations — variable assignment ───────────────────────────────────

(assignment
  left: (identifier) @declaration.name) @declaration.variable

;; ── Imports — require / require_relative / load ──────────────────────────
;;
;; All three are plain \`call\` nodes in tree-sitter-ruby with no receiver.
;; The import-decomposer in captures.ts fans out the argument to a path.

(call
  method: (identifier) @_method
  (#match? @_method "^(require|require_relative|load)$")) @import.statement

;; ── Type bindings — constructor inference: x = User.new ──────────────────
;;
;; tree-sitter-ruby parses \`x = User.new\` as:
;;   (assignment
;;     left: (identifier)         ;; "x"
;;     right: (call
;;       receiver: (constant)     ;; "User"
;;       method: (identifier)))   ;; "new"
;;
;; Captures the receiver constant as the type.

(assignment
  left: (identifier) @type-binding.name
  right: (call
    receiver: (constant) @type-binding.type
    method: (identifier) @_new_method
    (#eq? @_new_method "new"))) @type-binding.constructor

;; Qualified constructor: x = Foo::Bar.new (scope_resolution receiver)

(assignment
  left: (identifier) @type-binding.name
  right: (call
    receiver: (scope_resolution) @type-binding.type
    method: (identifier) @_new_method2
    (#eq? @_new_method2 "new"))) @type-binding.constructor

;; Instance-variable constructor: \`@service = UserService.new\` (#2807).
;; The patterns above bind locals and constants; an instance variable — the
;; only way a Ruby object gets a field at all — bound nothing, so \`@service.run\`
;; had no receiver type and the fold declined the whole chain.
;;
;; \`@type-binding.name\` is captured on the \`instance_variable\` node, so the
;; bound name keeps its \`@\` sigil and matches the receiver text at the call
;; site verbatim. The narrow \`@type-binding.ivar-field\` marker rides the same
;; node for \`rubyBindingScopeFor\` to hoist on; anchorCaptureFor takes the
;; broadest range, so the assignment stays the anchor and the source stays
;; \`constructor-inferred\`.
;;
;; These patterns match unconditionally HERE; captures.ts then discards the
;; whole binding via \`isRubyInstanceIvarWrite\` unless \`self\` at the write is
;; provably an instance of the enclosing lexical class — which rules out
;; \`def self.x\`, \`class << self\`, the class body itself, and any write reached
;; through a block, whose \`self\` its receiver chooses (\`class_eval\`,
;; \`Class.new\`, \`instance_eval\`, \`define_method\`, …). A tree-sitter pattern
;; cannot state "and no singleton or block ancestor", so the ownership test has
;; to be a walk.

(assignment
  left: (instance_variable) @type-binding.name @type-binding.ivar-field
  right: (call
    receiver: (constant) @type-binding.type
    method: (identifier) @_new_ivar
    (#eq? @_new_ivar "new"))) @type-binding.constructor

(assignment
  left: (instance_variable) @type-binding.name @type-binding.ivar-field
  right: (call
    receiver: (scope_resolution) @type-binding.type
    method: (identifier) @_new_ivar_q
    (#eq? @_new_ivar_q "new"))) @type-binding.constructor

;; Constant constructor: SERVICE = UserService.new (left is constant, not identifier)

(assignment
  left: (constant) @type-binding.name
  right: (call
    receiver: (constant) @type-binding.type
    method: (identifier) @_new_method3
    (#eq? @_new_method3 "new"))) @type-binding.constructor

(assignment
  left: (constant) @type-binding.name
  right: (call
    receiver: (scope_resolution) @type-binding.type
    method: (identifier) @_new_method4
    (#eq? @_new_method4 "new"))) @type-binding.constructor

;; Call-return inference: x = build_service() (factory pattern)

(assignment
  left: (identifier) @type-binding.name
  right: (call
    !receiver
    method: (identifier) @type-binding.type)) @type-binding.call-return

;; Constant call-return: SERVICE = build_service()

(assignment
  left: (constant) @type-binding.name
  right: (call
    !receiver
    method: (identifier) @type-binding.type)) @type-binding.call-return

;; ── Type bindings — for-in loop: for x in collection ─────────────────────
;;
;; The loop variable \`x\` gets the element type of the collection.
;; We bind \`x → collection\` as an alias; the chain-follow pass
;; resolves \`collection → ElementType\` via YARD \`@param\` annotations.
;; tree-sitter-ruby wraps the collection in an \`in\` node:
;;   (for pattern: (identifier) value: (in (identifier)))

(for
  pattern: (identifier) @type-binding.name
  value: (in
    (identifier) @type-binding.type)) @type-binding.alias

;; ── Type bindings — variable alias: x = y ────────────────────────────────

(assignment
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; ── References — free calls (no receiver) ────────────────────────────────

(call
  !receiver
  method: (identifier) @reference.name) @reference.call.free

;; ── References — bare calls (zero-arity calls without parentheses) ──────
;;
;; Ruby allows calling methods without parentheses. When no arguments are
;; passed, tree-sitter-ruby parses them as plain \`identifier\` nodes inside
;; \`body_statement\`. This mirrors the legacy query pattern. The scope-
;; resolution pipeline filters false positives via builtInNames and
;; arity-based overload narrowing.

(body_statement
  (identifier) @reference.name) @reference.call.free

;; ── References — member calls (with receiver): obj.method() ──────────────

(call
  receiver: (_) @reference.receiver
  method: (identifier) @reference.name) @reference.call.member

;; ── References — field writes: obj.field = value ─────────────────────────
;;
;; Ruby setter syntax: \`obj.name = x\` is an assignment whose left-hand
;; side is a \`call\` node with a receiver.

(assignment
  left: (call
    receiver: (_) @reference.receiver
    method: (identifier) @reference.name)) @reference.write

;; ── References — field writes (compound assignment: obj.field += value) ──

(operator_assignment
  left: (call
    receiver: (_) @reference.receiver
    method: (identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getRubyParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Ruby as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getRubyScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Ruby as Parameters<Parser['setLanguage']>[0], RUBY_SCOPE_QUERY);
  }
  return _query;
}
