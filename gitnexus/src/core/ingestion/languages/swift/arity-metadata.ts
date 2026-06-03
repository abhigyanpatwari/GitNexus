/**
 * Extract Swift arity metadata from a function-like tree-sitter node —
 * `function_declaration`, `protocol_function_declaration`, or
 * `init_declaration`.
 *
 * Reuses `swiftMethodConfig.extractParameters` so scope-extracted defs
 * carry the same arity semantics as the legacy parse-worker path:
 *   - Variadic params (`xs: Int...`) collapse `parameterCount` to
 *     `undefined`, which `swiftArityCompatibility` treats as "max
 *     unknown" — the candidate stays eligible at `argCount >= required`.
 *   - Defaulted params (`= expr`) contribute to `optionalCount`;
 *     `requiredParameterCount = total − optionalCount`.
 *   - `parameterTypes` collects declared type names for narrowing; a
 *     literal `'variadic'` marker is appended for variadic methods so
 *     `swiftArityCompatibility` can detect them without re-reading AST.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { swiftMethodConfig } from '../../method-extractors/configs/swift.js';

interface SwiftArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computeSwiftArityMetadata(fnNode: SyntaxNode): SwiftArityMetadata {
  const params = swiftMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasVariadic = false;
  let optionalCount = 0;
  const types: string[] = [];
  for (const p of params) {
    if (p.isVariadic) hasVariadic = true;
    else if (p.isOptional) optionalCount++;
    if (p.type !== null) types.push(p.type);
  }
  if (hasVariadic) types.push('variadic');

  const total = params.length;
  const parameterCount = hasVariadic ? undefined : total;
  const requiredParameterCount = hasVariadic ? undefined : total - optionalCount;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
