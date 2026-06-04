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

  it('resolves `: this()` to the sibling Child constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const thisCall = calls.find((c) => c.target === 'Child' && c.source === 'Child');
    expect(thisCall).toBeDefined();
    expect(['Class', 'Constructor']).toContain(thisCall!.targetLabel);
  });
});
