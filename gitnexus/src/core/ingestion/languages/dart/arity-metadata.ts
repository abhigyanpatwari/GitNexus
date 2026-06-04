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

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';

interface DartArityMetadata {
  parameterCount: number | undefined;
  requiredParameterCount: number | undefined;
  parameterTypes: readonly string[] | undefined;
}

/**
 * `fnNode` is the declaration WRAPPER node (`method_signature` /
 * `declaration` / a top-level `function_signature` / `constructor_signature`).
 * `dartMethodConfig.extractParameters` descends to the inner signature
 * internally, so the wrapper is the correct node to pass.
 */
export function computeDartArityMetadata(fnNode: SyntaxNode): DartArityMetadata {
  const params = dartMethodConfig.extractParameters?.(fnNode) ?? [];

  let optionalCount = 0;
  const types: string[] = [];
  for (const p of params) {
    if (p.isOptional) optionalCount++;
    if (p.type !== null) types.push(p.type);
  }

  const total = params.length;
  return {
    parameterCount: total,
    requiredParameterCount: total - optionalCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
