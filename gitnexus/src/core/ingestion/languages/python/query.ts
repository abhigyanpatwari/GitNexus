/**
 * Tree-sitter query for Python scope captures (RFC §5.1).
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't
 * pay tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

export const PYTHON_SCOPE_QUERY = `
;; Scopes
(module) @scope.module
(class_definition) @scope.class
(function_definition) @scope.function
(lambda) @scope.function

;; Declarations
(class_definition
  name: (identifier) @declaration.name) @declaration.class

(function_definition
  name: (identifier) @declaration.name) @declaration.function

;; Lambda bindings (\`f = lambda x: x\`). The \`@declaration.function\` anchor
;; sits on the INNER lambda so its range aligns with \`(lambda) @scope.function\`
;; above; otherwise the def is owned by the module scope and calls inside the
;; lambda lose caller attribution. Mirrors the TypeScript arrow patterns (#2687).
(expression_statement
  (assignment
    left: (identifier) @declaration.name
    right: (lambda) @declaration.function))

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

;; A nullable alternative preserves the non-None arm's inferred type. Keep
;; these patterns limited to a literal None arm: two value-producing arms do
;; not establish one receiver type.
(assignment
  left: (identifier) @type-binding.name @call-result-assignment.lhs
  right: (conditional_expression
    (call function: (identifier) @type-binding.type) @call-result-assignment.call
    (_)
    (none))) @type-binding.constructor

(assignment
  left: (identifier) @type-binding.name @call-result-assignment.lhs
  right: (conditional_expression
    (none)
    (_)
    (call function: (identifier) @type-binding.type) @call-result-assignment.call)) @type-binding.constructor

(assignment
  left: (identifier) @type-binding.name @call-result-assignment.lhs
  right: (boolean_operator
    left: (call function: (identifier) @type-binding.type) @call-result-assignment.call
    operator: "or"
    right: (none))) @type-binding.constructor

;; \`None or call()\` always evaluates to the call.
(assignment
  left: (identifier) @type-binding.name @call-result-assignment.lhs
  right: (boolean_operator
    left: (none)
    operator: "or"
    right: (call function: (identifier) @type-binding.type) @call-result-assignment.call)) @type-binding.constructor

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

;; Decorators — simple @decorator
(decorator
  (identifier) @reference.name) @reference.call.free

;; Decorators — @obj.decorator (single attribute, identifier receiver)
(decorator
  (attribute
    object: (identifier) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.call.member

;; Decorators — @a.b.decorator (nested attributes)
(decorator
  (attribute
    object: (attribute) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.call.member

;; References — calls
(call
  function: (identifier) @reference.name) @reference.call.free

;; A match stays open from its first node to its last, and tree-sitter
;; revisits every open match at every node it enters or leaves. A pattern
;; rooted at a node whose LATER child it needs is therefore open across the
;; earlier children: one open match per level of \`a.f().g()\`, \`a.b.c\` or
;; \`a + b + c\`, and a query quadratic in the depth of the chain. The patterns
;; below are anchored at the node they END on instead. A \`(_ child)\` pattern
;; starts at the child (tree-sitter skips a wildcard root and hands back the
;; parent), so it finishes at the same node, in the same order, as the
;; parent-rooted pattern it replaces. expandPythonScopeMatches() checks what
;; the wildcard could not and yields the captures of the replaced patterns.

;; Member call, first half: remember which call an attribute is the callee of.
;; Ends at the callee, before its receiver is walked.
(call
  function: (attribute) @_member-callee) @_member-call

;; Attribute reads and targets, and the second half of a member call. Yields
;; @reference.call.member (callee only) then @reference.read.member, each with
;; @reference.receiver and @reference.name. The provider classifies the AST
;; context, including annotation-only targets and augmented assignments.
(_
  attribute: (identifier) @reference.name) @_attribute

(binary_operator
  left: (identifier) @reference.name @reference.read.identifier)

;; The right operand of a binary_operator or boolean_operator.
(_
  right: (identifier) @reference.name @reference.read.identifier) @_right-operand-of

(comparison_operator
  (identifier) @reference.name @reference.read.identifier)

(boolean_operator
  left: (identifier) @reference.name @reference.read.identifier)

(return_statement
  (identifier) @reference.name @reference.read.identifier)

(assignment
  right: (identifier) @reference.name @reference.read.identifier)

(default_parameter
  value: (identifier) @reference.name @reference.read.identifier)

(typed_default_parameter
  value: (identifier) @reference.name @reference.read.identifier)

;; Anchor arguments under a call: class base lists use argument_list too.
;; Only a call has an \`arguments\` field, so \`(_ arguments: ...)\` is
;; \`(call arguments: ...)\` started at the argument list instead of the call:
;; it is not open while the callee (the rest of a call chain) is walked.
(_
  arguments: (argument_list
    (identifier) @reference.name @reference.read.identifier))

(_
  arguments: (argument_list
    (keyword_argument
      value: (identifier) @reference.name @reference.read.identifier)))

(_
  arguments: (argument_list
    (identifier) @reference.name @reference.value-ref))

(_
  arguments: (argument_list
    (keyword_argument
      value: (identifier) @reference.name @reference.value-ref)))
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

/**
 * Deepest node a scope-query match may start at. tree-sitter's query cursor
 * keeps that depth in 16 bits: a match started deeper gets a wrapped depth,
 * never finishes, is revisited at every later node, and can then match an
 * unrelated node at the wrapped depth. With this limit the cursor starts no
 * match below it and does not walk below it for nothing, so a deeper tree
 * loses the matches under the limit and nothing else.
 *
 * The 16-bit field is `uint16_t start_depth` in tree-sitter's QueryState
 * (query.c). node-tree-sitter applies cursor options on every call
 * (ts_query_cursor_set_max_start_depth in query.cc), so this limit is not
 * carried over to other queries.
 */
