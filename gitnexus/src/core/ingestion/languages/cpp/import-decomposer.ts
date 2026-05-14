import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Decompose a `preproc_include` node into a CaptureMatch with structured
 * import captures. C++ #include maps to a wildcard import (all symbols
 * from the header are visible). Identical to C's splitCInclude.
 */
export function splitCppInclude(node: SyntaxNode): CaptureMatch | null {
  const pathNode = node.childForFieldName?.('path') ?? null;
  if (pathNode === null) {
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
    const content = pathNode.namedChildren.find((c) => c.type === 'string_content');
    raw = content?.text ?? pathNode.text.replace(/^"|"$/g, '');
  } else {
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

/**
 * Decompose a `using_declaration` node into a CaptureMatch.
 *
 * tree-sitter-cpp produces:
 *   using namespace std;  → using_declaration { "using", "namespace", identifier("std"), ";" }
 *   using std::vector;    → using_declaration { "using", qualified_identifier("std::vector"), ";" }
 *
 * The first form is a wildcard import (all names from namespace).
 * The second form is a named import (single symbol).
 */
export function splitCppUsingDecl(node: SyntaxNode): CaptureMatch | null {
  if (node.type !== 'using_declaration') return null;

  // Check for "namespace" keyword among anonymous children
  let hasNamespaceKeyword = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && !child.isNamed && child.text === 'namespace') {
      hasNamespaceKeyword = true;
      break;
    }
  }

  if (hasNamespaceKeyword) {
    // using namespace <name>;
    // The namespace name can be an identifier or qualified_identifier
    let namespaceName: string | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;
      if (child.type === 'identifier' || child.type === 'qualified_identifier') {
        namespaceName = child.text;
        break;
      }
    }
    if (namespaceName === null) return null;

    return {
      '@import.statement': nodeToCapture('@import.statement', node),
      '@import.kind': syntheticCapture('@import.kind', node, 'wildcard'),
      '@import.source': syntheticCapture('@import.source', node, namespaceName),
      '@import.using-namespace': syntheticCapture('@import.using-namespace', node, 'true'),
    };
  }

  // using <qualified_identifier>;  (e.g. using std::vector)
  let qualId: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'qualified_identifier') {
      qualId = child;
      break;
    }
  }
  if (qualId === null) return null;

  // Extract the imported name (last identifier) and source (namespace part)
  const nameNode = qualId.childForFieldName?.('name') ?? null;
  const scopeNode = qualId.childForFieldName?.('scope') ?? null;

  const importedName = nameNode?.text ?? qualId.text.split('::').pop() ?? '';
  const source = scopeNode?.text ?? qualId.text.replace(new RegExp('::' + importedName + '$'), '');

  return {
    '@import.statement': nodeToCapture('@import.statement', node),
    '@import.kind': syntheticCapture('@import.kind', node, 'named'),
    '@import.source': syntheticCapture('@import.source', node, source),
    '@import.name': syntheticCapture('@import.name', node, importedName),
  };
}
