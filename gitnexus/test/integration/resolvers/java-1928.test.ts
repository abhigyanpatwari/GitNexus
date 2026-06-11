/**
 * Java parsing-layer coverage gaps (#1928) — end-to-end resolution.
 *
 *   - F35: qualified / qualified-generic constructor calls (`new pkg.Foo()`,
 *          `new pkg.Box<String>()`) resolve to the target constructor instead of
 *          dropping the edge on a corrupted `pkg.Foo` reference name.
 *   - F38: `super(...)` / `this(...)` explicit constructor invocations emit CALLS
 *          edges to the superclass / sibling constructor.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Java qualified constructor resolution (F35 #1928)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'java-qualified-constructor'), () => {});
  }, 60000);

  it('resolves `new pkg.Foo()` to the Foo constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const fooCtor = calls.find((c) => c.target === 'Foo' && c.source === 'make');
    expect(fooCtor).toBeDefined();
    expect(fooCtor!.targetLabel).toBe('Constructor');
    expect(fooCtor!.targetFilePath).toBe('pkg/Foo.java');
  });

  it('resolves `new pkg.Box<String>()` to the Box constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const boxCtor = calls.find((c) => c.target === 'Box' && c.source === 'make');
    expect(boxCtor).toBeDefined();
    expect(boxCtor!.targetLabel).toBe('Constructor');
    expect(boxCtor!.targetFilePath).toBe('pkg/Box.java');
  });

  it('does not emit a CALLS edge to a corrupted `pkg.Foo` / `pkg.Box` name', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.target === 'pkg.Foo' || c.target === 'pkg.Box')).toBe(false);
  });
});

describe('Java explicit constructor invocation resolution (F38 #1928)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'java-explicit-constructor'), () => {});
  }, 60000);

  it('resolves `super(1)` in Child() to the Base constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const superCall = calls.find((c) => c.target === 'Base' && c.targetLabel === 'Constructor');
    expect(superCall).toBeDefined();
    expect(superCall!.source).toBe('Child');
    expect(superCall!.targetFilePath).toBe('models/Base.java');
    // Source is the arity-0 `Child()`, where `super(1)` lives.
    expect(superCall!.rel.sourceId).toContain('Child.Child#0');
    expect(superCall!.rel.targetId).toContain('Base.Base#1');
  });

  it('resolves `this()` in Child(int) to a DISTINCT Child constructor (no self-loop)', () => {
    const calls = getRelationships(result, 'CALLS');
    const thisCall = calls.find(
      (c) => c.target === 'Child' && c.targetLabel === 'Constructor' && c.source === 'Child',
    );
    expect(thisCall).toBeDefined();
    expect(thisCall!.targetFilePath).toBe('models/Child.java');
    // The edge must connect DISTINCT constructors: the caller `Child(int)` (#1)
    // chains to `Child()` (#0). A self-loop (`#0 → #0`) — the bug this PR's
    // review caught (#1928 F38: ctor overload keys missing in node-lookup) —
    // satisfies the name-only match above but must NOT pass here.
    expect(thisCall!.rel.sourceId).not.toBe(thisCall!.rel.targetId);
    expect(thisCall!.rel.sourceId).toContain('Child.Child#1');
    expect(thisCall!.rel.targetId).toContain('Child.Child#0');
  });
});
