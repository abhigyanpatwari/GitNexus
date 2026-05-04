import type { SyntaxNode } from '../../utils/ast-helpers.js';

export interface GoArityMetadata {
  readonly parameterCount?: number;
  readonly requiredParameterCount?: number;
  readonly parameterTypes?: readonly string[];
}

export function computeGoDeclarationArity(node: SyntaxNode): GoArityMetadata {
  const params = node.childForFieldName('parameters');
  if (params === null) return {};

  let count = 0;
  let required = 0;
  const types: string[] = [];

  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (param === null) continue;
    if (param.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode === null ? '' : typeNode.text;
      const names = param.namedChildren.filter((c) => c.type === 'identifier');
      const n = Math.max(1, names.length);
      for (let j = 0; j < n; j++) {
        count++;
        required++;
        types.push(typeName);
      }
    }
    if (param.type === 'variadic_parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode === null ? '...' : `...${typeNode.text}`;
      count++;
      types.push(typeName);
    }
  }

  return { parameterCount: count, requiredParameterCount: required, parameterTypes: types };
}

export function computeGoCallArity(callNode: SyntaxNode): number {
  const args = callNode.childForFieldName('arguments');
  if (args === null) return 0;
  return args.namedChildCount;
}
