/**
 * Tree-sitter query for JavaScript scope captures (RFC §5.1, Ring 3).
 *
 * Subset of the TypeScript scope query (`languages/typescript/query.ts`)
 * compiled against `tree-sitter-javascript`. TypeScript-only node types
 * (`interface_declaration`, `type_alias_declaration`, `enum_declaration`,
 * `internal_module`, `abstract_class_declaration`, `function_signature`,
 * `method_signature`, `abstract_method_signature`, `type_annotation`,
 * `public_field_definition`) are dropped because:
 *
 *   1. The JS grammar doesn't define them — the query compiler would
 *      throw `InvalidNodeType` if they were included.
 *   2. JavaScript has no static type annotations, so the `@type-binding.*`
 *      patterns derived from TS annotation nodes don't apply.
 *
 * What IS shared with the TypeScript query:
 *
 *   - Scope patterns: `program`, `class_declaration`, `(class)` (the JS
 *     grammar node for class expressions — NOT `class_expression`, which
 *     does not exist in `tree-sitter-javascript`), `function_declaration`,
 *     `generator_function_declaration`, `function_expression`,
 *     `arrow_function`, `method_definition`.
 *   - Declaration patterns for functions, classes, const/let/var,
 *     object-property arrows (Zustand, TanStack, etc.), and HOC-wrapped
 *     variable declarations (forwardRef / memo / useCallback / useMemo).
 *   - Import patterns: `import_statement`, `export_statement` re-exports,
 *     and dynamic `import()` (represented as `call_expression(import)` in
 *     both grammars — the `import` leaf node exists in tree-sitter-javascript
 *     as well as tree-sitter-typescript).
 *   - Type-binding patterns that work without static annotations:
 *     constructor inference (`new User()`), call-result alias
 *     (`const u = getUser()`), member-access alias (`const a = u.addr`),
 *     identifier alias, assignment rebind, and for-of element bindings.
 *     JSDoc-derived type bindings (`@param {User} u`, `@returns {User}`)
 *     are handled separately in `captures.ts` via comment-node scanning.
 *   - Reference patterns: free calls, member calls, constructor calls,
 *     write-access, read-access, and dynamic import.
 *
 * CJS `require()` is NOT captured here; it is handled in `captures.ts`
 * by scanning parent context (destructured vs. namespace) of `call_expression`
 * nodes whose callee is the identifier `require`.
 *
 * Grammar version: `tree-sitter-javascript` pinned in gitnexus/package.json.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import JS from 'tree-sitter-javascript';
import {
  ARRAY_METHOD_NOT_ANY_OF_PREDICATE,
  DEFAULT_EXPORT_IDENTIFIER_NOT_ANY_OF_PREDICATE,
} from '../../ts-js-hoc-utils.js';

const JS_GRAMMAR = JS as Parameters<Parser['setLanguage']>[0];

/** True when the file should be parsed with the JSX-extended query. */
function isJsxFile(filePath: string): boolean {
  return filePath.endsWith('.jsx');
}

