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

import type {
  ArityVerdict,
  Callsite,
  ConstraintContext,
  ParameterTypeClass,
  SymbolDefinition,
} from 'gitnexus-shared';
import { classifyType, type TypeClass } from './type-classifier.js';
import type { ConstraintExpr, CppConstraintPayload } from './constraint-extractor.js';

interface ConstraintArgClass {
  readonly typeClass: TypeClass;
  readonly shape?: ParameterTypeClass;
}

type AtomicEvaluator = (args: readonly ConstraintArgClass[]) => ArityVerdict;

/**
 * Curated Tier-A predicate registry. Predicates that depend on pointer,
 * reference, or cv shape consult `ConstraintContext.argumentTypeClasses`.
 * Missing or unsupported shape returns 'unknown' to preserve monotonicity.
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
  [
    'is_void_v',
    (args) => unaryVerdict(args, (arg) => isPlainValue(arg) && arg.typeClass === 'void'),
  ],
  [
    'is_integral_v',
    (args) => unaryVerdict(args, (arg) => isPlainValue(arg) && isIntegralClass(arg.typeClass)),
  ],
  [
    'is_floating_point_v',
    (args) => unaryVerdict(args, (arg) => isPlainValue(arg) && arg.typeClass === 'floating'),
  ],
  [
    'is_arithmetic_v',
    (args) =>
      unaryVerdict(
        args,
        (arg) =>
          isPlainValue(arg) && (isIntegralClass(arg.typeClass) || arg.typeClass === 'floating'),
      ),
  ],
  [
    'is_enum_v',
    (args) => unaryVerdict(args, (arg) => isPlainValue(arg) && arg.typeClass === 'enum'),
  ],
  [
    'is_class_v',
    (args) => unaryVerdict(args, (arg) => isPlainValue(arg) && arg.typeClass === 'class'),
  ],
  [
    'is_pointer_v',
    (args) =>
      unaryShapeVerdict(args, (shape) => shape.indirection === 'pointer' && shape.pointerDepth > 0),
  ],
  [
    'is_reference_v',
    (args) =>
      unaryShapeVerdict(
        args,
        (shape) => shape.indirection === 'lvalue-ref' || shape.indirection === 'rvalue-ref',
      ),
  ],
  [
    'is_const_v',
    (args) =>
      unaryShapeVerdict(args, (shape) => shape.cv === 'const' || shape.cv === 'const volatile', {
        requireTopLevelCv: true,
      }),
  ],
  [
    'is_volatile_v',
    (args) =>
      unaryShapeVerdict(args, (shape) => shape.cv === 'volatile' || shape.cv === 'const volatile', {
        requireTopLevelCv: true,
      }),
  ],
  [
    'is_same_v',
    (args) => {
      if (args.length < 2 || args[0].typeClass === 'unknown' || args[1].typeClass === 'unknown') {
        return 'unknown';
      }
      return args[0].typeClass === args[1].typeClass ? 'compatible' : 'incompatible';
    },
  ],
]);

function unaryVerdict(
  args: readonly ConstraintArgClass[],
  predicate: (arg: ConstraintArgClass) => boolean,
): ArityVerdict {
  const arg = args[0];
  if (arg === undefined || arg.typeClass === 'unknown') return 'unknown';
  return predicate(arg) ? 'compatible' : 'incompatible';
}

function unaryShapeVerdict(
  args: readonly ConstraintArgClass[],
  predicate: (shape: ParameterTypeClass) => boolean,
  options: { readonly requireTopLevelCv?: boolean } = {},
): ArityVerdict {
  const arg = args[0];
  if (arg === undefined || arg.typeClass === 'unknown') return 'unknown';
  const shape = arg.shape;
  if (shape === undefined || shape.indirection === 'unknown' || shape.cv === 'unknown') {
    return 'unknown';
  }
  if (options.requireTopLevelCv === true && shape.indirection === 'pointer') {
    return 'unknown';
  }
  return predicate(shape) ? 'compatible' : 'incompatible';
}

function isPlainValue(arg: ConstraintArgClass): boolean {
  const shape = arg.shape;
  if (shape === undefined) return true;
  return shape.indirection === 'value';
}

function classifyConstraintArg(
  token: string | undefined,
  shape?: ParameterTypeClass,
): ConstraintArgClass {
  if (shape !== undefined && shape.base.startsWith('enum:')) {
    return { typeClass: 'enum', shape };
  }
  const typeClass = token === undefined || token === '' ? 'unknown' : classifyType(token);
  return { typeClass, ...(shape !== undefined ? { shape } : {}) };
}

function tokenForArg(ctx: ConstraintContext, argIdx: number): string | undefined {
  const shape = ctx.argumentTypeClasses?.[argIdx];
  if (shape?.base.startsWith('enum:')) return shape.base;
  return ctx.argumentTypes?.[argIdx];
}

function shapeForTemplateParam(
  ctx: ConstraintContext,
  paramName: string,
  argIdx: number,
  def?: SymbolDefinition,
): ParameterTypeClass | undefined {
  const argShape = ctx.argumentTypeClasses?.[argIdx];
  if (argShape === undefined) return undefined;

  const paramShape = def?.parameterTypeClasses?.[argIdx];
  if (paramShape === undefined) return argShape;
  if (paramShape.base === paramName && paramShape.indirection === 'value') return argShape;
  return undefined;
}

/** Public surface — registered as `ScopeResolver.constraintCompatibility`. */
export function cppConstraintCompatibility(
  _callsite: Callsite,
  def: SymbolDefinition,
  ctx: ConstraintContext,
): ArityVerdict {
  const payload = def.templateConstraints as CppConstraintPayload | undefined;
  if (payload === undefined) return 'unknown';
  return evaluate(payload.expr, payload, ctx, def);
}

function evaluate(
  expr: ConstraintExpr,
  payload: CppConstraintPayload,
  ctx: ConstraintContext,
  def?: SymbolDefinition,
): ArityVerdict {
  switch (expr.kind) {
    case 'unknown':
      return 'unknown';
    case 'atomic': {
      const evaluator = REGISTRY.get(expr.name);
      if (evaluator === undefined) return 'unknown';
      const classes = expr.args.map((paramName) => {
        const argIdx = payload.paramArgIndex[paramName];
        if (argIdx === undefined) return { typeClass: 'unknown' as TypeClass };
        return classifyConstraintArg(
          tokenForArg(ctx, argIdx),
          shapeForTemplateParam(ctx, paramName, argIdx, def),
        );
      });
      return evaluator(classes);
    }
    case 'and': {
      let result: ArityVerdict = 'compatible';
      for (const child of expr.children) {
        const v = evaluate(child, payload, ctx, def);
        if (v === 'incompatible') return 'incompatible';
        if (v === 'unknown') result = 'unknown';
      }
      return result;
    }
    case 'or': {
      let result: ArityVerdict = 'incompatible';
      for (const child of expr.children) {
        const v = evaluate(child, payload, ctx, def);
        if (v === 'compatible') return 'compatible';
        if (v === 'unknown') result = 'unknown';
      }
      return result;
    }
    case 'not': {
      const v = evaluate(expr.child, payload, ctx, def);
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
