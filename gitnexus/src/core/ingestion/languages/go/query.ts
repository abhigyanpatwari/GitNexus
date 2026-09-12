import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';

const GO_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
;; One Class scope per DECLARED TYPE, not per declaration (#2837).
;;
;; Capturing the type_declaration made a grouped declaration
;;   type (
;;     Decoy       struct { ... }
;;     PickService struct { ... }
;;   )
;; a SINGLE Class scope owning every struct in the block. Downstream that scope
;; can name only one owner -- buildWorkspaceResolutionIndex keeps the first
;; class-like def it finds -- so the block's structs lost their field type
;; bindings, typeOfMemberOnClass found no scope, the compound-receiver fold
;; declined, and every s.field.Method() site in the file emitted nothing at
;; all. Silent, per-file, and independent of file size: exactly the split
;; reported in #2837 that #2829's global fixes could not explain. Measured on
;; the go-grouped-type-decl fixture: EVERY struct in a grouped block lost its
;; edges, the first one included, and grouped interface blocks produced no
;; IMPLEMENTS edges at all.
;;
;; type_spec is the node Go's own grammar gives one declared type, so one
;; capture per type_spec is the granularity the rest of the pipeline already
;; assumes. A plain single-type declaration is unaffected in count -- only its
;; scope range narrows, from the type keyword to the name.
;;
;; NOTE: this string is a JS template literal. Backticks are a syntax error.
(type_declaration
  (type_spec
    type: [(struct_type) (interface_type)]) @scope.class)
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
;;
;; Anchored on the type_spec, in lockstep with @scope.class above (#2837). Both
;; captures MUST name the same node: the def node and the class-scope node are
;; paired by range, so anchoring the def on the enclosing type_declaration while
;; the scope sits on the type_spec leaves the def strictly larger than its own
;; scope and NOTHING is owned -- measured as every Go field-receiver edge in the
;; fixture disappearing, plain declarations included. Keeping both on
;; type_declaration is the original bug: a grouped block gave both structs the
;; same capture node, so one silently displaced the other.
(type_declaration
  (type_spec name: (type_identifier) @declaration.name
    type: (struct_type)) @declaration.struct)

;; Declarations — interface
;; Same lockstep requirement as @declaration.struct above (#2837).
(type_declaration
  (type_spec name: (type_identifier) @declaration.name
    type: (interface_type)) @declaration.interface)

;; Declarations — function
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Declarations — closure bindings (\`var f = func(){}\`, \`f := func(){}\`).
;; The \`@declaration.function\` anchor sits on the INNER func_literal so its
;; range aligns with the \`(func_literal) @scope.function\` scope above —
;; without that alignment pass2AttachDeclarations owns the def by the module
;; scope and calls inside the closure lose caller attribution. Mirrors the
;; TypeScript \`const f = () => {}\` patterns (#2687).
(var_declaration
  (var_spec
    name: (identifier) @declaration.name
    value: (expression_list (func_literal) @declaration.function)))
(var_declaration
  (var_spec_list
    (var_spec
      name: (identifier) @declaration.name
      value: (expression_list (func_literal) @declaration.function))))
(short_var_declaration
  left: (expression_list (identifier) @declaration.name)
  right: (expression_list (func_literal) @declaration.function))

;; Declarations — method
(method_declaration
  name: (field_identifier) @declaration.name) @declaration.method

;; Declarations — interface methods
(method_elem
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
    (identifier) @declaration.name)) @declaration.variable
(var_declaration
  (var_spec_list
    (var_spec
      (identifier) @declaration.name))) @declaration.variable

(const_declaration
  (const_spec
    (identifier) @declaration.name)) @declaration.const

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
      type: [(type_identifier) (qualified_type) (pointer_type) (slice_type) (map_type) (channel_type) (array_type) (function_type) (interface_type) (generic_type)] @type-binding.type))) @type-binding.parameter

(method_declaration
  name: (field_identifier) @_fn_name
  parameters: (parameter_list
    (parameter_declaration
      name: (identifier) @type-binding.name
      type: [(type_identifier) (qualified_type) (pointer_type) (slice_type) (map_type) (channel_type) (array_type) (function_type) (interface_type) (generic_type)] @type-binding.type))) @type-binding.parameter

;; Type bindings — constructor-inferred (:= T{})
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list
    (composite_literal
      type: [(type_identifier) (qualified_type) (generic_type)] @type-binding.type))) @type-binding.constructor

;; Type bindings — pointer constructor (:= &T{})
(short_var_declaration
  left: (expression_list (identifier) @type-binding.name)
  right: (expression_list
    (unary_expression
      "&"
      operand: (composite_literal
        type: [(type_identifier) (qualified_type) (generic_type)] @type-binding.type)))) @type-binding.constructor

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
  type: [(type_identifier) (qualified_type) (generic_type)] @reference.name) @reference.call.constructor

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
