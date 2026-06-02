import type { SyntaxNode } from '../../utils/ast-helpers.js';

export interface GoArityMetadata {
  readonly parameterCount?: number;
  readonly requiredParameterCount?: number;
  readonly parameterTypes?: readonly string[];
  readonly returnType?: string;
}

export function computeGoDeclarationArity(node: SyntaxNode): GoArityMetadata {
  const params = node.childForFieldName('parameters');
  const returnType = extractGoReturnType(node);
  if (params === null) return returnType === undefined ? {} : { returnType };

  return {
    ...computeGoParameterMetadata(params),
    ...(returnType === undefined ? {} : { returnType }),
  };
}

function computeGoParameterMetadata(params: SyntaxNode): GoArityMetadata {
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

function extractGoReturnType(node: SyntaxNode): string | undefined {
  const result = node.childForFieldName('result');
  if (result === null) return undefined;
  if (result.type !== 'parameter_list') return result.text;

  const returnTypes: string[] = [];
  for (const child of result.namedChildren) {
    if (child.type !== 'parameter_declaration') continue;
    const typeNode = child.childForFieldName('type');
    if (typeNode === null) continue;
    const names = child.namedChildren.filter((c) => c.type === 'identifier');
    const n = Math.max(1, names.length);
    for (let i = 0; i < n; i++) {
      returnTypes.push(typeNode.text);
    }
  }
  if (returnTypes.length === 0) return undefined;
  return returnTypes.length === 1 ? returnTypes[0] : `(${returnTypes.join(', ')})`;
}
