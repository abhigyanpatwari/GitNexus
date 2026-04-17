/**
 * Unit tests for MethodRegistry (SM-20).
 *
 * MethodRegistry is the most complex of the three owner-scoped registries
 * because it supports C++/Java/C# overloads. Lookup does two layers of
 * narrowing after the primary `ownerNodeId + methodName` key match:
 *
 *   1. Arity filter: when `argCount` is provided and there are multiple
 *      overloads, keep only those whose parameterCount range can match.
 *      Variadic candidates (`parameterCount === undefined`) are retained.
 *      If arity excludes EVERY candidate, fall back to the full pool so
 *      fuzzy resolution still has something to work with (the "arity
 *      fallback" branch — flagged as an untested branch by the testing
 *      reviewer).
 *
 *   2. Return-type dedup: among the remaining candidates, if every def
 *      shares the same defined returnType, return the first. If return
 *      types differ, return undefined (truly ambiguous).
 */

import { describe, it, expect } from 'vitest';
import { createMethodRegistry } from '../../../src/core/ingestion/model/method-registry.js';
import { makeMethod } from './helpers.js';

describe('MethodRegistry — basic lookup', () => {
  it('returns undefined when the registry is empty', () => {
    const reg = createMethodRegistry();
    expect(reg.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
  });

  it('register + lookup round-trips the def reference', () => {
    const reg = createMethodRegistry();
    const def = makeMethod({ nodeId: 'method:User.save' });

    reg.register('class:User', 'save', def);

    expect(reg.lookupMethodByOwner('class:User', 'save')).toBe(def);
  });

  it('isolates methods by ownerNodeId — same method name on two classes does not collide', () => {
    const reg = createMethodRegistry();
    const userSave = makeMethod({ nodeId: 'method:User.save' });
    const orderSave = makeMethod({ nodeId: 'method:Order.save' });

    reg.register('class:User', 'save', userSave);
    reg.register('class:Order', 'save', orderSave);

    expect(reg.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('method:User.save');
    expect(reg.lookupMethodByOwner('class:Order', 'save')?.nodeId).toBe('method:Order.save');
  });
});

describe('MethodRegistry — arity narrowing', () => {
  it('narrows overloads by parameterCount when argCount is provided', () => {
    const reg = createMethodRegistry();
    const greetEmpty = makeMethod({ nodeId: 'method:greet#0', parameterCount: 0 });
    const greetString = makeMethod({
      nodeId: 'method:greet#1',
      parameterCount: 1,
      returnType: 'void',
    });

    reg.register('class:User', 'greet', greetEmpty);
    reg.register('class:User', 'greet', greetString);

    // argCount 0 matches only the 0-arg overload
    expect(reg.lookupMethodByOwner('class:User', 'greet', 0)?.nodeId).toBe('method:greet#0');
    // argCount 1 matches only the 1-arg overload
    expect(reg.lookupMethodByOwner('class:User', 'greet', 1)?.nodeId).toBe('method:greet#1');
  });

  it('arity fallback — when no overload matches argCount, returns from the full pool (testing reviewer T-01)', () => {
    // This is the explicit arity-fallback branch flagged as untested.
    // Without the fallback, `save(1)` / `save(2)` with argCount=3 would
    // return undefined. With the fallback, it returns one of them so the
    // caller's fuzzy resolution path can still make progress.
    const reg = createMethodRegistry();
    const save1 = makeMethod({ nodeId: 'method:save#1', parameterCount: 1, returnType: 'void' });
    const save2 = makeMethod({ nodeId: 'method:save#2', parameterCount: 2, returnType: 'void' });

    reg.register('class:User', 'save', save1);
    reg.register('class:User', 'save', save2);

    // argCount 3 matches neither; fallback returns one of them (first
    // wins because both share the same returnType 'void').
    const result = reg.lookupMethodByOwner('class:User', 'save', 3);
    expect(result).toBeDefined();
    expect(result?.nodeId).toBe('method:save#1');
  });

  it('requiredParameterCount range — argCount between required and total is accepted (testing reviewer T-02)', () => {
    // Default parameters: `bar(a, b=1, c=2)` has requiredParameterCount: 1,
    // parameterCount: 3. Calls with argCount 1, 2, and 3 must all match.
    const reg = createMethodRegistry();
    const bar = makeMethod({
      nodeId: 'method:bar',
      parameterCount: 3,
      requiredParameterCount: 1,
      returnType: 'int',
    });
    // Add a second overload so arity filtering engages (defs.length > 1).
    const barOther = makeMethod({
      nodeId: 'method:bar#other',
      parameterCount: 5,
      requiredParameterCount: 5,
      returnType: 'int',
    });

    reg.register('class:Calc', 'bar', bar);
    reg.register('class:Calc', 'bar', barOther);

    expect(reg.lookupMethodByOwner('class:Calc', 'bar', 1)?.nodeId).toBe('method:bar');
    expect(reg.lookupMethodByOwner('class:Calc', 'bar', 2)?.nodeId).toBe('method:bar');
    expect(reg.lookupMethodByOwner('class:Calc', 'bar', 3)?.nodeId).toBe('method:bar');
    // argCount 5 matches the second overload only
    expect(reg.lookupMethodByOwner('class:Calc', 'bar', 5)?.nodeId).toBe('method:bar#other');
  });

  it('variadic fallback — defs with parameterCount=undefined are retained during arity narrowing', () => {
    const reg = createMethodRegistry();
    const fixed = makeMethod({
      nodeId: 'method:print#fixed',
      parameterCount: 1,
      returnType: 'void',
    });
    const variadic = makeMethod({
      nodeId: 'method:print#variadic',
      parameterCount: undefined,
      returnType: 'void',
    });

    reg.register('class:Logger', 'print', fixed);
    reg.register('class:Logger', 'print', variadic);

    // argCount 5 excludes fixed (5 > parameterCount 1) but retains
    // variadic (parameterCount=undefined bypasses the range check).
    // Result: variadic is the only surviving candidate.
    const result = reg.lookupMethodByOwner('class:Logger', 'print', 5);
    expect(result?.nodeId).toBe('method:print#variadic');
  });

  it('variadic + matching fixed — argCount in fixed range keeps both, first wins on shared returnType', () => {
    const reg = createMethodRegistry();
    const fixed = makeMethod({
      nodeId: 'method:print#fixed',
      parameterCount: 2,
      returnType: 'void',
    });
    const variadic = makeMethod({
      nodeId: 'method:print#variadic',
      parameterCount: undefined,
      returnType: 'void',
    });

    reg.register('class:Logger', 'print', fixed);
    reg.register('class:Logger', 'print', variadic);

    // argCount 2 satisfies fixed's range AND keeps variadic.
    // Both share returnType 'void', so first-registered wins.
    const result = reg.lookupMethodByOwner('class:Logger', 'print', 2);
    expect(result?.nodeId).toBe('method:print#fixed');
  });
});

describe('MethodRegistry — return-type dedup', () => {
  it('returns first when all overloads share the same returnType', () => {
    const reg = createMethodRegistry();
    const a = makeMethod({ nodeId: 'method:a', parameterCount: 1, returnType: 'int' });
    const b = makeMethod({ nodeId: 'method:b', parameterCount: 1, returnType: 'int' });

    reg.register('class:X', 'compute', a);
    reg.register('class:X', 'compute', b);

    // Two overloads with same arity & same returnType → first wins
    expect(reg.lookupMethodByOwner('class:X', 'compute', 1)?.nodeId).toBe('method:a');
  });

  it('returns undefined when overloads differ in returnType (truly ambiguous)', () => {
    const reg = createMethodRegistry();
    const intVersion = makeMethod({
      nodeId: 'method:int',
      parameterCount: 1,
      returnType: 'int',
    });
    const stringVersion = makeMethod({
      nodeId: 'method:string',
      parameterCount: 1,
      returnType: 'string',
    });

    reg.register('class:X', 'compute', intVersion);
    reg.register('class:X', 'compute', stringVersion);

    // Same arity, different returnType → undefined (ambiguous)
    expect(reg.lookupMethodByOwner('class:X', 'compute', 1)).toBeUndefined();
  });

  it('returns undefined when firstReturnType is itself undefined', () => {
    const reg = createMethodRegistry();
    const a = makeMethod({ nodeId: 'method:a', parameterCount: 1, returnType: undefined });
    const b = makeMethod({ nodeId: 'method:b', parameterCount: 1, returnType: 'int' });

    reg.register('class:X', 'compute', a);
    reg.register('class:X', 'compute', b);

    // First def has no declared returnType → bail out as undefined
    expect(reg.lookupMethodByOwner('class:X', 'compute', 1)).toBeUndefined();
  });

  it('single-overload methods skip the dedup path', () => {
    const reg = createMethodRegistry();
    reg.register(
      'class:X',
      'only',
      makeMethod({ nodeId: 'method:only', parameterCount: 1, returnType: undefined }),
    );

    // Only one candidate → returned directly regardless of returnType
    expect(reg.lookupMethodByOwner('class:X', 'only', 1)?.nodeId).toBe('method:only');
  });
});

describe('MethodRegistry — clear()', () => {
  it('empties the registry', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod());
    reg.register('class:Order', 'update', makeMethod());

    reg.clear();

    expect(reg.lookupMethodByOwner('class:User', 'save')).toBeUndefined();
    expect(reg.lookupMethodByOwner('class:Order', 'update')).toBeUndefined();
  });

  it('allows re-registration after clear', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:first' }));
    reg.clear();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:second' }));

    expect(reg.lookupMethodByOwner('class:User', 'save')?.nodeId).toBe('method:second');
  });
});

