/**
 * Shadowed CommonJS export-assignment detection (issue #2723).
 *
 * The CJS declaration rules in the JS/TS scope queries bind the bare property
 * name of `exports.X = function () {}` / `module.exports.X = (a) => a` into the
 * enclosing module scope, so importers resolve to it by name. That is the whole
 * point of #2723 — without it the graph node exists and nothing resolves to it.
 *
 * But a file may ALSO declare that same name lexically:
 *
 *   function dup(v) { return v; }
 *   exports.dup = function (v) { return !v; };
 *   function callIt(v) { return dup(v); }
 *
 * Then the module scope holds TWO declarations named `dup`, the name is
 * ambiguous, and the resolver drops `callIt -> dup` altogether — an edge that
 * resolved fine before #2723. A silently missing caller is worse than the gap
 * #2723 set out to close, so the emitter drops the CJS declaration in exactly
 * this case: the lexical declaration already supplies the module-scope name,
 * so importers still resolve, and intra-module resolution is unchanged from
 * before #2723.
 *
 * Only the `@declaration.function` match is suppressed. The graph node comes
 * from a separate query (`tree-sitter-queries.ts`) and collapses onto the
 * lexical declaration's node by name anyway, so no node is lost.
 *
 * Shared by both the JavaScript and TypeScript capture emitters — every
 * grammar node named here (`assignment_expression`, `member_expression`,
 * `property_identifier`, `function_declaration`, `lexical_declaration`,
 * `variable_declaration`, `export_statement`) exists in both
 * `tree-sitter-javascript` and `tree-sitter-typescript`.
 *
 * Pure given the input nodes. No I/O, no globals; the cache is keyed on the
 * root node it derives from, so it cannot outlive its tree.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Module-scope declared names per program root.
 *
 * Memoized because the emitter asks once per CJS export match: a file with
 * 1000 `exports.X = function () {}` lines would otherwise re-walk the top
 * level 1000 times, which is the O(n²) shape that has bitten this repo's
 * scope capture before. Keyed on the root `SyntaxNode`, so it is dropped with
 * the tree.
 */
const moduleScopeNamesByRoot = new WeakMap<SyntaxNode, Set<string>>();

/** Declaration nodes whose name binds directly in the enclosing scope. */
const NAMED_DECLARATION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
]);

/** Declaration nodes that carry one or more `variable_declarator` children. */
const VARIABLE_DECLARATION_TYPES = new Set(['lexical_declaration', 'variable_declaration']);

/**
 * Identifiers bound to the exports object at module scope, per program root.
 *
 * `const e = exports;` / `const e = module.exports;` makes `e.foo = fn` an
 * export just as surely as `exports.foo = fn`. The queries cannot express
 * "an identifier that happens to alias exports", so they match any identifier
 * receiver and the emitters prune here.
 *
 * Memoized for the same reason as {@link moduleScopeDeclaredNames}: asked once
 * per candidate assignment, and a large CommonJS module has many.
 */
const exportAliasesByRoot = new WeakMap<SyntaxNode, Set<string>>();

/** True when `node` is the `exports` / `module.exports` object itself. */
function isExportsObjectExpression(node: SyntaxNode): boolean {
  if (node.type === 'identifier') return node.text === 'exports';
  if (node.type !== 'member_expression') return false;
  return (
    node.childForFieldName('object')?.text === 'module' &&
    node.childForFieldName('property')?.text === 'exports'
  );
}

/** The set of module-scope identifiers aliasing the exports object. */
function exportAliases(root: SyntaxNode): Set<string> {
  const cached = exportAliasesByRoot.get(root);
  if (cached !== undefined) return cached;

  const aliases = new Set<string>();
  for (const child of root.namedChildren) {
    if (!VARIABLE_DECLARATION_TYPES.has(child.type)) continue;
    for (const declarator of child.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (name === null || name.type !== 'identifier' || value === null) continue;
      if (isExportsObjectExpression(value)) aliases.add(name.text);
    }
  }

  exportAliasesByRoot.set(root, aliases);
  return aliases;
}

/** Collect the names `node` binds into its enclosing scope, into `out`. */
function collectDeclaredNames(node: SyntaxNode, out: Set<string>): void {
  if (NAMED_DECLARATION_TYPES.has(node.type)) {
    const name = node.childForFieldName('name');
    if (name !== null && name.type === 'identifier') out.add(name.text);
    return;
  }

  if (VARIABLE_DECLARATION_TYPES.has(node.type)) {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      // Destructuring patterns bind several names; they never collide with a
      // CJS export assignment's single property name in a way this guard
      // needs to model, so only plain identifiers are collected.
      if (name !== null && name.type === 'identifier') out.add(name.text);
    }
    return;
  }

  // `export function f() {}` / `export const f = …` — the binding is the
  // wrapped declaration's, so recurse one level through the wrapper.
  if (node.type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration !== null) collectDeclaredNames(declaration, out);
  }
}

