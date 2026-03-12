import { SupportedLanguages } from '../../config/supported-languages.js';

/* 
 * Tree-sitter queries for extracting code definitions.
 * 
 * Note: Different grammars (typescript vs tsx vs javascript) may have
 * slightly different node types. These queries are designed to be 
 * compatible with the standard tree-sitter grammars.
 */

// TypeScript queries - works with tree-sitter-typescript
export const TYPESCRIPT_QUERIES = `
(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
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

; Heritage queries - class extends
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (extends_clause
      value: (identifier) @heritage.extends))) @heritage

; Heritage queries - class implements interface
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (implements_clause
      (type_identifier) @heritage.implements))) @heritage.impl
`;

// JavaScript queries - works with tree-sitter-javascript
export const JAVASCRIPT_QUERIES = `
(class_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
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

; Heritage queries - class extends (JavaScript uses different AST than TypeScript)
; In tree-sitter-javascript, class_heritage directly contains the parent identifier
(class_declaration
  name: (identifier) @heritage.class
  (class_heritage
    (identifier) @heritage.extends)) @heritage
`;

// Python queries - works with tree-sitter-python
export const PYTHON_QUERIES = `
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(import_statement
  name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (relative_import) @import.source) @import

(call
  function: (identifier) @call.name) @call

(call
  function: (attribute
    attribute: (identifier) @call.name)) @call

; Heritage queries - Python class inheritance
(class_definition
  name: (identifier) @heritage.class
  superclasses: (argument_list
    (identifier) @heritage.extends)) @heritage
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

; Imports - capture any import declaration child as source
(import_declaration (_) @import.source) @import

; Calls
(method_invocation name: (identifier) @call.name) @call
(method_invocation object: (_) name: (identifier) @call.name) @call

; Constructor calls: new Foo()
(object_creation_expression type: (type_identifier) @call.name) @call

; Heritage - extends class
(class_declaration name: (identifier) @heritage.class
  (superclass (type_identifier) @heritage.extends)) @heritage

; Heritage - implements interfaces
(class_declaration name: (identifier) @heritage.class
  (super_interfaces (type_list (type_identifier) @heritage.implements))) @heritage.impl
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
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.typedef

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
`;

// Go queries - works with tree-sitter-go
export const GO_QUERIES = `
; Functions & Methods
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method

; Types
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

; Imports
(import_declaration (import_spec path: (interpreted_string_literal) @import.source)) @import
(import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @import.source))) @import

; Struct embedding (anonymous fields = inheritance)
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (struct_type
      (field_declaration_list
        (field_declaration
          type: (type_identifier) @heritage.extends))))) @definition.struct

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call

; Struct literal construction: User{Name: "Alice"}
(composite_literal type: (type_identifier) @call.name) @call
`;

// C++ queries - works with tree-sitter-cpp
export const CPP_QUERIES = `
; Classes, Structs, Namespaces
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(enum_specifier name: (type_identifier) @name) @definition.enum

; Typedefs and unions (common in C-style headers and mixed C/C++ code)
(type_definition declarator: (type_identifier) @name) @definition.typedef
(union_specifier name: (type_identifier) @name) @definition.union

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Functions & Methods (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.method

; Functions/methods returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method

; Functions/methods returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))))) @definition.method

; Functions/methods returning references (reference_declarator wraps function_declarator)
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @definition.method

; Destructors (destructor_name is distinct from identifier in tree-sitter-cpp)
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (destructor_name) @name))) @definition.method

; Function declarations / prototypes (common in headers)
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Inline class method declarations (inside class body, no body: void Foo();)
(field_declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.method

; Inline class method definitions (inside class body, with body: void Foo() { ... })
(field_declaration_list
  (function_definition
    declarator: (function_declarator
      declarator: [(field_identifier) (identifier) (operator_name) (destructor_name)] @name))) @definition.method

; Templates
(template_declaration (class_specifier name: (type_identifier) @name)) @definition.template
(template_declaration (function_definition declarator: (function_declarator declarator: (identifier) @name))) @definition.template

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier name: (identifier) @call.name)) @call
(call_expression function: (template_function name: (identifier) @call.name)) @call

; Constructor calls: new User()
(new_expression type: (type_identifier) @call.name) @call

; Heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (type_identifier) @heritage.extends)) @heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (access_specifier) (type_identifier) @heritage.extends)) @heritage
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

; Constructor calls: new Foo() and new Foo { Props }
(object_creation_expression type: (identifier) @call.name) @call

; Target-typed new (C# 9): User u = new("x", 5)
(variable_declaration type: (identifier) @call.name (variable_declarator (implicit_object_creation_expression) @call))

; Heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (identifier) @heritage.extends)) @heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (generic_name (identifier) @heritage.extends))) @heritage
`;

// Rust queries - works with tree-sitter-rust
export const RUST_QUERIES = `
; Functions & Items
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name !trait) @definition.impl
(impl_item type: (generic_type type: (type_identifier) @name) !trait) @definition.impl
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

; Heritage (trait implementation) — all combinations of concrete/generic trait × concrete/generic type
(impl_item trait: (type_identifier) @heritage.trait type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (type_identifier) @heritage.trait type: (generic_type type: (type_identifier) @heritage.class)) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (generic_type type: (type_identifier) @heritage.class)) @heritage
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

; ── Heritage: extends ────────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (base_clause
    [(name) (qualified_name)] @heritage.extends)) @heritage

; ── Heritage: implements ─────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (class_interface_clause
    [(name) (qualified_name)] @heritage.implements)) @heritage.impl

; ── Heritage: use trait (must capture enclosing class name) ──────────────────
(class_declaration
  name: (name) @heritage.class
  body: (declaration_list
    (use_declaration
      [(name) (qualified_name)] @heritage.trait))) @heritage
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

; ── Properties ───────────────────────────────────────────────────────────
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.property

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
(infix_expression
  (simple_identifier) @call.name) @call

; ── Heritage: extends / implements via delegation_specifier ──────────────
; Interface implementation (bare user_type): class Foo : Bar
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (user_type (type_identifier) @heritage.extends))) @heritage

; Class extension (constructor_invocation): class Foo : Bar()
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (constructor_invocation
      (user_type (type_identifier) @heritage.extends)))) @heritage
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

; Imports
(import_declaration (identifier (simple_identifier) @import.source)) @import

; Calls - direct function calls
(call_expression (simple_identifier) @call.name) @call

; Calls - member/navigation calls (obj.method())
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.name))) @call

; Heritage - class/struct/enum inheritance and protocol conformance
(class_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - protocol inheritance
(protocol_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - extension protocol conformance (e.g. extension Foo: SomeProtocol)
; Extensions wrap the name in user_type unlike class/struct/enum declarations
(class_declaration "extension" name: (user_type (type_identifier) @heritage.class)
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage
`;

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
  [SupportedLanguages.Swift]: SWIFT_QUERIES,
};
 