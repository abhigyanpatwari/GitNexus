/**
 * Tree-sitter query for C# scope captures (RFC §5.1).
 *
 * Captures the structural skeleton the generic scope-resolution
 * pipeline consumes: scopes (module/namespace/class/function),
 * declarations (class-likes, method-likes, properties, variables,
 * local functions), imports (using directives), type bindings
 * (parameter annotations, variable annotations, constructor
 * inference), and references (call sites, member writes).
 *
 * C# specifics that shape this query:
 *
 *   - Both block-scoped (`namespace X { }`) and file-scoped
 *     (`namespace X;`) namespaces. tree-sitter-c-sharp emits them
 *     under distinct node types (`namespace_declaration` vs
 *     `file_scoped_namespace_declaration`); both map to
 *     `@scope.namespace` since the scope semantics are identical.
 *   - `partial class X` splits a Class def across files. Each file
 *     emits its own `@declaration.class`; cross-file resolution is
 *     handled at the graph-bridge layer via the qualified-name key.
 *   - `using X = Y;` aliases and `using static X;` are interpreted in
 *     `interpret.ts` via the `@import.*` captures. All three using
 *     flavors share the same anchor (`@import.statement`).
 *   - Explicit interface implementations (`void IFoo.Bar() { }`)
 *     expose the qualified name via the existing `@declaration.name`
 *     — the extractor's `csharpMethodConfig.extractQualifiedName`
 *     picks up the explicit qualifier from the method declaration
 *     node.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp';

const CSHARP_SCOPE_QUERY = `
;; Scopes
(compilation_unit) @scope.module

(namespace_declaration) @scope.namespace
(file_scoped_namespace_declaration) @scope.namespace

(class_declaration) @scope.class
(interface_declaration) @scope.class
(struct_declaration) @scope.class
(record_declaration) @scope.class
(enum_declaration) @scope.class

(method_declaration) @scope.function
(constructor_declaration) @scope.function
(destructor_declaration) @scope.function
(local_function_statement) @scope.function
(operator_declaration) @scope.function
(conversion_operator_declaration) @scope.function
;; Property accessors are blocks within a property; not scoped here.
;; Anonymous methods / lambdas are not scoped — out of scope per plan.

;; Declarations — types
(class_declaration
  name: (identifier) @declaration.name) @declaration.class

(interface_declaration
  name: (identifier) @declaration.name) @declaration.interface

(struct_declaration
  name: (identifier) @declaration.name) @declaration.struct

(record_declaration
  name: (identifier) @declaration.name) @declaration.record

(enum_declaration
  name: (identifier) @declaration.name) @declaration.enum

;; Declarations — methods / constructors / properties
(method_declaration
  name: (identifier) @declaration.name) @declaration.method

(constructor_declaration
  name: (identifier) @declaration.name) @declaration.constructor

(destructor_declaration
  name: (identifier) @declaration.name) @declaration.method

(local_function_statement
  name: (identifier) @declaration.name) @declaration.function

;; Operator declarations — \`public static T operator +(T a, T b)\`.
;; tree-sitter-c-sharp exposes the operator token under the \`operator:\`
;; field (an anonymous node like \`+\`, \`-\`, \`==\`). Capture the whole
;; node under @declaration.name so the extractor reads the operator
;; symbol as the declared name; downstream csharpMethodConfig can
;; normalize it (e.g. to \`op_Addition\`) when it runs.
(operator_declaration
  operator: _ @declaration.name) @declaration.method

;; Conversion operators — \`public static explicit operator int(T x)\`.
;; No operator token; the target type (\`int\`) identifies the conversion
;; and serves as the name anchor.
(conversion_operator_declaration
  type: _ @declaration.name) @declaration.method

(property_declaration
  name: (identifier) @declaration.name) @declaration.property

(indexer_declaration) @declaration.property

;; Fields — \`int x;\` at class scope. variable_declarator inside
;; field_declaration carries the name.
(field_declaration
  (variable_declaration
    (variable_declarator
      name: (identifier) @declaration.name))) @declaration.variable

;; Local variables — \`int x = 1;\` inside a method body
(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @declaration.name))) @declaration.variable

;; Imports — single anchor per directive; interpretCsharpImport classifies
(using_directive) @import.statement

;; Type bindings — parameter annotations: \`void F(User u)\`
(parameter
  type: (identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

(parameter
  type: (generic_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

(parameter
  type: (qualified_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

(parameter
  type: (nullable_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.parameter

;; Type bindings — local variable annotations: \`User u = new User();\`
;; Typed local with identifier type + \`new X()\` initializer — shape
;; matters so \`u\` binds to \`X\` (the constructor call's type), not the
;; declared type alias (which is usually the same, but \`new DerivedUser()\`
;; would be distinct).
(local_declaration_statement
  (variable_declaration
    type: (identifier) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

(local_declaration_statement
  (variable_declaration
    type: (generic_name) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

(local_declaration_statement
  (variable_declaration
    type: (qualified_name) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

;; Type bindings — \`var u = new User();\` — constructor-inferred.
;; Captures object_creation_expression's type as the binding type.
;; variable_declarator wraps the \`= <expr>\` directly; tree-sitter-c-sharp
;; does not surface an equals_value_clause wrapper here.
(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @type-binding.name
      (object_creation_expression
        type: (identifier) @type-binding.type)))) @type-binding.constructor

(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @type-binding.name
      (object_creation_expression
        type: (generic_name) @type-binding.type)))) @type-binding.constructor

(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @type-binding.name
      (object_creation_expression
        type: (qualified_name) @type-binding.type)))) @type-binding.constructor

;; Type bindings — \`var u = factory();\` alias (chain-follow picks up
;; factory's return type via propagateImportedReturnTypes)
(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @type-binding.name
      (invocation_expression
        function: (identifier) @type-binding.type)))) @type-binding.alias

;; Type bindings — identifier-to-identifier alias: \`var alias = u;\`.
;; The resolver's chain-follow walks from \`alias\` → \`u\` → u's
;; declared type, so we only need to tag the rename here.
(local_declaration_statement
  (variable_declaration
    type: (implicit_type)
    (variable_declarator
      name: (identifier) @type-binding.name
      (identifier) @type-binding.type))) @type-binding.alias

;; Type bindings — chained method-call alias: \`var u = svc.GetUser();\`.
;; The chain-follow then walks GetUser's return-type binding.
(local_declaration_statement
  (variable_declaration
    type: (implicit_type)
    (variable_declarator
      name: (identifier) @type-binding.name
      (invocation_expression
        function: (member_access_expression
          name: (identifier) @type-binding.type))))) @type-binding.alias

;; Type bindings — \`await\` propagation: \`var u = await Factory();\`.
;; Strip the await wrapper to get the underlying invocation; interpret
;; layer's stripGeneric handles Task<T> / ValueTask<T>.
(local_declaration_statement
  (variable_declaration
    type: (implicit_type)
    (variable_declarator
      name: (identifier) @type-binding.name
      (await_expression
        (invocation_expression
          function: (identifier) @type-binding.type))))) @type-binding.alias

(local_declaration_statement
  (variable_declaration
    type: (implicit_type)
    (variable_declarator
      name: (identifier) @type-binding.name
      (await_expression
        (invocation_expression
          function: (member_access_expression
            name: (identifier) @type-binding.type)))))) @type-binding.alias

;; Type bindings — identifier-to-identifier assignment rebind:
;; \`alias = u;\` — aliases the rhs identifier's current type.
(assignment_expression
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; Type bindings — method return type: \`public User GetUser() { ... }\`.
;; Anchor on the method_declaration so bindingScopeFor can hoist the
;; binding from function scope to the enclosing class/module scope
;; (callers, not the function body, look up the return type by the
;; function's name). Required for cross-file return-type propagation
;; via propagateImportedReturnTypes.
(method_declaration
  returns: (identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

(method_declaration
  returns: (generic_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

(method_declaration
  returns: (qualified_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

(method_declaration
  returns: (nullable_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.return

;; Type bindings — field declaration: \`private City _city;\`. Attaches
;; to the enclosing class scope via positionIndex, so \`this._city.X\`
;; can look up _city's type on the class.
(field_declaration
  (variable_declaration
    type: (identifier) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

(field_declaration
  (variable_declaration
    type: (generic_name) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

(field_declaration
  (variable_declaration
    type: (qualified_name) @type-binding.type
    (variable_declarator
      name: (identifier) @type-binding.name))) @type-binding.annotation

;; Type bindings — property declaration: \`public User Owner { get; set; }\`.
(property_declaration
  type: (identifier) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

(property_declaration
  type: (generic_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

(property_declaration
  type: (qualified_name) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

(property_declaration
  type: (nullable_type) @type-binding.type
  name: (identifier) @type-binding.name) @type-binding.annotation

;; Type bindings — assignment rebind: \`alias = Factory();\` where
;; \`alias\` was previously declared. Same alias shape as \`var x = F();\`.
(assignment_expression
  left: (identifier) @type-binding.name
  right: (invocation_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — assignment with constructor: \`alias = new User();\`.
(assignment_expression
  left: (identifier) @type-binding.name
  right: (object_creation_expression
    type: (identifier) @type-binding.type)) @type-binding.constructor

(assignment_expression
  left: (identifier) @type-binding.name
  right: (object_creation_expression
    type: (generic_name) @type-binding.type)) @type-binding.constructor

;; Type bindings — \`is\` pattern: \`if (obj is User u) { u.Save(); }\`.
;; The declaration_pattern carries both the matched type and the
;; binding name; scope narrowing to the guarded branch is simplified
;; to function-scope (matches Python's match-case treatment) since we
;; don't emit @scope.block.
(is_pattern_expression
  pattern: (declaration_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(is_pattern_expression
  pattern: (declaration_pattern
    type: (generic_name) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(is_pattern_expression
  pattern: (declaration_pattern
    type: (qualified_name) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — \`case User u:\` inside a switch section.
;; tree-sitter-c-sharp's switch_section directly contains the
;; declaration_pattern / recursive_pattern (no case_pattern_switch_label
;; wrapper as in other C# grammars).
(switch_section
  (declaration_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(switch_section
  (declaration_pattern
    type: (generic_name) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — recursive_pattern with named binding:
;; \`x is User { Age: 1 } u\` / \`case User { Age: 1 } u:\`. type + name
;; are named fields on recursive_pattern; inner property/positional
;; clauses don't affect the binding.
(is_pattern_expression
  pattern: (recursive_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(switch_section
  (recursive_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — switch-expression arms: \`obj switch { User u => …, Repo { Name: "x" } r => … }\`.
;; Distinct from the \`switch_statement\` shape above — expression-switch
;; uses \`switch_expression_arm\` nodes.
(switch_expression_arm
  (declaration_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(switch_expression_arm
  (declaration_pattern
    type: (generic_name) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

(switch_expression_arm
  (recursive_pattern
    type: (identifier) @type-binding.type
    name: (identifier) @type-binding.name)) @type-binding.annotation

;; Type bindings — typed foreach: \`foreach (User u in xs)\`.
;; Shape parity with \`User u = …;\` — left binds to the declared type.
(foreach_statement
  type: (identifier) @type-binding.type
  left: (identifier) @type-binding.name) @type-binding.annotation

(foreach_statement
  type: (generic_name) @type-binding.type
  left: (identifier) @type-binding.name) @type-binding.annotation

(foreach_statement
  type: (qualified_name) @type-binding.type
  left: (identifier) @type-binding.name) @type-binding.annotation

(foreach_statement
  type: (nullable_type) @type-binding.type
  left: (identifier) @type-binding.name) @type-binding.annotation

;; Type bindings — \`var\` foreach: \`foreach (var u in xs)\`. Alias to
;; the iterable's identifier / chain so chain-follow unwraps
;; \`List<User>\` / \`Dictionary<K,V>.Values\` to the element type via
;; the generic-stripper in interpret.ts. Mirrors Python's for-loop
;; alias patterns.
(foreach_statement
  type: (implicit_type)
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

(foreach_statement
  type: (implicit_type)
  left: (identifier) @type-binding.name
  right: (member_access_expression) @type-binding.type) @type-binding.alias

(foreach_statement
  type: (implicit_type)
  left: (identifier) @type-binding.name
  right: (invocation_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

;; Return-type captures on method_declaration / property_declaration /
;; field_declaration are deferred — tree-sitter-c-sharp does not expose
;; the return/field type under a simple named field that pattern-matches
;; cleanly. When Unit 7's parity gate surfaces a gap requiring these
;; bindings, revisit with a positional pattern or a post-hoc lookup via
;; csharpMethodConfig.extractReturnType / csharpFieldConfig.extractType.

;; References — free calls: \`Foo()\`
(invocation_expression
  function: (identifier) @reference.name) @reference.call.free

;; References — member calls: \`obj.Method()\`
;; \`(_)\` matches only named nodes in tree-sitter queries. \`this\` and
;; \`base\` are anonymous tokens in tree-sitter-c-sharp (unlike Python's
;; \`self\` which is a regular identifier), so they need explicit
;; patterns to emit a receiver capture.
(invocation_expression
  function: (member_access_expression
    expression: (_) @reference.receiver
    name: (identifier) @reference.name)) @reference.call.member

(invocation_expression
  function: (member_access_expression
    expression: "this" @reference.receiver
    name: (identifier) @reference.name)) @reference.call.member

(invocation_expression
  function: (member_access_expression
    expression: "base" @reference.receiver
    name: (identifier) @reference.name)) @reference.call.member

;; References — null-conditional member calls: \`obj?.Method()\`
;; conditional_access_expression wraps a receiver followed by a
;; member_binding_expression. Capture the receiver explicitly so
;; receiver-bound resolution doesn't silently downgrade the call to
;; a free-call (which would misresolve to an imported \`Save\`).
;; tree-sitter-c-sharp doesn't expose named fields here, so use
;; positional wildcards.
(invocation_expression
  function: (conditional_access_expression
    (_) @reference.receiver
    (member_binding_expression
      (identifier) @reference.name))) @reference.call.member

;; References — constructor calls: \`new User(...)\`
(object_creation_expression
  type: (identifier) @reference.name) @reference.call.constructor

(object_creation_expression
  type: (generic_name
    (identifier) @reference.name)) @reference.call.constructor

(object_creation_expression
  type: (qualified_name) @reference.call.constructor.qualified) @reference.call.constructor

;; References — field/property writes: \`obj.Name = "x"\` emits a write
;; ACCESSES edge from the enclosing method to the field/property on
;; obj's class.
(assignment_expression
  left: (member_access_expression
    expression: (_) @reference.receiver
    name: (identifier) @reference.name)) @reference.write.member

(assignment_expression
  left: (member_access_expression
    expression: "this" @reference.receiver
    name: (identifier) @reference.name)) @reference.write.member

(assignment_expression
  left: (member_access_expression
    expression: "base" @reference.receiver
    name: (identifier) @reference.name)) @reference.write.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getCsharpParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(CSharp as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getCsharpScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(CSharp as Parameters<Parser['setLanguage']>[0], CSHARP_SCOPE_QUERY);
  }
  return _query;
}