const JAVASCRIPT_SCOPE_QUERY = `
;; Scopes — module / class-likes / function-likes
(program) @scope.module

(class_declaration) @scope.class
(class) @scope.class

(function_declaration) @scope.function
(generator_function_declaration) @scope.function
(function_expression) @scope.function
(arrow_function) @scope.function
(method_definition) @scope.function

;; Declarations — classes
(class_declaration
  name: (identifier) @declaration.name) @declaration.class

;; Declarations — methods (inside class bodies)
(method_definition
  name: (property_identifier) @declaration.name) @declaration.method

;; Declarations — class fields (JS uses field_definition, not public_field_definition)
(field_definition
  property: (property_identifier) @declaration.name) @declaration.property

;; Declarations — free functions
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

(generator_function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Arrow / function-expression assigned to a const/let/var.
;; Anchor discipline: @declaration.function sits on the INNER arrow or
;; function_expression, NOT on the lexical_declaration wrapper. This
;; aligns anchor.range with the @scope.function range so
;; pass2AttachDeclarations resolves the innermost scope correctly and
;; resolveCallerGraphId walks up to the right caller anchor.
(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (arrow_function) @declaration.function))

(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (function_expression) @declaration.function))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (arrow_function) @declaration.function)))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (function_expression) @declaration.function)))

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (arrow_function) @declaration.function))

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (function_expression) @declaration.function))

;; Object-property arrows / function expressions named by their pair key.
;; Same anchor discipline as the lexical_declaration block above: the
;; @declaration.function capture must sit on the INNER arrow/fn-expression.
(pair
  key: (property_identifier) @declaration.name
  value: (arrow_function) @declaration.function)

(pair
  key: (property_identifier) @declaration.name
  value: (function_expression) @declaration.function)

(pair
  key: (string (string_fragment) @declaration.name)
  value: (arrow_function) @declaration.function)

(pair
  key: (string (string_fragment) @declaration.name)
  value: (function_expression) @declaration.function)

;; HOC-wrapped variable declarations: const X = HOC((args) => { ... }).
;; Covers React.forwardRef, memo, useCallback, useMemo, observer,
;; debounce, and any user-defined HOC factory.
;;
;; #1876: this shape also matches array higher-order-method callbacks
;; (const x = arr.map(a => ...)), where x is a value, not a function.
;; Those are filtered out emit-side in captures.ts via
;; isArrayMethodCallbackArrow (member-expression callee whose property
;; is a known Array method), so only the @declaration.const survives.
;; Excludes common array methods (map, filter, reduce, etc.) to avoid
;; false positives like \`const x = arr.map(a => ...)\`.
(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function) @declaration.function))))

(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression) @declaration.function))))

(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (arrow_function) @declaration.function)))))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (call_expression
        function: (identifier)
        arguments: (arguments
          (function_expression) @declaration.function)))))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (arrow_function) @declaration.function))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name
      value: (call_expression
        function: (member_expression
          property: (property_identifier) @callee)
        arguments: (arguments
          (function_expression) @declaration.function))))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (arrow_function) @declaration.function))))

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (identifier)
      arguments: (arguments
        (function_expression) @declaration.function))))

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (arrow_function) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (call_expression
      function: (member_expression
        property: (property_identifier) @callee)
      arguments: (arguments
        (function_expression) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

;; HOC-wrapped default exports (JS parity with TS patterns in
;; languages/typescript/query.ts). The emit phase rewrites
;; @declaration.name to a file-derived name so wrapper helpers do not
;; become the graph-visible symbol name.
((export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (arrow_function) @declaration.function)))
  ${DEFAULT_EXPORT_IDENTIFIER_NOT_ANY_OF_PREDICATE})

((export_statement
  value: (call_expression
    function: (identifier) @hoc
    arguments: (arguments
      (function_expression) @declaration.function)))
  ${DEFAULT_EXPORT_IDENTIFIER_NOT_ANY_OF_PREDICATE})

((export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (arrow_function) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

((export_statement
  value: (call_expression
    function: (member_expression
      property: (property_identifier) @callee)
    arguments: (arguments
      (function_expression) @declaration.function)))
  ${ARRAY_METHOD_NOT_ANY_OF_PREDICATE})

;; Variable / constant declarations (non-function values).
(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name)) @declaration.const

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @declaration.name))) @declaration.const

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name)) @declaration.variable

;; Imports (ESM) — single anchor per statement; decomposer emits per-specifier markers.
(import_statement) @import.statement

;; Re-exports with a source clause.
(export_statement
  source: (string)) @import.statement

;; Dynamic imports: import('./m') — tree-sitter-javascript represents this
;; as call_expression with a named import leaf as the function field,
;; identical to tree-sitter-typescript.
(call_expression
  function: (import)) @import.dynamic

;; ── Type bindings (no static annotations in JS; inferred from AST shape) ──

;; Constructor-inferred: const u = new User()
(variable_declarator
  name: (identifier) @type-binding.name
  value: (new_expression
    constructor: (identifier) @type-binding.type)) @type-binding.constructor

;; Qualified constructor: const u = new models.User()
(variable_declarator
  name: (identifier) @type-binding.name
  value: (new_expression
    constructor: (member_expression) @type-binding.type)) @type-binding.constructor

;; Call-result alias: const u = getUser()
(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

;; Member-call alias: const u = svc.getUser()
(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (member_expression) @type-binding.type)) @type-binding.alias

;; Await chain: const u = await getUser() / await svc.getUser()
(variable_declarator
  name: (identifier) @type-binding.name
  value: (await_expression
    (call_expression
      function: (identifier) @type-binding.type))) @type-binding.alias

(variable_declarator
  name: (identifier) @type-binding.name
  value: (await_expression
    (call_expression
      function: (member_expression) @type-binding.type))) @type-binding.alias

;; Member-access alias: const addr = user.address
(variable_declarator
  name: (identifier) @type-binding.name
  value: (member_expression) @type-binding.type) @type-binding.member-alias

;; Identifier alias: const alias = user
(variable_declarator
  name: (identifier) @type-binding.name
  value: (identifier) @type-binding.type) @type-binding.alias

;; Assignment rebind: u = new User() / u = getUser()
(assignment_expression
  left: (identifier) @type-binding.name
  right: (new_expression
    constructor: (identifier) @type-binding.type)) @type-binding.constructor

(assignment_expression
  left: (identifier) @type-binding.name
  right: (call_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

(assignment_expression
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; For-of element: for (const u of users) / for (const u of getUsers())
(for_in_statement
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

(for_in_statement
  left: (identifier) @type-binding.name
  right: (call_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

(for_in_statement
  left: (identifier) @type-binding.name
  right: (call_expression
    function: (member_expression) @type-binding.type)) @type-binding.alias

(for_in_statement
  left: (identifier) @type-binding.name
  right: (member_expression
    property: (property_identifier) @type-binding.type)) @type-binding.alias

;; ── References ────────────────────────────────────────────────────────────

;; Free calls: fn(args). The dynamic-import filter runs in captures.ts.
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; Awaited free call: await fn<T>(...) re-associated by tree-sitter.
(call_expression
  function: (await_expression
    (identifier) @reference.name)) @reference.call.free

;; Member calls: obj.method() (includes optional chain).
(call_expression
  function: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.call.member

;; Awaited member call: await svc.m<T>(...)
(call_expression
  function: (await_expression
    (member_expression
      object: (_) @reference.receiver
      property: (property_identifier) @reference.name))) @reference.call.member

;; Constructor calls: new User() / new ns.User()
(new_expression
  constructor: (identifier) @reference.name) @reference.call.constructor

(new_expression
  constructor: (member_expression
    property: (property_identifier) @reference.name) @reference.call.constructor.qualified) @reference.call.constructor

;; Write access: obj.field = value
(assignment_expression
  left: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.write.member

(augmented_assignment_expression
  left: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.write.member

;; Read access: obj.field (in read context; captures.ts filters non-reads).
(member_expression
  object: (_) @reference.receiver
  property: (property_identifier) @reference.name) @reference.read.member
`;

