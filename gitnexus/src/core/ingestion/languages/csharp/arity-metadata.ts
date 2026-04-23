/**
 * Extract C# arity metadata from a method-like tree-sitter node —
 * `method_declaration`, `constructor_declaration`, `destructor_declaration`,
 * `operator_declaration`, `conversion_operator_declaration`, or
 * `local_function_statement`.
 *
 * Reuses `csharpMethodConfig.extractParameters` so scope-extracted defs
 * carry the same arity semantics as the legacy parse-worker path:
 *   - `params` variadic collapses `parameterCount` to `undefined`,
 *     which `csharpArityCompatibility` then treats as "max unknown" —
 *     the candidate stays eligible at `argCount >= required`.
 *   - Defaulted parameters (`= expr`) contribute to `optionalCount`;
 *     `requiredParameterCount = total − optionalCount`.
 *   - `parameterTypes` collects declared type names (with `ref`/`out`/
 *     `in` prefix) for overload narrowing; a literal `'params'` marker
 *     is appended for variadic methods so `csharpArityCompatibility`
 *     can detect them without re-reading the AST.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { csharpMethodConfig } from '../../method-extractors/configs/csharp.js';

interface CsharpArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computeCsharpArityMetadata(fnNode: SyntaxNode): CsharpArityMetadata {
  const params = csharpMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasVariadic = false;
  let optionalCount = 0;
  const types: string[] = [];
  for (const p of params) {
    if (p.isVariadic) hasVariadic = true;
    else if (p.isOptional) optionalCount++;
    if (p.type !== null) types.push(p.type);
  }
  if (hasVariadic) types.push('params');

  const total = params.length;
  // `params int[] args` declares one formal param but accepts any arg
  // count ≥ required — mirror Python's treatment of `*args` and leave
  // `parameterCount` undefined so the registry treats max as unknown.
  const parameterCount = hasVariadic ? undefined : total;
  const requiredParameterCount = hasVariadic ? undefined : total - optionalCount;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
