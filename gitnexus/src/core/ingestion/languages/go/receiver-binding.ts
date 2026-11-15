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
  if (typeNode === null) return null;
  const typeName = typeNode.text;
  // Unnamed receivers still declare method ownership. Keep their self type
  // fact under a key that cannot be a Go identifier, so it never creates a
  // usable receiver variable. Type bindings do not register lexical symbols.
  const boundName = nameNode?.text ?? '<unnamed-receiver>';

  return {
    '@type-binding.self': syntheticCapture('@type-binding.self', fnNode, boundName),
    '@type-binding.name': syntheticCapture('@type-binding.name', nameNode ?? param, boundName),
    '@type-binding.type': syntheticCapture('@type-binding.type', typeNode, typeName),
  };
}
