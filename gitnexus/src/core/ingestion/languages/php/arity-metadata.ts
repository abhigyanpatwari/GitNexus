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
 *     `requiredParameterCount = total − optionalCount − (variadic ? 1 : 0)`.
 *     The variadic slot itself accepts zero args so it is subtracted from
 *     the required count — `f(int $a, ...$rest)` requires exactly 1 arg,
 *     not 2, and `f(...$rest)` requires 0.
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
  // PHP variadic marker convention: append the literal '...' string to
  // `parameterTypes`. This is intentionally DIFFERENT from C#, which uses
  // the literal 'params' (its source-language keyword). The shared
  // `narrowOverloadCandidates` pass in `scope-resolution/passes/overload-
  // narrowing.ts` checks for the C# 'params' marker — that branch is
  // dead code for PHP because PHP variadic methods set `parameterCount
  // = undefined` (see line below), which skips the `max !== undefined`
  // gate that hosts the 'params' check. PHP's actual variadic-aware
  // arity logic lives in `phpArityCompatibility` (arity.ts) and now
  // also in `phpEmitUnresolvedReceiverEdges` (scope-resolver.ts), both
  // of which check `'...'`. Finding 9 of PR #1497 adversarial review.
  if (hasVariadic) types.push('...');

  const total = params.length;
  // Variadic methods accept any arg count ≥ required — leave `parameterCount`
  // undefined so the registry treats max as unknown.
  const parameterCount = hasVariadic ? undefined : total;
  // The variadic slot itself accepts zero args; subtract it from the required
  // count so PHP's ArgumentCountError-equivalent calls (too few args before
  // the variadic) are correctly rejected by arity compatibility.
  const requiredParameterCount = total - optionalCount - (hasVariadic ? 1 : 0);

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
