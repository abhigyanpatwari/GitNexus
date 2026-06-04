/**
 * C# parsing-layer coverage gaps mirroring the Java #1928 findings — end-to-end.
 *
 *   - F35: qualified / qualified-generic constructor calls (`new Ns.Foo()`,
 *          `new Ns.Box<int>()`) resolve to the target constructor/class instead
 *          of dropping the edge on a corrupted `Ns.Foo` reference name.
 *   - F38: `: base(...)` / `: this(...)` constructor initializers emit CALLS
 *          edges to the base / sibling constructor.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('C# qualified constructor resolution (F35, mirror of Java #1928)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-qualified-constructor'),
      () => {},
    );
  }, 60000);

  it('resolves `new Models.Widget()` to the Widget type', () => {
    const calls = getRelationships(result, 'CALLS');
    const widget = calls.find((c) => c.source === 'Make' && c.target === 'Widget');
    expect(widget).toBeDefined();
    expect(['Class', 'Constructor']).toContain(widget!.targetLabel);
  });

  it('resolves `new Models.Box<int>()` to the Box type', () => {
    const calls = getRelationships(result, 'CALLS');
    const box = calls.find((c) => c.source === 'Make' && c.target === 'Box');
    expect(box).toBeDefined();
    expect(['Class', 'Constructor']).toContain(box!.targetLabel);
  });

  it('never emits a CALLS edge to a corrupted qualified/raw name', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.target.includes('.') || c.target.includes('new '))).toBe(false);
  });
});

describe('C# explicit constructor initializer resolution (F38, mirror of Java #1928)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-explicit-ctor-init'), () => {});
  }, 60000);

  it('resolves `: base(1)` to the Base type', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseCall = calls.find((c) => c.target === 'Base');
    expect(baseCall).toBeDefined();
    expect(baseCall!.source).toBe('Child');
    expect(['Class', 'Constructor']).toContain(baseCall!.targetLabel);
  });

  it('resolves `: this()` to a DISTINCT sibling Child constructor (no self-loop)', () => {
    const calls = getRelationships(result, 'CALLS');
    const thisCall = calls.find((c) => c.target === 'Child' && c.source === 'Child');
    expect(thisCall).toBeDefined();
    expect(thisCall!.targetLabel).toBe('Constructor');
    expect(thisCall!.rel.sourceId).not.toBe(thisCall!.rel.targetId);
    expect(thisCall!.rel.sourceId).toMatch(/Child\.Child#1/);
    expect(thisCall!.rel.targetId).toMatch(/Child\.Child#0/);
  });
});

describe('C# interface-only `: base()` must not target an interface (#2046)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'csharp-interface-only-base'), () => {});
  }, 60000);

  it('emits no CALLS edge to IFoo from `: base()` on `class C : IFoo`', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.target === 'IFoo')).toBe(false);
    expect(calls.some((c) => c.targetLabel === 'Interface')).toBe(false);
  });
});

describe('C# qualified constructor resolves by qualifier, not same-tail local (#2046)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-namespace-qualified-ctor'),
      () => {},
    );
  }, 60000);

  it('resolves `new B.Foo()` to the Foo in namespace B, not the colliding A.Foo', () => {
    const calls = getRelationships(result, 'CALLS');
    const hit = calls.find((c) => c.source === 'Make' && c.target === 'Foo');
    expect(hit).toBeDefined();
    expect(hit!.targetFilePath).toBe('B/Foo.cs');
  });
});
