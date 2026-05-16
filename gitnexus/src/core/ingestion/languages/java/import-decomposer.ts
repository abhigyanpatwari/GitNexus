/**
 * Decompose a Java `import_declaration` into a `CaptureMatch` carrying
 * the synthesized markers `@import.kind` / `@import.source` /
 * `@import.name` that `interpretJavaImport` consumes.
 *
 * Unlike C#'s using-directive decomposer, Java has four import forms:
 *
 *   import com.example.User;                     → named
 *   import com.example.*;                         → wildcard
 *   import static com.example.Utils.format;       → static
 *   import static com.example.Utils.*;             → static-wildcard
 *
 * Each produces exactly one import. The decomposer inspects the raw
 * source text and tree-sitter children to determine the flavor.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

type ImportKind = 'named' | 'wildcard' | 'static' | 'static-wildcard';

interface ImportSpec {
  readonly kind: ImportKind;
  /** Full dotted path: `com.example.User`. */
  readonly source: string;
  /** Local binding name — last path segment for named/static,
   *  `'*'` for wildcard/static-wildcard. */
  readonly name: string;
  /** Node to anchor the synthesized captures (range-wise). */
  readonly atNode: SyntaxNode;
}

export function splitImportDeclaration(stmtNode: SyntaxNode): CaptureMatch | null {
  if (stmtNode.type !== 'import_declaration') return null;
  const spec = parseImportDeclaration(stmtNode);
  if (spec === null) return null;
  return buildImportMatch(stmtNode, spec);
}

function parseImportDeclaration(node: SyntaxNode): ImportSpec | null {
  // Detect `static` by checking for an anonymous `static` token child.
  let isStatic = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type === 'static') {
      isStatic = true;
      break;
    }
  }

  // Detect wildcard by checking for `asterisk` named child.
  let isWildcard = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'asterisk') {
      isWildcard = true;
      break;
    }
  }

  // Find the scoped_identifier (or identifier for single-segment imports).
  let pathNode: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && (child.type === 'scoped_identifier' || child.type === 'identifier')) {
      pathNode = child;
      break;
    }
  }
  if (pathNode === null) return null;

  const fullPath = pathNode.text;
  if (fullPath === '') return null;

  if (isStatic && isWildcard) {
    // `import static com.example.Utils.*;`
    return { kind: 'static-wildcard', source: fullPath, name: '*', atNode: node };
  }
  if (isStatic) {
    // `import static com.example.Utils.format;`
    const lastDot = fullPath.lastIndexOf('.');
    const name = lastDot >= 0 ? fullPath.slice(lastDot + 1) : fullPath;
    return { kind: 'static', source: fullPath, name, atNode: node };
  }
  if (isWildcard) {
    // `import com.example.*;`
    return { kind: 'wildcard', source: fullPath, name: '*', atNode: node };
  }

  // `import com.example.User;`
  const lastDot = fullPath.lastIndexOf('.');
  const name = lastDot >= 0 ? fullPath.slice(lastDot + 1) : fullPath;
  return { kind: 'named', source: fullPath, name, atNode: node };
}

function buildImportMatch(stmtNode: SyntaxNode, spec: ImportSpec): CaptureMatch {
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  return m;
}
