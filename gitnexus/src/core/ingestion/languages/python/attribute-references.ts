import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const TARGET_WRAPPERS = new Set([
  'parenthesized_expression',
  'pattern_list',
  'tuple_pattern',
  'list_pattern',
  'list_splat_pattern',
  'as_pattern_target',
  'expression_list',
  'tuple',
  'list',
]);

let typeQuery: Parser.Query | undefined;
/** Per parse tree: sorted, disjoint [start, end) byte spans covered by `type` nodes. */
const typeSpansMemo = new WeakMap<object, number[]>();

function typeSpansFor(tree: { rootNode: SyntaxNode }): number[] {
  let spans = typeSpansMemo.get(tree);
  if (spans !== undefined) return spans;
  typeQuery ??= new Parser.Query(Python as Parameters<Parser['setLanguage']>[0], '(type) @type');
  spans = [];
  // Captures arrive in document order; a nested `type` merges into its outer span.
  for (const { node } of typeQuery.captures(tree.rootNode)) {
    const last = spans.length - 1;
    if (spans.length > 0 && node.startIndex < spans[last]!) {
      spans[last] = Math.max(spans[last]!, node.endIndex);
    } else spans.push(node.startIndex, node.endIndex);
  }
  typeSpansMemo.set(tree, spans);
  return spans;
}

/**
 * True when `node` (an identifier or attribute) sits inside a `type` annotation.
 * Expressions never contain a block, so lying inside a `type` node's byte span
 * is equivalent to having a `type` ancestor below the nearest block.
 * tree-sitter nodes have no parent pointer: each `.parent` walks down from the
 * root, so climbing ancestors per read cost O(depth^2) per read.
 */
export function isPythonTypeAnnotation(node: SyntaxNode): boolean {
  const tree = (node as { tree?: { rootNode: SyntaxNode } }).tree;
  if (tree === undefined) {
    for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
      if (ancestor.type === 'type') return true;
      if (ancestor.type === 'block' || ancestor.type === 'module') break;
    }
    return false;
  }
  const spans = typeSpansFor(tree);
  // Find the last span starting at or before the node.
  let lo = 0;
  let hi = spans.length / 2 - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[2 * mid]! <= node.startIndex) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && node.endIndex <= spans[2 * found + 1]!;
}

/** Python Language Reference §§6.3.1, 7.2 and 7.5: a target is not a read,
 * except for augmented assignment. Reading the receiver of a target still is. */
export function pythonAttributeAccessKinds(node: SyntaxNode): readonly ('read' | 'write')[] {
  // An annotation names a type; it does not read that instance's field.
  if (isPythonTypeAnnotation(node)) return [];

  let target = node;
  while (target.parent !== null && TARGET_WRAPPERS.has(target.parent.type)) {
    target = target.parent;
  }
  const parent = target.parent;
  if (parent === null) return ['read'];
  if (parent.type === 'call' && parent.childForFieldName('function')?.id === target.id) {
    // The member-call capture owns this site.
    return [];
  }
  if (parent.type === 'decorator') return [];
  if (parent.type === 'delete_statement') return ['write'];
  if (parent.type === 'as_pattern' && parent.childForFieldName('alias')?.id === target.id) {
    return ['write'];
  }
  if (parent.childForFieldName('left')?.id === target.id) {
    if (parent.type === 'assignment') {
      // `obj.x: T` evaluates obj but neither reads nor assigns x.
      return parent.childForFieldName('right') === null ? [] : ['write'];
    }
    if (parent.type === 'augmented_assignment') return ['read', 'write'];
    if (parent.type === 'for_statement' || parent.type === 'for_in_clause') return ['write'];
  }
  return ['read'];
}
