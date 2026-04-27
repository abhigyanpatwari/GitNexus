/**
 * Tree-sitter scope-query for Lua (RFC §5.1).
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't
 * pay tree-sitter init cost per file.
 *
 * Capture vocabulary
 * ──────────────────
 * @scope.module        — top-level chunk (file == module)
 * @scope.function      — function body
 *
 * @declaration.name    — the identifier being declared
 * @declaration.function — function definition_statement / local_function
 * @declaration.method  — method via dot_index / method_index
 * @declaration.variable — local or global variable assignment
 * @declaration.module  — table literal assigned to a name (Lua namespace)
 *
 * @import.statement    — require() call (local or bare)
 *
 * @reference.name      — callee of any function/method call
 * @reference.call.free — free call (foo())
 * @reference.call.member — method call (obj:method())
 */

import Parser from 'tree-sitter';
import Lua from '@tree-sitter-grammars/tree-sitter-lua';

const LUA_SCOPE_QUERY = `
;; ── Scopes ──────────────────────────────────────────────────────────────────
;; The entire file is one module scope.
(chunk) @scope.module

;; Each function body introduces its own function scope.
(function_definition) @scope.function

;; ── Declarations: global functions ──────────────────────────────────────────
;; function foo(...) ... end
(function_definition_statement
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations: method-style (Foo.bar / Foo:bar) ──────────────────────────
;; function Foo.bar(...) ... end
(function_definition_statement
  name: (dot_index_expression
    field: (identifier) @declaration.name)) @declaration.method

;; function Foo:bar(...) ... end
(function_definition_statement
  name: (method_index_expression
    method: (identifier) @declaration.name)) @declaration.method

;; ── Declarations: local functions ────────────────────────────────────────────
;; local function bar(...) ... end
(local_function_definition_statement
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations: tables used as namespaces/modules ──────────────────────────
;; Foo = {}
(assignment_statement
  (variable_list
    name: (identifier) @declaration.name)
  (expression_list
    (table_constructor))) @declaration.module

;; local Foo = {}
(local_variable_declaration
  (attribute_list
    name: (identifier) @declaration.name)
  (expression_list
    (table_constructor))) @declaration.module

;; ── Declarations: variables ──────────────────────────────────────────────────
;; local x = ...
(local_variable_declaration
  (attribute_list
    name: (identifier) @declaration.name)) @declaration.variable

;; x = ... (global assignment)
(assignment_statement
  (variable_list
    name: (identifier) @declaration.name)) @declaration.variable

;; ── Imports ──────────────────────────────────────────────────────────────────
;; local M = require("foo.bar")
(local_variable_declaration
  (expression_list
    (function_call_expression
      name: (identifier) @_req
      (argument_list
        (string) @import.source))
    (#eq? @_req "require"))) @import.statement

;; require("foo.bar")  (bare call)
(function_call_expression
  name: (identifier) @_req2
  (argument_list
    (string) @import.source)
  (#eq? @_req2 "require")) @import.statement

;; ── References: free calls ───────────────────────────────────────────────────
(function_call_expression
  name: (identifier) @reference.name) @reference.call.free

;; ── References: method calls ─────────────────────────────────────────────────
(method_call_expression
  method: (identifier) @reference.name) @reference.call.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getLuaParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Lua as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getLuaScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      Lua as Parameters<Parser['setLanguage']>[0],
      LUA_SCOPE_QUERY,
    );
  }
  return _query;
}
