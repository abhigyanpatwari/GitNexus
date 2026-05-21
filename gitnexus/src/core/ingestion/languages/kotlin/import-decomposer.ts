import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

type KotlinImportKind = 'named' | 'alias' | 'wildcard';

interface KotlinImportSpec {
  readonly kind: KotlinImportKind;
  readonly source: string;
  readonly name: string;
  readonly alias?: string;
  readonly atNode: SyntaxNode;
}

export function splitKotlinImportHeader(importNode: SyntaxNode): CaptureMatch | null {
  if (importNode.type !== 'import_header') return null;
  const spec = parseKotlinImport(importNode);
  if (spec === null) return null;

  const out: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', importNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  if (spec.alias !== undefined) {
    out['@import.alias'] = syntheticCapture('@import.alias', spec.atNode, spec.alias);
  }
  return out;
}

function parseKotlinImport(node: SyntaxNode): KotlinImportSpec | null {
  const identifier = node.namedChildren.find((child) => child.type === 'identifier');
  if (identifier === undefined) return null;
  const source = identifier.text.trim();
  if (source.length === 0) return null;

  const hasWildcard = node.namedChildren.some((child) => child.type === 'wildcard_import');
  if (hasWildcard) {
    return { kind: 'wildcard', source, name: '*', atNode: node };
  }

  const aliasNode = node.namedChildren.find((child) => child.type === 'import_alias');
  const alias = aliasNode?.namedChildren.find((child) => child.type === 'type_identifier')?.text;
  const importedName = source.split('.').pop() ?? source;
  if (alias !== undefined && alias.length > 0) {
    return { kind: 'alias', source, name: importedName, alias, atNode: node };
  }
  return { kind: 'named', source, name: importedName, atNode: node };
}