/** JSX-only suffix — appended when compiling against the JSX grammar for .jsx files. */
const JSX_QUERY_SUFFIX = `
;; <Foo />
((jsx_self_closing_element
  name: (identifier) @reference.name) @reference.call.free
  (#match? @reference.name "^[A-Z]"))

;; <Foo> ... </Foo>
((jsx_opening_element
  name: (identifier) @reference.name) @reference.call.free
  (#match? @reference.name "^[A-Z]"))

;; <Foo.Bar />
(jsx_self_closing_element
  name: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.call.member

(jsx_opening_element
  name: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.call.member
`;

let _jsParser: Parser | null = null;
let _jsQuery: Parser.Query | null = null;
let _jsxParser: Parser | null = null;
let _jsxQuery: Parser.Query | null = null;

export function getJsParser(filePath?: string): Parser {
  // JSX files use the same JavaScript grammar in tree-sitter-javascript;
  // both .js and .jsx parse with the same grammar object. We keep separate
  // singletons only to mirror the TypeScript pattern and in case a future
  // version of the grammar diverges.
  if (filePath !== undefined && isJsxFile(filePath)) {
    if (_jsxParser === null) {
      _jsxParser = new Parser();
      _jsxParser.setLanguage(JS_GRAMMAR);
    }
    return _jsxParser;
  }
  if (_jsParser === null) {
    _jsParser = new Parser();
    _jsParser.setLanguage(JS_GRAMMAR);
  }
  return _jsParser;
}

export function getJsScopeQuery(filePath?: string): Parser.Query {
  if (filePath !== undefined && isJsxFile(filePath)) {
    if (_jsxQuery === null) {
      _jsxQuery = new Parser.Query(JS_GRAMMAR, JAVASCRIPT_SCOPE_QUERY + JSX_QUERY_SUFFIX);
    }
    return _jsxQuery;
  }
  if (_jsQuery === null) {
    _jsQuery = new Parser.Query(JS_GRAMMAR, JAVASCRIPT_SCOPE_QUERY);
  }
  return _jsQuery;
}

/** Validate that a cached Tree was produced by the JS grammar. */
export function jsCachedTreeMatchesGrammar(tree: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lang = (tree as any)?.getLanguage?.();
  if (lang === undefined || lang === null) return true;
  return lang === JS_GRAMMAR;
}
