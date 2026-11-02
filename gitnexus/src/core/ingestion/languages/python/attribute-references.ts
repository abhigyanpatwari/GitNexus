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

/** Python Language Reference §§6.3.1, 7.2 and 7.5: a target is not a read,
 * except for augmented assignment. Reading the receiver of a target still is. */
export function pythonAttributeAccessKinds(node: SyntaxNode): readonly ('read' | 'write')[] {
  // An annotation names a type; it does not read that instance's field.
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type === 'type') return [];
    if (ancestor.type === 'block' || ancestor.type === 'module') break;
  }

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
