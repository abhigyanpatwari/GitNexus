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

;; Type bindings — var u = svc.getUser(); (Java 10+ call-result inference)
(local_variable_declaration
  type: (type_identifier) @_var_type
  (#eq? @_var_type "var")
  declarator: (variable_declarator
    name: (identifier) @type-binding.name
    value: (method_invocation
      name: (identifier) @type-binding.type))) @type-binding.call-result

;; Type bindings — var alias = u; (Java 10+ alias inference)
(local_variable_declaration
  type: (type_identifier) @_var_type
  (#eq? @_var_type "var")
  declarator: (variable_declarator
    name: (identifier) @type-binding.name
    value: (identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — var addr = user.address; (Java 10+ field-access alias)
(local_variable_declaration
  type: (type_identifier) @_var_type
  (#eq? @_var_type "var")
  declarator: (variable_declarator
    name: (identifier) @type-binding.name
    value: (field_access
      field: (identifier) @type-binding.type))) @type-binding.alias

;; Type bindings — enhanced-for with var: for (var user : users)
(enhanced_for_statement
  (type_identifier) @_var_type
  (#eq? @_var_type "var")
  (identifier) @type-binding.name
  (identifier) @type-binding.type) @type-binding.alias

;; Enhanced-for with var + method iterable: for (var user : data.values())
(enhanced_for_statement
  (type_identifier) @_var_type
  (#eq? @_var_type "var")
  (identifier) @type-binding.name
  (method_invocation
    object: (identifier) @type-binding.type)) @type-binding.alias

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

;; Type bindings — instanceof pattern (Java 16+): if (obj instanceof User user)
(instanceof_expression
  (type_identifier) @type-binding.type
  (identifier) @type-binding.name) @type-binding.pattern

;; Type bindings — switch case pattern (Java 21+): case User user ->
(type_pattern
  (type_identifier) @type-binding.type
  (identifier) @type-binding.name) @type-binding.pattern

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

;; References — qualified constructor calls: new pkg.Foo(), new a.b.Foo() (F35 #1928)
;; tree-sitter-java parses \`pkg.Foo\` as a scoped_type_identifier whose final
;; child is the simple type. Bind that tail as @reference.name (trailing \`.\`
;; anchor = last child) so resolution targets \`Foo\`, not the raw \`pkg.Foo\` text.
;; Mirrors the TS/JS new-expression qualified-constructor capture.
(object_creation_expression
  type: (scoped_type_identifier
    (type_identifier) @reference.name .) @reference.call.constructor.qualified) @reference.call.constructor

;; References — qualified + generic constructor calls: new pkg.Box<T>() (F35 #1928)
;; The base is a generic_type whose first child is a scoped_type_identifier, so
;; neither the simple-generic nor the plain-scoped arm above matches it. Bind the
;; scoped tail as @reference.name.
(object_creation_expression
  type: (generic_type
    (scoped_type_identifier
      (type_identifier) @reference.name .) @reference.call.constructor.qualified)) @reference.call.constructor

;; References — method references: User::getName, obj::method
(method_reference
  (identifier) @reference.receiver
  (identifier) @reference.name) @reference.call.member

;; References — this::method and super::method
(method_reference
  (this) @reference.receiver
  (identifier) @reference.name) @reference.call.member

(method_reference
  (super) @reference.receiver
  (identifier) @reference.name) @reference.call.member

;; References — field_access::method: responseBuilder::buildResponse
(method_reference
  (field_access) @reference.receiver
  (identifier) @reference.name) @reference.call.member

;; References — constructor references: User::new
(method_reference
  (identifier) @reference.name
  "new") @reference.call.constructor

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
