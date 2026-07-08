import type { CaptureMatch } from 'gitnexus-shared';
import { syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export function splitGoImportStatement(node: SyntaxNode): CaptureMatch[] {
  if (node.type === 'import_declaration') {
    const out: CaptureMatch[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'import_spec') out.push(...splitGoImportStatement(child));
      if (child?.type === 'import_spec_list') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const spec = child.namedChild(j);
          if (spec?.type === 'import_spec') out.push(...splitGoImportStatement(spec));
        }
      }
    }
    return out;
  }

  if (node.type !== 'import_spec') return [];
  const pathNode = node.childForFieldName('path');
  if (pathNode === null) return [];

  const rawPath = pathNode.text.replace(/^"|"$/g, '').replace(/^`|`$/g, '');
  const nameNode = node.childForFieldName('name');
  const alias = nameNode?.text;
  const leaf = rawPath.split('/').filter(Boolean).pop() ?? rawPath;
  const kind =
    alias === '.' ? 'dot' : alias === '_' ? 'blank' : alias === undefined ? 'namespace' : 'alias';

  // Blank imports (import _ "pkg") are dropped in V1 — they represent
  // side-effect registrations (e.g. database drivers), but emitting
  // side-effect edges is deferred. See test: go-imports.test.ts.
  if (kind === 'blank') return [];

  const aliased = alias !== undefined && alias !== '.' && alias !== '_';
  return [
    {
      '@import.statement': syntheticCapture('@import.statement', node, node.text),
      '@import.kind': syntheticCapture('@import.kind', node, kind),
      '@import.source': syntheticCapture('@import.source', pathNode, rawPath),
      '@import.name': syntheticCapture(
        '@import.name',
        nameNode ?? pathNode,
        aliased ? alias! : leaf,
      ),
      ...(aliased ? { '@import.alias': syntheticCapture('@import.alias', nameNode!, alias!) } : {}),
    },
  ];
}
