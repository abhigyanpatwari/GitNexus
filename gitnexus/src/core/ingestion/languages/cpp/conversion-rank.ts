/**
 * C++ conversion-rank scoring for overload resolution (#1578, #1637).
 *
 * Operates on normalized type strings (output of `normalizeCppParamType`
 * in `arity-metadata.ts`) plus optional shape sidecars from #1630.
 * Normalization intentionally collapses cv/ref/pointer spelling for stable
 * graph IDs, so pointer/nullptr rules must consult `ParameterTypeClass`.
 *
 * Post-normalization ranking:
 *   - rank 0: exact (same normalized type)
 *   - rank 1: integral promotion (char -> int, bool -> int)
 *   - rank 2: standard conversion (arithmetic, nullptr -> T*, T* -> bool,
 *             T* -> void*)
 *   - rank 3: nullptr -> bool (kept worse than nullptr -> T*)
 *   - rank 4: ellipsis conversion (worst viable)
 *   - Infinity: mismatch (string -> int, user types, unsupported shapes)
 *
 * This function is intentionally C++-specific. Other languages may define
 * their own `ConversionRankFn` in the future.
 */

import type { ParameterTypeClass } from 'gitnexus-shared';

/** Set of normalized arithmetic types that support implicit conversion. */
const ARITHMETIC = new Set(['int', 'double', 'char', 'bool']);

/** Integral promotion targets: char -> int and bool -> int are rank 1. */
const INTEGRAL_PROMOTION = new Map([
  ['char', 'int'],
  ['bool', 'int'],
]);

/**
 * Return the conversion rank from `argType` to `paramType`.
 *
 * @returns 0 for exact match, 1 for integral promotion, 2 for standard
 *          conversion, 3 for nullptr -> bool, 4 for ellipsis, Infinity
 *          for mismatch.
 */
export function cppConversionRank(
  argType: string,
  paramType: string,
  argTypeClass?: ParameterTypeClass,
  paramTypeClass?: ParameterTypeClass,
): number {
  if (argType === paramType) {
    return exactShapeCompatible(argTypeClass, paramTypeClass) ? 0 : Infinity;
  }
  if (paramType === '...') return 4;
  if (INTEGRAL_PROMOTION.get(argType) === paramType) return 1;
  if (ARITHMETIC.has(argType) && ARITHMETIC.has(paramType)) return 2;
  if (argType === 'null' && isPointer(paramTypeClass)) return 2;
  if (argType === 'null' && paramType === 'bool') return 3;
  if (isPointer(argTypeClass) && paramType === 'bool') return 2;
  if (isPointer(argTypeClass) && isPointer(paramTypeClass) && paramType === 'void') return 2;
  return Infinity;
}

function isPointer(typeClass: ParameterTypeClass | undefined): boolean {
  return typeClass?.indirection === 'pointer' && typeClass.pointerDepth > 0;
}

function exactShapeCompatible(
  argTypeClass: ParameterTypeClass | undefined,
  paramTypeClass: ParameterTypeClass | undefined,
): boolean {
  if (argTypeClass === undefined || paramTypeClass === undefined) return true;
  if (argTypeClass.indirection === 'unknown' || paramTypeClass.indirection === 'unknown') {
    return true;
  }
  return isPointer(argTypeClass) === isPointer(paramTypeClass);
}
