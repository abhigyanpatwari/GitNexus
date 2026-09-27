/**
 * Extract Python arity metadata from a `function_definition` tree-sitter
 * node — parameter count, required count, and (where present) a type
 * list that the existing `pythonArityCompatibility` hook reads.
 *
 * Mirrors the legacy `buildMethodProps` conversion so scope-extracted
 * defs carry the same arity semantics as the parse-worker path:
 *   - A bound method's first positional receiver is stripped by class and
 *     decorator context, independent of spelling; static/free functions keep it.
 *   - Defaulted params contribute to `optionalCount`, flipping
 *     `requiredParameterCount = total − optionalCount`.
 *   - Variadic (`*args` / `**kwargs`) leaves both count-only bounds unknown:
 *     parameter kinds are not retained, so a required keyword-only argument
 *     cannot safely be treated as a positional minimum.
 *   - `parameterTypes` is populated only with real type text, matching
 *     legacy behavior.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { pythonMethodConfig } from '../../method-extractors/configs/python.js';

interface PythonArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
  readonly parameterNames: readonly string[];
}

export function computePythonArityMetadata(fnNode: SyntaxNode): PythonArityMetadata {
  const params = pythonMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasVariadic = false;
  let optionalCount = 0;
  const types: string[] = [];
  for (const p of params) {
    if (p.isVariadic) hasVariadic = true;
    else if (p.isOptional) optionalCount++;
    if (p.type !== null) types.push(p.type);
  }

  const total = params.length;
  const parameterCount = hasVariadic ? undefined : total;
  // Unlike legacy `buildMethodProps`, we populate `requiredParameterCount`
  // whenever the function isn't variadic — even when it equals
  // `parameterCount`. The scope-resolution registry needs a concrete min
  // to rule out under-application (e.g. picking `write_audit(x, y)` for
  // a 1-arg call). Legacy could get away with leaving it undefined
  // because its call-graph builder had a separate arity pre-filter.
  const requiredParameterCount = hasVariadic ? undefined : total - optionalCount;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
    parameterNames: params.map((parameter) => parameter.name),
  };
}
