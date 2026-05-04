import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';

const GO_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(type_declaration
  (type_spec
    type: [(struct_type) (interface_type)])) @scope.class
(function_declaration) @scope.function
(method_declaration) @scope.function
(func_literal) @scope.function
(block) @scope.block
(if_statement) @scope.block
(for_statement) @scope.block
(select_statement) @scope.block
(expression_switch_statement) @scope.block
(type_switch_statement) @scope.block
(expression_case) @scope.block
(default_case) @scope.block
(type_case) @scope.block
(communication_case) @scope.block

;; Declarations — struct
(type_declaration
  (type_spec name: (type_identifier) @declaration.name
    type: (struct_type))) @declaration.struct

;; Declarations — interface
(type_declaration
  (type_spec name: (type_identifier) @declaration.name
    type: (interface_type))) @declaration.interface

;; Declarations — function
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Declarations — method
(method_declaration
  name: (field_identifier) @declaration.name) @declaration.method

;; Declarations — struct fields
(struct_type
  (field_declaration_list
    (field_declaration
      name: (field_identifier) @declaration.name
      type: (_) @declaration.field-type))) @declaration.field

;; Declarations — variables
(var_declaration
  (var_spec
    name: (identifier) @declaration.name)) @declaration.variable

(const_declaration
  (const_spec
    name: (identifier) @declaration.name)) @declaration.const

(short_var_declaration
  left: (expression_list (identifier) @declaration.name)) @declaration.variable

;; Imports
(import_spec) @import.statement

;; Type bindings — parameter annotations
(function_declaration
  name: (identifier) @_fn_name
  parameters: (parameter_list
    (parameter_declaration
      name: (identifier) @type-binding.name
      type: [(type_identifier) (qualified_type) (pointer_type) (slice_type) (map_type)] @type-binding.type))) @type-binding.parameter

(method_declaration
  name: (field_identifier) @_fn_name
  parameters: (parameter_list
    (parameter_declaration
      name: (identifier) @type-binding.name
      type: [(type_identifier) (qualified_type) (pointer_type) (slice_type) (map_type)] @type-binding.type))) @type-binding.parameter

;; Type bindings — constructor-inferred (:= T{})
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list
    (composite_literal
      type: [(type_identifier) (qualified_type)] @type-binding.type))) @type-binding.constructor

;; Type bindings — pointer constructor (:= &T{})
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list
    (unary_expression
      "&"
      operand: (composite_literal
        type: [(type_identifier) (qualified_type)] @type-binding.type)))) @type-binding.constructor

;; Type bindings — type assertion (:= s.(T))
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list
    (type_assertion_expression
      type: (_) @type-binding.type))) @type-binding.assertion

(var_declaration
  (var_spec
    name: (identifier) @type-binding.name
    value: (expression_list
      (type_assertion_expression
        type: (_) @type-binding.type)))) @type-binding.assertion

;; Type bindings — explicit var type
(var_declaration
  (var_spec
    name: (identifier) @type-binding.name
    type: (_) @type-binding.type)) @type-binding.assignment

;; Type bindings — call-return inference (:= Func(args))
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list (call_expression
    function: (identifier) @type-binding.type))) @type-binding.call-return

;; Type bindings — call-return inference qualified (:= pkg.Func(args))
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list (call_expression
    function: (selector_expression
      field: (field_identifier) @type-binding.type)))) @type-binding.call-return

;; Type bindings — return type annotation (func Foo() *Type)
(function_declaration
  name: (identifier) @type-binding.name
  result: (_) @type-binding.type) @type-binding.return

;; Type bindings — method return type (func (r *T) Method() *Type)
(method_declaration
  name: (field_identifier) @type-binding.name
  result: (_) @type-binding.type) @type-binding.return

;; Type bindings — variable alias (y := x)
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list (identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — variable alias var form (var x = y)
(var_declaration
  (var_spec
    name: (identifier) @type-binding.name
    value: (expression_list (identifier) @type-binding.type))) @type-binding.alias

;; Type bindings — call-return var form (var x = Func())
(var_declaration
  (var_spec
    name: (identifier) @type-binding.name
    value: (expression_list (call_expression
      function: (identifier) @type-binding.type)))) @type-binding.call-return

;; References — free calls
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; References — member calls
(call_expression
  function: (selector_expression
    operand: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.call.member

;; References — constructor calls (T{})
(composite_literal
  type: [(type_identifier) (qualified_type)] @reference.name) @reference.call.constructor

;; References — field reads
(selector_expression
  operand: (_) @reference.receiver
  field: (field_identifier) @reference.name) @reference.read

;; References — field writes (assignment)
(assignment_statement
  left: (expression_list
    (selector_expression
      operand: (_) @reference.receiver
      field: (field_identifier) @reference.name))) @reference.write

;; References — field writes (inc: obj.Field++)
(inc_statement
  (selector_expression
    operand: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write

;; References — field writes (dec: obj.Field--)
(dec_statement
  (selector_expression
    operand: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getGoParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Go as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getGoScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Go as Parameters<Parser['setLanguage']>[0], GO_SCOPE_QUERY);
  }
  return _query;
}
