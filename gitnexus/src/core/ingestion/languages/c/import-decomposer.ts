import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Decompose a `preproc_include` node into a CaptureMatch with structured
 * import captures. C #include maps to a wildcard import (all symbols
 * from the header are visible).
 */
export function splitCInclude(node: SyntaxNode): CaptureMatch | null {
  // node.type === 'preproc_include'
  // path field: (string_literal (string_content)) | (system_lib_string)
  const pathNode = node.childForFieldName?.('path') ?? null;
  if (pathNode === null) {
    // Fallback: scan children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child === null) continue;
      if (child.type === 'string_literal' || child.type === 'system_lib_string') {
        return buildIncludeCapture(node, child);
      }
    }
    return null;
  }
  return buildIncludeCapture(node, pathNode);
}

function buildIncludeCapture(node: SyntaxNode, pathNode: SyntaxNode): CaptureMatch {
  let raw: string;
  if (pathNode.type === 'string_literal') {
    // string_literal has children: `"`, string_content, `"`
    // Use namedChildren to find the string_content node
    const content = pathNode.namedChildren.find((c) => c.type === 'string_content');
    raw = content?.text ?? pathNode.text.replace(/^"|"$/g, '');
  } else {
    // system_lib_string: <stdio.h> → strip angle brackets
    raw = pathNode.text;
    if (raw.startsWith('<') && raw.endsWith('>')) {
      raw = raw.slice(1, -1);
    }
  }

  const isSystem = pathNode.type === 'system_lib_string';

  const result: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', node),
    '@import.kind': syntheticCapture('@import.kind', node, 'wildcard'),
    '@import.source': syntheticCapture('@import.source', node, raw),
  };

  if (isSystem) {
    result['@import.system'] = syntheticCapture('@import.system', node, 'true');
  }

  return result;
}
