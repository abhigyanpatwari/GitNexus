import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { kotlinMethodConfig } from '../../method-extractors/configs/jvm.js';

export interface KotlinArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computeKotlinArityMetadata(fnNode: SyntaxNode): KotlinArityMetadata {
  const params = kotlinMethodConfig.extractParameters?.(fnNode) ?? [];
  let hasVararg = false;
  const parameterTypes: string[] = [];
  for (const param of params) {
    if (param.isVariadic) hasVararg = true;
    if (param.type !== null) parameterTypes.push(param.type);
  }
  if (hasVararg) parameterTypes.push('vararg');

  const required = params.filter((p) => !p.isOptional && !p.isVariadic).length;
  return {
    parameterCount: hasVararg ? undefined : params.length,
    requiredParameterCount: required,
    parameterTypes: parameterTypes.length > 0 ? parameterTypes : undefined,
  };
}
