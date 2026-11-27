import { kotlinNominalType } from './nullable-heritage.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { kotlinMethodConfig } from '../../method-extractors/configs/jvm.js';
import { declarationParameterTypes } from '../../method-extractors/declaration-facts.js';

export interface KotlinArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
  readonly declaredParameterTypes?: readonly string[];
}

export function computeKotlinArityMetadata(fnNode: SyntaxNode): KotlinArityMetadata {
  const params = kotlinMethodConfig.extractParameters?.(fnNode) ?? [];
  let hasVararg = false;
  let parameterTypes = declarationParameterTypes(params);
  for (const param of params) {
    if (param.isVariadic) hasVararg = true;
  }
  if (hasVararg) parameterTypes = [...parameterTypes, 'vararg'];

  const required = params.filter((p) => !p.isOptional && !p.isVariadic).length;
  const declaredParameterTypes =
    !hasVararg &&
    params.some((p) => p.rawType?.endsWith('?')) &&
    params.every((p) => p.rawType && kotlinNominalType(p.rawType) !== null)
      ? params.map((p) => p.rawType!)
      : undefined;
  return {
    declaredParameterTypes,
    parameterCount: hasVararg ? undefined : params.length,
    requiredParameterCount: required,
    parameterTypes: parameterTypes.length > 0 ? parameterTypes : undefined,
  };
}
