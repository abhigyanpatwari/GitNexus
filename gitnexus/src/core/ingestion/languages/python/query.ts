/**
 * Tree-sitter query for Python scope captures (RFC §5.1).
 *
 * The `.scm` sibling file is the human-readable spec; this module
 * mirrors it at runtime. **Edit both together** — the unit/integration
 * tests reference the embedded constant, and the file documents the
 * contract.
 *
 * Also exposes lazy `Parser` and `Query` singletons so callers don't
 * pay tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

const PYTHON_SCOPE_QUERY = `
;; Scopes
(module) @scope.module
(class_definition) @scope.class
(function_definition) @scope.function

;; Declarations
(class_definition
  name: (identifier) @declaration.name) @declaration.class

(function_definition
  name: (identifier) @declaration.name) @declaration.function

(assignment
  left: (identifier) @declaration.name) @declaration.variable

;; Declarations: for-loop target — Python for-statements do NOT introduce
;; a new scope, so the loop variable binds in the enclosing function/module
;; scope. We emit it as a Variable declaration so Pass-2 attaches it.
(for_statement
  left: (identifier) @declaration.name) @declaration.variable

;; Imports — single anchor per statement; interpretImport decomposes
(import_statement) @import.statement
(import_from_statement) @import.statement

;; Type bindings (parameter annotations)
(typed_parameter
  (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

(typed_default_parameter
  name: (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

;; Type bindings (constructor-inferred: \`u = User(...)\`)
;; Listed BEFORE the annotation pattern so \`u: User = find()\` — which
;; matches BOTH patterns — has the annotation (stronger source) win over
;; the constructor-inferred guess via the scope-extractor's source-
;; strength tie-break in pass4CollectTypeBindings.
(assignment
  left: (identifier) @type-binding.name
  right: (call
    function: (identifier) @type-binding.type)) @type-binding.constructor

;; Qualified constructor (\`u = models.User(...)\`). Captures the
;; attribute node as the type — its \`.text\` is the full dotted path
;; (\`models.User\`), which \`resolveTypeRef\` resolves via
;; \`QualifiedNameIndex\` Phase 2.
(assignment
  left: (identifier) @type-binding.name
  right: (call
    function: (attribute) @type-binding.type)) @type-binding.constructor

;; Walrus operator: \`(u := User(...))\`. Python 3.8+ named expression.
;; Shares the constructor-inferred shape so the binding lands in the
;; enclosing function/module scope's typeBindings the same way a plain
;; assignment would.
(named_expression
  name: (identifier) @type-binding.name
  value: (call
    function: (identifier) @type-binding.type)) @type-binding.constructor

(named_expression
  name: (identifier) @type-binding.name
  value: (call
    function: (attribute) @type-binding.type)) @type-binding.constructor

;; Match-case as-pattern: \`case User() as u:\` → \`u: User\`. The
;; class_pattern's dotted_name carries the type; the outer as_pattern's
;; second child is the binding name.
(as_pattern
  (case_pattern
    (class_pattern
      (dotted_name) @type-binding.type))
  (identifier) @type-binding.name) @type-binding.constructor

;; Assignment chain: \`alias = user\` — the new name inherits the
;; RHS-identifier's type. The pattern emits a TypeRef whose rawName is
;; the RHS identifier's text; the scope-extractor's post-pass follows
;; the chain so \`alias\` ends up pointing at whatever type \`user\` has.
(assignment
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; For-loop iterable of an already-typed variable:
;;   def f(users: list[User]):
;;       for u in users:     # u: users (chained via post-pass)
;;           u.save()
;; The chain post-pass resolves \`users\` → its own type \`User\` via
;; the generic-arg stripping in \`interpret.ts\`.
(for_statement
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; For-loop iterable of a free-call result:
;;   def get_users() -> list[User]: ...
;;   for u in get_users():   # u: get_users → User via chain follow
;;       u.save()
;; Captures the call's function identifier as the rawName. With
;; \`propagateImportedReturnTypes\`, this works cross-file too.
(for_statement
  left: (identifier) @type-binding.name
  right: (call
    function: (identifier) @type-binding.type)) @type-binding.alias

;; for (i, u) in enumerate(X) — paren-tuple, bind last element to X's
;; element type. \`enumerate(X)\` yields (int, X-element); the second
;; pattern var takes X (which the chain-follow then unwraps to its
;; element type via generic-strip in interpret.ts).
(for_statement
  left: (tuple_pattern
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (identifier) @type-binding.type))
  (#eq? @_enum "enumerate")) @type-binding.alias

;; for i, u in enumerate(X) — pattern_list (no parens) variant.
(for_statement
  left: (pattern_list
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (identifier) @type-binding.type))
  (#eq? @_enum "enumerate")) @type-binding.alias

;; for k, v in d.items() — bind v to d. The chain-follow unwraps d's
;; dict[K, V] annotation to V via the dict-aware stripGeneric in
;; interpret.ts. Covers both pattern_list and tuple_pattern shapes.
(for_statement
  left: (pattern_list
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (attribute
      object: (identifier) @type-binding.type
      attribute: (identifier) @_items))
  (#eq? @_items "items")) @type-binding.alias

(for_statement
  left: (tuple_pattern
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (attribute
      object: (identifier) @type-binding.type
      attribute: (identifier) @_items))
  (#eq? @_items "items")) @type-binding.alias

;; for i, (k, v) in enumerate(d.items()) — nested tuple destructuring.
;; Bind v (last id of the nested tuple) to d (the dict).
(for_statement
  left: (pattern_list
    (identifier)
    (tuple_pattern
      (identifier)
      (identifier) @type-binding.name))
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (call
        function: (attribute
          object: (identifier) @type-binding.type
          attribute: (identifier) @_items))))
  (#eq? @_enum "enumerate")
  (#eq? @_items "items")) @type-binding.alias

;; for i, k, v in enumerate(d.items()) — 3-var flat destructuring of
;; the (i, (k,v)) tuple emitted by enumerate over items(). Bind v
;; (last id) to d.
(for_statement
  left: (pattern_list
    (identifier)
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (call
        function: (attribute
          object: (identifier) @type-binding.type
          attribute: (identifier) @_items))))
  (#eq? @_enum "enumerate")
  (#eq? @_items "items")) @type-binding.alias

;; for u in self.X — heuristic: bind u to X (the attribute name).
;; The chain-follow then resolves X via the enclosing method's
;; parameter typeBinding, supporting fixtures that reference
;; \`self.X\` as a stand-in for a parameter X (matches legacy DAG
;; behavior).
(for_statement
  left: (identifier) @type-binding.name
  right: (attribute
    object: (identifier) @_self
    attribute: (identifier) @type-binding.type)
  (#eq? @_self "self")) @type-binding.alias

;; for v in d.values() — bind v to d (dict-strip yields value type).
(for_statement
  left: (identifier) @type-binding.name
  right: (call
    function: (attribute
      object: (identifier) @type-binding.type
      attribute: (identifier) @_values))
  (#eq? @_values "values")) @type-binding.alias

;; Type bindings (variable annotations: \`u: User\` / \`u: User = x\`)
(assignment
  left: (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.annotation

;; Return-type annotation: \`def get_user() -> User:\` binds the
;; FUNCTION'S NAME to its return type in the enclosing scope. Combined
;; with the constructor-inferred + chain-follow path, \`u = get_user()\`
;; then resolves \`u: User\` cross-call. The Python provider hoists the
;; binding via \`pythonBindingScopeFor\` to the function's parent scope
;; so callers in module/class scope see it.
(function_definition
  name: (identifier) @type-binding.name
  return_type: (type) @type-binding.type) @type-binding.return

;; References — calls
(call
  function: (identifier) @reference.name) @reference.call.free

(call
  function: (attribute
    object: (_) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.call.member

;; References — attribute writes: \`obj.name = "x"\` emits a write
;; ACCESSES edge from the enclosing function to the field on obj's
;; class. The receiver-bound emit pass resolves obj → its class and
;; \`name\` → the field def via the existing typeref-receiver path.
(assignment
  left: (attribute
    object: (_) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.write.member
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getPythonParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Python as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getPythonScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Python as Parameters<Parser['setLanguage']>[0], PYTHON_SCOPE_QUERY);
  }
  return _query;
}
