/*
 * Tree-sitter queries for extracting code definitions.
 *
 * Note: Different grammars (typescript vs tsx vs javascript) may have
 * slightly different node types. These queries are designed to be
 * compatible with the standard tree-sitter grammars.
 *
 * Heritage (extends/implements/embed/trait) is NOT captured here. The legacy
 * heritage-capture leg was removed (issue #942); inheritance edges are
 * produced by the registry-primary scope-resolution path, which synthesizes
 * `@reference.inherits` captures in each language's `languages/<lang>/captures.ts`.
 */

import { ARRAY_METHOD_NOT_ANY_OF_PREDICATE } from './ts-js-hoc-utils.js';

// TypeScript queries - works with tree-sitter-typescript
export const TYPESCRIPT_QUERIES = `
(class_declaration
  name: (type_identifier) @name) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

; TypeScript overload signatures (function_signature is a separate node type from function_declaration)
(function_signature
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

; ES2022 #private methods (private_property_identifier not matched by property_identifier)
(method_definition
  name: (private_property_identifier) @name) @definition.method

; Abstract method signatures in abstract classes
(abstract_method_signature
  name: (property_identifier) @name) @definition.method

; Interface method signatures
(method_signature
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

; Object-property arrows / function expressions: \`{ addItem: () => ... }\`.
; The pair's key field carries the meaningful name. Without these patterns,
; calls inside the arrow are attributed to the file (issue #1166), and the
; arrow itself is invisible to context() / impact() despite carrying real
; behaviour (Zustand actions, TanStack queryFn, React Context providers).
; String-key variant covers \`"add-item": () => ...\`; computed keys
; (\`[K]: () => ...\`) intentionally fall through anonymous.
(pair
  key: (property_identifier) @name
  value: (arrow_function)) @definition.function

(pair
  key: (property_identifier) @name
  value: (function_expression)) @definition.function

(pair
  key: (string (string_fragment) @name)
  value: (arrow_function)) @definition.function

(pair
  key: (string (string_fragment) @name)
  value: (function_expression)) @definition.function

; HOC-wrapped variable declarations: \`const X = HOC((args) => { ... })\`.
; Mirrors the registry-primary patterns in \`languages/typescript/query.ts\`
; so the legacy Call-Resolution DAG and the registry-primary pipeline
; produce the same set of \`Function\` nodes — required for the CI parity
; gate. Covers React.forwardRef / memo / useCallback / useMemo / observer
; / debounce / user-defined HOC factories. The \`var X = HOC(...)\` form is
; mirrored too (registry-primary has it) so that codebases mixing \`var\` and
; \`const\` see identical attribution on both pipelines. See
; \`tsExtractFunctionName\` for the resolution logic and the \`query.ts\`
; comment for the full anchor-discipline rationale and the chained-
; array-method trade-off.
;
; NOTE: Excludes member-expression calls to common array methods (map, filter,
; reduce, etc.) to avoid false positives like \`const x = arr.map(a => ...)\`
; being classified as a Function when it's actually a Const holding an array.
; Direct identifier calls and member expressions on non-array-methods (like
; React.memo) are still matched.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function))))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression))))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (arrow_function)))))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (function_expression)))))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (arrow_function)))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (function_expression)))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

; \`var X = HOC(...)\` parity with registry-primary. Legacy code (and any
; transpiler output that downlevels \`const\` to \`var\`) hits this shape.
; Same array-method exclusions as const/let patterns above.
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function))))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression))))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

; HOC-wrapped default exports: \`export default defineEventHandler(async (e) => { ... })\`.
; The worker rewrites the wrapper-derived @name to a file-derived symbol name
; so helpers like \`defineEventHandler\` / \`React.memo\` do not collapse
; unrelated modules onto the same Function name.
 (export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (arrow_function)))) @definition.function

 (export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (function_expression)))) @definition.function

 (export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (arrow_function)))) @definition.function

 (export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (function_expression)))) @definition.function

; Variable/constant declarations (non-function values).
; Overlap with @definition.function patterns is handled by parse-worker dedup.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.const

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.const

; var declarations (mutable, function-scoped)
(variable_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.variable

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; Generic awaited free call: await fn<T>(args)
; tree-sitter-typescript parses "await fn<T>(args)" as a call_expression whose
; "function" field is an await_expression (not a bare identifier), because the
; grammar resolves the ambiguity between generics and comparisons by consuming
; "await fn" as an expression before attaching <T> as type_arguments.
(call_expression
  function: (await_expression
    (identifier) @call.name)
  (type_arguments)) @call

; Generic awaited member call: await obj.fn<T>(args)
(call_expression
  function: (await_expression
    (member_expression
      property: (property_identifier) @call.name))
  (type_arguments)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; Class properties — public_field_definition covers most TS class fields
(public_field_definition
  name: (property_identifier) @name) @definition.property

; Private class fields: #address: Address
(public_field_definition
  name: (private_property_identifier) @name) @definition.property

; Constructor parameter properties: constructor(public address: Address)
(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @name) @definition.property

; Write access: obj.field = value
(assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; HTTP consumers: fetch('/path'), axios.get('/path'), $.get('/path'), etc.
; fetch() — global function
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url])) @route.fetch

; Custom fetch wrappers: apiFetch('/path'), fetchJSON('/api/data'), httpGet('/users'), etc.
(call_expression
  function: (identifier) @_wrapper_fn (#match? @_wrapper_fn "^(api(Fetch|Get|Post|Put|Delete|Patch|Request)|fetch(API|JSON|Data|Endpoint|Resource|Url)|http(Fetch|Get|Post|Put|Delete|Patch|Request))$")
  arguments: (arguments
    (string (string_fragment) @route.url))) @route.fetch

; axios.get/post/put/delete/patch('/path'), $.get/post/ajax({url:'/path'})
(call_expression
  function: (member_expression
    property: (property_identifier) @http_client.method)
  arguments: (arguments
    (string (string_fragment) @http_client.url))) @http_client

; Decorators: @Controller, @Get, @Post, etc.
(decorator
  (call_expression
    function: (identifier) @decorator.name
    arguments: (arguments (string (string_fragment) @decorator.arg)?))) @decorator

; Express/Hono route registration: app.get('/path', handler), router.post('/path', fn)
(call_expression
  function: (member_expression
    property: (property_identifier) @express_route.method)
  arguments: (arguments
    (string (string_fragment) @express_route.path))) @express_route
`;

