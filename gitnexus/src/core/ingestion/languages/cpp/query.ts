import Parser from 'tree-sitter';
import CPP from 'tree-sitter-cpp';

const CPP_SCOPE_QUERY = `
;; ─── Scopes ──────────────────────────────────────────────────────────
(translation_unit) @scope.module
(namespace_definition) @scope.namespace
(class_specifier) @scope.class
(struct_specifier) @scope.class
(function_definition) @scope.function
(lambda_expression) @scope.function
(compound_statement) @scope.block
(if_statement) @scope.block
(for_statement) @scope.block
(for_range_loop) @scope.block
(while_statement) @scope.block
(do_statement) @scope.block
(switch_statement) @scope.block
(case_statement) @scope.block
(try_statement) @scope.block
(catch_clause) @scope.block

;; ─── Declarations — namespace ────────────────────────────────────────
(namespace_definition
  name: (namespace_identifier) @declaration.name) @declaration.namespace

;; Anonymous namespace (no name child) — captured as scope only, names
;; inside are marked file-local by captures.ts.

;; ─── Declarations — class / struct (named) ───────────────────────────
(class_specifier
  name: (type_identifier) @declaration.name
  body: (field_declaration_list)) @declaration.class

(struct_specifier
  name: (type_identifier) @declaration.name
  body: (field_declaration_list)) @declaration.struct

;; ─── Declarations — class / struct inside template_declaration ───────
(template_declaration
  (class_specifier
    name: (type_identifier) @declaration.name
    body: (field_declaration_list)) @declaration.class)

(template_declaration
  (struct_specifier
    name: (type_identifier) @declaration.name
    body: (field_declaration_list)) @declaration.struct)

;; ─── Declarations — enum ─────────────────────────────────────────────
(enum_specifier
  name: (type_identifier) @declaration.name) @declaration.enum

;; ─── Declarations — enum constants ───────────────────────────────────
(enumerator
  name: (identifier) @declaration.name) @declaration.const

;; ─── Declarations — function definition (plain identifier) ──────────
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; ─── Declarations — function definition with pointer return ─────────
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; ─── Declarations — out-of-class method (qualified_identifier) ──────
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @declaration.name))) @declaration.method

;; ─── Declarations — out-of-class method with pointer return ─────────
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (qualified_identifier
        name: (identifier) @declaration.name)))) @declaration.method

;; ─── Declarations — out-of-class method (destructor_name) ───────────
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (destructor_name) @declaration.name))) @declaration.method

;; ─── Declarations — template function definition ────────────────────
(template_declaration
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @declaration.name)) @declaration.function)

;; ─── Declarations — template method (qualified) ─────────────────────
(template_declaration
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier
        name: (identifier) @declaration.name))) @declaration.method)

;; ─── Declarations — inline method in class body (field_identifier) ──
;; tree-sitter-cpp uses field_identifier for names inside class bodies
(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @declaration.name)) @declaration.method

;; ─── Declarations — inline method with pointer return (field_identifier) ──
;; Covers: User* lookup(int id) { ... } inside a class body
;; AST: function_definition > pointer_declarator > function_declarator > field_identifier
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

;; ─── Declarations — inline method with reference return (field_identifier) ──
;; Covers: User& getRef() { ... } inside a class body
(function_definition
  declarator: (reference_declarator
    (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

;; ─── Declarations — function prototype (forward declaration) ────────
(declaration
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; ─── Declarations — function prototype with pointer return ──────────
(declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; ─── Declarations — typedef ─────────────────────────────────────────
(type_definition
  declarator: (type_identifier) @declaration.name) @declaration.typedef

;; ─── Declarations — type alias (using Name = Type) ──────────────────
(alias_declaration
  name: (type_identifier) @declaration.name) @declaration.typedef

;; ─── Declarations — method prototype in class body (forward decl) ────
;; Covers: class User { void save(); std::string getName(); };
;; AST: field_declaration > function_declarator > field_identifier
(field_declaration
  declarator: (function_declarator
    declarator: (field_identifier) @declaration.name)) @declaration.method

;; Method prototype with pointer return: User* lookup(int id);
(field_declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

;; Method prototype with reference return: User& getRef();
(field_declaration
  declarator: (reference_declarator
    (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

;; ─── Declarations — fields ──────────────────────────────────────────
(field_declaration
  declarator: (field_identifier) @declaration.name) @declaration.field

;; Declarations — fields (pointer)
(field_declaration
  declarator: (pointer_declarator
    declarator: (field_identifier) @declaration.name)) @declaration.field

;; Declarations — fields (reference)
(field_declaration
  declarator: (reference_declarator
    (field_identifier) @declaration.name)) @declaration.field

;; ─── Declarations — variables (with initializer) ────────────────────
(declaration
  declarator: (init_declarator
    declarator: (identifier) @declaration.name)) @declaration.variable

;; ─── Declarations — macro definitions ───────────────────────────────
(preproc_def
  name: (identifier) @declaration.name) @declaration.macro

(preproc_function_def
  name: (identifier) @declaration.name) @declaration.macro

;; ─── Imports — #include ─────────────────────────────────────────────
(preproc_include) @import.statement

;; ─── Imports — using declaration ─────────────────────────────────────
;; Both "using namespace std;" and "using std::vector;" are
;; using_declaration nodes in tree-sitter-cpp. The captures.ts
;; differentiates between them by checking for a "namespace" anonymous
;; child token.
(using_declaration) @import.using-decl

;; ─── Type bindings — parameter annotations ──────────────────────────
(parameter_declaration
  type: (_) @type-binding.type
  declarator: (identifier) @type-binding.name) @type-binding.parameter

;; Type bindings — reference parameter (const std::string& name)
(parameter_declaration
  type: (_) @type-binding.type
  declarator: (reference_declarator
    (identifier) @type-binding.name)) @type-binding.parameter

;; Type bindings — pointer parameter (User* ptr)
(parameter_declaration
  type: (_) @type-binding.type
  declarator: (pointer_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.parameter

;; ─── Type bindings — variable with type (init_declarator) ───────────
;; Covers: User user("alice"), User user = ..., int x = 0
(declaration
  type: (_) @type-binding.type
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.assignment

;; ─── Type bindings — plain declaration (no initializer) ─────────────
;; Covers: User user;
(declaration
  type: (type_identifier) @type-binding.type
  declarator: (identifier) @type-binding.name) @type-binding.annotation

;; ─── Type bindings — pointer variable declaration ───────────────────
;; Covers: User* ptr = new User()
(declaration
  type: (type_identifier) @type-binding.type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @type-binding.name))) @type-binding.annotation

;; ─── Type bindings — auto + constructor call ────────────────────────
;; Covers: auto user = User("alice")
;; AST: declaration > placeholder_type_specifier/auto > init_declarator > identifier + call_expression > identifier
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (call_expression
      function: (identifier) @type-binding.type))) @type-binding.constructor

;; ─── Type bindings — auto + brace-init (compound_literal_expression) ─
;; Covers: auto user = User{}, auto user = User{args}
;; AST: declaration > placeholder_type_specifier/auto > init_declarator > identifier + compound_literal_expression > type_identifier
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (compound_literal_expression
      type: (type_identifier) @type-binding.type))) @type-binding.constructor

;; ─── Type bindings — auto + scoped brace-init (qualified) ───────────
;; Covers: auto client = ns::HttpClient{}
;; AST: compound_literal_expression > qualified_identifier > type_identifier
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (compound_literal_expression
      type: (qualified_identifier
        name: (type_identifier) @type-binding.type)))) @type-binding.constructor

;; ─── Type bindings — auto + new expression ──────────────────────────
;; Covers: auto user = new User(name)
;; AST: declaration > placeholder_type_specifier/auto > init_declarator > identifier + new_expression > type_identifier
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (new_expression
      type: (type_identifier) @type-binding.type))) @type-binding.constructor

;; ─── Type bindings — auto + qualified template factory (std::make_shared<Dog>()) ─
;; AST: declaration(1 > placeholder_type_specifier(2)2 > init_declarator(3 >
;;   identifier(4)4 > call_expression(5 > qualified_identifier(6 >
;;   template_function(7 > template_argument_list(8 > type_descriptor(9 >
;;   type_identifier(10)10 )9 )8 )7 )6 )5 )3 )1
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (call_expression
      function: (qualified_identifier
        name: (template_function
          arguments: (template_argument_list
            (type_descriptor
              type: (type_identifier) @type-binding.type))))))) @type-binding.constructor

;; ─── Type bindings — auto + bare template factory (make_shared<Dog>()) ───────
;; Same but without qualified_identifier wrapper — one fewer nesting level
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (call_expression
      function: (template_function
        arguments: (template_argument_list
          (type_descriptor
            type: (type_identifier) @type-binding.type)))))) @type-binding.constructor

;; ─── Type bindings — auto alias assignment ──────────────────────────
;; Covers: auto alias = existingVar (RHS is a plain identifier)
;; AST: declaration > placeholder_type_specifier/auto > init_declarator > identifier + identifier
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (identifier) @type-binding.type)) @type-binding.alias

;; ─── Type bindings — auto + member access (field_expression) ────────
;; Covers: auto addr = user.address (RHS is obj.field)
;; AST: declaration > placeholder_type_specifier > init_declarator > identifier + field_expression
;; We capture the field name as @type-binding.type so the compound-receiver
;; chain resolver can look it up on the receiver class scope.
;; The full obj.field text is synthesized by interpret.ts into a dotted
;; rawName for chain-follow resolution.
(declaration
  type: (placeholder_type_specifier)
  declarator: (init_declarator
    declarator: (identifier) @type-binding.name
    value: (field_expression
      argument: (_) @type-binding.member-access-receiver
      field: (field_identifier) @type-binding.type))) @type-binding.member-access

;; ─── Type bindings — function return type ───────────────────────────
;; Covers: User getUser() { ... }
;; AST: function_definition > type_identifier + function_declarator > identifier
(function_definition
  type: (type_identifier) @type-binding.type
  declarator: (function_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.return

;; Return type — out-of-class method: User Class::getUser() { ... }
(function_definition
  type: (type_identifier) @type-binding.type
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @type-binding.name))) @type-binding.return

;; Return type — pointer return: User* getUser() { ... }
(function_definition
  type: (type_identifier) @type-binding.type
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @type-binding.name))) @type-binding.return

;; ─── Type bindings — inline method return type ──────────────────────
;; Covers: class Foo { User getUser() { ... } };
(function_definition
  type: (type_identifier) @type-binding.type
  declarator: (function_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.return

;; Inline method pointer return type: class Foo { User* lookup(int) { ... } };
(function_definition
  type: (type_identifier) @type-binding.type
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @type-binding.name))) @type-binding.return

;; ─── Type bindings — method prototype return type in class body ──────
;; Covers: class User { User* lookup(int); std::string getName(); };
;; AST: field_declaration > function_declarator > field_identifier
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (function_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.return

;; Method prototype pointer return type: User* lookup(int id);
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @type-binding.name))) @type-binding.return

;; ─── Type bindings — field type declarations (class members) ────────
;; Covers: class User { Address address; };
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (field_identifier) @type-binding.name) @type-binding.field

;; Field pointer type: Address* address;
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (pointer_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.field

;; Field reference type: Address& address;
(field_declaration
  type: (type_identifier) @type-binding.type
  declarator: (reference_declarator
    (field_identifier) @type-binding.name)) @type-binding.field

;; ─── References — constructor calls (new Foo()) ─────────────────────
(new_expression
  type: (type_identifier) @reference.name) @reference.call.constructor

;; Constructor call with qualified type: new ns::Foo()
(new_expression
  type: (qualified_identifier
    name: (type_identifier) @reference.name)) @reference.call.constructor

;; ─── References — free calls ────────────────────────────────────────
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; ─── References — qualified calls (Namespace func or Class method) ───
;; Capture the LHS of scope-resolution as the explicit receiver so
;; qualified static member calls route through receiver-bound-calls
;; Case 2 (class-name receiver) path. Without the receiver capture,
;; qualified calls have no explicit receiver and class methods cannot
;; resolve through receiver-bound paths.
(call_expression
  function: (qualified_identifier
    scope: (_) @reference.receiver
    name: (identifier) @reference.name)) @reference.call.qualified

;; ─── References — member calls (obj.method() / ptr->method()) ───────
(call_expression
  function: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.call.member

;; ─── References — template calls (func<T>()) ────────────────────────
(call_expression
  function: (template_function
    name: (identifier) @reference.name)) @reference.call.free

;; Note: Ns::func<T>() is parsed as qualified_identifier by tree-sitter-cpp,
;; already captured by the qualified calls pattern above.

;; ─── References — field reads ───────────────────────────────────────
(field_expression
  argument: (_) @reference.receiver
  field: (field_identifier) @reference.name) @reference.read

;; ─── References — field writes (assignment) ─────────────────────────
(assignment_expression
  left: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getCppParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(CPP as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getCppScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(CPP as Parameters<Parser['setLanguage']>[0], CPP_SCOPE_QUERY);
  }
  return _query;
}
