import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Keep class and constructor field metadata on the same naming convention. */
export function pythonFieldVisibility(name: string | undefined): FieldVisibility {
  if (!name) return 'public';
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  return name.startsWith('_') ? 'protected' : 'public';
}

/** Match a direct receiver member; chained and foreign objects are excluded. */
export function pythonReceiverField(target: SyntaxNode, receiverName: string): SyntaxNode | null {
  if (target.type !== 'attribute') return null;
  const object = target.childForFieldName('object');
  return object?.type === 'identifier' && object.text === receiverName
    ? target.childForFieldName('attribute')
    : null;
}
