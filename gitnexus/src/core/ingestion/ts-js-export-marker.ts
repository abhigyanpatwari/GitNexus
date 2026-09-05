/**
 * Export evidence for ECMAScript declarations — the `@declaration.is-exported`
 * marker both the TypeScript and the JavaScript capture emitters synthesize.
 *
 * `SymbolDefinition.isExported` is tri-state, and this is where the three
 * states are decided for TS/JS:
 *
 *  - `true`  — the declaration sits under an `export_statement` (`export
 *              function f`, `export const x`, `export default class`), or the
 *              file names it in an `export { f }` / `export { f as g }` clause
 *              or an `export default f` / `export = f` statement.
 *  - `false` — an ESM-shaped file (no CommonJS export assignment) that does
 *              neither. The declaration is module-private: `export *` cannot
 *              republish it and it must not be counted as a wildcard provider.
 *  - no verdict — the file exports through CommonJS (`module.exports = …`,
 *              `exports.x = …`, top-level `this.x = …`) or is an ambient
 *              `.d.ts`, where "not under `export`" says nothing about what the
 *              module publishes. Nothing is emitted, and the reader keeps its
 *              prior behavior. One CommonJS shape IS decidable and gets `true`:
 *              a method or property declared directly in the object literal
 *              assigned to `module.exports` (`module.exports = { alpha() {} }`)
 *              is that module's export of `alpha`.
 *
 * Only a declaration reached from the top level through DECLARATION nodes can
 * be a module export. The walk therefore stops with `false` at the first
 * nesting boundary — a class body, an interface/enum body, a function body, an
 * object literal that is not the `module.exports` value: `export class C {
 * m() {} }` exports `C`, not `m`; `function w() { function s() {} }` exports
 * nothing even when the file has `export { s }` for a different `s`.
 *
 * The ancestor walk here is deliberately NOT `tsExportChecker`
 * (`export-detection.ts`): that checker's text fallback (`text.startsWith('export ')`)
 * fires on the `program` node of any file whose first token is `export`, which
 * would mark every declaration in such a file exported.
 */

import type { SyntaxNode } from './utils/ast-helpers.js';

export interface EsmExportEvidence {
  /** Local names published by `export { … }`, `export default <id>`, `export = <id>`. */
  readonly namedLocals: ReadonlySet<string>;
  /** The file exports through a CommonJS assignment: a plain "not under
   *  `export`" is no verdict there. */
  readonly commonJs: boolean;
}

const CJS_EXPORT_ASSIGNMENT = /^\s*(module\.exports\b|exports\s*[.[]|this\.[A-Za-z_$][\w$]*\s*=)/;
const CJS_SURFACE = /\bmodule\.exports\b|\bexports\s*[.[=]/;

/** Node types below which a declaration is nested, not module-level. */
const NESTING_BOUNDARIES: ReadonlySet<string> = new Set([
  'class_body',
  'interface_body',
  'enum_body',
  'object_type',
  'statement_block',
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'internal_module',
]);

/**
 * Scan a file's top level once. `undefined` means the file's export surface
 * cannot be read at all (ambient `.d.ts`), so no marker should be emitted.
 */
export function collectEsmExportEvidence(
  root: SyntaxNode,
  filePath: string,
): EsmExportEvidence | undefined {
  if (filePath.endsWith('.d.ts')) return undefined;
  const namedLocals = new Set<string>();
  // Any CommonJS export surface anywhere in the file — a direct `module.exports
  // = …`, an alias (`const m = module.exports; m.x = …`), an `exports.x` — means
  // "not under `export`" says nothing. Text-level on purpose: the alias forms
  // are open-ended and a missed one would mark a real export private.
  let commonJs = CJS_SURFACE.test(root.text);
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') {
      for (const child of stmt.namedChildren) {
        if (child.type === 'export_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name')?.text;
            if (name !== undefined && name !== '') namedLocals.add(name);
          }
        } else if (child.type === 'identifier') {
          // `export default f;` and TS `export = f;`.
          namedLocals.add(child.text);
        }
      }
    } else if (stmt.type === 'expression_statement' && CJS_EXPORT_ASSIGNMENT.test(stmt.text)) {
      commonJs = true;
    }
  }
  return { namedLocals, commonJs };
}

/** Is `object` the value of a top-level `module.exports = { … }` assignment? */
function isModuleExportsObject(object: SyntaxNode): boolean {
  const assignment = object.parent;
  if (assignment === null || assignment.type !== 'assignment_expression') return false;
  if (assignment.childForFieldName('right')?.id !== object.id) return false;
  const left = assignment.childForFieldName('left');
  if (left === null || left.type !== 'member_expression') return false;
  if (left.childForFieldName('object')?.text !== 'module') return false;
  if (left.childForFieldName('property')?.text !== 'exports') return false;
  return (
    assignment.parent?.type === 'expression_statement' &&
    assignment.parent.parent?.type === 'program'
  );
}

/**
 * The export verdict for a declaration whose NAME node is `nameNode`:
 * `true` / `false` as documented in the header, `undefined` when this file's
 * export surface cannot decide it (CommonJS, other than the `module.exports`
 * object literal itself).
 */
export function esmExportVerdict(
  nameNode: SyntaxNode,
  evidence: EsmExportEvidence,
): boolean | undefined {
  // The name node's own declaration node is where the walk starts; the
  // declaration itself (a `method_definition`, a `function_declaration`) must
  // not count as its own nesting boundary.
  let current: SyntaxNode | null = nameNode.parent;
  while (current !== null && current.type !== 'program') {
    if (current.type === 'export_statement') return true;
    if (current.type === 'object') {
      // `module.exports = { alpha() {} }`: the literal's own members are the
      // module's exports. Any other object literal is a nesting boundary.
      if (isModuleExportsObject(current) && nameNode.parent?.parent?.id === current.id) return true;
      return evidence.commonJs ? undefined : false;
    }
    if (NESTING_BOUNDARIES.has(current.type) && current.id !== nameNode.parent?.id) {
      return evidence.commonJs ? undefined : false;
    }
    current = current.parent;
  }
  if (evidence.commonJs) return undefined;
  return evidence.namedLocals.has(nameNode.text);
}