// ---------------------------------------------------------------------------
// lookupMethodByName — flat-by-name secondary index (A4 / plan 006)
// ---------------------------------------------------------------------------

describe('MethodRegistry — lookupMethodByName', () => {
  it('returns an empty array when no method with that name is registered', () => {
    const reg = createMethodRegistry();
    expect(reg.lookupMethodByName('save')).toEqual([]);
  });

  it('returns a singleton array after one registration', () => {
    const reg = createMethodRegistry();
    const def = makeMethod({ nodeId: 'method:User.save' });

    reg.register('class:User', 'save', def);

    const result = reg.lookupMethodByName('save');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(def);
  });

  it('accumulates homonym registrations across different owners in order', () => {
    const reg = createMethodRegistry();
    const userSave = makeMethod({ nodeId: 'method:User.save' });
    const orderSave = makeMethod({ nodeId: 'method:Order.save' });

    reg.register('class:User', 'save', userSave);
    reg.register('class:Order', 'save', orderSave);

    const result = reg.lookupMethodByName('save');
    expect(result).toHaveLength(2);
    expect(result).toEqual([userSave, orderSave]);
  });

  it('accumulates overloads under the same owner', () => {
    const reg = createMethodRegistry();
    const overload1 = makeMethod({ nodeId: 'method:User.save#0', parameterCount: 0 });
    const overload2 = makeMethod({ nodeId: 'method:User.save#1', parameterCount: 1 });

    reg.register('class:User', 'save', overload1);
    reg.register('class:User', 'save', overload2);

    const result = reg.lookupMethodByName('save');
    expect(result).toHaveLength(2);
    expect(result).toEqual([overload1, overload2]);
  });

  it('returns an empty array after clear()', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:old' }));

    reg.clear();

    expect(reg.lookupMethodByName('save')).toEqual([]);
  });

  it('re-registering after clear only returns post-clear defs', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:old' }));
    reg.clear();
    const fresh = makeMethod({ nodeId: 'method:fresh' });
    reg.register('class:User', 'save', fresh);

    const result = reg.lookupMethodByName('save');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fresh);
  });

  it('returns the same SymbolDefinition reference as lookupMethodByOwner (dual-index identity)', () => {
    const reg = createMethodRegistry();
    const def = makeMethod({ nodeId: 'method:User.save' });

    reg.register('class:User', 'save', def);

    const byOwner = reg.lookupMethodByOwner('class:User', 'save');
    const byName = reg.lookupMethodByName('save');

    expect(byName).toHaveLength(1);
    expect(Object.is(byName[0], byOwner)).toBe(true);
  });

  it('does not return methods with different names', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:User.save' }));
    reg.register('class:User', 'load', makeMethod({ nodeId: 'method:User.load' }));

    expect(reg.lookupMethodByName('save')).toHaveLength(1);
    expect(reg.lookupMethodByName('load')).toHaveLength(1);
    expect(reg.lookupMethodByName('missing')).toEqual([]);
  });
});

