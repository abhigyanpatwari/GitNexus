/**
 * Tree-sitter query for PHP scope captures (RFC #909 Ring 3 LANG-php).
 *
 * Captures the structural skeleton the generic scope-resolution pipeline
 * consumes: scopes (program/namespace/class/function), declarations
 * (class-likes, method-likes, properties, variables), imports
 * (namespace_use_declaration), type bindings (parameter annotations,
 * property types, constructor-inferred locals, return types), and
 * references (call sites, member writes).
 *
 * PHP specifics that shape this query:
 *
 *   - `namespace_use_declaration` is an import only at top level / inside
 *     namespace blocks. Class-body `use_declaration` (trait-use) is a
 *     different node type and is NOT captured here.
 *
 *   - `object_creation_expression` has `name` and `qualified_name` as
 *     direct children (no wrapping node).
 *
 *   - `method_declaration` exposes a `return_type:` named field containing
 *     a `type` node, which may be `named_type`, `optional_type`, etc.
 *
 *   - `property_element` has a `name:` field of type `variable_name`.
 *
 *   - `variable_name` nodes always include the `$` sigil in their text.
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Php from 'tree-sitter-php';

// tree-sitter-php exports `{ php, php_only, html }` in recent versions, or the
// language directly in older versions.
//
// IMPORTANT: must match the grammar used by the central parse phase
// (`src/core/tree-sitter/parser-loader.ts` line: `[SupportedLanguages.PHP]: PHP.php_only`).
// Using a different grammar variant causes tree-sitter to throw when running
// a query built against grammar A on a tree parsed by grammar B — this error
// is swallowed by `scope-extractor-bridge.ts`, producing silent empty results.
const Php_typed = Php as unknown as { php_only?: unknown; php?: unknown };
const PHP_LANG = Php_typed.php_only ?? Php_typed.php ?? Php;

const PHP_SCOPE_QUERY = `
;; ── Scopes ────────────────────────────────────────────────────────────────

(program) @scope.module

;; Both block-scoped and statement-scoped namespace declarations.
(namespace_definition) @scope.namespace

(class_declaration)     @scope.class
(interface_declaration) @scope.class
(trait_declaration)     @scope.class
(enum_declaration)      @scope.class

(method_declaration)                        @scope.function
(function_definition)                       @scope.function
(anonymous_function)                        @scope.function
(arrow_function)                            @scope.function

;; ── Declarations — types ──────────────────────────────────────────────────

(class_declaration
  name: (name) @declaration.name) @declaration.class

(interface_declaration
  name: (name) @declaration.name) @declaration.interface

(trait_declaration
  name: (name) @declaration.name) @declaration.trait

(enum_declaration
  name: (name) @declaration.name) @declaration.enum

;; ── Declarations — methods / functions / constructors ─────────────────────

(method_declaration
  name: (name) @declaration.name) @declaration.method

(function_definition
  name: (name) @declaration.name) @declaration.function

;; ── Declarations — properties ─────────────────────────────────────────────

;; PHP 7.4+ typed property: private UserRepo $repo;
;; property_element has name: (variable_name) field.
;; Emits BOTH a declaration (so SemanticModel registers the property) AND a type-binding.
(property_declaration
  type: (_) @type-binding.type
  (property_element
    name: (variable_name) @type-binding.name)) @type-binding.annotation

(property_declaration
  type: (_)
  (property_element
    name: (variable_name) @declaration.name)) @declaration.property

;; Untyped property: public $id; — capture as plain declaration.
(property_declaration
  (property_element
    name: (variable_name) @declaration.name)) @declaration.variable

;; ── Imports — namespace_use_declaration ───────────────────────────────────
;;
;; Captures ALL forms: plain, alias, function/const qualifiers, and grouped.
;; The import-decomposer in captures.ts fans out grouped uses.
;;
;; NOTE: class-body use_declaration = trait-use, NOT an import.
;; Only namespace_use_declaration (top-level / namespace scope) is an import.

(namespace_use_declaration) @import.statement

;; ── Type bindings — parameters ────────────────────────────────────────────

;; simple_parameter with a type hint: function f(User $u)
;; type field is a 'type' supertype (named_type, optional_type, union_type, etc.)
(simple_parameter
  type: (_) @type-binding.type
  name: (variable_name) @type-binding.name) @type-binding.parameter

;; property_promotion_parameter: function __construct(private User $u)
;; Emits type-binding so the constructor body can resolve $u as the typed param.
(property_promotion_parameter
  type: (_) @type-binding.type
  name: (variable_name) @type-binding.name) @type-binding.parameter

;; Also emit a @type-binding.annotation for the promoted parameter so that
;; phpBindingScopeFor can hoist it to the Class scope (stripping the $ sigil).
;; This enables compound-receiver resolution: $user->address->save() resolves
;; address → Address via the Class scope's typeBindings.
;; The @type-binding.parameter above stays for constructor-body resolution ($address).
(property_promotion_parameter
  type: (_) @type-binding.type
  name: (variable_name) @type-binding.name) @type-binding.annotation

;; Also emit a @declaration.property so SemanticModel registers the promoted
;; parameter as a class-owned property (enabling $obj->propName lookups).
(property_promotion_parameter
  name: (variable_name) @declaration.name) @declaration.property

;; ── Type bindings — local assignment: $u = new User() ─────────────────────

;; new ClassName() — name is a direct child of object_creation_expression
(assignment_expression
  left: (variable_name) @type-binding.name
  right: (object_creation_expression
    (name) @type-binding.type)) @type-binding.constructor

;; new Foo\Bar\ClassName() — qualified_name wraps name
(assignment_expression
  left: (variable_name) @type-binding.name
  right: (object_creation_expression
    (qualified_name
      (name) @type-binding.type))) @type-binding.constructor

;; ── Type bindings — $alias = $u (identifier alias) ───────────────────────

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (variable_name) @type-binding.type) @type-binding.alias

;; ── Type bindings — $u = factory() (free call return alias) ──────────────

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (function_call_expression
    function: (name) @type-binding.type)) @type-binding.alias

;; ── Type bindings — $u = $svc->getUser() (method call return alias) ───────

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (member_call_expression
    name: (name) @type-binding.type)) @type-binding.alias

;; ── Type bindings — method return type ───────────────────────────────────

;; method_declaration exposes return_type: field (type node supertype).
;; named_type wraps the class name: function getUser(): User
(method_declaration
  name: (name) @type-binding.name
  return_type: (named_type
    (name) @type-binding.type)) @type-binding.return

;; nullable return type via optional_type: function getUser(): ?User
(method_declaration
  name: (name) @type-binding.name
  return_type: (optional_type
    (named_type
      (name) @type-binding.type))) @type-binding.return

;; function_definition (top-level or namespace-level) return type: User
;; Enables cross-file return-type propagation for free functions.
(function_definition
  name: (name) @type-binding.name
  return_type: (named_type
    (name) @type-binding.type)) @type-binding.return

;; nullable return type for function_definition: ?User
(function_definition
  name: (name) @type-binding.name
  return_type: (optional_type
    (named_type
      (name) @type-binding.type))) @type-binding.return

;; ── References — free calls: foo() ───────────────────────────────────────

(function_call_expression
  function: (name) @reference.name) @reference.call.free

;; ── References — member calls: $obj->method() ────────────────────────────
;;
;; SAFETY-INVARIANT (Finding 1 of PR #1497 adversarial review): the name:
;; field is constrained to (name), NOT (_) — tree-sitter-php emits
;; variable_name nodes for dynamic method names ($obj->$method(),
;; $obj->{$method}()). Keeping the pattern at (name) is what suppresses
;; capture of those dynamic shapes. The resolver is structural-only and
;; cannot infer the bound method name from runtime values; relaxing this
;; pattern to (_) would silently emit zero-confidence false-positive
;; edges. Regression: test/fixtures/lang-resolution/php-dynamic-calls/.

(member_call_expression
  object: (_) @reference.receiver
  name: (name) @reference.name) @reference.call.member

;; ── References — null-safe member calls: $obj?->method() (PHP 8+) ─────────

(nullsafe_member_call_expression
  object: (_) @reference.receiver
  name: (name) @reference.name) @reference.call.member

;; ── References — static calls: X::method() ───────────────────────────────
;;
;; Same SAFETY-INVARIANT as member_call_expression above: name: (name)
;; deliberately excludes variable_name so Class::$method() and
;; $className::$method() shapes do not capture. The receiver field uses
;; (_) because static dispatch on a variable receiver
;; ($className::method()) IS captured — but resolution falls through
;; harmlessly when $className has no class type binding. See
;; php-dynamic-calls/ regression suite.

(scoped_call_expression
  scope: (_) @reference.receiver
  name: (name) @reference.name) @reference.call.member

;; ── Type bindings — $x = X::Constant or $x = X::CASE (enum case) ─────────
;; Binds the variable to the class name X so member calls on $x dispatch
;; to X's methods (e.g. UserRole::Viewer → label()).
;;
;; tree-sitter-php emits class_constant_access_expression with two name
;; children: [0]=class/enum name, [1]=constant/case name. The dot-anchor
;; before (name) matches only the FIRST name child (the class).

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (class_constant_access_expression
    . (name) @type-binding.type)) @type-binding.alias

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (class_constant_access_expression
    (qualified_name
      (name) @type-binding.type))) @type-binding.alias

;; ── Type bindings — $x = SomeClass::staticFactory() ──────────────────────
;; Binds $x to the type returned by the static factory method, anchored on
;; the method name (chain-follow resolves the actual return type later).

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (scoped_call_expression
    name: (name) @type-binding.type)) @type-binding.alias

;; ── Type bindings — null-safe member-call result: $x = $a?->getY() ───────

(assignment_expression
  left: (variable_name) @type-binding.name
  right: (nullsafe_member_call_expression
    name: (name) @type-binding.type)) @type-binding.alias

;; ── References — constructor calls: new User() ───────────────────────────

(object_creation_expression
  (name) @reference.name) @reference.call.constructor

(object_creation_expression
  (qualified_name
    (name) @reference.name)) @reference.call.constructor

;; ── References — member writes: $obj->prop = $x ──────────────────────────

(assignment_expression
  left: (member_access_expression
    object: (_) @reference.receiver
    name: (name) @reference.name)) @reference.write.member

;; ── References — static property writes: User::$count = $x ──────────────
;; Uses @reference.write.static anchor so captures.ts can strip the leading
;; $ from the variable_name capture (static props are stored without $ in graph).
;;
;; SAFETY-INVARIANT (Finding 2 of PR #1497 adversarial review): no
;; read-access property capture exists in this query — dynamic property
;; reads ($obj->$prop, $obj->{$prop}) produce no captures, which is the
;; desired behavior for a structural-only resolver. Adding a read pattern
;; in the future MUST keep name: (name) (not (_)) to preserve the
;; suppression. Regression: php-dynamic-calls/ fixture dynamicPropertyRead.

(assignment_expression
  left: (scoped_property_access_expression
    scope: (_) @reference.receiver
    name: (variable_name) @reference.name)) @reference.write.static
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getPhpParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(PHP_LANG as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getPhpScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(PHP_LANG as Parameters<Parser['setLanguage']>[0], PHP_SCOPE_QUERY);
  }
  return _query;
}