// JavaScript queries - works with tree-sitter-javascript
export const JAVASCRIPT_QUERIES = `
(class_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

; ES2022 #private methods
(method_definition
  name: (private_property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

; Object-property arrows / function expressions: \`{ addItem: () => ... }\`.
; See TYPESCRIPT_QUERIES for rationale (issue #1166).
(pair
  key: (property_identifier) @name
  value: (arrow_function)) @definition.function

(pair
  key: (property_identifier) @name
  value: (function_expression)) @definition.function

(pair
  key: (string (string_fragment) @name)
  value: (arrow_function)) @definition.function

(pair
  key: (string (string_fragment) @name)
  value: (function_expression)) @definition.function

; HOC-wrapped variable declarations: \`const X = HOC((args) => { ... })\`.
; See TYPESCRIPT_QUERIES section above for the full rationale (issue #1166
; follow-up — covers forwardRef / memo / useCallback / useMemo / observer
; / debounce / user-defined HOC factories). Both \`const\` and \`var\` forms
; are mirrored so JS code that uses \`var\` (or transpiler output) gets the
; same attribution as the registry-primary path.
; Excludes common array methods (map, filter, reduce, etc.) to avoid false positives.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function))))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression))))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (arrow_function)))))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (function_expression)))))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (arrow_function)))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (function_expression)))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE}) @definition.function

; \`var X = HOC(...)\` parity with registry-primary.
; Same array-method exclusions as const/let patterns.
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function))))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression))))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function))))
  (#not-any-of? @callee "map" "filter" "reduce" "forEach" "find" "findIndex" "some" "every" "flatMap" "sort" "splice" "slice" "concat" "fill" "copyWithin" "join" "flat" "at" "entries" "keys" "values" "indexOf" "lastIndexOf" "includes" "pop" "push" "shift" "unshift" "reverse" "reduceRight" "toSorted" "toReversed" "toSpliced" "with")) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression))))
  (#not-any-of? @callee "map" "filter" "reduce" "forEach" "find" "findIndex" "some" "every" "flatMap" "sort" "splice" "slice" "concat" "fill" "copyWithin" "join" "flat" "at" "entries" "keys" "values" "indexOf" "lastIndexOf" "includes" "pop" "push" "shift" "unshift" "reverse" "reduceRight" "toSorted" "toReversed" "toSpliced" "with")) @definition.function

; HOC-wrapped default exports (JS parity with TS patterns above).
 (export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (arrow_function)))) @definition.function

 (export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (function_expression)))) @definition.function

 (export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (arrow_function)))) @definition.function

 (export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (function_expression)))) @definition.function

; Variable/constant declarations (non-function values).
; Overlap with @definition.function patterns is handled by parse-worker dedup.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.const

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.const

; var declarations (mutable, function-scoped)
(variable_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.variable

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; Class fields — field_definition captures JS class fields (class User { address = ... })
(field_definition
  property: (property_identifier) @name) @definition.property

; Write access: obj.field = value
(assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment_expression
  left: (member_expression
    object: (_) @assignment.receiver
    property: (property_identifier) @assignment.property)
  right: (_)) @assignment

; HTTP consumers: fetch('/path'), axios.get('/path'), $.get('/path'), etc.
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url])) @route.fetch

; Custom fetch wrappers: apiFetch('/path'), fetchJSON('/api/data'), httpGet('/users'), etc.
(call_expression
  function: (identifier) @_wrapper_fn (#match? @_wrapper_fn "^(api(Fetch|Get|Post|Put|Delete|Patch|Request)|fetch(API|JSON|Data|Endpoint|Resource|Url)|http(Fetch|Get|Post|Put|Delete|Patch|Request))$")
  arguments: (arguments
    (string (string_fragment) @route.url))) @route.fetch

; axios.get/post, $.get/post/ajax
(call_expression
  function: (member_expression
    property: (property_identifier) @http_client.method)
  arguments: (arguments
    (string (string_fragment) @http_client.url))) @http_client

; Express/Hono route registration
(call_expression
  function: (member_expression
    property: (property_identifier) @express_route.method)
  arguments: (arguments
    (string (string_fragment) @express_route.path))) @express_route
`;

