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
/** Per parse tree: keys of every identifier and attribute inside a `type` node. */
const annotatedMemo = new WeakMap<object, Set<string>>();
const nodeKey = (node: SyntaxNode): string => `${node.startIndex}:${node.endIndex}:${node.type}`;

function annotatedNodesFor(tree: { rootNode: SyntaxNode }): Set<string> {
  let keys = annotatedMemo.get(tree);
  if (keys !== undefined) return keys;
  typeQuery ??= new Parser.Query(Python as Parameters<Parser['setLanguage']>[0], '(type) @type');
  keys = new Set();
  let outerEnd = -1;
  // Captures arrive in document order. A `type` inside an annotation already
  // collected adds nothing, and skipping it keeps nested generics linear.
  for (const { node } of typeQuery.captures(tree.rootNode)) {
    if (node.endIndex <= outerEnd) continue;
    outerEnd = node.endIndex;
    for (const inner of node.descendantsOfType(['identifier', 'attribute']))
      keys.add(nodeKey(inner));
  }
  annotatedMemo.set(tree, keys);
  return keys;
}

/**
 * True when `node` (an identifier or attribute) sits inside a `type` annotation.
 * Expressions never contain a block, so any `type` ancestor lies below the
 * nearest block. tree-sitter nodes have no parent pointer: each `.parent`
 * walks down from the root, so climbing ancestors per read cost O(depth^2).
 * The per-tree set makes each check one hash lookup.
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
  return annotatedNodesFor(tree).has(nodeKey(node));
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
