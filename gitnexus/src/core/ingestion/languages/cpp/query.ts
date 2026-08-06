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

(class_specifier
  name: (template_type
    (type_identifier) @declaration.name
    (template_argument_list) @declaration.template-arguments)
  body: (field_declaration_list)) @declaration.class

(struct_specifier
  name: (type_identifier) @declaration.name
  body: (field_declaration_list)) @declaration.struct

(struct_specifier
  name: (template_type
    (type_identifier) @declaration.name
    (template_argument_list) @declaration.template-arguments)
  body: (field_declaration_list)) @declaration.struct

;; Declarations — struct (typedef struct { ... } Name)
(type_definition
  type: (struct_specifier
    body: (field_declaration_list))
  declarator: (type_identifier) @declaration.name) @declaration.struct

;; ─── Declarations — class / struct inside template_declaration ───────
(template_declaration
  (class_specifier
    name: (type_identifier) @declaration.name
    body: (field_declaration_list)) @declaration.class)

(template_declaration
  (class_specifier
    name: (template_type
      (type_identifier) @declaration.name
      (template_argument_list) @declaration.template-arguments)
    body: (field_declaration_list)) @declaration.class)

(template_declaration
  (struct_specifier
    name: (type_identifier) @declaration.name
    body: (field_declaration_list)) @declaration.struct)

(template_declaration
  (struct_specifier
    name: (template_type
      (type_identifier) @declaration.name
      (template_argument_list) @declaration.template-arguments)
    body: (field_declaration_list)) @declaration.struct)

;; ─── Declarations — enum ─────────────────────────────────────────────
(enum_specifier
  name: (type_identifier) @declaration.name) @declaration.enum

;; ─── Declarations — enum (typedef enum { ... } Name) ─────────────────
(type_definition
  type: (enum_specifier
    body: (enumerator_list))
  declarator: (type_identifier) @declaration.name) @declaration.enum

;; ─── Declarations — enum constants ───────────────────────────────────
(enumerator
  name: (identifier) @declaration.name) @declaration.const

