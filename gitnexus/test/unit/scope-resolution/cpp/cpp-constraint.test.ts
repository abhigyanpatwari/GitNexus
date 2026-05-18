/**
 * Unit tests for the C++ SFINAE / `requires`-clause constraint pipeline
 * (issue #1579). Three sections per the plan:
 *   1. Extractor — F1, F2, F4 shapes plus an unknown-bail row.
 *   2. Kleene 3-valued evaluator — AND / OR / NOT truth-table rows.
 *   3. Predicate registry — `is_integral_v`, `is_floating_point_v`,
 *      `is_arithmetic_v`, `is_same_v` × representative type tokens;
 *      surface-size assertion guards the registry shape.
 */

import { describe, it, expect } from 'vitest';
import { emitCppScopeCaptures } from '../../../../src/core/ingestion/languages/cpp/captures.js';
import type {
  ConstraintExpr,
  CppConstraintPayload,
} from '../../../../src/core/ingestion/languages/cpp/constraint-extractor.js';
import {
  cppConstraintCompatibility,
  evaluateForTest,
  getRegistrySize,
} from '../../../../src/core/ingestion/languages/cpp/constraint-filter.js';
import type { ArityVerdict, SymbolDefinition } from 'gitnexus-shared';

function templateConstraintsFor(src: string): CppConstraintPayload | undefined {
  const matches = emitCppScopeCaptures(src, 'test.cpp');
  for (const m of matches) {
    const cap = m['@declaration.template-constraints'];
    if (cap !== undefined) return JSON.parse(cap.text) as CppConstraintPayload;
  }
  return undefined;
}

// ─── Section 1: Extractor ─────────────────────────────────────────────────

describe('extractCppTemplateConstraints — AST shapes', () => {
  it('F1 — unqualified enable_if_t<P, int> = 0 default parameter', () => {
    // Genuinely unqualified form — no `std::` prefix on `enable_if_t`,
    // which exercises the `template_type`-direct branch in the extractor
    // independently of the `qualified_identifier` unwrap covered by F2.
    const payload = templateConstraintsFor(`
      #include <type_traits>
      using std::enable_if_t;
      using std::is_integral_v;
      template<class T, enable_if_t<is_integral_v<T>, int> = 0>
      void process(T value);
    `);
    expect(payload).toBeDefined();
    expect(payload!.templateParams).toContain('T');
    expect(payload!.paramArgIndex).toEqual({ T: 0 });
    expect(payload!.expr.kind).toBe('atomic');
    if (payload!.expr.kind === 'atomic') {
      expect(payload!.expr.name).toBe('is_integral_v');
      expect(payload!.expr.args).toEqual(['T']);
    }
  });

  it('F2 — std::-qualified enable_if_t (canonical ticket form)', () => {
    const payload = templateConstraintsFor(`
      #include <type_traits>
      template<class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
      void process(T value);
    `);
    expect(payload).toBeDefined();
    if (payload!.expr.kind === 'atomic') {
      // Qualified prefix stripped — registry lookup keys on the bare name.
      expect(payload!.expr.name).toBe('is_floating_point_v');
      expect(payload!.expr.args).toEqual(['T']);
    } else {
      throw new Error(`expected atomic, got ${payload!.expr.kind}`);
    }
  });

  it('F4 — C++20 leading requires-clause', () => {
    const payload = templateConstraintsFor(`
      #include <type_traits>
      template<class T> requires std::is_integral_v<T>
      void process(T value);
    `);
    expect(payload).toBeDefined();
    if (payload!.expr.kind === 'atomic') {
      expect(payload!.expr.name).toBe('is_integral_v');
      expect(payload!.expr.args).toEqual(['T']);
    } else {
      throw new Error(`expected atomic, got ${payload!.expr.kind}`);
    }
  });

  it('unknown-bail row — non-template constraint payload returns unknown', () => {
    // Use a predicate name the registry doesn't recognize, plus an
    // unsupported boolean composition shape (decltype). Even if the
    // extractor produces an `unknown` node here, monotonicity guarantees
    // the candidate is kept at evaluation time.
    const payload = templateConstraintsFor(`
      #include <type_traits>
      template<class T, std::enable_if_t<decltype(some_check<T>())::value, int> = 0>
      void process(T value);
    `);
    // Extractor MAY succeed with kind: 'unknown' or return undefined —
    // either is acceptable; the monotonicity invariant is what matters.
    if (payload !== undefined) {
      // Walk the expression tree: every leaf must be either an atomic
      // outside the registry or an 'unknown' node — never a wrongly-typed
      // boolean compose hiding an unrecognized shape.
      const reachableKinds = collectKinds(payload.expr);
      expect(reachableKinds.has('unknown')).toBe(true);
    }
  });
});

function collectKinds(expr: ConstraintExpr): Set<ConstraintExpr['kind']> {
  const out = new Set<ConstraintExpr['kind']>([expr.kind]);
  if (expr.kind === 'and' || expr.kind === 'or') {
    for (const c of expr.children) for (const k of collectKinds(c)) out.add(k);
  } else if (expr.kind === 'not') {
    for (const k of collectKinds(expr.child)) out.add(k);
  }
  return out;
}

// ─── Section 2: Kleene 3-valued evaluator ──────────────────────────────────

