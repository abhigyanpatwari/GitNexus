/**
 * Tree-sitter query for TypeScript scope captures (RFC §5.1).
 *
 * Captures the structural skeleton the generic scope-resolution pipeline
 * consumes: scopes (module/namespace/class/function), declarations (class-
 * likes, method-likes, properties, variables), imports (one anchor per
 * statement — decomposed in `import-decomposer.ts`), type bindings
 * (parameter annotations, variable annotations, constructor inference,
 * return types), and references (call sites, member writes).
 *
 * TypeScript specifics that shape this query:
 *
 *   - **Namespaces** (`namespace Foo { }`) use `internal_module` with a
 *     `namespace` anon keyword + `identifier` or `nested_identifier` name +
 *     `statement_block` body. Verified via Unit 1 probe.
 *   - **`this` / `super`** are NAMED nodes `(this)` / `(super)` — unlike
 *     C#'s `this`/`base` which are anonymous tokens. `(_)` wildcard matches
 *     them as the receiver child of `member_expression`, so we don't need
 *     explicit string patterns.
 *   - **Optional chaining** (`obj?.m()`) still matches the regular
 *     `member_expression > object: (_) / property: (property_identifier)`
 *     pattern; the `(optional_chain)` child sits between them but doesn't
 *     occupy a named field. Same query handles both.
 *   - **Dynamic imports** (`import('./mod')`) are `call_expression` whose
 *     `function` field is a named `import` node (not a regular identifier).
 *     Captured via a dedicated pattern.
 *   - **Function overloads** — `function f(x:string); function f(x:number);
 *     function f(x) { … }` emits two `function_signature` nodes plus one
 *     `function_declaration`. All three emit `@declaration.function`;
 *     arity metadata synthesis merges parameterTypes.
 *   - **Parameter properties** (`constructor(public name: string)`) — each
 *     parameter emits `@declaration.property` on the enclosing class; the
 *     same identifier also binds as a parameter in the constructor scope
 *     via the normal `required_parameter` → `@type-binding.parameter` path.
 *   - **Enum** — dual type+value. Emits `@scope.class` (enum body contains
 *     member declarations) + `@declaration.enum`. Members are captured as
 *     `@declaration.property` via the generic property_identifier pattern
 *     inside enum_body.
 *
 * Node types pinned via `scripts/_probe_typescript_grammar.ts`:
 *   internal_module, namespace_export, namespace_import, import_specifier,
 *   export_specifier, enum_declaration, type_alias_declaration,
 *   abstract_class_declaration, abstract_method_signature, method_signature,
 *   generator_function_declaration, optional_parameter, rest_parameter,
 *   required_parameter, public_field_definition, private_property_identifier,
 *   new_expression (constructor field), call_expression with (import) fn.
 *
 * Grammar version: tree-sitter-typescript pinned in gitnexus/package.json.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay tree-
 * sitter init cost per file.
 */

import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';

// tree-sitter-typescript exports both `typescript` and `tsx` grammars on
// the default export. The package's `.d.ts` types the default export
// loosely; we narrow at the use site. The two grammars are NOT
// interchangeable: feeding a `.tsx` source to the `typescript` grammar
// mis-parses JSX as a sequence of less-than/greater-than expressions
// and silently drops every capture inside JSX elements. We therefore
// pick the grammar by file extension.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TS_GRAMMAR = (TS as any).typescript as Parameters<Parser['setLanguage']>[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSX_GRAMMAR = (TS as any).tsx as Parameters<Parser['setLanguage']>[0];

/** True when the file should be parsed with the TSX grammar. The TSX
 *  grammar is a superset of TypeScript that adds JSX productions; it
 *  parses plain `.ts` files correctly too, but we keep `.ts` on the
 *  `typescript` grammar so the parser cache stays small and so any
 *  subtle TSX-only mis-parses don't bleed into non-TSX files. */
function isTsxFile(filePath: string): boolean {
  return filePath.endsWith('.tsx');
}

