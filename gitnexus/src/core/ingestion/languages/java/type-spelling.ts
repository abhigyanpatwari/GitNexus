import type Parser from 'tree-sitter';
import type { ElementAccessRoute } from '../../scope-resolution/contract/scope-resolver.js';

/** Remove type-use annotations structurally, including their argument values. */
export function javaTypeText(node: Parser.SyntaxNode): string {
  const annotations = node
    .descendantsOfType(['annotation', 'marker_annotation'])
    .sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const written = node.text;
  let cursor = 0;
  let text = '';
  for (const annotation of annotations) {
    const start = annotation.startIndex - node.startIndex;
    if (start < cursor) continue; // An outer annotation already consumed it.
    text += written.slice(cursor, start);
    cursor = annotation.endIndex - node.startIndex;
  }
  text += written.slice(cursor);
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

/** Declarator dimensions belong only to that declarator (JLS 10.2). */
export function javaTrailingDimensions(node: Parser.SyntaxNode | null | undefined): string {
  const dimensions = node?.childForFieldName('dimensions');
  return '[]'.repeat(dimensions?.children.filter((child) => child.type === '[').length ?? 0);
}

/** Erasure retains the outer type and every array dimension, never its element. */
export function eraseJavaTypeArguments(text: string): string {
  let depth = 0;
  let result = '';
  for (const char of text) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (depth === 0) result += char;
    if (depth < 0) return text;
  }
  return depth === 0 ? result : text;
}

/** Java brackets unwrap arrays only; collections have no bracket operator. */
export function javaArrayElementType(type: string, via: ElementAccessRoute): string | undefined {
  if (via.kind !== 'index') return undefined;
  const normalized = type.replace(/\s+/g, '');
  return normalized.endsWith('[]') ? normalized.slice(0, -2) : undefined;
}
