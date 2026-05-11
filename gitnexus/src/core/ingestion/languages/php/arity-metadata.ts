/**
 * Extract PHP arity metadata from a method-like tree-sitter node —
 * `method_declaration` or `function_definition`.
 *
 * Reuses `phpMethodConfig.extractParameters` so scope-extracted defs
 * carry the same arity semantics as the legacy parse-worker path:
 *   - `variadic_parameter` (`...$args`) collapses `parameterCount` to
 *     `undefined`, which `phpArityCompatibility` then treats as
 *     "max unknown" — the candidate stays eligible at `argCount >= required`.
 *   - Defaulted parameters (`= expr`) contribute to `optionalCount`;
 *     `requiredParameterCount = total − optionalCount`.
 *   - `property_promotion_parameter` (constructor-promoted) is counted
 *     the same as `simple_parameter` since both consume an argument slot.
 *   - `parameterTypes` collects declared type names; a literal `'...'`
 *     marker is appended for variadic methods so `phpArityCompatibility`
 *     can detect them without re-reading the AST.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { phpMethodConfig } from '../../method-extractors/configs/php.js';

interface PhpArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computePhpArityMetadata(fnNode: SyntaxNode): PhpArityMetadata {
  const params = phpMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasVariadic = false;
  let optionalCount = 0;
  const types: string[] = [];

  for (const p of params) {
    if (p.isVariadic) {
      hasVariadic = true;
    } else if (p.isOptional) {
      optionalCount++;
    }
    if (p.type !== null) types.push(p.type);
  }
  if (hasVariadic) types.push('...');

  const total = params.length;
  // Variadic methods accept any arg count ≥ required — leave `parameterCount`
  // undefined so the registry treats max as unknown.
  const parameterCount = hasVariadic ? undefined : total;
  const requiredParameterCount = hasVariadic ? undefined : total - optionalCount;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
