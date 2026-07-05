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
 *   - rank 4: user-defined conversion (one-step, conservative)
 *   - rank 5: ellipsis conversion (worst viable)
 *   - Infinity: mismatch (string -> int, user types, unsupported shapes)
 *
 * This function is intentionally C++-specific. Other languages may define
 * their own `ConversionRankFn` in the future.
 */

import type { ParameterTypeClass } from 'gitnexus-shared';
import { normalizeCppParamType } from './arity-metadata.js';
import { hasCppUserDefinedConversion } from './user-defined-conversions.js';

/** Set of normalized arithmetic types that support implicit conversion. */
const ARITHMETIC = new Set(['int', 'double', 'char', 'bool']);

/** Integral promotion targets: char -> int and bool -> int are rank 1. */
const INTEGRAL_PROMOTION = new Map([
  ['char', 'int'],
  ['bool', 'int'],
]);

export const CPP_BRACED_INIT_TYPE_PREFIX = 'braced-init:';
export const CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES = [CPP_BRACED_INIT_TYPE_PREFIX] as const;

const BRACED_INIT_CONTAINER_TYPES = new Set([
  'array',
  'deque',
  'list',
  'set',
  'std::array',
  'std::deque',
  'std::list',
  'std::set',
  'std::unordered_set',
  'std::vector',
  'unordered_set',
  'vector',
]);

interface BracedInitArgType {
  elementType: string;
  elementCount?: number;
}

/**
 * Return the conversion rank from `argType` to `paramType`.
 *
 * @returns 0 for exact match, 1 for integral promotion, 2 for standard
 *          conversion, 3 for nullptr -> bool, 4 for user-defined conversion,
 *          5 for ellipsis, Infinity
 *          for mismatch.
 */
export function cppConversionRank(
  argType: string,
  paramType: string,
  argTypeClass?: ParameterTypeClass,
  paramTypeClass?: ParameterTypeClass,
): number {
  const bracedInitType = parseBracedInitArgType(argType);
  if (bracedInitType !== undefined) {
    if (bracedInitType.elementType === 'unknown') return Infinity;
    if (bracedInitType.elementCount === 1) {
      const scalarRank = cppConversionRank(
        bracedInitType.elementType,
        paramType,
        undefined,
        paramTypeClass,
      );
      if (isFinite(scalarRank)) return scalarRank;
    }
    return bracedInitConversionRank(paramType, bracedInitType, paramTypeClass);
  }
  if (argType === paramType) {
    return exactShapeCompatible(argTypeClass, paramTypeClass) ? 0 : Infinity;
  }
  if (paramType === '...') return 5;
  if (INTEGRAL_PROMOTION.get(argType) === paramType) return 1;
  if (ARITHMETIC.has(argType) && ARITHMETIC.has(paramType)) return 2;
  if (argType === 'null' && isPointer(paramTypeClass)) return 2;
  if (argType === 'null' && paramType === 'bool') return 3;
  if (isPointer(argTypeClass) && paramType === 'bool') return 2;
  if (isPointer(argTypeClass) && isPointer(paramTypeClass) && paramType === 'void') return 2;
  if (hasCppUserDefinedConversion(argType, paramType)) return 4;
  return Infinity;
}

function parseBracedInitArgType(argType: string): BracedInitArgType | undefined {
  if (!argType.startsWith(CPP_BRACED_INIT_TYPE_PREFIX)) return undefined;
  const payload = argType.slice(CPP_BRACED_INIT_TYPE_PREFIX.length);
  if (payload === '') return undefined;
  const separator = payload.lastIndexOf(':');
  if (separator > 0) {
    const countText = payload.slice(separator + 1);
    if (/^\d+$/.test(countText)) {
      return {
        elementType: payload.slice(0, separator),
        elementCount: Number(countText),
      };
    }
  }
  return { elementType: payload };
}

function bracedInitConversionRank(
  paramType: string,
  argType: BracedInitArgType,
  paramTypeClass?: ParameterTypeClass,
): number {
  const targetBase = bracedInitTargetBase(paramType);
  if (targetBase === 'initializer_list' || targetBase === 'std::initializer_list') {
    return bracedInitValueTypeMatches(paramType, argType, paramTypeClass) ? 0 : Infinity;
  }
  if (BRACED_INIT_CONTAINER_TYPES.has(targetBase)) {
    return bracedInitValueTypeMatches(paramType, argType, paramTypeClass) ? 4 : Infinity;
  }
  return Infinity;
}

function bracedInitValueTypeMatches(
  paramType: string,
  argType: BracedInitArgType,
  paramTypeClass?: ParameterTypeClass,
): boolean {
  const valueType = bracedInitTargetValueType(paramType, paramTypeClass);
  if (valueType === undefined) return false;
  return isFinite(cppConversionRank(argType.elementType, valueType));
}

function bracedInitTargetValueType(
  paramType: string,
  paramTypeClass?: ParameterTypeClass,
): string | undefined {
  return firstTemplateArgument(paramType) ?? paramTypeClass?.templateArguments?.[0];
}

function firstTemplateArgument(rawType: string): string | undefined {
  const start = rawType.indexOf('<');
  if (start < 0) return undefined;

  let depth = 0;
  for (let i = start + 1; i < rawType.length; i++) {
    const ch = rawType[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      if (depth === 0) return bracedInitTargetBase(rawType.slice(start + 1, i));
      depth--;
    } else if (ch === ',' && depth === 0) {
      return bracedInitTargetBase(rawType.slice(start + 1, i));
    }
  }

  return undefined;
}

function bracedInitTargetBase(paramType: string): string {
  return normalizeCppParamType(paramType);
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
