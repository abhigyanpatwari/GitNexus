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

;; ── Declarations — module ────────────────────────────────────────────────

(module
  name: (constant) @declaration.name) @declaration.module

;; ── Declarations — method (instance) ─────────────────────────────────────

(method
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations — singleton method (class-level: def self.foo) ──────────

(singleton_method
  name: (identifier) @declaration.name) @declaration.function

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

;; ── Type bindings — variable alias: x = y ────────────────────────────────

(assignment
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; ── References — free calls (no receiver) ────────────────────────────────

(call
  !receiver
  method: (identifier) @reference.name) @reference.call.free

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
