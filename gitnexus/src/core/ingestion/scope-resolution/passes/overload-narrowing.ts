/**
 * Overload narrowing — pick candidates from a list of same-named
 * method / function overloads using the call-site's arity and
 * argument-type signals.
 *
 * Used by both `receiver-bound-calls.ts::pickOverload` (explicit
 * receiver member call) and `free-call-fallback.ts::pickImplicitThisOverload`
 * (implicit `this` free-call inside a class-like body). Shared to keep
 * narrowing semantics in lockstep across the two sites.
 *
 * Semantics (first-wins; callers take `result[0]`):
 *   1. If `argCount` is undefined, arity is a pass-through.
 *   2. Exact-required-match wins over variadic. Variadic is detected
 *      via a `parameterTypes` entry equal to `'params'` or starting
 *      with `'params '` (C# `params` / variadic marker).
 *   3. If the arity filter empties the set AND any candidate had
 *      unknown bounds (both `parameterCount` and `requiredParameterCount`
 *      undefined), fall back to the full overload list — the empty
 *      result may be due to missing metadata rather than a real mismatch.
 *      If EVERY rejected candidate had definite arity bounds, trust the
 *      filter and return empty — the call is genuinely arity-incompatible
 *      (e.g., PHP `f(int $req, ...$rest)` called with zero args).
 *   4. If `argTypes` is present, filter further by per-slot type
 *      equality. An empty string in `argTypes[i]` means "unknown" and
 *      counts as a match. Mismatches disqualify. A non-empty typed
 *      result wins; otherwise return the arity-filtered candidates.
 *   5. Empty input returns empty output.
 */

import type { SymbolDefinition } from 'gitnexus-shared';

export function narrowOverloadCandidates(
  overloads: readonly SymbolDefinition[],
  argCount: number | undefined,
  argTypes: readonly string[] | undefined,
): readonly SymbolDefinition[] {
  if (overloads.length === 0) return [];

  const arityMatches: readonly SymbolDefinition[] =
    argCount === undefined
      ? overloads
      : overloads.filter((d) => {
          const max = d.parameterCount;
          const min = d.requiredParameterCount;
          if (max !== undefined && argCount > max) {
            // Variadic marker check is C#-specific (the 'params' keyword).
            // Other languages use their own marker — PHP uses '...' (see
            // `languages/php/arity-metadata.ts:46`), Python uses '*args'-
            // shaped metadata that lives outside `parameterTypes` entirely.
            // This branch is dead code for those languages because they
            // set `parameterCount = undefined` for variadic functions,
            // which keeps `max` undefined and skips this check entirely.
            // Adding new variadic markers here changes behavior for those
            // other languages too — don't extend without auditing each
            // adapter's `arity-metadata.ts`. Finding 9 of PR #1497.
            const variadic =
              d.parameterTypes !== undefined &&
              d.parameterTypes.some((t) => t === 'params' || t.startsWith('params '));
            if (!variadic) return false;
          }
          if (min !== undefined && argCount < min) return false;
          return true;
        });

  // When the arity filter empties the set, only fall back to the full
  // overload list if some candidate had unknown bounds — otherwise the
  // empty result is authoritative (every candidate definitively failed
  // arity, e.g., PHP variadic with required-prefix called with too few
  // args).
  const anyUnknownBounds = overloads.some(
    (d) => d.parameterCount === undefined && d.requiredParameterCount === undefined,
  );
  const candidates: readonly SymbolDefinition[] =
    arityMatches.length > 0 ? arityMatches : anyUnknownBounds ? overloads : [];

  if (argTypes !== undefined && argTypes.length > 0) {
    const typed = candidates.filter((d) => {
      const params = d.parameterTypes;
      if (params === undefined) return false;
      for (let i = 0; i < argTypes.length && i < params.length; i++) {
        if (argTypes[i] === '') continue;
        if (argTypes[i] !== params[i]) return false;
      }
      return true;
    });
    if (typed.length > 0) return typed;
  }

  return candidates;
}

/**
 * Detect when >1 candidate share identical `parameterTypes` after the
 * per-language normalizer has collapsed distinct underlying types. This
 * signals "the resolver cannot pick the right overload — the
 * normalization that helps single-candidate flows now hides a real
 * ambiguity" and lets callers suppress the edge rather than pick
 * arbitrarily.
 *
 * Concrete trigger (PR #1520 review follow-up plan U2, Claude review
 * Finding 5): the C++ `arity-metadata.ts` normalizer collapses `int`,
 * `long`, `short`, `unsigned`, and `size_t` to `'int'`. Without this
 * check, `process(int)` and `process(long)` both end up with
 * `parameterTypes === ['int']`, and `pickOverload` arbitrarily picks
 * the first — emitting a false CALLS edge to the wrong overload.
 *
 * Returns false when:
 *   - 0 or 1 candidates (no ambiguity to detect)
 *   - any candidate has undefined `parameterTypes` (can't compare)
 *   - candidates differ in arity or in any parameter-type slot
 *
 * Other languages: this check is a precondition gate, not a behavior
 * change for normal narrowing. Languages whose normalizers do not
 * collapse distinct types (verified by grep over `*-arity-metadata.ts`
 * — no `int → int` collapse outside C++) will never produce >1
 * candidate with identical `parameterTypes` from genuinely distinct
 * declarations, so this returns false for them. The branch is
 * effectively C++-only in practice.
 */
export function isOverloadAmbiguousAfterNormalization(
  candidates: readonly SymbolDefinition[],
  argCount?: number,
): boolean {
  if (candidates.length < 2) return false;
  const first = candidates[0].parameterTypes;
  if (first === undefined) return false;
  // When argCount is provided, compare only the first `argCount` slots —
  // this catches default-argument ambiguity: `void f(int); void f(int, int = 0);`
  // called with `f(1)` (argCount=1) leaves both candidates viable because
  // default args make them arity-compatible, and their first slot is
  // identical even though full parameterTypes lengths differ.
  // Without argCount, fall back to full-sequence comparison (the original
  // int/long normalization-collapse case).
  const compareUpTo = argCount !== undefined ? argCount : first.length;
  if (compareUpTo === 0) return false;
  if (first.length < compareUpTo) return false;
  for (let i = 1; i < candidates.length; i++) {
    const p = candidates[i].parameterTypes;
    if (p === undefined) return false;
    if (p.length < compareUpTo) return false;
    for (let j = 0; j < compareUpTo; j++) {
      if (p[j] !== first[j]) return false;
    }
    // When argCount is NOT provided, also require length equality so
    // distinct-arity candidates that happen to share a prefix don't
    // collapse to ambiguous (preserves the original int/long contract).
    if (argCount === undefined && p.length !== first.length) return false;
  }
  return true;
}