// Python queries - works with tree-sitter-python
export const PYTHON_QUERIES = `
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(import_statement
  name: (dotted_name) @import.source) @import

; import numpy as np  →  aliased_import captures the module name so the
; import path is resolved and named-binding extraction stores "np" → "numpy".
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.source)) @import

(import_from_statement
  module_name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (relative_import) @import.source) @import

(call
  function: (identifier) @call.name) @call

(call
  function: (attribute
    attribute: (identifier) @call.name)) @call

; Class attribute type annotations — PEP 526: address: Address or address: Address = Address()
; Both bare annotations (address: Address) and annotated assignments (name: str = "test")
; are parsed as (assignment left: ... type: ...) in tree-sitter-python.
(expression_statement
  (assignment
    left: (identifier) @name
    type: (type)) @definition.property)

; Plain variable assignments without type annotation: x = 5, MAX_SIZE = 100
; Overlap with @definition.property (typed) is handled by parse-worker dedup.
(expression_statement
  (assignment
    left: (identifier) @name)) @definition.variable

; Write access: obj.field = value
(assignment
  left: (attribute
    object: (_) @assignment.receiver
    attribute: (identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(augmented_assignment
  left: (attribute
    object: (_) @assignment.receiver
    attribute: (identifier) @assignment.property)
  right: (_)) @assignment

; Python HTTP clients: requests.get('/path'), httpx.post('/path'), session.get('/path')
(call
  function: (attribute
    attribute: (identifier) @http_client.method)
  arguments: (argument_list
    (string (string_content) @http_client.url))) @http_client

; Python decorators: @app.route, @router.get, etc.
; The first positional argument is captured three ways (#2391): a string literal
; path via @decorator.arg (quote-free, the fast path); a bare constant name or a
; plus-concatenation via @decorator.arg_expr (resolved cross-file by the constant
; resolver). The anchored optional alternation pins to the FIRST arg and stays
; optional, so no-arg decorators (@app.tool(), etc.) and non-path first args still
; match.
(decorator
  (call
    function: (attribute
      object: (identifier) @decorator.receiver
      attribute: (identifier) @decorator.name)
    arguments: (argument_list
      .
      [
        (string (string_content)? @decorator.arg) @decorator.arg_str
        (identifier) @decorator.arg_expr
        (binary_operator) @decorator.arg_expr
      ]?))) @decorator
`;

// Java queries - works with tree-sitter-java
export const JAVA_QUERIES = `
; Classes, Interfaces, Enums, Annotations
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(annotation_type_declaration name: (identifier) @name) @definition.annotation

; Methods & Constructors
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor

; Fields — typed field declarations inside class bodies
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.property

; Imports - capture any import declaration child as source
(import_declaration (_) @import.source) @import

; Calls
(method_invocation name: (identifier) @call.name) @call
(method_invocation object: (_) name: (identifier) @call.name) @call
(method_reference) @call

; Constructor calls: new Foo()
(object_creation_expression type: (type_identifier) @call.name) @call

; Local variable declarations inside method bodies
(local_variable_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.variable

; Write access: obj.field = value
(assignment_expression
  left: (field_access
    object: (_) @assignment.receiver
    field: (identifier) @assignment.property)
  right: (_)) @assignment
`;

// C queries - works with tree-sitter-c
export const C_QUERIES = `
; Functions (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function

; Functions returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Functions returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function

; Structs, Unions, Enums, Typedefs
(struct_specifier name: (type_identifier) @name) @definition.struct
(type_definition
  type: (struct_specifier
    body: (field_declaration_list))
  declarator: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition
  type: (enum_specifier
    body: (enumerator_list))
  declarator: (type_identifier) @name) @definition.enum
(enumerator name: (identifier) @name) @definition.const
(type_definition declarator: (type_identifier) @name) @definition.typedef

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call

; Variable declarations: int x = 5; or int x;
(declaration
  declarator: (init_declarator
    declarator: (identifier) @name)) @definition.variable
`;

// Go queries - works with tree-sitter-go
export const GO_QUERIES = `
; Functions & Methods
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(method_elem name: (field_identifier) @name) @definition.method

; Types
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

; Imports
(import_declaration (import_spec path: (interpreted_string_literal) @import.source)) @import
(import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @import.source))) @import

; Struct fields — named field declarations inside struct types
(field_declaration_list
  (field_declaration
    name: (field_identifier) @name) @definition.property)

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call

; Const/var declarations
(const_declaration (const_spec (identifier) @name)) @definition.const
(var_declaration (var_spec (identifier) @name)) @definition.variable
(var_declaration (var_spec_list (var_spec (identifier) @name))) @definition.variable

; Short variable declaration: x := 5
(short_var_declaration left: (expression_list (identifier) @name)) @definition.variable

; Struct literal construction: User{Name: "Alice"}
(composite_literal type: (type_identifier) @call.name) @call

; Write access: obj.field = value
(assignment_statement
  left: (expression_list
    (selector_expression
      operand: (_) @assignment.receiver
      field: (field_identifier) @assignment.property))
  right: (_)) @assignment

; Write access: obj.field++ / obj.field--
(inc_statement
  (selector_expression
    operand: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)) @assignment
(dec_statement
  (selector_expression
    operand: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)) @assignment
`;

