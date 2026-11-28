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

import type { Capture, SymbolDefinition } from 'gitnexus-shared';
import { canonicalModuleExportName, decodeIdentifierEscapes } from './utils/ecmascript-literals.js';
import { sourceRangeKey, syntheticCapture, type SyntaxNode } from './utils/ast-helpers.js';

interface LocalExportSpecifier {
  readonly publicName: SyntaxNode;
  readonly typeOnly: boolean;
}

type EsmPublication = Pick<
  SymbolDefinition,
  'namedExports' | 'typeOnlyExports' | 'isDefaultExport'
>;

export type ConditionalEsmExports = {
  readonly hasModuleSyntax: boolean;
  readonly declarations: Record<string, EsmPublication>;
};

export interface EsmExportEvidence {
  /** Local names published by `export { … }`, `export default <id>`, `export = <id>`. */
  readonly namedLocals: ReadonlySet<string>;
  /** Source-less export specifiers, keyed by the canonical local binding. */
  readonly localSpecifiers?: ReadonlyMap<string, readonly LocalExportSpecifier[]>;
  /** The file exports through a CommonJS assignment: a plain "not under
   *  `export`" is no verdict there. */
  readonly commonJs: boolean;
  /** Positive ESM declarations for a mixed file whose package or compiler determines the format. */
  readonly conditionalEsmExports?: ConditionalEsmExports;
  /** Local published as the default export by `export default <id>` or
   *  `export { <id> as default }`. */
  readonly defaultLocal: string | undefined;
}

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
    if (scope.type === 'for_in_statement' || scope.type === 'for_of_statement') {
      if (bindsReceiver(scope.childForFieldName('left'), name)) return true;
    }
    if (scope.type === 'for_statement') {
      const initializer = scope.childForFieldName('initializer');
      if (
        initializer !== null &&
        (initializer.type === 'lexical_declaration' ||
          initializer.type === 'variable_declaration') &&
        initializer.namedChildren.some((child) => bindsReceiver(child, name))
      )
        return true;
    }
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

/**
 * Top-level control-flow wrappers around `this.x =` / `this['x'] =`.
 * Recurse through these only — a function or class body is a different `this`.
 */
const TOP_LEVEL_THIS_WALK: ReadonlySet<string> = new Set([
  'if_statement',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'switch_body',
  'switch_case',
  'switch_default',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'labeled_statement',
  'statement_block',
]);

/** Module-wrapper `this.x =` / `this['x'] =` as a statement. */
function isThisExportAssignment(stmt: SyntaxNode): boolean {
  if (stmt.type !== 'expression_statement') return false;
  const assignment = stmt.namedChildren[0];
  const left =
    assignment?.type === 'assignment_expression' ? assignment.childForFieldName('left') : null;
  return (
    left !== null &&
    (left.type === 'member_expression' || left.type === 'subscript_expression') &&
    left.childForFieldName('object')?.type === 'this'
  );
}

/**
 * A top-level `this` export, including `if (enabled) this.api = api` and the
 * braced form. Does not walk into function or class bodies.
 */
function hasTopLevelThisExportAssignment(stmt: SyntaxNode): boolean {
  if (isThisExportAssignment(stmt)) return true;
  if (!TOP_LEVEL_THIS_WALK.has(stmt.type)) return false;
  return stmt.namedChildren.some(hasTopLevelThisExportAssignment);
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
  // `ambient_declaration` only wraps `declare`: an exported class/function
  // under it is still a file export. Ambient module bodies remain bounded by
  // their `module`/`internal_module` and `statement_block` nodes above.
]);

/** Static module declarations and import.meta are module syntax; import() also runs in scripts. */
export function hasEsmSyntax(root: SyntaxNode, sourceText?: string): boolean {
  return (
    root.namedChildren.some(
      (stmt) => stmt.type === 'import_statement' || stmt.type === 'export_statement',
    ) ||
    ((sourceText === undefined || sourceText.includes('import')) &&
      root.descendantsOfType('meta_property').some((meta) => meta.firstChild?.type === 'import'))
  );
}

/** Source-less export clauses bind each public spelling to a local declaration. */
export function* localExportSpecifiers(statement: SyntaxNode, clause: SyntaxNode) {
  const erased = statement.children.some((token) => token.type === 'type');
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const local = spec.childForFieldName('name');
    if (!local) continue;
    yield {
      name: decodeIdentifierEscapes(local.text),
      publicName: spec.childForFieldName('alias') ?? local,
      typeOnly: erased || spec.children.some((token) => token.type === 'type'),
    };
  }
}

/**
 * Scan a file's top level once. `undefined` means the file's export surface
 * cannot be read at all (ambient `.d.ts`), so no marker should be emitted.
 */
