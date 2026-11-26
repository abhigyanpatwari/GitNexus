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
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getJavaParser } from './query.js';
import { stripGaps } from './type-spelling.js';

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
  const pathNode = node.namedChildren.find(
    (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
  );
  if (!pathNode?.text) return null;
  const source = stripGaps(pathNode.text);
  const isStatic = node.children.some((child) => child.type === 'static');
  if (node.namedChildren.some((child) => child.type === 'asterisk')) {
    return { kind: isStatic ? 'static-wildcard' : 'wildcard', source, name: '*', atNode: node };
  }
  const name = source.slice(source.lastIndexOf('.') + 1);
  return { kind: isStatic ? 'static' : 'named', source, name, atNode: node };
}

export function readJavaWorkspaceImports(source: string, filePath: string) {
  const lastImport = source.lastIndexOf('import');
  if (lastImport < 0) return [];
  const parse = (text: string) =>
    parseSourceSafe(getJavaParser(), text, undefined, undefined, filePath).rootNode;
  // A complete import at the end of this prefix accounts for every import
  // keyword in the file. A semicolon inside trivia or a later use of the
  // word in a method body can cut the prefix short. Parse the full unit then.
  const end = source.indexOf(';', lastImport) + 1;
  const prefix = end > 0 && end < source.length ? parse(source.slice(0, end)) : undefined;
  const root =
    prefix && !prefix.hasError && prefix.lastNamedChild?.type === 'import_declaration'
      ? prefix
      : parse(source);
  const imports = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration') continue;
    const spec = parseImportDeclaration(node);
    if (spec)
      imports.push({
        name: spec.name === '*' ? spec.source + '.*' : spec.source,
        isStatic: spec.kind === 'static' || spec.kind === 'static-wildcard',
      });
  }
  return imports;
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
