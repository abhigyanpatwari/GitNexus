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

; Type aliases (A4). TypeScript was the only language whose aliases minted no
; node: Rust (type_item), Kotlin (type_alias), Swift (typealias_declaration)
; and Dart all emit @definition.type. The alias was declared for scope
; resolution but never became a graph symbol, so a context() lookup on an
; exported API-contract type answered "Symbol not found".
(type_alias_declaration
  name: (type_identifier) @name) @definition.type

; Members of a declared SHAPE — interface bodies and object-type aliases both
; spell them as property_signature, so one pattern covers both. A TS frontend
; models its API contracts this way, and without these there is no graph path
; from a contract field to the code that reads it.
; ANCHORED to declared shapes. Unanchored, property_signature matches every
; object_type in the grammar — an inline parameter type, an inline return
; type, a nested object type — and the enclosing-container walk then hangs the
; node off the nearest class/interface/alias. class Svc { retries = 1;
; run(opts: { retries: number }) {} } minted Property:a.ts:Svc.retries twice,
; and graph.addNode is first-write-wins, so two distinct symbols merged into
; one and every context()/impact()/rename() answer about that field described
; the merge. It also emitted the outright false Svc HAS_PROPERTY retries for a
; field belonging to an anonymous parameter type.
;
; The sibling JS object-literal rule in this same PR is anchored for exactly
; this reason; this is the TypeScript half of the same fix.
;
; (A (B)) matches DIRECT children, so a nested object type
; (type Config = { host: string; db: { host: string } }) is excluded here as
; well — its members are not direct children of the alias's own object_type.
(interface_body
  (property_signature
    name: (property_identifier) @name) @definition.property)

(type_alias_declaration
  value: (object_type
    (property_signature
      name: (property_identifier) @name) @definition.property))

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