export const PYTHON_QUERY_MAX_START_DEPTH = 0xffff;

export function getPythonScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(Python as Parameters<Parser['setLanguage']>[0], PYTHON_SCOPE_QUERY);
  }
  return _query;
}

/**
 * The raw matches of the scope query under `root`: see expandPythonScopeMatches().
 * Its name must not end in `ScopeQuery`: the grammar-literal gate calls every
 * such export with no arguments to compile the query.
 */
export function pythonScopeQueryMatches(root: Parser.SyntaxNode): Parser.QueryMatch[] {
  return getPythonScopeQuery().matches(root, { maxStartDepth: PYTHON_QUERY_MAX_START_DEPTH });
}

const RIGHT_OPERAND_PARENTS: ReadonlySet<string> = new Set(['binary_operator', 'boolean_operator']);

/**
 * The captures of each scope-query match, in match order, with the end-anchored
 * patterns (see PYTHON_SCOPE_QUERY) turned back into the matches of the
 * parent-rooted patterns they replace:
 *
 *   (call function: (attribute object: (_) @reference.receiver
 *     attribute: (identifier) @reference.name)) @reference.call.member
 *   (attribute object: (_) @reference.receiver
 *     attribute: (identifier) @reference.name) @reference.read.member
 *   (binary_operator (identifier) @reference.name @reference.read.identifier)
 *   (boolean_operator (identifier) @reference.name @reference.read.identifier)
 *
 * Every other match passes through untouched.
 */
export function* expandPythonScopeMatches(
  matches: readonly Parser.QueryMatch[],
): Generator<readonly Parser.QueryCapture[]> {
  /** Callee `attribute` node id -> its call. Set when the query enters the
   * callee, read when it reaches the callee's name: always later. */
  const callByCallee = new Map<number, Parser.SyntaxNode>();
  for (const { captures } of matches) {
    const anchor = captures[0];
    switch (anchor?.name) {
      case '_member-call':
        callByCallee.set(captures[1].node.id, anchor.node);
        break;
      case '_attribute': {
        const attribute = anchor.node;
        // `object: (_)`: a named node that is not an ERROR.
        const receiver = attribute.childForFieldName('object');
        if (
          attribute.type !== 'attribute' ||
          receiver === null ||
          !receiver.isNamed ||
          receiver.isError
        ) {
          break;
        }
        const receiverCapture = { name: 'reference.receiver', node: receiver };
        const call = callByCallee.get(attribute.id);
        if (call !== undefined) {
          callByCallee.delete(attribute.id);
          yield [{ name: 'reference.call.member', node: call }, receiverCapture, captures[1]];
        }
        yield [{ name: 'reference.read.member', node: attribute }, receiverCapture, captures[1]];
        break;
      }
      case '_right-operand-of':
        if (RIGHT_OPERAND_PARENTS.has(anchor.node.type)) yield captures.slice(1);
        break;
      default:
        yield captures;
    }
  }
}
