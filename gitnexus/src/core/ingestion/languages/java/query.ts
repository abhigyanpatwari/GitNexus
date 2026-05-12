/**
 * Tree-sitter query for Java scope captures (RFC §5.1).
 *
 * Captures the structural skeleton the generic scope-resolution
 * pipeline consumes: scopes (module/class/function), declarations
 * (class-likes, method-likes, fields, variables), imports (import
 * declarations), type bindings (parameter annotations, variable
 * annotations, constructor inference), and references (call sites,
 * member writes/reads).
 *
 * Java specifics that shape this query:
 *
 *   - Java uses `program` as the root node (not `compilation_unit`).
 *   - `import_declaration` nodes carry `scoped_identifier` children
 *     and optional `asterisk` for wildcard imports.
 *   - `static` imports are detected by an anonymous `static` token
 *     child within `import_declaration`.
 *   - `var` (Java 10+ local variable type inference) parses as a
 *     `type_identifier` with text `"var"`, not a dedicated node type.
 *   - Modifiers (`public`, `static`, etc.) are grouped under a
 *     `modifiers` named child with anonymous keyword tokens.
 *   - Superclass inheritance uses a `superclass:` field containing
 *     a `superclass` node wrapping a `type_identifier`.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

const JAVA_SCOPE_QUERY = `
;; Scopes
(program) @scope.module

(class_declaration) @scope.class
(interface_declaration) @scope.class
(enum_declaration) @scope.class
(record_declaration) @scope.class
(annotation_type_declaration) @scope.class

(method_declaration) @scope.function
(constructor_declaration) @scope.function

;; Declarations — types
(class_declaration
  name: (identifier) @declaration.name) @declaration.class

(interface_declaration
  name: (identifier) @declaration.name) @declaration.interface

(enum_declaration
  name: (identifier) @declaration.name) @declaration.enum

(record_declaration
  name: (identifier) @declaration.name) @declaration.record

(annotation_type_declaration
  name: (identifier) @declaration.name) @declaration.class

;; Declarations — methods / constructors
(method_declaration
  name: (identifier) @declaration.name) @declaration.method

(constructor_declaration
  name: (identifier) @declaration.name) @declaration.constructor

;; Declarations — fields
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @declaration.name)) @declaration.variable

;; Declarations — local variables
(local_variable_declaration
  declarator: (variable_declarator
    name: (identifier) @declaration.name)) @declaration.variable

;; Imports — single anchor per import_declaration
(import_declaration) @import.statement

;; Type bindings — parameter annotations: void f(User u)
(formal_parameter
  type: (type_identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

(formal_parameter
  type: (generic_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

(formal_parameter
  type: (scoped_type_identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

;; Type bindings — local variable annotations: User u = new User();
(local_variable_declaration
  type: (type_identifier) @type-binding.type
  declarator: (variable_declarator
    name: (identifier) @type-binding.name)) @type-binding.annotation

(local_variable_declaration
  type: (generic_type) @type-binding.type
  declarator: (variable_declarator
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — var u = new User(); (Java 10+ local variable type inference)
;; tree-sitter-java parses \`var\` as a \`type_identifier\` with text "var".
;; The type-binding.constructor anchor fires when the rhs is an
;; object_creation_expression so interpretJavaTypeBinding can infer
;; the concrete type from the constructor call.
(local_variable_declaration
  type: (type_identifier) @_var_type
  declarator: (variable_declarator
    name: (identifier) @type-binding.name
    value: (object_creation_expression
      type: (type_identifier) @type-binding.type))) @type-binding.constructor

;; Type bindings — field declarations: private User user;
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (variable_declarator
    name: (identifier) @type-binding.name)) @type-binding.annotation

(field_declaration
  type: (generic_type) @type-binding.type
  declarator: (variable_declarator
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — method return type: public User getUser() { }
(method_declaration
  type: (type_identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

(method_declaration
  type: (generic_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

;; Type bindings — enhanced for: for (User u : list)
(enhanced_for_statement
  type: (type_identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

(enhanced_for_statement
  type: (generic_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

;; References — all method calls: foo() and obj.method()
;; tree-sitter-java's query engine drops negation-based \`!object\`
;; patterns when a positive \`object:\` pattern exists for the same
;; node type, so we match all calls here and classify free vs
;; member in captures.ts based on the presence of @reference.receiver.
(method_invocation
  object: (_) @reference.receiver
  name: (identifier) @reference.name) @reference.call.member

(method_invocation
  name: (identifier) @reference.name) @reference.call.free

;; References — constructor calls: new User(...)
(object_creation_expression
  type: (type_identifier) @reference.name) @reference.call.constructor

(object_creation_expression
  type: (generic_type
    (type_identifier) @reference.name)) @reference.call.constructor

(object_creation_expression
  type: (scoped_type_identifier) @reference.call.constructor.qualified) @reference.call.constructor

;; References — field/property writes: obj.name = "x"
(assignment_expression
  left: (field_access
    object: (_) @reference.receiver
    field: (identifier) @reference.name)) @reference.write.member

;; References — field/property reads: obj.name
(field_access
  object: (_) @reference.receiver
  field: (identifier) @reference.name) @reference.read.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getJavaParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Java as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getJavaScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Java as Parameters<Parser['setLanguage']>[0], JAVA_SCOPE_QUERY);
  }
  return _query;
}