describe('hasFunctionMethods flag', () => {
  it('is false for a fresh registry', () => {
    const reg = createMethodRegistry();
    expect(reg.hasFunctionMethods).toBe(false);
  });

  it('stays false after registering only strict-Method defs', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'save', makeMethod({ nodeId: 'method:User.save', type: 'Method' }));
    reg.register(
      'class:User',
      'load',
      makeMethod({ nodeId: 'method:User.load', type: 'Constructor' }),
    );
    expect(reg.hasFunctionMethods).toBe(false);
  });

  it('flips to true when a Function-typed def (Python/Rust/Kotlin class method) is registered', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'greet', makeMethod({ nodeId: 'fn:User.greet', type: 'Function' }));
    expect(reg.hasFunctionMethods).toBe(true);
  });

  it('stays true after further strict-Method registrations', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'greet', makeMethod({ nodeId: 'fn:User.greet', type: 'Function' }));
    reg.register('class:Dog', 'bark', makeMethod({ nodeId: 'method:Dog.bark', type: 'Method' }));
    expect(reg.hasFunctionMethods).toBe(true);
  });

  it('resets to false after clear()', () => {
    const reg = createMethodRegistry();
    reg.register('class:User', 'greet', makeMethod({ nodeId: 'fn:User.greet', type: 'Function' }));
    expect(reg.hasFunctionMethods).toBe(true);
    reg.clear();
    expect(reg.hasFunctionMethods).toBe(false);
  });
});
