import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';

import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';
import { C_SCOPE_QUERY_SOURCE } from '../c/query.js';

export const OBJECTIVE_C_SCOPE_QUERY_SOURCE = `
;; Scopes and class-like declarations
(class_interface) @scope.class @declaration.class
(class_implementation) @scope.class @declaration.class
(protocol_declaration) @scope.class @declaration.interface

;; Methods use provider-synthesized full signed selectors.
(method_declaration) @scope.function @declaration.method
(method_definition) @scope.function @declaration.method

;; Properties
(property_declaration
  (struct_declaration
    (struct_declarator
      (identifier) @declaration.name))) @declaration.property
(property_declaration
  (struct_declaration
    (struct_declarator
      (pointer_declarator declarator: (identifier) @declaration.name)))) @declaration.property

;; Message sends use provider-synthesized full selectors and arity.
(message_expression) @reference.call.member

;; Subscripting resolves one of the indexed/keyed Objective-C selectors.
(subscript_expression) @reference.call.member
`;

let parser: Parser | null = null;
let query: Parser.Query | null = null;
let cFamilyQuery: Parser.Query | null = null;

export function getObjectiveCParser(): Parser {
  if (parser === null) {
    parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return parser;
}

export function getObjectiveCScopeQuery(): Parser.Query {
  if (query === null) {
    query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
      OBJECTIVE_C_SCOPE_QUERY_SOURCE,
    );
  }
  return query;
}

export function getObjectiveCCFamilyScopeQuery(): Parser.Query {
  if (cFamilyQuery === null) {
    cFamilyQuery = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
      C_SCOPE_QUERY_SOURCE,
    );
  }
  return cFamilyQuery;
}
