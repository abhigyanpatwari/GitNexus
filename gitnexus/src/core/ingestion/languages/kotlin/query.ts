import Parser from 'tree-sitter';
import Kotlin from 'tree-sitter-kotlin';

const KOTLIN_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(class_declaration) @scope.class
(object_declaration) @scope.class
(companion_object) @scope.class
(function_declaration) @scope.function

;; Declarations — types
(class_declaration
  "interface"
  (type_identifier) @declaration.name) @declaration.interface

(class_declaration
  "class"
  (type_identifier) @declaration.name) @declaration.class

(object_declaration
  (type_identifier) @declaration.name) @declaration.class

(companion_object
  (type_identifier) @declaration.name) @declaration.class

(type_alias
  (type_identifier) @declaration.name) @declaration.type_alias

;; Declarations — functions / methods / properties
(function_declaration
  (simple_identifier) @declaration.name) @declaration.function

(property_declaration
  (variable_declaration
    (simple_identifier) @declaration.name)) @declaration.property

(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @declaration.name) @declaration.property

;; Imports
(import_header) @import.statement

;; Type bindings — parameters
(parameter
  (simple_identifier) @type-binding.name
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.parameter

;; Type bindings — property / local annotations
(property_declaration
  (variable_declaration
    (simple_identifier) @type-binding.name
    [(user_type) (nullable_type) (function_type)] @type-binding.type)) @type-binding.annotation

(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @type-binding.name
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.annotation

;; Type bindings — constructor-inferred val user = User(...)
(property_declaration
  (variable_declaration
    (simple_identifier) @type-binding.name)
  (call_expression
    (simple_identifier) @type-binding.type)) @type-binding.constructor

;; Type bindings — return annotations after function parameters
(function_declaration
  (simple_identifier) @type-binding.name
  (function_value_parameters)
  [(user_type) (nullable_type) (function_type)] @type-binding.type) @type-binding.return

;; References — direct calls / constructor syntax
(call_expression
  (simple_identifier) @reference.name) @reference.call.free

;; References — member calls: obj.method()
(call_expression
  (navigation_expression
    (_) @reference.receiver
    (navigation_suffix
      (simple_identifier) @reference.name))) @reference.call.member

;; References — property writes
(assignment
  (directly_assignable_expression
    (_) @reference.receiver
    (navigation_suffix
      (simple_identifier) @reference.name))
  (_)) @reference.write.member

;; References — property reads
(navigation_expression
  (_) @reference.receiver
  (navigation_suffix
    (simple_identifier) @reference.name)) @reference.read.member
`;

let parser: Parser | null = null;
let query: Parser.Query | null = null;

export function getKotlinParser(): Parser {
  if (parser === null) {
    parser = new Parser();
    parser.setLanguage(Kotlin as Parameters<Parser['setLanguage']>[0]);
  }
  return parser;
}

export function getKotlinScopeQuery(): Parser.Query {
  if (query === null) {
    query = new Parser.Query(Kotlin as Parameters<Parser['setLanguage']>[0], KOTLIN_SCOPE_QUERY);
  }
  return query;
}
