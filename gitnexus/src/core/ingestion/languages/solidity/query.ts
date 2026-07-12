/**
 * Solidity scope-capture query + lazy Parser/Query singletons.
 * Grammar: vendored tree-sitter-solidity@1.1.0 (root: source_file).
 */

import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';

const SOLIDITY_SCOPE_QUERY = `
; ── Scopes ───────────────────────────────────────────────────────────────────
(source_file) @scope.module
(contract_declaration) @scope.class
(interface_declaration) @scope.class
(library_declaration) @scope.class

(function_definition) @scope.function
(modifier_definition) @scope.function
(constructor_definition) @scope.function
(fallback_receive_definition) @scope.function

; ── Declarations — types ─────────────────────────────────────────────────────
(contract_declaration name: (identifier) @declaration.name) @declaration.class
(interface_declaration name: (identifier) @declaration.name) @declaration.interface
(library_declaration name: (identifier) @declaration.name) @declaration.class
(struct_declaration struct_name: (identifier) @declaration.name) @declaration.struct
(enum_declaration enum_type_name: (identifier) @declaration.name) @declaration.enum
(event_definition name: (identifier) @declaration.name) @declaration.class
(error_declaration (identifier) @declaration.name) @declaration.class

; ── Declarations — callables ─────────────────────────────────────────────────
(function_definition function_name: (identifier) @declaration.name) @declaration.method
(modifier_definition name: (identifier) @declaration.name) @declaration.method
(constructor_definition) @declaration.constructor
(fallback_receive_definition) @declaration.method

; ── Declarations — state ─────────────────────────────────────────────────────
(state_variable_declaration name: (identifier) @declaration.name) @declaration.property

; ── Imports ──────────────────────────────────────────────────────────────────
(import_directive source: (string) @import.source) @import.statement

; ── Type bindings — locals / parameters ──────────────────────────────────────
(variable_declaration
  (type_name (user_defined_type (identifier) @type-binding.type))
  name: (identifier) @type-binding.name) @type-binding.annotation

(state_variable_declaration
  type: (type_name (user_defined_type (identifier) @type-binding.type))
  name: (identifier) @type-binding.name) @type-binding.annotation

(parameter
  type: (type_name (user_defined_type (identifier) @type-binding.type))
  name: (identifier) @type-binding.name) @type-binding.parameter

; ── References — calls ───────────────────────────────────────────────────────
(call_expression (identifier) @reference.name) @reference.call.free
(call_expression
  (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.call.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getSolidityParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Solidity) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return _parser;
}

export function getSolidityScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Solidity) as Parameters<Parser['setLanguage']>[0],
      SOLIDITY_SCOPE_QUERY,
    );
  }
  return _query;
}