// C++ queries - works with tree-sitter-cpp
export const CPP_QUERIES = `
; Classes, Structs, Namespaces
(class_specifier name: (type_identifier) @name) @definition.class
(class_specifier
  name: (template_type
    (type_identifier) @name
    (template_argument_list) @template-arguments)) @definition.class
; Out-of-line nested definition: class Outer::Inner { ... } / struct Outer::Inner { ... }.
; Key the node by the full qualified_identifier text so the def materializes a
; node that matches the HAS_METHOD owner id (also the full qualified text) and
; stays distinct from a same-tail type in another scope (#1975, #1978).
(class_specifier name: (qualified_identifier) @name) @definition.class
(struct_specifier name: (qualified_identifier) @name) @definition.struct
(struct_specifier name: (type_identifier) @name) @definition.struct
(struct_specifier
  name: (template_type
    (type_identifier) @name
    (template_argument_list) @template-arguments)) @definition.struct
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(enum_specifier name: (type_identifier) @name) @definition.enum

; Typedefs and unions (common in C-style headers and mixed C/C++ code)
(type_definition
  type: (struct_specifier
    body: (field_declaration_list))
  declarator: (type_identifier) @name) @definition.struct
(type_definition
  type: (enum_specifier
    body: (enumerator_list))
  declarator: (type_identifier) @name) @definition.enum
(enumerator name: (identifier) @name) @definition.const
(type_definition declarator: (type_identifier) @name) @definition.typedef
(union_specifier name: (type_identifier) @name) @definition.union

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Functions & Methods (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (operator_name) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (operator_name) @name))) @definition.method

; Functions/methods returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method

; Functions/methods returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))))) @definition.method

; Functions/methods returning references (reference_declarator wraps function_declarator)
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (operator_name) @name))) @definition.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier name: (operator_name) @name)))) @definition.method

; Destructors (destructor_name is distinct from identifier in tree-sitter-cpp)
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (destructor_name) @name))) @definition.method

; Function declarations / prototypes (common in headers)
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (operator_name) @name)) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(declaration declarator: (reference_declarator (function_declarator declarator: (operator_name) @name))) @definition.function

; Class/struct data member fields (Address address; int count;)
; Uses field_identifier to exclude method declarations (which use function_declarator)
(field_declaration
  declarator: (field_identifier) @name) @definition.property

; Pointer member fields (Address* address;)
(field_declaration
  declarator: (pointer_declarator
    declarator: (field_identifier) @name)) @definition.property

; Reference member fields (Address& address;)
(field_declaration
  declarator: (reference_declarator
    (field_identifier) @name)) @definition.property

; Inline class method declarations (inside class body, no body: void save();)
; tree-sitter-cpp uses field_identifier (not identifier) for names inside class bodies
(field_declaration declarator: (function_declarator declarator: [(field_identifier) (identifier) (operator_name)] @name)) @definition.method

; Inline class method declarations returning a pointer (User* lookup();)
(field_declaration declarator: (pointer_declarator declarator: (function_declarator declarator: [(field_identifier) (identifier)] @name))) @definition.method

; Inline class method declarations returning a reference (User& lookup();)
(field_declaration declarator: (reference_declarator (function_declarator declarator: [(field_identifier) (identifier) (operator_name)] @name))) @definition.method

; Inline class method definitions (inside class body, with body: void Foo() { ... })
(field_declaration_list
  (function_definition
    declarator: (function_declarator
      declarator: [(field_identifier) (identifier) (operator_name) (destructor_name)] @name)) @definition.method)

; Inline class methods returning a pointer type (User* lookup(int id) { ... })
(field_declaration_list
  (function_definition
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: [(field_identifier) (identifier) (operator_name)] @name))) @definition.method)

; Inline class methods returning a reference type (User& lookup(int id) { ... })
(field_declaration_list
  (function_definition
    declarator: (reference_declarator
      (function_declarator
        declarator: [(field_identifier) (identifier) (operator_name)] @name))) @definition.method)

; Templates
(template_declaration (class_specifier name: (type_identifier) @name)) @definition.template
(template_declaration
  (class_specifier
    name: (template_type
      (type_identifier) @name
      (template_argument_list) @template-arguments))) @definition.template
(template_declaration (function_definition declarator: (function_declarator declarator: (identifier) @name))) @definition.template

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier name: (identifier) @call.name)) @call
(call_expression function: (template_function name: (identifier) @call.name)) @call
(binary_expression operator: "+" @call.name) @call
(binary_expression operator: "<<" @call.name) @call

; Constructor calls: new User()
(new_expression type: (type_identifier) @call.name) @call

; Variable declarations: int x = 5; or auto x = 5;
(declaration
  declarator: (init_declarator
    declarator: (identifier) @name)) @definition.variable

; Structured bindings: auto [a, b] = makePair();  (one @name per bound identifier)
(declaration
  declarator: (init_declarator
    declarator: (structured_binding_declarator
      (identifier) @name))) @definition.variable

; Structured bindings, reference form: auto& [x, y] = tup;
(declaration
  declarator: (init_declarator
    declarator: (reference_declarator
      (structured_binding_declarator
        (identifier) @name)))) @definition.variable

; Write access: obj.field = value
(assignment_expression
  left: (field_expression
    argument: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment

`;

// C# queries - works with tree-sitter-c-sharp
export const CSHARP_QUERIES = `
; Types
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(delegate_declaration name: (identifier) @name) @definition.delegate

; Namespaces (block form and C# 10+ file-scoped form)
(namespace_declaration name: (identifier) @name) @definition.namespace
(namespace_declaration name: (qualified_name) @name) @definition.namespace
(file_scoped_namespace_declaration name: (identifier) @name) @definition.namespace
(file_scoped_namespace_declaration name: (qualified_name) @name) @definition.namespace

; Methods & Properties
(method_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.property

; Primary constructors (C# 12): class User(string name, int age) { }
(class_declaration name: (identifier) @name (parameter_list) @definition.constructor)
(record_declaration name: (identifier) @name (parameter_list) @definition.constructor)

; Using
(using_directive (qualified_name) @import.source) @import
(using_directive (identifier) @import.source) @import

; Calls
(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call

; Null-conditional method calls: user?.Save()
; Parses as: invocation_expression → conditional_access_expression → member_binding_expression → identifier
(invocation_expression
  function: (conditional_access_expression
    (member_binding_expression
      (identifier) @call.name))) @call

; Constructor calls: new Foo() and new Foo { Props }
(object_creation_expression type: (identifier) @call.name) @call

; Target-typed new (C# 9): User u = new("x", 5)
(variable_declaration type: (identifier) @call.name (variable_declarator (implicit_object_creation_expression) @call))

; Local variable declarations
(local_declaration_statement
  (variable_declaration
    (variable_declarator
      (identifier) @name))) @definition.variable

; Write access: obj.field = value
(assignment_expression
  left: (member_access_expression
    expression: (_) @assignment.receiver
    name: (identifier) @assignment.property)
  right: (_)) @assignment
`;

