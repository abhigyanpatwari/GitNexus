import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';

const RUST_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(struct_item) @scope.class
(trait_item) @scope.class
(impl_item) @scope.class
(enum_item) @scope.class
(function_item) @scope.function
(closure_expression) @scope.function
(block) @scope.block
(if_expression) @scope.block
(match_expression) @scope.block
(for_expression) @scope.block
(while_expression) @scope.block
(loop_expression) @scope.block
(mod_item) @scope.namespace

;; Declarations — struct
(struct_item
  name: (type_identifier) @declaration.name) @declaration.struct

;; Declarations — trait
(trait_item
  name: (type_identifier) @declaration.name) @declaration.trait

;; Declarations — enum
(enum_item
  name: (type_identifier) @declaration.name) @declaration.enum

;; Declarations — function (top-level or inside mod)
(function_item
  name: (identifier) @declaration.name) @declaration.function

;; Declarations — struct fields
(field_declaration
  name: (field_identifier) @declaration.name
  type: (_) @declaration.field-type) @declaration.field

;; Declarations — variables (let bindings)
(let_declaration
  pattern: (identifier) @declaration.name) @declaration.variable

;; Declarations — const
(const_item
  name: (identifier) @declaration.name) @declaration.const

;; Declarations — static
(static_item
  name: (identifier) @declaration.name) @declaration.const

;; Imports
(use_declaration) @import.statement

;; Type bindings — parameter annotations
(parameter
  pattern: (identifier) @type-binding.name
  type: (_) @type-binding.type) @type-binding.parameter

;; Type bindings — let with type annotation
(let_declaration
  pattern: (identifier) @type-binding.name
  type: (_) @type-binding.type) @type-binding.assignment

;; Type bindings — struct literal constructor inference
(let_declaration
  pattern: (identifier) @type-binding.name
  value: (struct_expression
    name: (_) @type-binding.type)) @type-binding.constructor

;; Type bindings — call-return inference (let x = Foo::new())
(let_declaration
  pattern: (identifier) @type-binding.name
  value: (call_expression
    function: (_) @type-binding.type)) @type-binding.call-return

;; Type bindings — call-return inference through .await (let x = foo().await)
(let_declaration
  pattern: (identifier) @type-binding.name
  value: (await_expression
    (call_expression
      function: (_) @type-binding.type))) @type-binding.call-return

;; Type bindings — variable alias (let x = y)
(let_declaration
  pattern: (identifier) @type-binding.name
  value: (identifier) @type-binding.type) @type-binding.alias

;; Type bindings — return type annotation
(function_item
  name: (identifier) @type-binding.name
  return_type: (_) @type-binding.type) @type-binding.return

;; References — free calls
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; References — member calls (obj.method())
(call_expression
  function: (field_expression
    value: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.call.member

;; References — scoped calls (Foo::bar())
(call_expression
  function: (scoped_identifier
    name: (identifier) @reference.name)) @reference.call.free

;; References — constructor calls (struct literal)
(struct_expression
  name: (_) @reference.name) @reference.call.constructor

;; References — field reads
(field_expression
  value: (_) @reference.receiver
  field: (field_identifier) @reference.name) @reference.read

;; References — field writes (assignment)
(assignment_expression
  left: (field_expression
    value: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write

;; References — field writes (compound assignment: +=, -=, etc.)
(compound_assignment_expr
  left: (field_expression
    value: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getRustParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Rust as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getRustScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Rust as Parameters<Parser['setLanguage']>[0], RUST_SCOPE_QUERY);
  }
  return _query;
}