export function collectEsmExportEvidence(
  root: SyntaxNode,
  filePath: string,
  sourceText?: string,
  format?: 'commonjs' | 'esm',
): EsmExportEvidence | undefined {
  if (filePath.endsWith('.d.ts')) return undefined;
  const namedLocals = new Set<string>();
  let localSpecifiers: Map<string, LocalExportSpecifier[]> | undefined;
  // Every local named as the default; two different ones (invalid input) name none.
  const defaultLocals = new Set<string>();
  // Any CommonJS export surface anywhere in the file — a direct `module.exports
  // = …`, an alias (`const m = module.exports; m.x = …`), an `exports.x` — means
  // "not under `export`" says nothing.
  let commonJs = format !== 'esm' && hasCommonJsExportSurface(root);
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') {
      // `export { a } from './x'` / `export type { T } from './t'` re-export
      // ANOTHER module's names: they say nothing about a local `a`, and adding
      // them here marked a private local of the same name exported.
      if (stmt.childForFieldName('source') !== null) continue;
      for (const child of stmt.namedChildren) {
        if (child.type === 'export_clause') {
          for (const { name, publicName, typeOnly } of localExportSpecifiers(stmt, child)) {
            namedLocals.add(name);
            localSpecifiers ??= new Map();
            let entries = localSpecifiers.get(name);
            if (!entries) {
              entries = [];
              localSpecifiers.set(name, entries);
            }
            entries.push({ publicName, typeOnly });
            if (!typeOnly && canonicalModuleExportName(publicName.text) === 'default')
              defaultLocals.add(name);
          }
        } else if (child.type === 'identifier') {
          // `export default f;` and TS `export = f;`. Only the former names a
          // default: `export =` binds `import X from` only under esModuleInterop.
          namedLocals.add(decodeIdentifierEscapes(child.text));
          if (isDefaultExportStatement(stmt))
            defaultLocals.add(decodeIdentifierEscapes(child.text));
        }
      }
    } else if (format !== 'esm' && hasTopLevelThisExportAssignment(stmt)) {
      commonJs = true;
    }
  }
  const [defaultLocal] = defaultLocals.size === 1 ? defaultLocals : [];
  return {
    namedLocals,
    localSpecifiers,
    commonJs,
    defaultLocal,
    ...(commonJs &&
      format !== 'commonjs' && {
        conditionalEsmExports: {
          hasModuleSyntax: hasEsmSyntax(root, sourceText),
          declarations: {},
        },
      }),
  };
}

function isDefaultExportStatement(stmt: SyntaxNode): boolean {
  return stmt.children.some((child) => child.type === 'default');
}

/**
 * Is the declaration named by `nameNode` the module's default export — either
 * written as `export default function f` / `export default class C`, or named
 * by `export default f` / `export { f as default }`? Call it only for
 * declarations whose export verdict is `true`, which keeps class members and
 * nested functions of the same name out.
 */
export function isEsmDefaultExport(nameNode: SyntaxNode, evidence: EsmExportEvidence): boolean {
  if (nameNode.type === 'default' && nameNode.parent?.type === 'export_statement') return true;
  if (
    evidence.defaultLocal !== undefined &&
    evidence.defaultLocal === decodeIdentifierEscapes(nameNode.text)
  )
    return true;
  const declaration = nameNode.parent;
  const statement = declaration?.parent;
  return (
    statement?.type === 'export_statement' &&
    statement.childForFieldName('declaration')?.id === declaration?.id &&
    isDefaultExportStatement(statement)
  );
}

function hasNamedExportDeclaration(nameNode: SyntaxNode): boolean {
  for (let declaration = nameNode.parent; declaration !== null; declaration = declaration.parent) {
    const statement = declaration.parent;
    if (
      statement?.type === 'export_statement' &&
      statement.childForFieldName('declaration')?.id === declaration.id
    ) {
      return !isDefaultExportStatement(statement);
    }
  }
  return false;
}

function removeValueExports(erased: Set<string>, names: ReadonlySet<string>): void {
  if (erased.size === 0) return;
  for (const spelling of names) {
    const canonical = canonicalModuleExportName(spelling);
    if (canonical !== null) erased.delete(canonical);
  }
}