// Rust queries - works with tree-sitter-rust
export const RUST_QUERIES = `
; Functions & Items
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
; A union is materialized as a Struct node (same rationale as the
; scope-resolution @declaration.struct in languages/rust/query.ts: every
; registry-primary resolution gate includes Struct but excludes Union, so a
; Union-labeled node would be an unresolvable orphan). #1934 F71.
(union_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name !trait) @definition.impl
(impl_item type: (generic_type type: (type_identifier) @name) !trait) @definition.impl
; Scoped inherent impl: impl path::Type { ... }. Key the Impl node by the full
; scoped_type_identifier text so it matches the owner id (also full text) and
; stays distinct from a same-tail type in another module (#1975).
(impl_item type: (scoped_type_identifier) @name !trait) @definition.impl
(mod_item name: (identifier) @name) @definition.module

; Type aliases, const, static, macros
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.const
(static_item name: (identifier) @name) @definition.static
(macro_definition name: (identifier) @name) @definition.macro

; Use statements
(use_declaration argument: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (scoped_identifier name: (identifier) @call.name)) @call
(call_expression function: (generic_function function: (identifier) @call.name)) @call

; Struct literal construction: User { name: value }
(struct_expression name: (type_identifier) @call.name) @call

; Struct fields — named field declarations inside struct bodies
(field_declaration_list
  (field_declaration
    name: (field_identifier) @name) @definition.property)

; Write access: obj.field = value
(assignment_expression
  left: (field_expression
    value: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment)
(compound_assignment_expr
  left: (field_expression
    value: (_) @assignment.receiver
    field: (field_identifier) @assignment.property)
  right: (_)) @assignment
`;

// PHP queries - works with tree-sitter-php (php_only grammar)
export const PHP_QUERIES = `
; ── Namespace ────────────────────────────────────────────────────────────────
(namespace_definition
  name: (namespace_name) @name) @definition.namespace

; ── Classes ──────────────────────────────────────────────────────────────────
(class_declaration
  name: (name) @name) @definition.class

; ── Interfaces ───────────────────────────────────────────────────────────────
(interface_declaration
  name: (name) @name) @definition.interface

; ── Traits ───────────────────────────────────────────────────────────────────
(trait_declaration
  name: (name) @name) @definition.trait

; ── Enums (PHP 8.1) ──────────────────────────────────────────────────────────
(enum_declaration
  name: (name) @name) @definition.enum

; ── Top-level functions ───────────────────────────────────────────────────────
(function_definition
  name: (name) @name) @definition.function

; ── Methods (including constructors) ─────────────────────────────────────────
(method_declaration
  name: (name) @name) @definition.method

; ── Class properties (including Eloquent $fillable, $casts, etc.) ────────────
(property_declaration
  (property_element
    (variable_name
      (name) @name))) @definition.property

; Constructor property promotion (PHP 8.0+: public Address $address in __construct)
(method_declaration
  parameters: (formal_parameters
    (property_promotion_parameter
      name: (variable_name
        (name) @name)))) @definition.property

; ── Imports: use statements ──────────────────────────────────────────────────
; Simple: use App\\Models\\User;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @import.source)) @import

; ── Function/method calls ────────────────────────────────────────────────────
; Regular function call: foo()
(function_call_expression
  function: (name) @call.name) @call

; Method call: $obj->method()
(member_call_expression
  name: (name) @call.name) @call

; Nullsafe method call: $obj?->method()
(nullsafe_member_call_expression
  name: (name) @call.name) @call

; Static call: Foo::bar() (php_only uses scoped_call_expression)
(scoped_call_expression
  name: (name) @call.name) @call

; Constructor call: new User()
(object_creation_expression (name) @call.name) @call

; Const declarations at class scope
(const_declaration
  (const_element
    (name) @name)) @definition.const

; PHP HTTP consumers: file_get_contents('/path'), curl_init('/path')
(function_call_expression
  function: (name) @_php_http (#match? @_php_http "^(file_get_contents|curl_init)$")
  arguments: (arguments
    (argument (string (string_content) @http_client.url)))) @http_client

; Write access: $obj->field = value
(assignment_expression
  left: (member_access_expression
    object: (_) @assignment.receiver
    name: (name) @assignment.property)
  right: (_)) @assignment

; Write access: ClassName::$field = value (static property)
(assignment_expression
  left: (scoped_property_access_expression
    scope: (_) @assignment.receiver
    name: (variable_name (name) @assignment.property))
  right: (_)) @assignment
`;

// Ruby queries - works with tree-sitter-ruby
// NOTE: Ruby uses `call` for require, include, extend, prepend, attr_* etc.
// These are all captured as @call and routed in JS post-processing:
//   - require/require_relative → import extraction
//   - include/extend/prepend → heritage (mixin) extraction
//   - attr_accessor/attr_reader/attr_writer → property definition extraction
//   - everything else → regular call extraction
export const RUBY_QUERIES = `
; ── Modules ──────────────────────────────────────────────────────────────────
(module
  name: (constant) @name) @definition.module

; Namespaced module: module Baz::Qux (name field is a scope_resolution node).
; Separate top-level pattern (not a [...] alternation) so neither branch is
; silently dropped — see #1975. The full scope_resolution text keys the node so
; it matches the HAS_METHOD owner id derived from the same name field.
(module
  name: (scope_resolution) @name) @definition.module

; ── Classes ──────────────────────────────────────────────────────────────────
(class
  name: (constant) @name) @definition.class

; Namespaced class: class Foo::Bar (name field is a scope_resolution node).
(class
  name: (scope_resolution) @name) @definition.class

; ── Instance methods ─────────────────────────────────────────────────────────
(method
  name: (identifier) @name) @definition.method

; ── Singleton (class-level) methods ──────────────────────────────────────────
(singleton_method
  name: (identifier) @name) @definition.method

; ── All calls (require, include, attr_*, and regular calls routed in JS) ─────
(call
  method: (identifier) @call.name) @call

; ── Constant assignment: MAX_SIZE = 100, ITEMS = [...] ───────────────────────
(assignment
  left: (constant) @name) @definition.const

; ── Bare calls without parens (identifiers at statement level are method calls) ─
; NOTE: This may over-capture variable reads as calls (e.g. 'result' at
; statement level). Ruby's grammar makes bare identifiers ambiguous — they
; could be local variables or zero-arity method calls. Post-processing via
; provider.isBuiltInName and symbol resolution filtering suppresses most false
; positives, but a variable name that coincidentally matches a method name
; elsewhere may produce a false CALLS edge.
(body_statement
  (identifier) @call.name @call)

; Write access: obj.field = value (Ruby setter — syntactically a method call to field=)
(assignment
  left: (call
    receiver: (_) @assignment.receiver
    method: (identifier) @assignment.property)
  right: (_)) @assignment

; Write access: obj.field += value (compound assignment — operator_assignment node, not assignment)
(operator_assignment
  left: (call
    receiver: (_) @assignment.receiver
    method: (identifier) @assignment.property)
  right: (_)) @assignment
`;

