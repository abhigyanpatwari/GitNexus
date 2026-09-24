/**
 * Decompose a Python `import_statement` / `import_from_statement` into
 * one `CaptureMatch` per imported name.
 *
 * Why split here? The `LanguageProvider.interpretImport` contract is
 * one `ParsedImport` per call. Tree-sitter delivers `import a, b as c`
 * and `from m import x, y, z` as a single match each, so without
 * decomposition we'd lose names. The synthesized markers
 * (`@import.kind` / `@import.name` / `@import.alias` / `@import.source`)
 * carry everything `interpretPythonImport` needs to recover the original
 * `ParsedImport` shape — see `interpret.ts`.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findAncestorBeforeBoundary,
  findChild,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

/** Tag a single decomposed import. Mirrors the `case` arms of
 *  `interpretPythonImport`. */
type ImportKind = 'plain' | 'aliased' | 'from' | 'from-alias' | 'wildcard' | 'dynamic';

/**
 * The only two constructs that stop a module-level `from m import x` from
 * publishing `x` as `<module>.x`. Python has no block scope, so an import
 * under `if` / `try` / `for` / `with` still publishes when its branch runs —
 * verified against CPython 3.11; only `def` and `class` bodies suppress it.
 */
const PUBLICATION_SUPPRESSING_ANCESTORS: ReadonlySet<string> = new Set([
  'function_definition',
  'class_definition',
]);
const NO_BOUNDARY: ReadonlySet<string> = new Set();

interface ImportSpec {
  readonly kind: ImportKind;
  readonly source: string;
  readonly name: string;
  readonly alias?: string;
  readonly atNode: SyntaxNode;
  /**
   * Statement sits at module level, so the bound name joins the module
   * namespace and is importable from this module. Read by
   * `interpretPythonImport` to set `ParsedImport.reexportsName`.
   */
  readonly publishesToModule?: boolean;
}

export function splitImportStatement(stmtNode: SyntaxNode): CaptureMatch[] {
  if (stmtNode.type === 'import_statement') return splitImportStmt(stmtNode);
  if (stmtNode.type === 'import_from_statement') return splitImportFromStmt(stmtNode);
  return [];
}

function splitImportStmt(stmtNode: SyntaxNode): CaptureMatch[] {
  // `import a, b as c, d.e`
  const out: CaptureMatch[] = [];
  for (let i = 0; i < stmtNode.namedChildCount; i++) {
    const child = stmtNode.namedChild(i);
    if (child === null) continue;
    if (child.type === 'dotted_name') {
      out.push(
        buildImportMatch(stmtNode, {
          kind: 'plain',
          source: child.text,
          name: child.text.split('.')[0]!,
          atNode: child,
        }),
      );
    } else if (child.type === 'aliased_import') {
      const dotted = findChild(child, 'dotted_name');
      const alias = findChild(child, 'identifier');
      if (dotted !== null && alias !== null) {
        out.push(
          buildImportMatch(stmtNode, {
            kind: 'aliased',
            source: dotted.text,
            name: dotted.text,
            alias: alias.text,
            atNode: child,
          }),
        );
      }
    }
  }
  return out;
}

function splitImportFromStmt(stmtNode: SyntaxNode): CaptureMatch[] {
  // `from m import a, b as c` / `from m import *` / `from . import x`
  const out: CaptureMatch[] = [];
  const moduleField = stmtNode.childForFieldName('module_name');
  const moduleText = moduleField?.text ?? '';
  // Once per statement, not once per name.
  const publishesToModule =
    findAncestorBeforeBoundary(stmtNode, PUBLICATION_SUPPRESSING_ANCESTORS, NO_BOUNDARY) === null;

  // Wildcard? tree-sitter-python represents `*` as a `wildcard_import`
  // child and emits no name children.
  const wildcardChild = findChild(stmtNode, 'wildcard_import');
  if (wildcardChild !== null) {
    out.push(
      buildImportMatch(stmtNode, {
        kind: 'wildcard',
        source: moduleText,
        name: '*',
        atNode: wildcardChild,
      }),
    );
    return out;
  }

  // Names = every dotted_name / aliased_import that isn't the module.
  for (let i = 0; i < stmtNode.namedChildCount; i++) {
    const child = stmtNode.namedChild(i);
    if (child === null) continue;
    if (moduleField !== null && child.startIndex === moduleField.startIndex) continue;

    if (child.type === 'dotted_name') {
      out.push(
        buildImportMatch(stmtNode, {
          kind: 'from',
          source: moduleText,
          name: child.text,
          atNode: child,
          publishesToModule,
        }),
      );
    } else if (child.type === 'aliased_import') {
      const dotted = findChild(child, 'dotted_name');
      const alias = findChild(child, 'identifier');
      if (dotted !== null && alias !== null) {
        out.push(
          buildImportMatch(stmtNode, {
            kind: 'from-alias',
            source: moduleText,
            name: dotted.text,
            alias: alias.text,
            atNode: child,
            publishesToModule,
          }),
        );
      }
    }
  }
  return out;
}

function buildImportMatch(stmtNode: SyntaxNode, spec: ImportSpec): CaptureMatch {
  const stmtCap = nodeToCapture('@import.statement', stmtNode);
  const m: Record<string, Capture> = {
    '@import.statement': stmtCap,
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  if (spec.alias !== undefined) {
    m['@import.alias'] = syntheticCapture('@import.alias', spec.atNode, spec.alias);
  }
  // Anchored at `spec.atNode`, never `stmtNode`: `anchorCaptureFor` picks the
  // broadest span with a strict `>`, so a statement-wide span here would tie
  // with `@import.statement` and let key order decide the anchor.
  if (spec.publishesToModule === true) {
    m['@import.publishes'] = syntheticCapture('@import.publishes', spec.atNode, 'module');
  }
  return m;
}
