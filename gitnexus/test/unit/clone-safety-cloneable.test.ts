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

    // `X | undefined` (the real shape provider hooks return — collectFoo(): Foo | undefined).
    const maybe: string | undefined = undefined;
    expect(assertCloneable(maybe)).toBeUndefined();

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

    // R4 (#2135 tri-review): an `any`-typed member must NOT defeat the guard.
    interface LeakyAny {
      readonly name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly bag: any;
    }
    const leakyAny: LeakyAny = { name: 'x', bag: () => {} };
    // @ts-expect-error — an `any` member resolves to never, so the payload is rejected
    assertCloneable(leakyAny);

    // The guard must not be vacuous — these resolve to `never` at the type level.
    type FnIsNever = [Cloneable<() => void>] extends [never] ? true : false;
    type SymIsNever = [Cloneable<symbol>] extends [never] ? true : false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyIsNever = [Cloneable<any>] extends [never] ? true : false;
    const fnIsNever: FnIsNever = true;
    const symIsNever: SymIsNever = true;
    const anyIsNever: AnyIsNever = true;
    // Array equality (not `&&`) so this isn't a trivial-always-true conditional;
    // the real assertions are the `: …IsNever = true` annotations above, which
    // fail to compile if any guard regresses.
    expect([fnIsNever, symIsNever, anyIsNever]).toEqual([true, true, true]);
  });
});
