/**
 * Dart arity compatibility (count-primary, labels soft) — mirror of
 * `languages/swift/arity.ts`.
 *
 * Dart parameters come in four flavours: required positional, optional
 * positional (`[...]`), named (`{...}`), and required-named
 * (`{required ...}`). `dartMethodConfig.extractParameters` collapses these
 * into `isOptional` (a non-`required` named/optional-positional param is
 * optional), which `computeDartArityMetadata` turns into
 * `requiredParameterCount = total − optionalCount`. Named arguments are
 * unordered and matched on COUNT only here — label-precise dispatch is left
 * to the type-binding layer (Swift's documented "labels soft" decision).
 * Dart has no variadic parameters, so the max bound always applies.
 *
 * NOTE arg order: `(def, callsite)` — matches the `LanguageProvider` hook.
 * The `ScopeResolver` wires an adapter that flips the order to `(callsite, def)`.
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function dartArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (argCount === undefined || !Number.isFinite(argCount) || argCount < 0) return 'unknown';

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max) return 'incompatible';
  return 'compatible';
}