// Kotlin queries - works with tree-sitter-kotlin (fwcd/tree-sitter-kotlin)
// Based on official tags.scm; functions use simple_identifier, classes use type_identifier
export const KOTLIN_QUERIES = `
; ── Interfaces ─────────────────────────────────────────────────────────────
; tree-sitter-kotlin (fwcd) has no interface_declaration node type.
; Interfaces are class_declaration nodes with an anonymous "interface" keyword child.
(class_declaration
  "interface"
  (type_identifier) @name) @definition.interface

; ── Classes (regular, data, sealed, enum) ────────────────────────────────
; All have the anonymous "class" keyword child. enum class has both
; "enum" and "class" children — the "class" child still matches.
(class_declaration
  "class"
  (type_identifier) @name) @definition.class

; ── Object declarations (Kotlin singletons) ──────────────────────────────
(object_declaration
  (type_identifier) @name) @definition.class

; ── Companion objects (named only) ───────────────────────────────────────
(companion_object
  (type_identifier) @name) @definition.class

; ── Functions (top-level, member, extension) ──────────────────────────────
(function_declaration
  (simple_identifier) @name) @definition.function

; ── Secondary constructors (F49 sibling F48, issue #1919) ────────────────
; "constructor(...) { }" inside a class body is a secondary_constructor with
; no name child — its only identity token is the anonymous "constructor"
; keyword, captured here as @name so the node is named "constructor"
; (matching kotlinMethodConfig.extractName). Multiple secondary constructors
; share that name but get distinct ids via the worker's #<arity> suffix.
(secondary_constructor
  "constructor" @name) @definition.constructor

; ── Properties ───────────────────────────────────────────────────────────
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.property

; ── Destructuring declarations (F51, issue #1919) ────────────────────────
; "val (a, b) = pair" binds several names through a multi_variable_declaration
; (NOT a variable_declaration), which the property rule above misses. Emit one
; @definition.property per bound name — the SAME label every other Kotlin val/var
; gets (KOTLIN_QUERIES has no @definition.variable rule, so a single "val x"
; is already a Property; matching that keeps destructured names consistent and
; out of the block-scope local-symbol pruner that drops Variable/Const/Static).
; The Kotlin "_" discard placeholder is filtered out here via (#not-eq? @name "_")
; — these locals have no enclosing class, so the field-extractor enrichment path
; never runs and cannot do the filtering itself. Each rule is a standalone
; pattern (NOT a top-level [...] alternation), so the predicate is safe under
; tree-sitter 0.21.1 (no sibling-branch drop). Loop destructuring
; "for ((k, v) in m)" nests the SAME multi_variable_declaration directly under the
; for_statement (no property_declaration wrapper); the scope-path loop binding only
; handles the single variable_declaration form, so this rule does not double-emit.
((property_declaration
  (multi_variable_declaration
    (variable_declaration
      (simple_identifier) @name))) @definition.property
  (#not-eq? @name "_"))

((for_statement
  (multi_variable_declaration
    (variable_declaration
      (simple_identifier) @name))) @definition.property
  (#not-eq? @name "_"))

; Primary constructor val/var parameters (data class, value class, regular class)
; binding_pattern_kind contains "val" or "var" — without it, the param is not a property
(class_parameter
  (binding_pattern_kind)
  (simple_identifier) @name) @definition.property

; ── Enum entries ─────────────────────────────────────────────────────────
(enum_entry
  (simple_identifier) @name) @definition.enum

; ── Type aliases ─────────────────────────────────────────────────────────
(type_alias
  (type_identifier) @name) @definition.type

; ── Imports ──────────────────────────────────────────────────────────────
(import_header
  (identifier) @import.source) @import

; ── Function calls (direct) ──────────────────────────────────────────────
(call_expression
  (simple_identifier) @call.name) @call

; ── Method calls (via navigation: obj.method()) ──────────────────────────
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @call.name))) @call

; ── Constructor invocations ──────────────────────────────────────────────
(constructor_invocation
  (user_type
    (type_identifier) @call.name)) @call

; ── Infix function calls (e.g., a to b, x until y) ──────────────────────
; tree-sitter-kotlin models infix_expression as three UNNAMED-FIELD children:
; (operand) (operator) (operand) — all three are simple_identifier for
; "a to b". The old rule "(infix_expression (simple_identifier) @call.name)"
; matched EVERY simple_identifier child, so it captured the operands a/b as
; spurious @call.name calls (F49, issue #1919). There is no operator: field to
; anchor on, so anchor positionally: the operator is the middle child, flanked
; by an operand on each side. End-anchored on both sides so only the lone
; middle simple_identifier (the infix function) is captured; chained
; "a to b to c" still matches each nested infix_expression's own operator.
(infix_expression
  .
  (_)
  .
  (simple_identifier) @call.name
  .
  (_)
  .) @call

; Write access: obj.field = value
(assignment
  (directly_assignable_expression
    (_) @assignment.receiver
    (navigation_suffix
      (simple_identifier) @assignment.property))
  (_)) @assignment

`;

