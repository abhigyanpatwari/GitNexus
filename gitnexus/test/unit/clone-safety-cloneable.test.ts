/**
 * #2143 — compile-time boundary guard: `Cloneable<T>` + `assertCloneable()`.
 *
 * `assertCloneable` is a runtime identity (zero cost); its real value is the
 * compile-time guarantee that a producer feeding an `unknown` worker-result
 * sink returns only structured-clone-safe data. The `@ts-expect-error` lines
 * below ARE the assertions — they make the type-check fail (`tsconfig.test.json`)
 * if a non-cloneable payload ever becomes assignable to `Cloneable<T>`; the
 * runtime cases pin the identity contract callers rely on.
 */
import { describe, it, expect } from 'vitest';

import { assertCloneable, type Cloneable } from '../../src/core/ingestion/workers/clone-safety.js';

describe('#2143: assertCloneable runtime identity', () => {
  it('returns clone-safe values unchanged (zero-cost identity)', () => {
    const obj = { kind: 'cpp' as const, names: ['a', 'b'], depth: 3, ok: true };
    expect(assertCloneable(obj)).toBe(obj);

    const withMap = { m: new Map<string, number>([['a', 1]]) as ReadonlyMap<string, number> };
    expect(assertCloneable(withMap)).toBe(withMap);

    expect(assertCloneable(undefined)).toBeUndefined();

    const nested = { a: { b: { c: [1, 2, 3] } } };
    expect(assertCloneable(nested)).toBe(nested);
  });

  it('a guarded value really is structured-cloneable (the runtime claim behind the type)', () => {
    const payload = { kind: 'cpp' as const, ranges: ['1:2'], inner: { xs: [1, 2] } };
    const guarded = assertCloneable(payload);
    expect(() => structuredClone(guarded)).not.toThrow();
  });
});

describe('#2143: Cloneable<T> compile-time rejection (type-level)', () => {
  it('accepts clean interface payloads and rejects function/symbol members', () => {
    interface Clean {
      readonly kind: 'cpp';
      readonly names: readonly string[];
      readonly inner: { readonly n: number };
    }
    const clean: Clean = { kind: 'cpp', names: ['a'], inner: { n: 1 } };
    expect(assertCloneable(clean)).toBe(clean); // compiles — clean interface is Cloneable

    interface LeakyFn {
      readonly name: string;
      readonly toString: () => string;
    }
    const leakyFn: LeakyFn = { name: 'x', toString: () => 'x' };
    // @ts-expect-error — a function member is not Cloneable (toString resolves to never)
    assertCloneable(leakyFn);

    interface LeakySym {
      readonly tag: symbol;
    }
    const leakySym: LeakySym = { tag: Symbol('t') };
    // @ts-expect-error — a symbol member is not Cloneable (tag resolves to never)
    assertCloneable(leakySym);

    // The guard must not be vacuous — these resolve to `never` at the type level.
    type FnIsNever = [Cloneable<() => void>] extends [never] ? true : false;
    type SymIsNever = [Cloneable<symbol>] extends [never] ? true : false;
    const fnIsNever: FnIsNever = true;
    const symIsNever: SymIsNever = true;
    expect(fnIsNever && symIsNever).toBe(true);
  });
});