describe('evaluate — Kleene 3-valued truth table', () => {
  const payload: CppConstraintPayload = {
    templateParams: ['T'],
    paramArgIndex: { T: 0 },
    expr: { kind: 'unknown' }, // unused; we pass expr to evaluate directly
  };
  const ctx = { argumentTypes: ['int'] as const };

  const atomic = (verdict: ArityVerdict): ConstraintExpr => {
    // Inject a verdict via a synthetic registry-miss-or-hit: use is_integral_v
    // on T at argIdx 0 ('int') for compatible, is_floating_point_v for
    // incompatible, and an unknown predicate for unknown.
    if (verdict === 'compatible') return { kind: 'atomic', name: 'is_integral_v', args: ['T'] };
    if (verdict === 'incompatible')
      return { kind: 'atomic', name: 'is_floating_point_v', args: ['T'] };
    return { kind: 'atomic', name: '__not_in_registry__', args: ['T'] };
  };

  it('AND: incompatible if any child incompatible', () => {
    const expr: ConstraintExpr = {
      kind: 'and',
      children: [atomic('compatible'), atomic('incompatible')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('incompatible');
  });

  it('AND: compatible iff all children compatible', () => {
    const expr: ConstraintExpr = {
      kind: 'and',
      children: [atomic('compatible'), atomic('compatible')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('compatible');
  });

  it('AND: unknown when no incompatible but at least one unknown', () => {
    const expr: ConstraintExpr = {
      kind: 'and',
      children: [atomic('compatible'), atomic('unknown')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('unknown');
  });

  it('OR: compatible if any child compatible', () => {
    const expr: ConstraintExpr = {
      kind: 'or',
      children: [atomic('incompatible'), atomic('compatible')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('compatible');
  });

  it('OR: incompatible iff all children incompatible', () => {
    const expr: ConstraintExpr = {
      kind: 'or',
      children: [atomic('incompatible'), atomic('incompatible')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('incompatible');
  });

  it('OR: unknown when no compatible but at least one unknown', () => {
    const expr: ConstraintExpr = {
      kind: 'or',
      children: [atomic('incompatible'), atomic('unknown')],
    };
    expect(evaluateForTest(expr, payload, ctx)).toBe('unknown');
  });

  it('NOT: flips compatible ↔ incompatible, passes through unknown', () => {
    expect(evaluateForTest({ kind: 'not', child: atomic('compatible') }, payload, ctx)).toBe(
      'incompatible',
    );
    expect(evaluateForTest({ kind: 'not', child: atomic('incompatible') }, payload, ctx)).toBe(
      'compatible',
    );
    expect(evaluateForTest({ kind: 'not', child: atomic('unknown') }, payload, ctx)).toBe(
      'unknown',
    );
  });
});

// ─── Section 3: Predicate registry ─────────────────────────────────────────

describe('Tier-A predicate registry', () => {
  it('registry size is exactly 4 (surface-guard against accidental adds)', () => {
    expect(getRegistrySize()).toBe(4);
  });

  function verdict(name: string, args: string[], argumentTypes: readonly string[]): ArityVerdict {
    const payload: CppConstraintPayload = {
      templateParams: args,
      paramArgIndex: Object.fromEntries(args.map((a, i) => [a, i])),
      expr: { kind: 'atomic', name, args },
    };
    const def: SymbolDefinition = {
      nodeId: 'x',
      filePath: 'x.cpp',
      type: 'Function',
      templateConstraints: payload,
    };
    return cppConstraintCompatibility({ arity: argumentTypes.length }, def, { argumentTypes });
  }

  it('is_integral_v matches int, rejects double, unknown for blank', () => {
    expect(verdict('is_integral_v', ['T'], ['int'])).toBe('compatible');
    expect(verdict('is_integral_v', ['T'], ['double'])).toBe('incompatible');
    expect(verdict('is_integral_v', ['T'], [''])).toBe('unknown');
  });

  it('is_integral_v accepts bool and char per ISO `<type_traits>`', () => {
    // ISO §21.3.4 Table 48: bool and char are integral types.
    expect(verdict('is_integral_v', ['T'], ['bool'])).toBe('compatible');
    expect(verdict('is_integral_v', ['T'], ['char'])).toBe('compatible');
  });

  it('is_floating_point_v matches double, rejects int, unknown for blank', () => {
    expect(verdict('is_floating_point_v', ['T'], ['double'])).toBe('compatible');
    expect(verdict('is_floating_point_v', ['T'], ['int'])).toBe('incompatible');
    expect(verdict('is_floating_point_v', ['T'], [''])).toBe('unknown');
  });

  it('is_arithmetic_v matches both int and double (integral ∨ floating)', () => {
    expect(verdict('is_arithmetic_v', ['T'], ['int'])).toBe('compatible');
    expect(verdict('is_arithmetic_v', ['T'], ['double'])).toBe('compatible');
    expect(verdict('is_arithmetic_v', ['T'], ['bool'])).toBe('compatible');
    expect(verdict('is_arithmetic_v', ['T'], ['char'])).toBe('compatible');
    expect(verdict('is_arithmetic_v', ['T'], ['MyClass'])).toBe('incompatible');
  });

  it('is_same_v matches same tokens, rejects different, unknown on blanks', () => {
    expect(verdict('is_same_v', ['A', 'B'], ['int', 'int'])).toBe('compatible');
    expect(verdict('is_same_v', ['A', 'B'], ['int', 'double'])).toBe('incompatible');
    expect(verdict('is_same_v', ['A', 'B'], ['int', ''])).toBe('unknown');
    // Regression guard: even though `is_integral_v` now treats `bool` and
    // `char` as integral, `is_same_v` must keep them distinct from `int`
    // (precise `TypeClass` enum — widening lives only in the registry).
    expect(verdict('is_same_v', ['A', 'B'], ['bool', 'int'])).toBe('incompatible');
    expect(verdict('is_same_v', ['A', 'B'], ['char', 'int'])).toBe('incompatible');
  });

  it('unregistered predicate yields unknown (monotonicity)', () => {
    expect(verdict('__not_in_registry__', ['T'], ['int'])).toBe('unknown');
  });
});