// Swift queries - works with tree-sitter-swift
export const SWIFT_QUERIES = `
; Classes
(class_declaration "class" name: (type_identifier) @name) @definition.class

; Structs
(class_declaration "struct" name: (type_identifier) @name) @definition.struct

; Enums
(class_declaration "enum" name: (type_identifier) @name) @definition.enum

; Extensions (mapped to class — no dedicated label in schema)
(class_declaration "extension" name: (user_type (type_identifier) @name)) @definition.class

; Actors
(class_declaration "actor" name: (type_identifier) @name) @definition.class

; Protocols (mapped to interface)
(protocol_declaration name: (type_identifier) @name) @definition.interface

; Type aliases
(typealias_declaration name: (type_identifier) @name) @definition.type

; Functions (top-level and methods)
(function_declaration name: (simple_identifier) @name) @definition.function

; Protocol method declarations
(protocol_function_declaration name: (simple_identifier) @name) @definition.method

; Initializers
(init_declaration) @definition.constructor

; Properties (stored and computed)
(property_declaration (pattern (simple_identifier) @name)) @definition.property

; Protocol property requirements (F75): "var title: String { get }" parses to a
; protocol_property_declaration (NOT property_declaration). Its name is a
; "name:" pattern field wrapping a value_binding_pattern + the bound
; simple_identifier; match the inner identifier so the requirement is emitted
; as a property symbol of the protocol.
(protocol_property_declaration (pattern (simple_identifier) @name)) @definition.property

; Enum cases
(enum_entry (simple_identifier) @name) @definition.property

; Imports
(import_declaration (identifier (simple_identifier) @import.source)) @import

; Calls - direct function calls
(call_expression (simple_identifier) @call.name) @call

; Calls - member/navigation calls (obj.method())
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.name))) @call

; Write access: obj.field = value (tree-sitter-swift 0.7.1 uses named fields)
(assignment
  target: (directly_assignable_expression
    (navigation_expression
      target: (_) @assignment.receiver
      suffix: (navigation_suffix
        suffix: (simple_identifier) @assignment.property)))
  result: (_)) @assignment

`;

