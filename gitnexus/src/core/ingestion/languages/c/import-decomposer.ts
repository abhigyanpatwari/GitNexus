import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Decompose a `preproc_include` node into a CaptureMatch with structured
 * import captures. C #include maps to a wildcard import (all symbols
 * from the header are visible).
 */
export function splitCInclude(node: SyntaxNode): CaptureMatch | null {
  // node.type === 'preproc_include'
  // children: '#include' + (string_literal | system_lib_string)
  let pathNode: SyntaxNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (child.type === 'string_literal' || child.type === 'system_lib_string') {
      pathNode = child;
      break;
    }
  }
  if (pathNode === null) return null;

  // Strip quotes: "foo.h" → foo.h  or <stdio.h> → stdio.h
  let raw = pathNode.text;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('<') && raw.endsWith('>'))) {
    raw = raw.slice(1, -1);
  }

  const isSystem = pathNode.type === 'system_lib_string';

  const result: CaptureMatch = {
    '@import.statement': nodeToCapture('@import.statement', node),
    '@import.kind': syntheticCapture('@import.kind', node, 'wildcard'),
    '@import.source': syntheticCapture('@import.source', node, raw),
  };

  if (isSystem) {
    result['@import.system'] = syntheticCapture('@import.system', node, 'true');
  }

  return result;
}