/** Explicit public spellings for an aliased or default binding. */
export function namedEsmPublications(
  nameNode: SyntaxNode,
  evidence: EsmExportEvidence,
  isDefault: boolean,
): { namedExports: string[]; typeOnlyExports?: string[] } | undefined {
  const specifiers = evidence.localSpecifiers?.get(decodeIdentifierEscapes(nameNode.text));
  if (!isDefault && !specifiers) return undefined;
  const names = new Set<string>();
  const erased = new Set<string>();
  for (const { publicName, typeOnly } of specifiers ?? []) {
    const canonical = canonicalModuleExportName(publicName.text);
    if (canonical === null) continue;
    if (typeOnly) erased.add(canonical);
    else if (canonical !== 'default') names.add(publicName.text);
  }
  if (hasNamedExportDeclaration(nameNode)) names.add(nameNode.text);
  if (isDefault) erased.delete('default');
  removeValueExports(erased, names);
  if (!isDefault && erased.size === 0 && names.size === 1 && names.has(nameNode.text))
    return undefined;
  return {
    namedExports: [...names],
    ...(erased.size ? { typeOnlyExports: [...erased] } : {}),
  };
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
  commonJs = evidence.commonJs,
): boolean | undefined {
  // The name node's own declaration node is where the walk starts; the
  // declaration itself (a `method_definition`, a `function_declaration`) must
  // not count as its own nesting boundary.
  let current: SyntaxNode | null = nameNode.parent;
  // An `export` keyword is only a FILE-level export when the walk reaches the
  // program without crossing a nesting boundary — one inside a namespace or
  // ambient-module body is that container's export (see NESTING_BOUNDARIES).
  let underExport = false;
  let functionScopedVariable = false;
  while (current !== null && current.type !== 'program') {
    if (current.type === 'variable_declaration') functionScopedVariable = true;
    if (current.type === 'export_statement') {
      underExport = true;
      current = current.parent;
      continue;
    }
    if (current.type === 'object') {
      // `module.exports = { alpha() {} }`: the literal's own members are the
      // module's exports. Any other object literal is a nesting boundary.
      if (commonJs && nameNode.parent?.parent?.id === current.id && isModuleExportsObject(current))
        return true;
      return commonJs ? undefined : false;
    }
    if (NESTING_BOUNDARIES.has(current.type) && current.id !== nameNode.parent?.id) {
      // `var` crosses blocks but never a function/namespace boundary. A
      // module-scoped `var` can therefore be exported by a later clause.
      if (current.type === 'statement_block' && functionScopedVariable) {
        current = current.parent;
        continue;
      }
      return commonJs ? undefined : false;
    }
    current = current.parent;
  }
  if (underExport) return true;
  if (commonJs) return undefined;
  return (
    evidence.namedLocals.size > 0 &&
    evidence.namedLocals.has(decodeIdentifierEscapes(nameNode.text))
  );
}

/** Synthetic ESM defaults have no lexical name for the ordinary declaration walk. */
export function recordEsmDefault(evidence: EsmExportEvidence | undefined, name?: Capture): void {
  if (name && evidence?.conditionalEsmExports) {
    evidence.conditionalEsmExports.declarations[sourceRangeKey(name.range)] = {
      isDefaultExport: true,
      namedExports: [],
    };
  }
}

/** Attach the same module export evidence to both grammar providers' declarations. */
export function addEsmExportMarkerCaptures(
  grouped: Record<string, Capture>,
  nameNode: SyntaxNode | undefined,
  evidence: EsmExportEvidence | undefined,
): void {
  if (!evidence) return;
  const name = grouped['@declaration.name'];
  const esm = evidence.conditionalEsmExports;
  if (esm?.hasModuleSyntax && name) {
    if (grouped['@declaration.is-default-export']?.text === 'true') {
      recordEsmDefault(evidence, name);
    } else if (nameNode && esmExportVerdict(nameNode, evidence, false)) {
      const isDefault = isEsmDefaultExport(nameNode, evidence);
      esm.declarations[sourceRangeKey(name.range)] = {
        ...(isDefault && { isDefaultExport: true }),
        ...namedEsmPublications(nameNode, evidence, isDefault),
      };
    }
  }
  if (!nameNode) return;
  const verdict = esmExportVerdict(nameNode, evidence);
  if (verdict === undefined) return;
  grouped['@declaration.is-exported'] = syntheticCapture(
    '@declaration.is-exported',
    nameNode,
    String(verdict),
  );
  if (!verdict) return;
  const isDefault = isEsmDefaultExport(nameNode, evidence);
  if (isDefault)
    grouped['@declaration.is-default-export'] = syntheticCapture(
      '@declaration.is-default-export',
      nameNode,
      'true',
    );
  const names = namedEsmPublications(nameNode, evidence, isDefault);
  if (names === undefined) return;
  grouped['@declaration.named-exports'] = syntheticCapture(
    '@declaration.named-exports',
    nameNode,
    JSON.stringify(names.namedExports),
  );
  if (names.typeOnlyExports)
    grouped['@declaration.type-only-exports'] = syntheticCapture(
      '@declaration.type-only-exports',
      nameNode,
      JSON.stringify(names.typeOnlyExports),
    );
}