// Dart queries - works with tree-sitter-dart (UserNobody14/tree-sitter-dart, ABI 14)
// Note: Dart grammar has function_signature/method_signature as wrappers;
// top-level functions are (program > function_signature),
// methods inside classes are (method_signature > function_signature).
// We match top-level functions via (program (function_signature ...)) to avoid
// double-counting methods that also contain function_signature.
export const DART_QUERIES = `
; ── Classes ──────────────────────────────────────────────────────────────────
(class_definition
  name: (identifier) @name) @definition.class

; ── Mixins ───────────────────────────────────────────────────────────────────
(mixin_declaration
  (identifier) @name) @definition.trait

; ── Extensions ───────────────────────────────────────────────────────────────
(extension_declaration
  name: (identifier) @name) @definition.class

; ── Enums ────────────────────────────────────────────────────────────────────
(enum_declaration
  name: (identifier) @name) @definition.enum

; ── Type aliases — new-style (typedef Pred = bool Function(int);) ────────────
; Anchor "=" after the name to avoid capturing the RHS type. The name is the
; first type_identifier (the alias), the RHS function_type follows the "=".
(type_alias
  (type_identifier) @name
  "=") @definition.type

; ── Type aliases — old-style (typedef int Cmp(int a, int b);) ────────────────
; The old-style function typedef has NO "=" — it parses as a type_alias whose
; children are: return type_identifier, NAME type_identifier, formal_parameter_list.
; Anchor @name as the type_identifier immediately before the parameter list so we
; capture the alias name (Cmp), not the leading return type (int).
(type_alias
  (type_identifier) @name
  .
  (formal_parameter_list)) @definition.type

; ── Type aliases — generic old-style (typedef int Cmp<T>(T a, T b);) ─────────
; #1919 review CF2: a generic <T> inserts a type_parameters node between the
; NAME and the parameter list, so the non-generic adjacency above misses it.
; Standalone pattern (NOT an alternation arm) anchoring @name immediately before
; type_parameters, which is immediately before the parameter list. The new-style
; "=" rule above is unanchored and already covers generic new-style (Mapper<T>).
(type_alias
  (type_identifier) @name
  .
  (type_parameters)
  .
  (formal_parameter_list)) @definition.type

; ── Top-level functions (parent is program, not method_signature) ────────────
(program
  (function_signature
    name: (identifier) @name) @definition.function)

; ── Abstract method declarations (function_signature inside class body declaration) ──
(declaration
  (function_signature
    name: (identifier) @name)) @definition.method

; ── Methods (inside class/mixin/extension bodies) ────────────────────────────
(method_signature
  (function_signature
    name: (identifier) @name)) @definition.method

; ── Constructors ─────────────────────────────────────────────────────────────
(constructor_signature
  name: (identifier) @name) @definition.constructor

; ── Factory constructors (anchor before param list to capture variant name, not class) ──
(method_signature
  (factory_constructor_signature
    (identifier) @name . (formal_parameter_list))) @definition.constructor

; ── Field declarations (String name = '', Address address = Address()) ──────
(declaration
  (type_identifier)
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name))) @definition.property

; ── Nullable field declarations (String? name) ──────────────────────────────
(declaration
  (nullable_type)
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name))) @definition.property

; ── static const / static final / const class fields ────────────────────────
; A "static const a = 1;" / "static final String b = ..., c = ...;" field parses
; with a static_final_declaration_list (NOT an initialized_identifier_list), so
; the field rules above miss them. One @name per static_final_declaration, so a
; multi-name declaration yields a Property per name. Anchored on declaration (not
; class_body) so top-level final/const variables — whose
; static_final_declaration_list is a direct child of program, not wrapped in a
; declaration — never match here.
(declaration
  (static_final_declaration_list
    (static_final_declaration
      (identifier) @name))) @definition.property

; ── Getters ──────────────────────────────────────────────────────────────────
(method_signature
  (getter_signature
    name: (identifier) @name)) @definition.property

; ── Setters ──────────────────────────────────────────────────────────────────
(method_signature
  (setter_signature
    name: (identifier) @name)) @definition.property

; ── Top-level variable declarations ──────────────────────────────────────────
; Top-level Dart variables are NOT wrapped in a declaration node (that wrapper
; only occurs for class-body members). They sit as loose siblings under program:
;   var name = 'x';   int x = 5;       → initialized_identifier_list
;   final int count = 3;   const a = 1, b = 2;   → static_final_declaration_list
; Anchor both rules under (program) so class-body fields (which reuse the same
; inner node types) are never matched here. One @name per declared name so
; multi-name forms (const a = 1, b = 2;) yield a Variable per name.
(program
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name)) @definition.variable)
(program
  (static_final_declaration_list
    (static_final_declaration
      (identifier) @name)) @definition.variable)

; ── Imports ──────────────────────────────────────────────────────────────────
(import_or_export
  (library_import
    (import_specification
      (configurable_uri) @import.source))) @import

; ── Calls: direct function/constructor calls (identifier immediately before argument_part) ──
(expression_statement
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: method calls (obj.method()) ───────────────────────────────────────
(expression_statement
  (selector
    (unconditional_assignable_selector
      (identifier) @call.name))) @call

; ── Calls: in return statements (return User()) ─────────────────────────────
(return_statement
  (identifier) @call.name
  (selector (argument_part))) @call

; ── Calls: in variable assignments (var x = getUser()) ──────────────────────
(initialized_variable_definition
  value: (identifier) @call.name
  (selector (argument_part))) @call

; ── Calls: member calls in variable assignments (var x = obj.method()) ──────
(initialized_variable_definition
  (selector
    (unconditional_assignable_selector
      (identifier) @call.name))
  (selector (argument_part))) @call

; ── Calls: await direct (await doSomething()) ────────────────────────────────
(await_expression
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: await method chain (await obj.method()) ───────────────────────────
; Requires argument_part to distinguish method calls from field access (await obj.field)
(await_expression
  (selector
    (unconditional_assignable_selector
      (identifier) @call.name))
  (selector (argument_part))) @call

; ── Calls: named argument (foo(child: buildX())) ─────────────────────────────
(named_argument
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: inside list literals ([buildA(), buildB()]) ───────────────────────
(list_literal
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: cascade (obj..add(x)..sort()) ─────────────────────────────────────
; Note: cascade_selector contains identifier directly (no unconditional_assignable_selector
; wrapper in Dart grammar), so inferCallForm() classifies these as free calls rather than
; member calls. Cross-file resolution still benefits from the call being recorded.
(cascade_section
  (cascade_selector (identifier) @call.name)
  (argument_part)) @call

; ── Calls: static final field initializers (static final _svc = MyService()) ──
(static_final_declaration
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: arrow function body (=> buildWidget()) ────────────────────────────
(function_body "=>"
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Calls: lambda body (() => doSomething()) ─────────────────────────────────
(function_expression_body
  (identifier) @call.name
  .
  (selector (argument_part))) @call

; ── Re-exports (export 'foo.dart') ───────────────────────────────────────────
(import_or_export
  (library_export
    (configurable_uri) @import.source)) @import

; ── Write access: obj.field = value ──────────────────────────────────────────
(assignment_expression
  left: (assignable_expression
    (identifier) @assignment.receiver
    (unconditional_assignable_selector
      (identifier) @assignment.property))
  right: (_)) @assignment

; ── Write access: this.field = value ─────────────────────────────────────────
(assignment_expression
  left: (assignable_expression
    (this) @assignment.receiver
    (unconditional_assignable_selector
      (identifier) @assignment.property))
  right: (_)) @assignment
`;

import { SupportedLanguages } from 'gitnexus-shared';

export const LANGUAGE_QUERIES: Record<SupportedLanguages, string> = {
  [SupportedLanguages.TypeScript]: TYPESCRIPT_QUERIES,
  [SupportedLanguages.JavaScript]: JAVASCRIPT_QUERIES,
  [SupportedLanguages.Python]: PYTHON_QUERIES,
  [SupportedLanguages.Java]: JAVA_QUERIES,
  [SupportedLanguages.C]: C_QUERIES,
  [SupportedLanguages.Go]: GO_QUERIES,
  [SupportedLanguages.CPlusPlus]: CPP_QUERIES,
  [SupportedLanguages.CSharp]: CSHARP_QUERIES,
  [SupportedLanguages.Rust]: RUST_QUERIES,
  [SupportedLanguages.PHP]: PHP_QUERIES,
  [SupportedLanguages.Kotlin]: KOTLIN_QUERIES,
  [SupportedLanguages.Ruby]: RUBY_QUERIES,
  [SupportedLanguages.Swift]: SWIFT_QUERIES,
  [SupportedLanguages.Dart]: DART_QUERIES,
  [SupportedLanguages.Vue]: TYPESCRIPT_QUERIES, // Vue <script> blocks are parsed as TypeScript
  [SupportedLanguages.Cobol]: '', // Standalone regex processor — no tree-sitter queries
};