; Generator EXPRESSIONS bound to a name (\`const g = function* () {}\`). Without
; these, the binding emitted a \`Const\` node rather than a \`Function\` one, so
; \`g()\` resolved to nothing: \`buildGraphTargetIndex\` only admits a callable
; node. Same construct and same binding semantics as the \`function_expression\`
; rules directly above, so same label. Covers the four variable-binding shapes
; (const/let and var, each plain and exported); a generator in an object-literal
; pair or a HOC wrapper is NOT covered and still falls through anonymous.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (generator_function))) @definition.function

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

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (generator_function)))) @definition.function

; \`var\` closure bindings (#2693). The lexical rules above cover const/let;
; \`var\` is a different grammar node, so \`var f = (x) => x\` kept a Variable
; label while const/let got Function — and the CALLS edge that resolved through
; the declaration route therefore pointed at a NON-callable node. Same construct,
; same binding semantics for this purpose, so same label.
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (generator_function))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (generator_function)))) @definition.function

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

; Object-literal keys of a NAMED object, and the same shape behind an
; identity-preserving wrapper. Both rules existed only in JAVASCRIPT_QUERIES, so
; a .ts file writing the single most common config idiom in the language —
; const CONFIG = { retries: 3 } — minted no node for any key: context() answered
; "Symbol not found" and a precise read through the holding variable had nothing
; to resolve to.
;
; TypeScript sets fieldFallbackOnMethodLookup:false, so these do NOT gain
; name-based inference; they gain the PRECISE path, which is the one TypeScript
; is supposed to use. A read through an untyped receiver stays unresolved, and
; is now reported as such rather than answering an empty set.
;
; Scoped exactly as the JavaScript rules are: bound to a variable, and for the
; wrapper only the three functions that return the argument they were given.
(variable_declarator
  name: (identifier)
  value: (object
    (pair
      key: (property_identifier) @name) @definition.property))

; Keys of an ANONYMOUS object literal in RETURN position (R3-4). The dominant
; shape in idiomatic JS: 437 sites in one backend directory of the reporting
; repo, including the ~25-field payload of its whole signal pipeline, none of
; which could be named because the literal binds to nothing.
;
; The enclosing function is the owner -- the literal is that function's return
; shape, a contract its callers consume -- so the key qualifies as
; <function>.<key> and two functions returning the same key stay distinct.
;
; DEFINITIONS, unlike the record-construction writes of R2-1b, and the
; difference is deliberate: there a definition already existed elsewhere and a
; construction site was a USE of it, while here nothing else names the field at
; all. To keep that from regressing R2-1b's case, narrowing ranks declared
; anchors ABOVE return shapes, so a name that already resolves keeps resolving
; to what it resolved to before.
(return_statement
  (object
    (pair
      key: (property_identifier) @name) @definition.property))

; SHORTHAND keys of the same literal. "return { symbol, interval, score }" is
; the commonest spelling of all -- the reporting repo's own alert payload is
; mostly shorthand -- and (pair) does not match it: tree-sitter models it as
; shorthand_property_identifier, where the key IS the value. Found by dumping
; the golden fixture and noticing that a literal returning
; { level, message, timestamp: Date.now() } had indexed only timestamp.
(return_statement
  (object
    (shorthand_property_identifier) @name @definition.property))

; Shorthand keys of a named object literal -- same gap, same reason as the
; return-position rule above.
(variable_declarator
  name: (identifier)
  value: (object
    (shorthand_property_identifier) @name @definition.property))

(variable_declarator
  name: (identifier)
  value: (call_expression
    function: (member_expression
      object: (identifier) @_ts.identity.obj
      property: (property_identifier) @_ts.identity.fn)
    arguments: (arguments
      (object
        (pair
          key: (property_identifier) @name) @definition.property)))
  (#eq? @_ts.identity.obj "Object")
  (#match? @_ts.identity.fn "^(freeze|seal|preventExtensions)$"))

; Private class fields: #address: Address
(public_field_definition
  name: (private_property_identifier) @name) @definition.property

; Closure-valued class fields (#2693): \`handler = (x) => x\` is a CALLABLE
; member, so it emits Method like every other closure binding rather than a
; Property that CALLS edges would point at — a call target must be callable.
; Kotlin already models its class-body closure this way (Method + HAS_METHOD).
;
; Note this diverges from tsc's SymbolFlags and SCIP's descriptor, which both
; class an arrow-initialized field as a PROPERTY/term. That is deliberate: the
; label here means "is a call target", not "is a tsc symbol kind", and #2687 set
; that convention for closure bindings in every language. Anchored on
; public_field_definition — the same node the property rules use — so the
; parse-worker dedup collapses the pair (callable ranks highest).
(public_field_definition
  name: (property_identifier) @name
  value: (arrow_function)) @definition.method

(public_field_definition
  name: (property_identifier) @name
  value: (function_expression)) @definition.method

; CJS property-assignment exports (#2723) — see JAVASCRIPT_QUERIES for the
; rationale and for why the receiver is pinned to \`exports\`/\`module.exports\`.
; Mirrored here because \`.ts\` files in a CommonJS package use the same form.
(assignment_expression
  left: (member_expression
    object: (identifier) @_cjs.receiver
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function) (generator_function)]) @definition.function

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @_cjs.module
      property: (property_identifier) @_cjs.exports)
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function) (generator_function)]
  (#eq? @_cjs.module "module")
  (#eq? @_cjs.exports "exports")) @definition.function

; Instance members assigned through \`this\` (#2723 follow-up) — see
; JAVASCRIPT_QUERIES for rationale.
(assignment_expression
  left: (member_expression
    object: (this)
    property: (property_identifier) @name)
  right: [
    (function_expression)
    (arrow_function)
    (generator_function)
  ]) @definition.function

; Prototype methods (#2723 follow-up) — see JAVASCRIPT_QUERIES for rationale.
(assignment_expression
  left: (member_expression
    object: (member_expression
      property: (property_identifier) @_proto.kw)
    property: (property_identifier) @name)
  right: [
    (function_expression)
    (arrow_function)
    (generator_function)
  ]
  (#eq? @_proto.kw "prototype")) @definition.function

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
; The URL alternation is OPTIONAL (#2897). Requiring a literal made the rule
; blind to fetch(url) with a variable argument -- measured on this repo, 44 of
; 47 fetch calls pass one, so 94% of outward calls produced no site at all. The
; R3-6 sink set needs only WHERE the program reaches outward, not the URL; route
; linking still needs the URL and already skips an entry without one
; (normalizeFetchURL returns nothing and processNextjsFetchRoutes continues), so
; widening here adds sink sites without inventing a single FETCHES edge.
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url]?)) @route.fetch

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

; Generator EXPRESSIONS bound to a name (\`const g = function* () {}\`). Without
; these, the binding emitted a \`Const\` node rather than a \`Function\` one, so
; \`g()\` resolved to nothing: \`buildGraphTargetIndex\` only admits a callable
; node. Same construct and same binding semantics as the \`function_expression\`
; rules directly above, so same label. Covers the four variable-binding shapes
; (const/let and var, each plain and exported); a generator in an object-literal
; pair or a HOC wrapper is NOT covered and still falls through anonymous.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (generator_function))) @definition.function

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

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (generator_function)))) @definition.function

; \`var\` closure bindings (#2693). The lexical rules above cover const/let;
; \`var\` is a different grammar node, so \`var f = (x) => x\` kept a Variable
; label while const/let got Function — and the CALLS edge that resolved through
; the declaration route therefore pointed at a NON-callable node. Same construct,
; same binding semantics for this purpose, so same label.
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (generator_function))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (generator_function)))) @definition.function

; CJS property-assignment exports (#2723): \`exports.foo = function () {}\`,
; \`module.exports.foo = (a) => a\`. This is the dominant export style in
; pre-ESM Node (Express, Firebase Functions), and without these rules a
; CommonJS codebase indexed its internals while every symbol on its public
; API was missing — \`impact\`/\`context\`/\`rename\` all answered "not found".
;
; Scoped to the \`exports\` / \`module.exports\` receivers on purpose. The
; general \`X.foo = function () {}\` shape also covers \`Foo.prototype.bar\` and
; \`this.handler\`, which are member constructs with their own ownership
; questions (an owning Class, a function-local binding) — a broader rule
; would emit ownerless top-level Functions for them. Same rationale as the
; other closure-binding rules above: the label means "is a call target".
(assignment_expression
  left: (member_expression
    object: (identifier) @_cjs.receiver
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function) (generator_function)]) @definition.function

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @_cjs.module
      property: (property_identifier) @_cjs.exports)
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function) (generator_function)]
  (#eq? @_cjs.module "module")
  (#eq? @_cjs.exports "exports")) @definition.function

; Prototype methods (#2723 follow-up): \`Foo.prototype.bar = function () {}\`.
; The dominant pre-ES6 method form, and previously invisible — no node at all,
; so \`impact\` could not reach a single prototype method. Emitted as a MEMBER:
; \`labelOverride\` reclassifies it to Method and the owner resolves to whatever
; \`Foo\` names, so \`HAS_METHOD\` makes it reachable the way a class method is.
(assignment_expression
  left: (member_expression
    object: (member_expression
      property: (property_identifier) @_proto.kw)
    property: (property_identifier) @name)
  right: [
    (function_expression)
    (arrow_function)
    (generator_function)
  ]
  (#eq? @_proto.kw "prototype")) @definition.function

; Instance members assigned through \`this\` (#2723 follow-up):
; \`function Widget() { this.handler = function () {}; }\`. The pre-ES6 sibling
; of a closure-valued class field, which #2693 already models as a Method.
; Ownership resolves to the enclosing constructor/class; a \`this\` at module
; top level owns nothing and stays a plain top-level definition.
(assignment_expression
  left: (member_expression
    object: (this)
    property: (property_identifier) @name)
  right: [
    (function_expression)
    (arrow_function)
    (generator_function)
  ]) @definition.function

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

; Object-literal keys of a NAMED object (A1/A5). Idiomatic JS models config as
; an object literal, not a class, so without these the fields of an options bag
; have no node and "who reads/writes this setting?" answers a confident zero.
;
; Deliberately scoped to a literal BOUND TO A VARIABLE. An unbound literal is
; usually an inline call argument or a JSX prop bag, whose keys are call-site
; data rather than a named surface other code references — minting a node per
; key there would add volume without adding an answerable question.
(variable_declarator
  name: (identifier)
  value: (object
    (pair
      key: (property_identifier) @name) @definition.property))

; Keys of an ANONYMOUS object literal in RETURN position (R3-4). The dominant
; shape in idiomatic JS: 437 sites in one backend directory of the reporting
; repo, including the ~25-field payload of its whole signal pipeline, none of
; which could be named because the literal binds to nothing.
;
; The enclosing function is the owner -- the literal is that function's return
; shape, a contract its callers consume -- so the key qualifies as
; <function>.<key> and two functions returning the same key stay distinct.
;
; DEFINITIONS, unlike the record-construction writes of R2-1b, and the
; difference is deliberate: there a definition already existed elsewhere and a
; construction site was a USE of it, while here nothing else names the field at
; all. To keep that from regressing R2-1b's case, narrowing ranks declared
; anchors ABOVE return shapes, so a name that already resolves keeps resolving
; to what it resolved to before.
(return_statement
  (object
    (pair
      key: (property_identifier) @name) @definition.property))

; SHORTHAND keys of the same literal. "return { symbol, interval, score }" is
; the commonest spelling of all -- the reporting repo's own alert payload is
; mostly shorthand -- and (pair) does not match it: tree-sitter models it as
; shorthand_property_identifier, where the key IS the value. Found by dumping
; the golden fixture and noticing that a literal returning
; { level, message, timestamp: Date.now() } had indexed only timestamp.
(return_statement
  (object
    (shorthand_property_identifier) @name @definition.property))

; Shorthand keys of a named object literal -- same gap, same reason as the
; return-position rule above.
(variable_declarator
  name: (identifier)
  value: (object
    (shorthand_property_identifier) @name @definition.property))

; Same named shape, behind an IDENTITY-PRESERVING wrapper (R2-1a):
;
;   export const INERT_EXIT_CONTRACT = Object.freeze({ exitModel: 'bracket', ... });
;
; Freezing a config object is the idiomatic way to publish an immutable
; contract, so the fields most worth querying are exactly the ones a bare
; "value: (object)" pattern cannot see — one call expression sits between the
; declarator and the literal.
;
; The allowlist is deliberately three functions rather than "any call". Only
; these RETURN THE ARGUMENT THEY WERE GIVEN, which is what makes the literal's
; keys members of the bound name. For an arbitrary "const x = compute({a: 1})"
; the literal is an argument and x is compute's return value, so attributing
; "a" to x would be a fabrication.
(variable_declarator
  name: (identifier)
  value: (call_expression
    function: (member_expression
      object: (identifier) @_identity.obj
      property: (property_identifier) @_identity.fn)
    arguments: (arguments
      (object
        (pair
          key: (property_identifier) @name) @definition.property)))
  (#eq? @_identity.obj "Object")
  (#match? @_identity.fn "^(freeze|seal|preventExtensions)$"))

; Closure-valued class fields (#2693) — see the TypeScript block for why these
; are Method rather than Property.
(field_definition
  property: (property_identifier) @name
  value: (arrow_function)) @definition.method

(field_definition
  property: (property_identifier) @name
  value: (function_expression)) @definition.method

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
; The URL alternation is OPTIONAL (#2897). Requiring a literal made the rule
; blind to fetch(url) with a variable argument -- measured on this repo, 44 of
; 47 fetch calls pass one, so 94% of outward calls produced no site at all. The
; R3-6 sink set needs only WHERE the program reaches outward, not the URL; route
; linking still needs the URL and already skips an entry without one
; (normalizeFetchURL returns nothing and processNextjsFetchRoutes continues), so
; widening here adds sink sites without inventing a single FETCHES edge.
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url]?)) @route.fetch

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

; Lambda bindings: \`f = lambda x: x\` binds a CALLABLE, so it emits Function
; rather than Variable, matching what TS/JS already do for \`const f = () => {}\`.
; This aligns the LABEL only — call resolution runs off the scope-resolution
; query, which still models the binding as a value, so \`f()\` does not resolve
; here yet. Overlap with the assignment pattern above is collapsed by the
; parse-worker dedup (#2687).
(expression_statement
  (assignment
    left: (identifier) @name
    right: (lambda))) @definition.function

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
; Classes, Interfaces, Enums, Records, Annotations
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(annotation_type_declaration name: (identifier) @name) @definition.annotation

; Canonical record-component accessors are implicit public zero-argument methods.
(record_declaration
  parameters: (formal_parameters
    (formal_parameter
      name: (identifier) @name) @definition.method))
(record_declaration
  parameters: (formal_parameters
    (spread_parameter
      (variable_declarator
        name: (identifier) @name)) @definition.method))

; Anonymous class bodies: new Runnable() { ... } — no @name capture; the
; class extractor synthesizes the javac-style Worker$N name (#2550)
(object_creation_expression (class_body)) @definition.class

; Enum constant bodies: enum E { A { ... } } — javac's other anonymous
; shape, synthesized as E$N by the same naming authority (#2555)
(enum_constant body: (class_body)) @definition.class

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

; ── Closure bindings (#2693) ────────────────────────────────────────────────
; A name bound to a closure literal IS a callable, so it emits Function rather
; than a value label — matching TS/JS and the languages #2687 already covered.
; The callable node is what callable-value-flow joins the binding to (by file,
; line and name), which is what makes handler.apply(1) resolve. Overlap with the value
; rules above is collapsed by the parse-worker dedup, which ranks callable
; highest (#2687).
; Anchored on field_declaration / local_variable_declaration — the SAME nodes
; the value rules above use — so the parse-worker dedup (keyed by definition
; node + name) actually collapses the pair. Anchoring on the inner
; variable_declarator instead produced a Function AND a Property twin, the exact
; double-indexing #2687 removed.
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name
    value: (lambda_expression))) @definition.function
(local_variable_declaration
  declarator: (variable_declarator
    name: (identifier) @name
    value: (lambda_expression))) @definition.function
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
;
; Anchored on the type_spec, NOT the enclosing type_declaration (#2837) — a
; grouped type ( A struct{}; B struct{} ) block otherwise gave every match the
; same capture node, and goClassConfig.extractName resolved all of them to the
; FIRST spec's name, collapsing the block to one node. Must stay in lockstep
; with @scope.class / @declaration.struct in languages/go/query.ts, which
; carries the full rationale. (No backticks here: this is a template literal.)
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct)
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface)

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

; Closure bindings: \`var f = func(){}\` / \`f := func(){}\` bind a CALLABLE, so
; they emit Function, not Variable — the same convention TS/JS already use for
; \`const f = () => {}\`. This aligns the LABEL only — call resolution runs off
; the scope-resolution query, which still models the binding as a value, so
; \`f()\` does not resolve here yet. Overlap with the value patterns above is
; collapsed by the parse-worker dedup (#2687).
(var_declaration
  (var_spec
    name: (identifier) @name
    value: (expression_list (func_literal)))) @definition.function
(var_declaration
  (var_spec_list
    (var_spec
      name: (identifier) @name
      value: (expression_list (func_literal))))) @definition.function
(short_var_declaration
  left: (expression_list (identifier) @name)
  right: (expression_list (func_literal))) @definition.function

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

; Lambda bindings: \`auto f = [](int x){ … };\` binds a CALLABLE, so it emits
; Function rather than Variable, matching TS/JS. This aligns the LABEL only —
; call resolution runs off the scope-resolution query, which still models the
; binding as a value, so \`f()\` does not resolve here yet. Overlap with the
; pattern above is collapsed by the parse-worker dedup (#2687).
(declaration
  declarator: (init_declarator
    declarator: (identifier) @name
    value: (lambda_expression))) @definition.function

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

; ── Closure bindings (#2693) ────────────────────────────────────────────────
; A name bound to a closure literal IS a callable, so it emits Function rather
; than a value label — matching TS/JS and the languages #2687 already covered.
; The callable node is what callable-value-flow joins the binding to (by file,
; line and name), which is what makes handler(1) resolve. Overlap with the value
; rules above is collapsed by the parse-worker dedup, which ranks callable
; highest (#2687).
(variable_declarator
  (identifier) @name
  (lambda_expression)) @definition.function
`;

// Rust queries - works with tree-sitter-rust
export const RUST_QUERIES = `
; Functions & Items
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function

; Closure bound to a let: let handler = || target(1);
; Emits the Function NODE. Without it a Rust closure binding had no graph node
; at all, so it could be neither a call target nor a call source (#2699), which
; made Rust the one exception to "a closure bound to a name is a Function node
; in every language" (#2687).
; Anchor note: this channel puts @definition.function on the OUTER
; let_declaration, which is the OPPOSITE of the scope-resolution channel in
; languages/rust/query.ts (inner closure_expression, to align with
; @scope.function). Both match their own channel's convention -- compare the
; (lexical_declaration (variable_declarator ... (arrow_function))) rule above.
(let_declaration
  pattern: (identifier) @name
  value: (closure_expression)) @definition.function
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

; ── Closure bindings (#2693) ────────────────────────────────────────────────
; A name bound to a closure literal IS a callable, so it emits Function rather
; than a value label — matching TS/JS and the languages #2687 already covered.
; The callable node is what callable-value-flow joins the binding to (by file,
; line and name), which is what makes $handler(1) resolve. Overlap with the value
; rules above is collapsed by the parse-worker dedup, which ranks callable
; highest (#2687).
; Captures the whole variable_name, so the node keeps PHP's \`$\` sigil. That is
; not cosmetic: PHP holds variables and functions in SEPARATE namespaces, so
; \`$save\` and \`save()\` can never collide in the language — but dropping the
; sigil made both mint the id Function:<file>:save, and the local closure was
; swallowed by the function's node (no node, therefore no edge). The property
; rules in languages/php/query.ts already keep the sigil for the same reason.
; The positional join normalises leading sigils, so the binding still matches
; its own declaration.
(assignment_expression
  left: (variable_name) @name
  right: (arrow_function)) @definition.function
(assignment_expression
  left: (variable_name) @name
  right: (anonymous_function)) @definition.function
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

; ── Closure bindings (#2693) ────────────────────────────────────────────────
; A name bound to a closure literal IS a callable, so it emits Function rather
; than a value label — matching TS/JS and the languages #2687 already covered.
; The callable node is what callable-value-flow joins the binding to (by file,
; line and name), which is what makes handler.call(1) resolve. Overlap with the value
; rules above is collapsed by the parse-worker dedup, which ranks callable
; highest (#2687).
(assignment
  left: (identifier) @name
  right: (lambda)) @definition.function

; The (lambda) rule above covers the stabby forms only. lambda do...end,
; proc do...end and Proc.new are (call) nodes, so without these the scope
; channel declared a closure the graph channel never gave a node to, and the
; call fell through to the enclosing method. Same two-channel lockstep Rust
; needed. Receiver constraints mirror ruby/query.ts exactly: bare for
; lambda/proc, Proc-constant for new — otherwise every block-taking call
; (items.map { }) would mint a Function node.
(assignment
  left: (identifier) @name
  right: (call
    !receiver
    method: (identifier) @_lam
    block: [(block) (do_block)])
  (#eq? @_lam "lambda")) @definition.function

(assignment
  left: (identifier) @name
  right: (call
    !receiver
    method: (identifier) @_prc
    block: [(block) (do_block)])
  (#eq? @_prc "proc")) @definition.function

(assignment
  left: (identifier) @name
  right: (call
    receiver: (constant) @_pc
    method: (identifier) @_nw
    block: [(block) (do_block)])
  (#eq? @_pc "Proc")
  (#eq? @_nw "new")) @definition.function
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

; Lambda bindings: \`val f = { x -> x }\` binds a CALLABLE, so it emits Function
; rather than Property, matching TS/JS. This aligns the LABEL only — call
; resolution runs off the scope-resolution query, which still models the binding
; as a value, so \`f()\` does not resolve here yet. Overlap with the property
; pattern above is collapsed by the parse-worker dedup (#2687).
(property_declaration
  (variable_declaration
    (simple_identifier) @name)
  (lambda_literal)) @definition.function

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

; Closure bindings: \`let f = { ... }\` binds a CALLABLE, so it emits Function
; rather than Property, matching TS/JS. This aligns the LABEL only — call
; resolution runs off the scope-resolution query, which still models the binding
; as a value, so \`f()\` does not resolve here yet. Overlap with the property
; pattern above is collapsed by the parse-worker dedup (#2687).
(property_declaration
  name: (pattern (simple_identifier) @name)
  value: (lambda_literal)) @definition.function

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
; Closure bindings: \`var f = (x) => x;\` binds a CALLABLE, so it emits Function
; rather than Variable, matching TS/JS. Overlap with the pattern above is
; collapsed by the parse-worker dedup (#2687). Since #2693 this node is also
; what makes \`f()\` resolve: the scope-resolution query declares the binding as
; a value, and callable-value-flow admits it as a call target precisely because
; the node it resolves to is a Function.
(program
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name
      (function_expression))) @definition.function)

; ── Top-level final/const closure bindings (#2693) ──────────────────────────
; \`final handler = (x) => x;\` parses as a static_final_declaration_list, not an
; initialized_identifier_list, so the rules above never reach it — \`final\` is
; the idiomatic top-level binding keyword and was the one closure form getting
; neither the callable label nor resolution.
(program
  (static_final_declaration_list
    (static_final_declaration
      (identifier) @name
      (function_expression))) @definition.function)

; ── Function-local closure bindings (#2693) ─────────────────────────────────
; \`void m() { var f = (x) => x; }\` — locals parse as initialized_variable_
; definition, which the top-level rules above never reach, so a local closure
; had no graph node at all and \`f()\` could not resolve. Restricted to a
; function_expression value: ordinary locals stay unindexed, as before.
(initialized_variable_definition
  name: (identifier) @name
  value: (function_expression)) @definition.function

; Second and later declarators of a multi-name local (\`var f = .., g = ..;\`)
; are initialized_identifier children NESTED INSIDE the same
; initialized_variable_definition, which the \`name:\`/\`value:\` field rule above
; only reaches for the FIRST name — so \`g\` silently had no node. Anchored on the
; inner node so each name gets its own range; the top-level form lives under
; initialized_identifier_list instead, so these never double-match.
(initialized_variable_definition
  (initialized_identifier
    (identifier) @name
    (function_expression)) @definition.function)
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

// ── Zig ──────────────────────────────────────────────────────────────────────
// Verified against @tree-sitter-grammars/tree-sitter-zig 1.1.2.
// Container declarations (struct/enum/union) are anonymous in the grammar; the
// binding name lives on the parent variable_declaration's first identifier
// child. Heritage queries are intentionally absent — Zig has no inheritance.
export const ZIG_QUERIES = `
; Functions (top-level + methods inside struct/enum/union containers)
(function_declaration
  name: (identifier) @name) @definition.function

; Struct: const Foo = struct { ... }
(variable_declaration
  (identifier) @name
  (struct_declaration)) @definition.struct

; Enum: const Foo = enum { ... }
(variable_declaration
  (identifier) @name
  (enum_declaration)) @definition.enum

; Union: const Foo = union { ... } (and tagged-union union(enum) { ... })
(variable_declaration
  (identifier) @name
  (union_declaration)) @definition.union

; File-struct: a file whose top level declares a container field IS a struct
; named after the file (\`Page.zig\` declares \`Page\`; \`@typeName\` agrees).
; The anchor is the whole file; the name comes from the class extractor
; (\`zigContainerName(source_file, filePath)\` — the file stem), not from a
; capture, since no node spells it. One match per top-level field — the
; definition phase dedupes by (node, name). Namespace-only files (no fields)
; never match and keep their Function ids.
((source_file (container_field name: (identifier) @_field)) @definition.struct
  (#not-eq? @_field ""))
; A FIELDLESS file-struct — \`Empty.zig\`: no field, but a top-level fn whose
; first parameter is typed as the file's own type (\`self: *@This()\`, or
; \`self: *Self\` beside \`const Self = @This();\`). Zero-sized types are still
; constructed (\`Empty{}\`) and dispatched on, and keyed on fields alone the
; file lost its Struct node and every \`e.ping()\` edge (PR #1432 review,
; 8.12). The two rules over-match on purpose — any \`@This\` in a first
; parameter, any top-level \`@This()\` alias — and the provider's
; \`shouldSkipDefinitionCapture\` keeps only what \`isZigFileStruct\` (the
; single predicate the owner walk and the scope side use) admits.
((source_file (function_declaration (parameters . (parameter type: (_) @_recv))))
  @definition.struct
  (#match? @_recv "@This"))
((source_file (variable_declaration (identifier) (builtin_function (builtin_identifier) @_this)))
  @definition.struct
  (#eq? @_this "@This"))

; Opaque: const Handle = opaque { ... } — the FFI handle type. It is a
; container (it may declare methods, never fields), so it is labelled Struct:
; the owner of a HAS_METHOD edge must be class-like, and there is no closer
; label. It is NOT a TypeAlias — an opaque type is a distinct nominal type,
; deliberately incompatible with whatever it wraps.
(variable_declaration
  (identifier) @name
  (opaque_declaration)) @definition.struct

; Generic type constructors: \`pub fn List(comptime T: type) type { return
; struct { … }; }\` — Zig's only spelling of a generic type. The returned
; container is anonymous in the grammar; the definition anchor is the
; container node and its name is the enclosing function's (\`List\`), which
; is what every caller writes (\`List(u8)\`). Only the direct \`return
; <container>\` of a fn whose return type is \`type\` qualifies (see
; \`zigTypeConstructorOf\`). The Function node \`List\` coexists: \`List\` is
; both a callable and a type.
((function_declaration
  name: (identifier) @name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (struct_declaration) @definition.struct))))
  (#eq? @_ret "type"))
((function_declaration
  name: (identifier) @name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (union_declaration) @definition.union))))
  (#eq? @_ret "type"))
((function_declaration
  name: (identifier) @name
  type: (builtin_type) @_ret
  body: (block (expression_statement (return_expression
    (enum_declaration) @definition.enum))))
  (#eq? @_ret "type"))

; Function-local and anonymous containers (F8): \`fn string() { const R =
; struct { fn get … }; }\` (Lightpanda's reflection.zig declares one \`R\` per
; builder fn), \`std.sort.pdq(T, items, {}, struct { fn lessThan … }.lessThan)\`,
; \`const cmp = struct { fn lt … }.lt;\`, a field typed \`?struct { min: u32 }\`.
; No name child spells their identity, so these rules match EVERY container
; and the class extractor names the node from \`zigContainerName\` (\`string$R\`,
; \`build$1\`) — the same function the owner walk uses for their fns, which
; were ownerless, colliding Methods before. The bound shapes above match too;
; the provider's \`shouldSkipDefinitionCapture\` keeps exactly one rule per
; container (\`zigContainerAnchor\`).
(struct_declaration) @definition.struct
(enum_declaration) @definition.enum
(union_declaration) @definition.union
(opaque_declaration) @definition.struct

; Container fields (struct fields, enum variants, union variants) — all are
; \`container_field\` in the grammar and all become Property (C labels its
; enumerators Const; Rust captures no variants; Zig's own vocabulary is
; "field" for all three, so one label keeps the query honest).
; #not-eq? guard: tree-sitter-zig 1.1.2 recovers an EMPTY container body
; (\`struct {}\`, \`opaque {}\`) as a container_field whose identifier is a
; zero-width MISSING placeholder — a parser artefact, not a field, and
; without the guard it minted a Property with an empty name.
((container_field
  name: (identifier) @name) @definition.property
  (#not-eq? @name ""))

; Named tests: test "description" { ... }. The name is the string node WITH
; its quotes, so \`test "add"\` next to \`fn add\` (the idiomatic layout) does
; not collide on Function:<file>:add. Anonymous \`test {}\` and decl-tests
; \`test add {}\` have no name of their own and are not graph nodes; their
; bodies' calls attribute to the File.
(test_declaration
  (string) @name) @definition.function

; const / var bindings that are neither a container nor an @import (those two
; are skipped by the provider's \`shouldSkipDefinitionCapture\` so the Struct /
; import binding is the only node for that name). The literal keyword is
; load-bearing: tree-sitter-zig 1.1.2 parses statement assignments (\`x = 5;\`,
; \`x += 1;\`, \`_ = expr;\`) as \`variable_declaration\` WITHOUT a keyword
; child, and a keyword-less rule would mint a Const per assignment and a
; Variable named \`_\` per discard.
(variable_declaration
  "const" . (identifier) @name) @definition.const
(variable_declaration
  "var" . (identifier) @name) @definition.variable

; @import("path") — capture the string argument as @import.source, in
; EVERY position: the value of a const/var (\`const std = @import("std")\`),
; a member chain (\`const X = @import("x.zig").X\`), \`pub usingnamespace
; @import("path")\`, a tuple element (\`pub const Interfaces = .{
; @import("a.zig"), @import("b.zig") }\`), a call argument, a comparison
; operand, the receiver of a member call (\`try @import("dump.zig").root(...)\`).
; Zig has no import statement — the builtin IS the import, wherever it sits,
; and every occurrence is a file dependency. The #eq? predicate keeps the
; other builtins (@sizeOf, @TypeOf, @as, …) out. One rule, one match per
; builtin: the structure phase only skips import matches (IMPORTS edges come
; from the scope phase — \`emitZigScopeCaptures\`, whose \`@import.inline\`
; rule is this rule's twin, decides which occurrences bind a name).
((builtin_function
  (builtin_identifier) @builtin
  (arguments
    (string) @import.source))
  (#eq? @builtin "@import")) @import

; Free calls: foo(...)
(call_expression
  function: (identifier) @call.name) @call

; Member calls: obj.method(...) and namespace.fn(...) (e.g. std.debug.print).
(call_expression
  function: (field_expression
    member: (identifier) @call.name)) @call
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
  [SupportedLanguages.Zig]: ZIG_QUERIES,
};
