/**
 * Extract Java arity metadata from a method-like tree-sitter node —
 * `method_declaration` or `constructor_declaration`.
 *
 * Reuses `javaMethodConfig.extractParameters` so scope-extracted defs
 * carry the same arity semantics as the legacy parse-worker path:
 *   - varargs (`...`) collapses `parameterCount` to `undefined`
 *   - `parameterTypes` collects declared type names; a literal
 *     `'varargs'` marker is appended for variadic methods so
 *     `javaArityCompatibility` can detect them.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { javaMethodConfig } from '../../method-extractors/configs/jvm.js';

export interface JavaArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computeJavaArityMetadata(fnNode: SyntaxNode): JavaArityMetadata {
  const params = javaMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasVariadic = false;
  const types: string[] = [];
  for (const p of params) {
    if (p.isVariadic) hasVariadic = true;
    if (p.type !== null) types.push(p.type);
  }
  if (hasVariadic) types.push('varargs');

  const total = params.length;
  // For varargs methods, `parameterCount` (max) is unknown — any number of
  // trailing arguments is valid.  But the fixed-prefix parameters (everything
  // before the variadic `...` param) are still required, so we preserve that
  // count in `requiredParameterCount` so `javaArityCompatibility` can reject
  // calls that undersupply the fixed prefix (e.g. `f(int x, String... args)`
  // called with 0 args).
  const fixedCount = params.filter((p) => !p.isVariadic).length;
  const parameterCount = hasVariadic ? undefined : total;
  const requiredParameterCount = hasVariadic ? fixedCount : total;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes: types.length > 0 ? types : undefined,
  };
}
