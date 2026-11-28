/**
 * Compute arity metadata from a Dart function-like node, reusing
 * `dartMethodConfig.extractParameters` so scope-extracted defs carry the
 * same semantics as the legacy parse-worker path. Mirror of
 * `languages/swift/arity-metadata.ts` (and C#'s `computeCsharpArityMetadata`).
 *
 * Dart has no variadic parameters, so `parameterCount` is always the param
 * total and the required count falls out of the optional flag:
 * `requiredParameterCount = total − optionalCount`, where a non-`required`
 * named param or an optional positional (`[...]`) param is optional.
 */

import { dartNominalType } from './nullable-heritage.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { dartMethodConfig, type DartParameterInfo } from '../../method-extractors/configs/dart.js';
import { declarationParameterTypes } from '../../method-extractors/declaration-facts.js';

interface DartArityMetadata {
  parameterCount: number | undefined;
  requiredParameterCount: number | undefined;
  parameterTypes: readonly string[] | undefined;
  readonly declaredParameterTypes?: readonly string[];
}

/**
 * `fnNode` is the declaration WRAPPER node (`method_signature` /
 * `declaration` / a top-level `function_signature` / `constructor_signature`).
 * `dartMethodConfig.extractParameters` descends to the inner signature
 * internally, so the wrapper is the correct node to pass.
 */
export function computeDartArityMetadata(fnNode: SyntaxNode): DartArityMetadata {
  const params: readonly DartParameterInfo[] = dartMethodConfig.extractParameters?.(fnNode) ?? [];

  let optionalCount = 0;
  const types = declarationParameterTypes(params);
  for (const p of params) {
    if (p.isOptional) optionalCount++;
  }

  const total = params.length;
  const declared = params.some((p) => p.nullableHeritageType?.endsWith('?'))
    ? params.map((p) =>
        p.type && p.nullableHeritageType !== null
          ? dartNominalType(p.nullableHeritageType ?? p.type)
          : null,
      )
    : undefined;
  const declaredParameterTypes = declared?.every((type) => type !== null) ? declared : undefined;
  return {
    declaredParameterTypes,
    parameterCount: total,
    requiredParameterCount: total - optionalCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