const TYPESCRIPT_SCOPE_QUERY = `
;; Scopes — module / namespace / class-likes / function-likes
(program) @scope.module

(internal_module) @scope.namespace

(class_declaration) @scope.class
(abstract_class_declaration) @scope.class
(interface_declaration) @scope.class
(enum_declaration) @scope.class

(function_declaration) @scope.function
(generator_function_declaration) @scope.function
(function_signature) @scope.function
(method_definition) @scope.function
(method_signature) @scope.function
(abstract_method_signature) @scope.function
(arrow_function) @scope.function
(function_expression) @scope.function

;; Type aliases that contain an object_type are structurally class-like —
;; they define a shape with named members. Emit @scope.class so the
;; field-extractor's type-alias-with-object-type handling (in
;; field-extractors/typescript.ts) finds a scope for its members.
(type_alias_declaration
  value: (object_type)) @scope.class

;; Declarations — types
(class_declaration
  name: (type_identifier) @declaration.name) @declaration.class

(abstract_class_declaration
  name: (type_identifier) @declaration.name) @declaration.class

(interface_declaration
  name: (type_identifier) @declaration.name) @declaration.interface

(enum_declaration
  name: (identifier) @declaration.name) @declaration.enum

(type_alias_declaration
  name: (type_identifier) @declaration.name) @declaration.type

(internal_module
  name: (identifier) @declaration.name) @declaration.namespace

;; Declarations — methods / functions / constructors
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

(generator_function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; Function overload signatures (declaration-only; body in a separate
;; function_declaration). Extractors dedup by (name, parameterTypes).
(function_signature
  name: (identifier) @declaration.name) @declaration.function

;; Arrow/function-expression assigned to a const/let/var — named by the
;; variable_declarator. Covers \`const fn = () => {}\` and its export
;; variant. Matches the legacy TYPESCRIPT_QUERIES pattern.
(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (arrow_function))) @declaration.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (function_expression))) @declaration.function

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (arrow_function))) @declaration.function

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (function_expression))) @declaration.function

;; Method definitions — regular + private (#field) methods.
(method_definition
  name: (property_identifier) @declaration.name) @declaration.method

(method_definition
  name: (private_property_identifier) @declaration.name) @declaration.method

;; Abstract method signatures in abstract classes.
(abstract_method_signature
  name: (property_identifier) @declaration.name) @declaration.method

;; Interface method signatures.
(method_signature
  name: (property_identifier) @declaration.name) @declaration.method

;; Declarations — class fields
(public_field_definition
  name: (property_identifier) @declaration.name) @declaration.property

(public_field_definition
  name: (private_property_identifier) @declaration.name) @declaration.property

;; Declarations — parameter properties: \`constructor(public name: string)\`.
;; The accessibility_modifier presence distinguishes these from regular
;; parameters. The identifier is also bound as a parameter in the
;; constructor's scope via @type-binding.parameter below (dual binding).
(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @declaration.name) @declaration.property

;; Declarations — variables (let / const / var)
(lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name)) @declaration.variable

(variable_declaration
  (variable_declarator
    name: (identifier) @declaration.name)) @declaration.variable

;; Imports — single anchor per statement; decomposer emits per-specifier markers.
(import_statement) @import.statement

;; Re-exports: \`export { X } from './y'\` / \`export * from './y'\` /
;; \`export * as ns from './y'\` / \`export type { X } from './y'\`.
;; Only re-exports (those with a \`from\` clause) emit @import.statement;
;; local \`export { X }\` (no source) is just visibility metadata, not an
;; import. The decomposer filters by source presence.
(export_statement
  source: (string)) @import.statement

;; Dynamic imports: \`import('./m')\` / \`await import(x)\`. tree-sitter-
;; typescript represents \`import\` as a named leaf node; the call_expression's
;; function field points at it.
(call_expression
  function: (import)) @import.dynamic

;; Type bindings — parameter annotations: \`function f(u: User)\`
(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.parameter

(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.parameter

(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (predefined_type) @type-binding.type)) @type-binding.parameter

;; Parameter with union / array / readonly wrappers: \`users: readonly User[]\`,
;; \`x: User | null\`, \`xs: User[]\`. interpret strips wrappers to the
;; discriminating type.
(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.parameter

(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.parameter

(required_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.parameter

;; Type bindings — parameter properties:
;;   \`constructor(public address: Address)\` — each parameter with an
;;   accessibility modifier is ALSO a class field. We emit a second
;;   capture so \`tsBindingScopeFor\` can hoist these to the Class scope,
;;   enabling \`user.address\` field access resolution. The regular
;;   @type-binding.parameter above still fires for the constructor
;;   scope binding — both bindings coexist, which is correct.
(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.parameter-property

(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.parameter-property

(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (predefined_type) @type-binding.type)) @type-binding.parameter-property

(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.parameter-property

(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.parameter-property

(required_parameter
  (accessibility_modifier)
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.parameter-property

(optional_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.parameter

(optional_parameter
  pattern: (identifier) @type-binding.name
  type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.parameter

;; Type bindings — variable annotations: \`let u: User = ...\` / \`const u: User\`.
(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.annotation

(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.annotation

(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (predefined_type) @type-binding.type)) @type-binding.annotation

;; Union types like \`User | null\` / \`User | undefined\` — interpret's
;; stripNullableUnion collapses to the discriminating arm.
(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.annotation

;; Array types: \`User[]\` / \`readonly User[]\` — stripArraySuffix unwraps.
(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.annotation

(variable_declarator
  name: (identifier) @type-binding.name
  type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.annotation

;; Type bindings — constructor-inferred: \`const u = new User()\`.
;; The variable_declarator's \`value\` field carries the new_expression; its
;; \`constructor\` field is the type identifier. Covers both typed (\`:User = \`)
;; and untyped declarations — the annotation pattern above wins if both
;; fire, via the scope-extractor's source-strength tie-break in
;; pass4CollectTypeBindings.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (new_expression
    constructor: (identifier) @type-binding.type)) @type-binding.constructor

;; Qualified constructor: \`const u = new models.User()\`. Captures the
;; member_expression's text as the type — resolver's QualifiedNameIndex
;; handles the dotted lookup.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (new_expression
    constructor: (member_expression) @type-binding.type)) @type-binding.constructor

;; Cast-wrapped constructor: \`const u = new User() as any\` /
;; \`const u = new User()!\`. The \`as T\` pattern also captures T itself
;; via the assertion clause above, but T is usually a non-discriminating
;; type (\`any\`, \`unknown\`) in these idioms; interpretTsTypeBinding
;; drops those so the constructor-inferred binding survives.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (as_expression
    (new_expression
      constructor: (identifier) @type-binding.type))) @type-binding.constructor

(variable_declarator
  name: (identifier) @type-binding.name
  value: (non_null_expression
    (new_expression
      constructor: (identifier) @type-binding.type))) @type-binding.constructor

;; Double-cast: \`const u = new User() as unknown as any\` — as_expression
;; nested inside as_expression, with new_expression at the core.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (as_expression
    (as_expression
      (new_expression
        constructor: (identifier) @type-binding.type)))) @type-binding.constructor

;; Type bindings — call-result alias: \`const u = find()\`. Chain-follow
;; walks \`find\`'s return type via propagateImportedReturnTypes for cross-
;; file; same-file covered by explicit return annotations.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — member-call alias: \`const u = svc.getUser()\`. The
;; callee is captured as a full \`member_expression\` text (\`svc.getUser\`)
;; so compound-receiver can resolve the receiver object before looking up
;; the method's hoisted return-type binding.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (member_expression) @type-binding.type)) @type-binding.alias

;; Type bindings — await chain: \`const u = await find()\` / \`await svc.m()\`.
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

;; Awaited generic calls re-associate: \`await fn<T>(...)\` parses as
;; \`call_expression(function: await_expression(identifier), type_arguments, arguments)\`
;; — NOT as an await_expression wrapping a call_expression. Handle both
;; free and member forms so the chain-follow picks up the inner callee.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (await_expression
      (identifier) @type-binding.type))) @type-binding.alias

(variable_declarator
  name: (identifier) @type-binding.name
  value: (call_expression
    function: (await_expression
      (member_expression) @type-binding.type))) @type-binding.alias

;; Type bindings — member-access alias: \`const addr = user.address\`.
;; Full \`member_expression\` text feeds compound-receiver Case 3b.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (member_expression) @type-binding.type) @type-binding.member-alias

;; Type bindings — identifier alias: \`const alias = user\`. Chain-follow
;; resolves alias via user's binding.
(variable_declarator
  name: (identifier) @type-binding.name
  value: (identifier) @type-binding.type) @type-binding.alias

;; Type bindings — \`as\` assertion: \`const u = x as User\`. Prefer
;; the assertion's target type over RHS inference. as_expression's right
;; child is the target type (positional; no field name).
(variable_declarator
  name: (identifier) @type-binding.name
  value: (as_expression
    (_)
    (type_identifier) @type-binding.type)) @type-binding.assertion

(variable_declarator
  name: (identifier) @type-binding.name
  value: (as_expression
    (_)
    (generic_type) @type-binding.type)) @type-binding.assertion

;; Type bindings — non-null assertion: \`const u = find()!\`. Unwrap to the
;; underlying call's function identifier (matches the call-alias pattern).
(variable_declarator
  name: (identifier) @type-binding.name
  value: (non_null_expression
    (call_expression
      function: (identifier) @type-binding.type))) @type-binding.alias

;; Type bindings — for-of element: \`for (const u of users)\` — bind u to
;; users (chain-follow unwraps to element type via stripGeneric).
(for_in_statement
  left: (identifier) @type-binding.name
  right: (identifier) @type-binding.type) @type-binding.alias

;; Type bindings — for-of call iterable: \`for (const u of getUsers())\`.
(for_in_statement
  left: (identifier) @type-binding.name
  right: (call_expression
    function: (identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — for-of member-call iterable: \`for (const u of svc.getUsers())\`.
(for_in_statement
  left: (identifier) @type-binding.name
  right: (call_expression
    function: (member_expression) @type-binding.type)) @type-binding.alias

;; Type bindings — for-of member-access iterable: \`for (const u of this.users)\`.
;; Bind u to \`users\` (the attribute name); chain-follow resolves users
;; via the enclosing class's field binding.
(for_in_statement
  left: (identifier) @type-binding.name
  right: (member_expression
    property: (property_identifier) @type-binding.type)) @type-binding.alias

;; Type bindings — class field annotation: \`private city: City\`.
(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.annotation

(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.annotation

(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (predefined_type) @type-binding.type)) @type-binding.annotation

;; Class field with union / array / readonly wrappers:
;; \`private users: User[]\`, \`private repos: readonly Repo[]\`,
;; \`private x: City | null\`. interpret strips wrappers to the
;; discriminating type so chain-follow unwraps to the element.
(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.annotation

(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.annotation

(public_field_definition
  name: (property_identifier) @type-binding.name
  type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.annotation

;; Private class field annotation: \`#city: City\`.
(public_field_definition
  name: (private_property_identifier) @type-binding.name
  type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.annotation

;; Type bindings — method return type: \`save(): User { … }\` / \`function f(): User { … }\`.
;; Function/method return-type is the type_annotation that is a direct
;; child of the function node (not the parameter's annotation). Anchor on
;; the function node so bindingScopeFor can hoist if the language requests
;; (TS keeps it on the method scope; we emit here and let the resolver
;; decide via hoistTypeBindingsToModule).
;;
;; Wrapper forms covered: plain \`User\`, generic \`Promise<User>\`,
;; array \`User[]\`, readonly \`readonly User[]\`, union \`User | null\`.
;; \`stripArraySuffix\` / \`stripReadonly\` / \`stripNullableUnion\` in
;; interpret reduce these to the discriminating element so chain-follow
;; can unwrap iterators returned from \`getUsers(): User[]\`.
(function_declaration
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.return

(function_declaration
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.return

(function_declaration
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.return

(function_declaration
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.return

(function_declaration
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.return

(function_signature
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.return

(function_signature
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.return

(function_signature
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.return

(function_signature
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.return

(function_signature
  name: (identifier) @type-binding.name
  return_type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.return

(method_definition
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.return

(method_definition
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.return

(method_definition
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.return

(method_definition
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.return

(method_definition
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.return

(method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.return

(method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.return

(method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (array_type) @type-binding.type)) @type-binding.return

(method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (readonly_type) @type-binding.type)) @type-binding.return

(method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (union_type) @type-binding.type)) @type-binding.return

(abstract_method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (type_identifier) @type-binding.type)) @type-binding.return

(abstract_method_signature
  name: (property_identifier) @type-binding.name
  return_type: (type_annotation
    (generic_type) @type-binding.type)) @type-binding.return

;; Type bindings — assignment rebind: \`u = new User()\` (no \`const\`).
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

;; References — free calls: \`fn(args)\`. Exclude the dynamic-import form,
;; which would otherwise double-classify as a call to a built-in \`import\`.
;; tree-sitter can't negate (import) with #not-eq?; the captures.ts layer
;; filters dynamic-imports BEFORE the free-call is consumed.
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; Awaited free call with generics: \`await fn<T>(...)\` — re-associated
;; by tree-sitter as \`call_expression(function: await_expression(identifier))\`.
(call_expression
  function: (await_expression
    (identifier) @reference.name)) @reference.call.free

;; References — member calls: \`obj.method()\` (includes optional chain).
;; The (_) wildcard matches any named receiver including \`this\` /
;; \`super\` (both are named nodes in tree-sitter-typescript, unlike C#'s
;; anonymous tokens).
(call_expression
  function: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.call.member

;; Awaited member call with generics: \`await svc.m<T>(...)\` — re-associated
;; as \`call_expression(function: await_expression(member_expression))\`.
(call_expression
  function: (await_expression
    (member_expression
      object: (_) @reference.receiver
      property: (property_identifier) @reference.name))) @reference.call.member

;; References — constructor calls: \`new User()\` / \`new ns.User()\`.
(new_expression
  constructor: (identifier) @reference.name) @reference.call.constructor

(new_expression
  constructor: (member_expression) @reference.call.constructor.qualified) @reference.call.constructor

;; References — write access: \`obj.field = value\`.
(assignment_expression
  left: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.write.member

(augmented_assignment_expression
  left: (member_expression
    object: (_) @reference.receiver
    property: (property_identifier) @reference.name)) @reference.write.member

;; References — read access: \`obj.field\` used in a read context.
;; Fires on EVERY member_expression; \`emitTsScopeCaptures\` filters out
;; contexts that shouldn't emit a read ACCESSES edge (LHS of assignment,
;; the \`function:\` of a call_expression, property_identifier inside a
;; computed member name, etc.). Keeping the filter on the emit side lets
;; tree-sitter's pattern stay simple and we don't replicate AST-context
;; predicates in the query itself.
(member_expression
  object: (_) @reference.receiver
  property: (property_identifier) @reference.name) @reference.read.member
`;

