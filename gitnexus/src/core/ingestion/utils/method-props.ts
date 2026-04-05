import type { MethodInfo } from '../method-types.js';
import type { SupportedLanguages } from 'gitnexus-shared';

/** Languages where class overload signatures are declaration-only contracts
 *  that should collapse to the implementation body's node ID. */
const SKIP_TYPE_HASH_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript']);

/**
 * Compute arity for ID-generation purposes.
 * Returns `undefined` when any parameter is variadic (arity is indeterminate).
 */
export function arityForIdFromInfo(info: MethodInfo): number | undefined {
  return info.parameters.some((p) => p.isVariadic) ? undefined : info.parameters.length;
}

/**
 * Compute a type-based discriminator suffix for same-arity overloads.
 * Returns `~type1,type2` when the current method collides with another method
 * in the same class that has the same name and arity but different parameter types.
 * Returns `''` when there is no collision or types are unavailable.
 */
export function typeTagForId(
  methodMap: Map<string, MethodInfo>,
  methodName: string,
  arity: number | undefined,
  currentInfo: MethodInfo,
  language?: SupportedLanguages,
): string {
  if (arity === undefined) return '';

  // Zero-arity methods have no parameter types to disambiguate.
  if (arity === 0) return '';

  // TS/JS class overload signatures are declaration-only contracts that should
  // collapse to the implementation body's node ID, not be disambiguated.
  if (language && SKIP_TYPE_HASH_LANGUAGES.has(language)) return '';

  // Check if all parameters of this method have types
  if (currentInfo.parameters.length > 0 && currentInfo.parameters.some((p) => p.type === null)) {
    return '';
  }

  // Find all methods in this class with the same name and arity
  const sameArityGroup: MethodInfo[] = [];
  for (const info of methodMap.values()) {
    if (info.name !== methodName) continue;
    if (info.parameters.some((p) => p.isVariadic)) continue;
    if (info.parameters.length !== arity) continue;
    sameArityGroup.push(info);
  }

  // No collision — single method with this name+arity
  if (sameArityGroup.length < 2) return '';

  // Check that ALL methods in the collision group have full type info
  for (const info of sameArityGroup) {
    if (info.parameters.length > 0 && info.parameters.some((p) => p.type === null)) {
      return '';
    }
  }

  // Build type tag from current method's parameter types
  const types = currentInfo.parameters.map((p) => p.type!);
  return `~${types.join(',')}`;
}

/**
 * Compute a const-qualifier suffix for C++ const/non-const method collisions.
 * Returns `$const` when the current method is const-qualified and a non-const
 * method with the same name and arity exists in the same class.
 * Returns `''` when there is no collision or the method is not const-qualified.
 */
export function constTagForId(
  methodMap: Map<string, MethodInfo>,
  methodName: string,
  arity: number | undefined,
  currentInfo: MethodInfo,
): string {
  if (!currentInfo.isConst) return '';

  // Check if a non-const method with the same name and arity exists
  for (const info of methodMap.values()) {
    if (info === currentInfo) continue;
    if (info.name !== methodName) continue;
    if (info.isConst) continue; // both const — no const/non-const collision
    const infoArity = info.parameters.some((p) => p.isVariadic)
      ? undefined
      : info.parameters.length;
    if (infoArity !== arity) continue;
    // Found a non-const method with same name+arity — collision exists
    return '$const';
  }

  return '';
}

/** Convert MethodInfo from methodExtractor into flat properties for a graph node. */
export function buildMethodProps(info: MethodInfo): Record<string, unknown> {
  const types: string[] = [];
  let optionalCount = 0;
  let hasVariadic = false;
  for (const p of info.parameters) {
    if (p.type !== null) types.push(p.type);
    if (p.isOptional) optionalCount++;
    if (p.isVariadic) hasVariadic = true;
  }
  return {
    parameterCount: hasVariadic ? undefined : info.parameters.length,
    ...(!hasVariadic && optionalCount > 0
      ? { requiredParameterCount: info.parameters.length - optionalCount }
      : {}),
    ...(types.length > 0 ? { parameterTypes: types } : {}),
    returnType: info.returnType ?? undefined,
    visibility: info.visibility,
    isStatic: info.isStatic,
    isAbstract: info.isAbstract,
    isFinal: info.isFinal,
    ...(info.isVirtual ? { isVirtual: info.isVirtual } : {}),
    ...(info.isOverride ? { isOverride: info.isOverride } : {}),
    ...(info.isAsync ? { isAsync: info.isAsync } : {}),
    ...(info.isPartial ? { isPartial: info.isPartial } : {}),
    ...(info.isConst ? { isConst: info.isConst } : {}),
    ...(info.annotations.length > 0 ? { annotations: info.annotations } : {}),
  };
}