;; ─── Declarations — function definition (plain identifier) ──────────
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; Lambda bindings (\`auto f = [](int x){ … };\`). The \`@declaration.function\`
;; anchor sits on the INNER lambda_expression so its range aligns with
;; \`(lambda_expression) @scope.function\` above; otherwise the def is owned by
;; the enclosing scope and calls inside the lambda lose caller attribution.
;; Mirrors the TypeScript arrow patterns (#2687).
(declaration
  declarator: (init_declarator
    declarator: (identifier) @declaration.name
    value: (lambda_expression) @declaration.function))

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

;; Out-of-class operator method: Point::operator+(...)
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (operator_name) @declaration.name))) @declaration.method

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

;; Inline operator method in class body: Point operator+(Point) const { ... }
(function_definition
  declarator: (function_declarator
    declarator: (operator_name) @declaration.name)) @declaration.method

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

;; Inline operator method with reference return: Point& operator+=(Point) { ... }
(field_declaration_list
  (function_definition
    declarator: (reference_declarator
      (function_declarator
        declarator: (operator_name) @declaration.name))) @declaration.method)

;; Free operator definition with reference return: std::ostream& operator<<(...) { ... }
(translation_unit
  (function_definition
    declarator: (reference_declarator
      (function_declarator
        declarator: (operator_name) @declaration.name))) @declaration.function)

(namespace_definition
  body: (declaration_list
    (function_definition
      declarator: (reference_declarator
        (function_declarator
          declarator: (operator_name) @declaration.name))) @declaration.function))

;; ─── Declarations — function prototype (forward declaration) ────────
(declaration
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; tree-sitter-cpp 0.23 represents a deleted free function as an
;; init_declarator whose value is a delete_expression.
(declaration
  declarator: (init_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name)
    value: (delete_expression))) @declaration.function

;; Deleted free operator declaration.
(declaration
  declarator: (init_declarator
    declarator: (function_declarator
      declarator: (operator_name) @declaration.name)
    value: (delete_expression))) @declaration.function

;; Deleted free function with a pointer return type.
(declaration
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: (identifier) @declaration.name))
    value: (delete_expression))) @declaration.function

;; Free operator prototype: std::ostream& operator<<(std::ostream&, T)
(declaration
  declarator: (function_declarator
    declarator: (operator_name) @declaration.name)) @declaration.function

;; ─── Declarations — function prototype with pointer return ──────────
(declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; Free operator prototype with reference return.
(declaration
  declarator: (reference_declarator
    (function_declarator
      declarator: (operator_name) @declaration.name))) @declaration.function

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

;; Operator method prototype in class body: Point operator+(Point) const;
(field_declaration
  declarator: (function_declarator
    declarator: (operator_name) @declaration.name)) @declaration.method

;; Method prototype with pointer return: User* lookup(int id);
(field_declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

;; Constructor prototype in class body: User(int id);
(field_declaration_list
  (declaration
    declarator: (function_declarator
      declarator: (identifier) @declaration.name)) @declaration.method)

;; Method prototype with reference return: User& getRef();
(field_declaration
  declarator: (reference_declarator
    (function_declarator
      declarator: (field_identifier) @declaration.name))) @declaration.method

(field_declaration
  declarator: (reference_declarator
    (function_declarator
      declarator: (operator_name) @declaration.name))) @declaration.method

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

;; ─── Declarations — variables (without initializer) ─────────────────
;; Covers non-leading declarators in mixed declaration lists.
(declaration
  declarator: (identifier) @declaration.name) @declaration.variable

(declaration
  declarator: (pointer_declarator
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

;; Covers: List<User> users;
(declaration
  type: (template_type) @type-binding.type
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

;; Generic field type: Repo<User> repo; (#2833)
;; The three rules above all require type: (type_identifier), so a member whose
;; type carries template arguments is a template_type and matched NONE of them —
;; the field got no type binding at all, and every call through it lost its edge
;; in BOTH spellings (repo.save() and this->repo.save()), while the same type in
;; a LOCAL resolved fine because the local declaration rules gained their
;; template_type variant long ago (see "Covers: List<User> users;" above).
;; These three mirror the three above, one per declarator shape. Written as
;; separate patterns rather than one alternation: a node-type alternation in a
;; field position is the tree-sitter 0.21 hazard this repo has been bitten by
;; before.
(field_declaration
  type: (template_type) @type-binding.type
  declarator: (field_identifier) @type-binding.name) @type-binding.field

;; Generic field, pointer: Repo<User>* repo;
(field_declaration
  type: (template_type) @type-binding.type
  declarator: (pointer_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.field

;; Generic field, reference: Repo<User>& repo;
(field_declaration
  type: (template_type) @type-binding.type
  declarator: (reference_declarator
    (field_identifier) @type-binding.name)) @type-binding.field

;; ─── Generic field type, QUALIFIED: std::vector<Item> items; (#2833) ─
;; The six rules above require the type node to BE a template_type, but the
;; commonest real-world spelling of a generic member is qualified, and
;; tree-sitter-cpp parses std::vector<Item> as a qualified_identifier WRAPPING
;; the template_type. So std::vector<Item>, ns::Repo<User> and
;; std::unique_ptr<Repo> matched none of them and still bound nothing.
;;
;; WHICH NODE IS CAPTURED IS THE WHOLE DESIGN, and it was measured rather than
;; assumed. @type-binding.type is put on the INNER template_type, so the binding
;; records Repo<User> and the qualifier is dropped. Capturing the outer
;; qualified_identifier instead would record ns::Repo<User>, which resolves to
;; NOTHING: findClassBindingInScope's dotted-tail fallback splits on "." and C++
;; writes "::", and resolveClassBindingForName's generic branch then looks up the
;; base ns::Repo, which is not a key either because C++ emits no
;; @declaration.qualified_name and indexes ns::Repo under Repo. Dropping the
;; qualifier lands on exactly the path the BARE spelling already takes — one
;; class-like match or decline — so a qualified generic field now behaves like
;; the bare one instead of like nothing.
;;
;; Two qualifier depths, because a::b::Repo<User> nests one qualified_identifier
;; inside another and a query cannot match a node at arbitrary depth. Depth 3+
;; (a::b::c::Repo<User>) is still uncaptured; it is vanishingly rare and adding
;; a level costs three more patterns.
;;
;; Separate patterns rather than one alternation, same as above: a node-type
;; alternation in a field position is the tree-sitter 0.21 hazard this repo has
;; been bitten by before. And, like the six above, each requires the declarator
;; to reach the field_identifier DIRECTLY, so a method whose return type is a
;; qualified generic (std::vector<Item> method();) still captures no field — a
;; function_declarator sits in between and none of these match it.
(field_declaration
  type: (qualified_identifier
    name: (template_type) @type-binding.type)
  declarator: (field_identifier) @type-binding.name) @type-binding.field

;; Qualified generic field, pointer: std::unique_ptr<Repo>* repo;
(field_declaration
  type: (qualified_identifier
    name: (template_type) @type-binding.type)
  declarator: (pointer_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.field

;; Qualified generic field, reference: std::vector<Item>& items;
(field_declaration
  type: (qualified_identifier
    name: (template_type) @type-binding.type)
  declarator: (reference_declarator
    (field_identifier) @type-binding.name)) @type-binding.field

;; Twice-qualified generic field: a::b::Repo<User> repo;
(field_declaration
  type: (qualified_identifier
    name: (qualified_identifier
      name: (template_type) @type-binding.type))
  declarator: (field_identifier) @type-binding.name) @type-binding.field

;; Twice-qualified generic field, pointer: std::pmr::vector<Item>* items;
(field_declaration
  type: (qualified_identifier
    name: (qualified_identifier
      name: (template_type) @type-binding.type))
  declarator: (pointer_declarator
    declarator: (field_identifier) @type-binding.name)) @type-binding.field

;; Twice-qualified generic field, reference: a::b::Repo<User>& repo;
(field_declaration
  type: (qualified_identifier
    name: (qualified_identifier
      name: (template_type) @type-binding.type))
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

;; Nested qualified receiver: outer::v1::Base<T>::f()
;; tree-sitter-cpp nests this as qualified_identifier(name:
;; qualified_identifier(scope: qualified_identifier(...), name: identifier)).
;; Capturing the innermost receiver still gives isSuperReceiverInContext
;; enough text to strip qualifiers/template args down to Base.
(call_expression
  function: (qualified_identifier
    name: (qualified_identifier
      scope: (_) @reference.receiver
      name: (identifier) @reference.name))) @reference.call.qualified

;; Double-nested qualified receiver: outer::v1::Base<T>::f()
(call_expression
  function: (qualified_identifier
    name: (qualified_identifier
      name: (qualified_identifier
        scope: (_) @reference.receiver
        name: (identifier) @reference.name)))) @reference.call.qualified

;; ─── References — member calls (obj.method() / ptr->method()) ───────
(call_expression
  function: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.call.member

;; Conservative operator-call support (#1636): model a + b as a
;; member-style operator+ lookup, and lhs << rhs as a free
;; operator<< lookup. Free operator+(T,T), member operator<<, and
;; complex operand expressions remain false negatives for now.
;; Built-in operators remain unresolved because no user-defined
;; operator target exists.
(binary_expression
  left: (_) @reference.receiver
  operator: "+" @reference.operator
  right: (_)) @reference.call.member

(binary_expression
  left: (_)
  operator: "<<" @reference.operator
  right: (_)) @reference.call.free

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
