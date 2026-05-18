/**
 * Kleene 3-valued evaluator + curated 4-predicate registry +
 * `cppConstraintCompatibility` hook export for SFINAE / `requires`-clause
 * filtering (issue #1579).
 *
 * Semantics:
 *   - `'incompatible'` → predicate provably fails for these argumentTypes
 *     (ISO `[temp.constr.atomic]` "not satisfied")
 *   - `'compatible'`   → predicate provably holds
 *   - `'unknown'`      → cannot decide (missing arg-type info, predicate
 *     not in registry, AST shape bailed during extraction). The shared
 *     filter keeps the candidate on `'unknown'` — monotonicity guarantee.
 *
 * Kleene rules (extension of ISO's 2-valued short-circuit conjunction in
 * `<https://en.cppreference.com/w/cpp/language/constraints>`):
 *   AND: incompatible if any child incompatible; compatible iff all
 *        children compatible; otherwise unknown.
 *   OR:  compatible if any child compatible; incompatible iff all
 *        children incompatible; otherwise unknown.
 *   NOT: flip compatible↔incompatible; pass through unknown.
 */

import type { ArityVerdict, Callsite, ConstraintContext, SymbolDefinition } from 'gitnexus-shared';
import { classifyType, type TypeClass } from './type-classifier.js';
import type { ConstraintExpr, CppConstraintPayload } from './constraint-extractor.js';

type AtomicEvaluator = (argClasses: readonly TypeClass[]) => ArityVerdict;

/**
 * Curated Tier-A predicate registry — the four canonical
 * `<type_traits>` variable templates whose truth tables are closed-form
 * over our coarse `TypeClass` enum.
 *
 * Deferred predicates that need a cv/ref/pointer sidecar on
 * `normalizeCppParamType` (today the normalizer strips those markers
 * before storage) live in #1579 as one-line follow-up adds.
 */
// ISO `<type_traits>` treats `bool`, `char`, and the signed/unsigned char
// variants as integral types (§21.3.4 Table 48), so `is_integral_v<bool>`
// and `is_integral_v<char>` must both yield `true`. We keep the `TypeClass`
// enum precise (separate `'bool'` / `'char'` buckets) so that
// `is_same_v<bool, int>` still resolves to `'incompatible'`; the integral-
// family widening lives here in the predicate evaluators instead.
function isIntegralClass(c: TypeClass | undefined): boolean {
  return c === 'integral' || c === 'bool' || c === 'char';
}

const REGISTRY = new Map<string, AtomicEvaluator>([
  ['is_integral_v', (cls) => verdictFromBool(isIntegralClass(cls[0]), cls)],
  ['is_floating_point_v', (cls) => verdictFromBool(cls[0] === 'floating', cls)],
  [
    'is_arithmetic_v',
    (cls) => verdictFromBool(isIntegralClass(cls[0]) || cls[0] === 'floating', cls),
  ],
  // NOTE: cv-qualifiers are stripped by `normalizeCppParamType` before the
  // type token reaches `classifyType`, so `is_same_v<const T, T>` returns
  // `'compatible'` instead of the ISO-correct `false`. Tracked under the
  // cv-sidecar refactor in #1579's "Out of scope" list; until that lands
  // this approximation matches the common `is_same_v<T, ConcreteType>`
  // dispatch idiom and silently degrades on cv-distinct compares.
  [
    'is_same_v',
    (cls) => {
      if (cls.length < 2 || cls[0] === 'unknown' || cls[1] === 'unknown') return 'unknown';
      return cls[0] === cls[1] ? 'compatible' : 'incompatible';
    },
  ],
]);

function verdictFromBool(predicate: boolean, cls: readonly TypeClass[]): ArityVerdict {
  if (cls[0] === 'unknown') return 'unknown';
  return predicate ? 'compatible' : 'incompatible';
}

/** Public surface — registered as `ScopeResolver.constraintCompatibility`. */
export function cppConstraintCompatibility(
  _callsite: Callsite,
  def: SymbolDefinition,
  ctx: ConstraintContext,
): ArityVerdict {
  const payload = def.templateConstraints as CppConstraintPayload | undefined;
  if (payload === undefined) return 'unknown';
  return evaluate(payload.expr, payload, ctx);
}

function evaluate(
  expr: ConstraintExpr,
  payload: CppConstraintPayload,
  ctx: ConstraintContext,
): ArityVerdict {
  switch (expr.kind) {
    case 'unknown':
      return 'unknown';
    case 'atomic': {
      const evaluator = REGISTRY.get(expr.name);
      if (evaluator === undefined) return 'unknown';
      const classes = expr.args.map((paramName) => {
        const argIdx = payload.paramArgIndex[paramName];
        if (argIdx === undefined) return 'unknown' as TypeClass;
        const token = ctx.argumentTypes?.[argIdx];
        if (token === undefined || token === '') return 'unknown' as TypeClass;
        return classifyType(token);
      });
      return evaluator(classes);
    }
    case 'and': {
      let result: ArityVerdict = 'compatible';
      for (const child of expr.children) {
        const v = evaluate(child, payload, ctx);
        if (v === 'incompatible') return 'incompatible';
        if (v === 'unknown') result = 'unknown';
      }
      return result;
    }
    case 'or': {
      let result: ArityVerdict = 'incompatible';
      for (const child of expr.children) {
        const v = evaluate(child, payload, ctx);
        if (v === 'compatible') return 'compatible';
        if (v === 'unknown') result = 'unknown';
      }
      return result;
    }
    case 'not': {
      const v = evaluate(expr.child, payload, ctx);
      if (v === 'compatible') return 'incompatible';
      if (v === 'incompatible') return 'compatible';
      return 'unknown';
    }
  }
}

/** Exposed for unit tests — lets `cpp-constraint.test.ts` assert
 *  `expect(getRegistrySize()).toBe(4)` without exporting the Map itself. */
export function getRegistrySize(): number {
  return REGISTRY.size;
}

/** Exposed for unit tests covering the Kleene 3-valued truth table
 *  directly, without an AST round-trip. */
export function evaluateForTest(
  expr: ConstraintExpr,
  payload: CppConstraintPayload,
  ctx: ConstraintContext,
): ArityVerdict {
  return evaluate(expr, payload, ctx);
}
