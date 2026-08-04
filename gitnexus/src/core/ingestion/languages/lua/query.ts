/**
 * Lua scope-resolution query (RFC #909).
 *
 * Captures the structural skeleton the central ScopeExtractor consumes:
 *   - scopes: (chunk) root + function bodies
 *   - declarations: function / local function / method (function Obj:m())
 *   - imports: require("a.b.c") — the call + its string arg
 *   - references: free calls foo() + member calls obj:m() / obj.f()
 *
 * `tree-sitter-lua` is a vendored grammar (loaded lazily via parser-loader, NOT
 * statically imported) — mirroring languages/dart/query.ts: a top-level
 * `import Lua from 'tree-sitter-lua'` would throw ERR_MODULE_NOT_FOUND on the
 * main thread (where the vendored grammar is not in node_modules) and crash
 * analyze even for repos with no Lua files (#2091/#2093).
 *
 * Node names verified against the vendored tree-sitter-lua grammar via the
 * parser-loader-abi smoke test:
 *   (chunk) (function_definition_statement name: (identifier|variable))
 *   (local_function_definition_statement name: (identifier))
 *   (call function: (variable name:|table:+method:|table:+field:) arguments: (argument_list (expression_list ...)))
 */
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';

const LUA_SCOPE_QUERY = `
;; ── Scopes ───────────────────────────────────────────────────────────────────
(chunk) @scope.module

(function_definition_statement) @scope.function
(local_function_definition_statement) @scope.function

;; ── Declarations — functions ─────────────────────────────────────────────────
(function_definition_statement
  name: (identifier) @declaration.name) @declaration.function

(local_function_definition_statement
  name: (identifier) @declaration.name) @declaration.function

;; ── Declarations — methods: function Obj:method() / function Obj.field() ────
;;   name is a (variable) with table + method (colon) or table + field (dot).
(function_definition_statement
  name: (variable
    method: (identifier) @declaration.name)) @declaration.method

(function_definition_statement
  name: (variable
    field: (identifier) @declaration.name)) @declaration.method

;; ── Declarations — middleclass classes: class("Name"[, Parent]) ──────────────
;;   local Foo = class("Foo", Parent) — class() is a plain call; the first
;;   string arg is the class name (quotes stripped in captures.ts). The second
;;   arg (Parent) → EXTENDS is Phase B2b (heritage marker).
(call
  function: (variable name: (identifier) @_class)
  arguments: (argument_list (expression_list (string) @declaration.name))
  (#eq? @_class "class")) @declaration.class

;; ── Imports — require("a.b.c") ──────────────────────────────────────────────
;;   require is a plain (call) whose function is a (variable name: (identifier)).
;;   The string arg is captured as @import.source; interpretLuaImport strips
;;   quotes and resolves it via the legacy luaRequireStrategy (suffixResolve).
(call
  function: (variable name: (identifier) @_req)
  arguments: (argument_list (expression_list (string) @import.source))
  (#eq? @_req "require")) @import.statement

;; ── References — free calls: foo() ───────────────────────────────────────────
;;   Also matches the require call — harmless: require has no def, so it stays an
;;   unresolved reference (no CALLS edge) while the @import.statement pattern
;;   above emits the IMPORTS edge.
(call
  function: (variable
    name: (identifier) @reference.name)) @reference.call.free

;; ── References — member calls: obj:method() (table + method) ─────────────────
(call
  function: (variable
    table: (_) @reference.receiver
    method: (identifier) @reference.name)) @reference.call.member

;; ── References — field calls: obj.field() (table + field) ────────────────────
(call
  function: (variable
    table: (_) @reference.receiver
    field: (identifier) @reference.name)) @reference.call.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getLuaParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return _parser;
}

export function getLuaScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
      LUA_SCOPE_QUERY,
    );
  }
  return _query;
}
