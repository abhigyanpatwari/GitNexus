import type { CaptureMatch } from 'gitnexus-shared';
import { syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export function synthesizeGoReceiverBinding(fnNode: SyntaxNode): CaptureMatch | null {
  if (fnNode.type !== 'method_declaration') return null;
  const receiver = fnNode.childForFieldName('receiver');
  if (receiver === null) return null;
  const param = receiver.namedChildren.find((c) => c.type === 'parameter_declaration');
  if (param === undefined) return null;
  const nameNode = param.childForFieldName('name');
  const typeNode = param.childForFieldName('type');
  if (nameNode === null || typeNode === null) return null;
  const typeName = typeNode.text.replace(/^\*/, '');

  return {
    '@type-binding.self': syntheticCapture('@type-binding.self', fnNode, nameNode.text),
    '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', typeNode, typeName),
  };
}
