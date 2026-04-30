/**
 * TypeScript arity check, accommodating rest parameters and optional
 * (`p?: T`) / defaulted (`p: T = …`) parameters.
 *
 * TypeScript-specific semantics vs C#:
 *
 *   - **Optional** — `p?: T` collapses to `isOptional` in the extractor
 *     and contributes to `optionalCount`, so `requiredParameterCount`
 *     excludes it. Same wire shape as a default-valued parameter.
 *   - **Rest** — `...args: T[]` makes `parameterCount` undefined (max
 *     unknown) and `parameterTypes` carries a literal `'params'` marker
 *     so this hook can detect variadic calls without re-reading the AST
 *     (mirrors the C# convention for cross-language consistency).
 *   - **Generics** — function-level generic type parameters (`<T, U>`)
 *     do NOT count toward arity; the method-extractor reads the
 *     `parameters` field and ignores `type_parameters`, so generic
 *     count never enters the metadata.
 *
 * The metadata shape (`parameterCount`, `requiredParameterCount`,
 * `parameterTypes`) is synthesized by `arity-metadata.ts` and stored
 * on `SymbolDefinition`. This file consumes that metadata.
 *
 * Verdicts:
 *   - `'compatible'`   — `requiredParameterCount <= argCount <=
 *                        parameterCount`, OR the def has rest params
 *                        (any `argCount >= required`).
 *   - `'incompatible'` — argCount is below required, OR above max with
 *                        no rest params.
 *   - `'unknown'`      — metadata is absent / incomplete (treated as
 *                        neutral by the registry).
 *
 * `'incompatible'` is a soft signal in `Registry.lookup` (penalized
 * but still considered when no compatible candidate exists), per
 * RFC §4.
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function typescriptArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

  // Variadic detection: the `arity-metadata` synthesizer appends the
  // literal `'params'` marker to `parameterTypes` when the def has a
  // rest parameter, to avoid re-parsing the AST here.
  const hasRest =
    def.parameterTypes !== undefined &&
    def.parameterTypes.some((t) => t === 'params' || t.startsWith('params '));

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max && !hasRest) return 'incompatible';

  return 'compatible';
}
