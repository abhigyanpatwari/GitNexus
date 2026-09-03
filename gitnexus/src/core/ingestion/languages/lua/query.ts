/**
 * Lua scope-resolution query (RFC #909).
 *
 * Captures the structural skeleton the central ScopeExtractor consumes:
 *   - scopes: (chunk) root + function bodies
 *   - declarations: function / local function / method (function Obj:m())
 *   - imports: Lua module-loading calls — the call + its string arg
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
;;   string arg is the class name (quotes stripped in captures.ts) and emits a
;;   Class node. The parent arg (Parent) → EXTENDS is captured by the separate
;;   HERITAGE_QUERY below (snapshotted via the capture side channel; see
;;   captures.ts + heritage.ts) — this pattern only matches the 1-arg form.
(call
  function: (variable name: (identifier) @_class)
  arguments: (argument_list (expression_list (string) @declaration.name))
  (#eq? @_class "class")) @declaration.class

;; local Foo = middleclass("Name") — the local binding is the class identity
;; used by method ownership and heritage resolution, so keep it aligned with
;; the legacy graph query instead of deriving a second name from the string.
(local_variable_declaration
  (variable_list (variable name: (identifier) @declaration.name))
  (expression_list
    value: (call
      function: (variable name: (identifier) @_middleclass)
      (#eq? @_middleclass "middleclass")))) @declaration.class

;; ── Imports — Lua module-loading calls ───────────────────────────────────────
;;   Import captures are emitted by captures.ts rather than this query. A
;;   query match cannot preserve positional pairing for
;;   a multi-variable declaration with two module-loading calls: it would
;;   cross-pair every
;;   local name with every source. The capture hook walks the two lists by
;;   index and emits one logical match per require. It also handles Lua's
;;   parenthesis-free 'require "mod"' and 'require [[mod]]' forms.

;; ── References — free calls: foo() ───────────────────────────────────────────
;;   Also matches the require call — harmless: require has no def, so it stays an
;;   unresolved reference (no CALLS edge) while the structural capture hook
;;   emits the IMPORTS edge.
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

// ── Heritage queries (run in the parse worker where the AST is live; the
//    pairs are snapshotted onto ParsedFile.captureSideChannel so the main-
//    thread heritage hook emits edges WITHOUT re-reading/re-parsing). ────────

// local Foo = class("Foo", Parent) — 2nd arg is a bare (variable name:).
// class("Foo") (no parent) does not match: this pattern requires the trailing
// variable, so parentless classes correctly emit no EXTENDS edge.
const HERITAGE_QUERY = `
(call
  function: (variable name: (identifier) @_class)
  arguments: (argument_list
    (expression_list
      (string) @child.name
      (variable name: (identifier) @parent.name)))
  (#eq? @_class "class")) @heritage

(call
  function: (variable name: (identifier) @_class)
  arguments: (argument_list
    (expression_list
      (string) @child.name
      (variable
        table: (identifier) @parent.module
        field: (identifier) @parent.field)))
  (#eq? @_class "class")) @heritage
`;

// function ClassName:method() (colon) and function ClassName.method() (dot).
// The receiver (table) is captured as @method.owner; resolves to a Class node
// for HAS_METHOD. middleclass methods are file-top-level (not in a class body),
// so lexical HAS_METHOD cannot produce these.
const METHOD_OWNER_QUERY = `
(function_definition_statement
  name: (variable
    table: (identifier) @method.owner
    method: (identifier) @method.name)) @method.def

(function_definition_statement
  name: (variable
    table: (identifier) @method.owner
    field: (identifier) @method.name)) @method.def

(variable_assignment
  (variable_list
    (variable
      table: (identifier) @method.owner
      field: (identifier) @method.name))
  (expression_list
    value: (function_definition) @method.def))

(variable_assignment
  (variable_list
    (variable
      table: (identifier) @method.owner
      field: (string) @method.name))
  (expression_list
    value: (function_definition) @method.def))
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;
let _heritageQuery: Parser.Query | null = null;
let _methodOwnerQuery: Parser.Query | null = null;

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

export function getHeritageQuery(): Parser.Query {
  if (_heritageQuery === null) {
    _heritageQuery = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
      HERITAGE_QUERY,
    );
  }
  return _heritageQuery;
}

export function getMethodOwnerQuery(): Parser.Query {
  if (_methodOwnerQuery === null) {
    _methodOwnerQuery = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Lua) as Parameters<Parser['setLanguage']>[0],
      METHOD_OWNER_QUERY,
    );
  }
  return _methodOwnerQuery;
}