/** The set of names declared at module scope (top level) of `root`. */
function moduleScopeDeclaredNames(root: SyntaxNode): Set<string> {
  const cached = moduleScopeNamesByRoot.get(root);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  for (const child of root.namedChildren) collectDeclaredNames(child, names);

  moduleScopeNamesByRoot.set(root, names);
  return names;
}

/**
 * The property name of the `exports.X = …` / `module.exports.X = …` assignment
 * whose right-hand side is `node`, or null when `node` is not such a value.
 *
 * Mirrors the receiver pinning in the scope queries: a bare `exports` receiver,
 * or a `module.exports` member expression. Any other receiver (`Foo.prototype`,
 * `this`, an aliased `const e = exports`) returns null, so this guard never
 * fires for a construct the CJS declaration rules did not create.
 */
function cjsExportedPropertyName(node: SyntaxNode, root?: SyntaxNode): string | null {
  const assignment = node.parent;
  if (assignment === null || assignment.type !== 'assignment_expression') return null;
  if (assignment.childForFieldName('right')?.id !== node.id) return null;

  const left = assignment.childForFieldName('left');
  if (left === null || left.type !== 'member_expression') return null;

  const property = left.childForFieldName('property');
  if (property === null || property.type !== 'property_identifier') return null;

  const receiver = left.childForFieldName('object');
  if (receiver === null) return null;

  if (isExportsObjectExpression(receiver)) return property.text;

  // An identifier aliasing the exports object (`const e = exports; e.foo = fn`).
  // Only consulted when a root is supplied, so the shadow guard — which asks
  // about a receiver it has already pinned — keeps its cheaper path.
  if (
    receiver.type === 'identifier' &&
    root !== undefined &&
    exportAliases(root).has(receiver.text)
  )
    return property.text;

  return null;
}

/**
 * The name this assignment exports, or null when it exports nothing.
 *
 * Takes the VALUE node (the function literal) and the program root, because
 * alias resolution is a whole-file question. Used by the capture emitters to
 * keep the widened `<identifier>.X = fn` match only when the receiver really
 * is the exports object.
 */
export function cjsExportedNameFor(node: SyntaxNode, root: SyntaxNode): string | null {
  return cjsExportedPropertyName(node, root);
}

/**
 * True when `node` is the value of a `<identifier>.<member> = fn` assignment
 * whose receiver is NOT the exports object — the over-match the widened
 * member-assignment rule accepts so an `exports` alias can be recognised.
 *
 * Such a receiver declares nothing at module scope: `obj.handler = fn` binds a
 * property of `obj`, not a module symbol named `handler`. Prototype and `this`
 * receivers are not identifiers, so they never reach this guard and keep their
 * own (Method) treatment.
 */
export function isUnexportedMemberAssignmentValue(node: SyntaxNode, root: SyntaxNode): boolean {
  const assignment = node.parent;
  if (assignment === null || assignment.type !== 'assignment_expression') return false;
  if (assignment.childForFieldName('right')?.id !== node.id) return false;

  const left = assignment.childForFieldName('left');
  if (left === null || left.type !== 'member_expression') return false;
  if (left.childForFieldName('object')?.type !== 'identifier') return false;

  return cjsExportedPropertyName(node, root) === null;
}

/**
 * True when `node` (an `arrow_function` / `function_expression` /
 * `generator_function`) is the value of a CJS export assignment whose property
 * name is ALREADY declared at module scope of `root`.
 *
 * False for a CJS export whose name is declared only by the assignment (the
 * ordinary #2723 case — the declaration must be emitted), and false for
 * anything that is not a CJS export assignment at all.
 */
export function isShadowedCjsExportAssignment(node: SyntaxNode, root: SyntaxNode): boolean {
  const exportedName = cjsExportedPropertyName(node);
  if (exportedName === null) return false;

  return moduleScopeDeclaredNames(root).has(exportedName);
}

/**
 * Same question as {@link isShadowedCjsExportAssignment}, asked of the
 * ASSIGNMENT node rather than its value — the shape `provider.labelOverride`
 * receives, since the graph-node capture is anchored on the assignment.
 *
 * Used to drop the graph node too, not just the scope declaration. When the
 * shadowed name is a `function`, the node collapsed onto the lexical
 * declaration's node anyway (same label, same id), but a `class Dup {}` plus
 * `exports.Dup = function () {}` produced `Class:f:Dup` AND an orphan
 * `Function:f:Dup` — a node nothing can reach, because the declaration that
 * would have made it reachable is suppressed by the rule above.
 */
export function isShadowedCjsExportAssignmentNode(node: SyntaxNode, root: SyntaxNode): boolean {
  if (node.type !== 'assignment_expression') return false;
  const value = node.childForFieldName('right');
  if (value === null) return false;
  return isShadowedCjsExportAssignment(value, root);
}

// `Foo.prototype.bar = function () {}` is handled as a MEMBER assignment — see
// `prototypeAssignmentOwnerName` / `findMemberAssignmentOwnerInfo` in
// `utils/ast-helpers.ts`, next to the object-literal owner helper it mirrors.
