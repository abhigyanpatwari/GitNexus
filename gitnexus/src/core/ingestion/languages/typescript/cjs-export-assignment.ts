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
function cjsExportedPropertyName(node: SyntaxNode): string | null {
  const assignment = node.parent;
  if (assignment === null || assignment.type !== 'assignment_expression') return null;
  if (assignment.childForFieldName('right')?.id !== node.id) return null;

  const left = assignment.childForFieldName('left');
  if (left === null || left.type !== 'member_expression') return null;

  const property = left.childForFieldName('property');
  if (property === null || property.type !== 'property_identifier') return null;

  const receiver = left.childForFieldName('object');
  if (receiver === null) return null;

  if (receiver.type === 'identifier' && receiver.text === 'exports') return property.text;

  if (receiver.type === 'member_expression') {
    const base = receiver.childForFieldName('object');
    const member = receiver.childForFieldName('property');
    if (
      base !== null &&
      base.type === 'identifier' &&
      base.text === 'module' &&
      member !== null &&
      member.text === 'exports'
    ) {
      return property.text;
    }
  }

  return null;
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
