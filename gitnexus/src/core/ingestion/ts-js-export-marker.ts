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

const CJS_EXPORT_ASSIGNMENT = /^\s*(this\.[A-Za-z_$][\w$]*\s*=)/;

/** Read binding patterns, never initializer expressions or property keys. */
function bindsReceiver(node: SyntaxNode | null, name: string): boolean {
  if (node === null) return false;
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
    return node.text === name;
  }
  if (node.type === 'variable_declarator')
    return bindsReceiver(node.childForFieldName('name'), name);
  if (node.type === 'assignment_pattern')
    return bindsReceiver(node.childForFieldName('left'), name);
  if (node.type === 'pair_pattern') return bindsReceiver(node.childForFieldName('value'), name);
  if (node.type === 'import_specifier') {
    return bindsReceiver(node.childForFieldName('alias') ?? node.childForFieldName('name'), name);
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    return bindsReceiver(node.childForFieldName('pattern'), name);
  }
  return (
    [
      'formal_parameters',
      'object_pattern',
      'array_pattern',
      'rest_pattern',
      'import_clause',
      'named_imports',
      'namespace_import',
    ].includes(node.type) && node.namedChildren.some((child) => bindsReceiver(child, name))
  );
}

/** A locally bound `module`/`exports` is not Node's export receiver. */
function isExportReceiverShadowed(node: SyntaxNode, name: string): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (
      ['function_expression', 'generator_function', 'class'].includes(scope.type) &&
      scope.childForFieldName('name')?.text === name
    )
      return true;
    if (
      bindsReceiver(scope.childForFieldName('parameters'), name) ||
      bindsReceiver(scope.childForFieldName('parameter'), name)
    )
      return true;
    if (scope.type !== 'program' && scope.type !== 'statement_block') continue;
    for (const statement of scope.namedChildren) {
      const declaration =
        statement.type === 'export_statement'
          ? statement.childForFieldName('declaration')
          : statement;
      if (declaration === null) continue;
      if (
        declaration.type === 'import_statement' &&
        declaration.namedChildren.some(
          (child) => child.type === 'import_clause' && bindsReceiver(child, name),
        )
      )
        return true;
      if (
        declaration.type === 'lexical_declaration' ||
        declaration.type === 'variable_declaration'
      ) {
        if (declaration.namedChildren.some((child) => bindsReceiver(child, name))) return true;
      } else if (
        ['function_declaration', 'class_declaration'].includes(declaration.type) &&
        declaration.childForFieldName('name')?.text === name
      )
        return true;
    }
  }
  return false;
}

/** Static dot and bracket spellings of the same CommonJS export object. */
function isModuleExportsReference(node: SyntaxNode): boolean {
  const object = node.childForFieldName('object');
  if (
    object?.type !== 'identifier' ||
    object.text !== 'module' ||
    isExportReceiverShadowed(node, 'module')
  )
    return false;
  if (node.type === 'member_expression') {
    return node.childForFieldName('property')?.text === 'exports';
  }
  if (node.type !== 'subscript_expression') return false;
  const index = node.childForFieldName('index');
  return index?.type === 'string' && (index.text === "'exports'" || index.text === '"exports"');
}

/**
 * Does the file touch a CommonJS export object anywhere — `module.exports` or
 * `exports.x` / `exports[x]` — as an actual expression? Read from AST nodes,
 * not source text, so a comment or string mentioning `module.exports` does not
 * disable the file's verdicts.
 */
function hasCommonJsExportSurface(root: SyntaxNode): boolean {
  for (const member of root.descendantsOfType('member_expression')) {
    const object = member.childForFieldName('object');
    if (object === null) continue;
    if (
      object.type === 'identifier' &&
      object.text === 'exports' &&
      !isExportReceiverShadowed(member, 'exports')
    )
      return true;
    if (isModuleExportsReference(member)) return true;
  }
  for (const sub of root.descendantsOfType('subscript_expression')) {
    const object = sub.childForFieldName('object');
    if (
      object?.type === 'identifier' &&
      object.text === 'exports' &&
      !isExportReceiverShadowed(sub, 'exports')
    )
      return true;
    if (isModuleExportsReference(sub)) return true;
  }
  return false;
}

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
  // `export namespace NS { export function f() {} }` / `declare module 'x' {
  // export function q(): void }`: an `export` inside these bodies is an export
  // of the namespace/ambient module, not of the file.
  'internal_module',
  'module',
  'ambient_declaration',
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
  // "not under `export`" says nothing.
  let commonJs = hasCommonJsExportSurface(root);
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') {
      // `export { a } from './x'` / `export type { T } from './t'` re-export
      // ANOTHER module's names: they say nothing about a local `a`, and adding
      // them here marked a private local of the same name exported.
      if (stmt.childForFieldName('source') !== null) continue;
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
  if (left === null || !isModuleExportsReference(left)) return false;
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
  // An `export` keyword is only a FILE-level export when the walk reaches the
  // program without crossing a nesting boundary — one inside a namespace or
  // ambient-module body is that container's export (see NESTING_BOUNDARIES).
  let underExport = false;
  while (current !== null && current.type !== 'program') {
    if (current.type === 'export_statement') {
      underExport = true;
      current = current.parent;
      continue;
    }
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
  if (underExport) return true;
  if (evidence.commonJs) return undefined;
  return evidence.namedLocals.has(nameNode.text);
}
