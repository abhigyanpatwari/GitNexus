import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

const C_SCOPE_QUERY = `
;; Scopes
(translation_unit) @scope.module
(struct_specifier) @scope.class
(union_specifier) @scope.class
(function_definition) @scope.function
(compound_statement) @scope.block
(if_statement) @scope.block
(for_statement) @scope.block
(while_statement) @scope.block
(do_statement) @scope.block
(switch_statement) @scope.block
(case_statement) @scope.block

;; Declarations — struct
(struct_specifier
  name: (type_identifier) @declaration.name
  body: (field_declaration_list)) @declaration.struct

;; Declarations — union
(union_specifier
  name: (type_identifier) @declaration.name
  body: (field_declaration_list)) @declaration.union

;; Declarations — enum
(enum_specifier
  name: (type_identifier) @declaration.name) @declaration.enum

;; Declarations — function definition
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; Declarations — function definition with pointer return
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; Declarations — function declaration (prototype)
(declaration
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; Declarations — function declaration with pointer return (prototype)
(declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; Declarations — typedef
(type_definition
  declarator: (type_identifier) @declaration.name) @declaration.typedef

;; Declarations — struct fields
(field_declaration
  declarator: (field_identifier) @declaration.name) @declaration.field

;; Declarations — struct fields (pointer)
(field_declaration
  declarator: (pointer_declarator
    declarator: (field_identifier) @declaration.name)) @declaration.field

;; Declarations — variables
(declaration
  declarator: (init_declarator
    declarator: (identifier) @declaration.name)) @declaration.variable

;; Declarations — plain variable (no initializer)
(declaration
  declarator: (identifier) @declaration.name
  !declarator) @declaration.variable

;; Declarations — macro definitions
(preproc_def
  name: (identifier) @declaration.name) @declaration.macro

(preproc_function_def
  name: (identifier) @declaration.name) @declaration.macro

;; Declarations — enum constants
(enumerator
  name: (identifier) @declaration.name) @declaration.const

;; Imports
(preproc_include) @import.statement

;; Type bindings — parameter annotations
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @_fn_name
    parameters: (parameter_list
      (parameter_declaration
        declarator: (identifier) @type-binding.name
        type: (_) @type-binding.type)))) @type-binding.parameter

;; Type bindings — variable with type (init_declarator)
(declaration
  type: (_) @type-binding.type
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.assignment

;; References — free calls
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; References — member calls via pointer (ptr->func())
(call_expression
  function: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.call.member

;; References — field reads
(field_expression
  argument: (_) @reference.receiver
  field: (field_identifier) @reference.name) @reference.read

;; References — field writes (assignment)
(assignment_expression
  left: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getCParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(C as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getCScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(C as Parameters<Parser['setLanguage']>[0], C_SCOPE_QUERY);
  }
  return _query;
}