let _tsParser: Parser | null = null;
let _tsxParser: Parser | null = null;
let _tsQuery: Parser.Query | null = null;
let _tsxQuery: Parser.Query | null = null;

/**
 * Return the right tree-sitter parser for `filePath` (or the TS parser
 * when no path is given — the legacy callsite shape).
 */
export function getTsParser(filePath?: string): Parser {
  if (filePath !== undefined && isTsxFile(filePath)) {
    if (_tsxParser === null) {
      _tsxParser = new Parser();
      _tsxParser.setLanguage(TSX_GRAMMAR);
    }
    return _tsxParser;
  }
  if (_tsParser === null) {
    _tsParser = new Parser();
    _tsParser.setLanguage(TS_GRAMMAR);
  }
  return _tsParser;
}

/**
 * Return the right tree-sitter Query (compiled against the same grammar
 * as the parser). A Query bound to the `typescript` grammar can NOT be
 * executed against a Tree produced by the `tsx` grammar — tree-sitter
 * matches by node-type id, and the two grammars have separate id
 * spaces.
 */
export function getTsScopeQuery(filePath?: string): Parser.Query {
  if (filePath !== undefined && isTsxFile(filePath)) {
    if (_tsxQuery === null) {
      _tsxQuery = new Parser.Query(TSX_GRAMMAR, TYPESCRIPT_SCOPE_QUERY);
    }
    return _tsxQuery;
  }
  if (_tsQuery === null) {
    _tsQuery = new Parser.Query(TS_GRAMMAR, TYPESCRIPT_SCOPE_QUERY);
  }
  return _tsQuery;
}

/**
 * Validate that a cached `Tree` was produced by the grammar matching
 * `filePath` (TSX vs TypeScript). The runtime tree-sitter `Tree` exposes
 * `getLanguage()` (returning the grammar object the parser was bound
 * to); the .d.ts is incomplete, so we reach via a cast. Identity
 * comparison against `TSX_GRAMMAR` / `TS_GRAMMAR` is exact: the same
 * module instance produces both. If `getLanguage` is unavailable for
 * any reason, return true to keep behavior backwards-compatible (the
 * original code never validated grammar at all).
 */
export function tsCachedTreeMatchesGrammar(tree: unknown, filePath: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lang = (tree as any)?.getLanguage?.();
  if (lang === undefined || lang === null) return true;
  return isTsxFile(filePath) ? lang === TSX_GRAMMAR : lang === TS_GRAMMAR;
}
