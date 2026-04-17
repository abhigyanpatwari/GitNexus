import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../src/core/ingestion/pipeline-phases/runner.js';
import type {
  PipelinePhase,
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import { getPhaseOutput } from '../../src/core/ingestion/pipeline-phases/types.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

function makeCtx(): PipelineContext {
  return {
    repoPath: '/tmp/test',
    graph: createKnowledgeGraph(),
    onProgress: () => {},
    pipelineStart: Date.now(),
  };
}

describe('runPipeline', () => {
  it('executes phases in dependency order', async () => {
    const order: string[] = [];

    const phaseA: PipelinePhase<string> = {
      name: 'a',
      deps: [],
      async execute() {
        order.push('a');
        return 'resultA';
      },
    };

    const phaseB: PipelinePhase<string> = {
      name: 'b',
      deps: ['a'],
      async execute(_ctx, deps) {
        const a = getPhaseOutput<string>(deps, 'a');
        order.push('b');
        return `${a}+B`;
      },
    };

    const phaseC: PipelinePhase<string> = {
      name: 'c',
      deps: ['a'],
      async execute(_ctx, deps) {
        const a = getPhaseOutput<string>(deps, 'a');
        order.push('c');
        return `${a}+C`;
      },
    };

    const phaseD: PipelinePhase<string> = {
      name: 'd',
      deps: ['b', 'c'],
      async execute(_ctx, deps) {
        const b = getPhaseOutput<string>(deps, 'b');
        const c = getPhaseOutput<string>(deps, 'c');
        order.push('d');
        return `${b}|${c}`;
      },
    };

    const results = await runPipeline([phaseD, phaseA, phaseC, phaseB], makeCtx());

    // A must run before B and C; B and C must run before D
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));

    // Check outputs are correctly threaded
    expect(results.get('d')?.output).toBe('resultA+B|resultA+C');
  });

  it('passes shared PipelineContext to every phase', async () => {
    const ctx = makeCtx();
    const seenContexts: PipelineContext[] = [];

    const phase: PipelinePhase<void> = {
      name: 'test',
      deps: [],
      async execute(c) {
        seenContexts.push(c);
      },
    };

    await runPipeline([phase], ctx);
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toBe(ctx);
  });

  it('records timing metadata in PhaseResult', async () => {
    const phase: PipelinePhase<number> = {
      name: 'slow',
      deps: [],
      async execute() {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      },
    };

    const results = await runPipeline([phase], makeCtx());
    const result = results.get('slow')!;
    expect(result.phaseName).toBe('slow');
    expect(result.output).toBe(42);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects duplicate phase names', async () => {
    const phaseA: PipelinePhase = {
      name: 'dup',
      deps: [],
      async execute() {},
    };
    const phaseB: PipelinePhase = {
      name: 'dup',
      deps: [],
      async execute() {},
    };

    await expect(runPipeline([phaseA, phaseB], makeCtx())).rejects.toThrow(/Duplicate phase name/);
  });

  it('rejects missing dependencies', async () => {
    const phase: PipelinePhase = {
      name: 'orphan',
      deps: ['nonexistent'],
      async execute() {},
    };

    await expect(runPipeline([phase], makeCtx())).rejects.toThrow(/depends on 'nonexistent'/);
  });

  it('rejects cyclic dependencies', async () => {
    const phaseA: PipelinePhase = {
      name: 'x',
      deps: ['y'],
      async execute() {},
    };
    const phaseB: PipelinePhase = {
      name: 'y',
      deps: ['x'],
      async execute() {},
    };

    await expect(runPipeline([phaseA, phaseB], makeCtx())).rejects.toThrow(/Cycle detected/);
  });

  it('reports only cycle members (not transitive dependents) in cycle error', async () => {
    // A <-> B is the actual cycle. C, D, E are downstream and would also have
    // inDegree > 0 after Kahn's drains, but they are NOT cycle members.
    const phases: PipelinePhase[] = [
      { name: 'a', deps: ['b'], async execute() {} },
      { name: 'b', deps: ['a'], async execute() {} },
      { name: 'c', deps: ['a'], async execute() {} },
      { name: 'd', deps: ['c'], async execute() {} },
      { name: 'e', deps: ['c'], async execute() {} },
    ];

    let caught: Error | undefined;
    try {
      await runPipeline(phases, makeCtx());
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const msg = caught!.message;
    // Cycle path must include both A and B
    expect(msg).toMatch(/Cycle detected in pipeline phases: /);
    expect(msg).toMatch(/\ba\b/);
    expect(msg).toMatch(/\bb\b/);
    // Transitive dependents must NOT appear in the cycle path itself,
    // they should be summarized in the parenthetical.
    const pathSection = msg.split('(')[0];
    expect(pathSection).not.toMatch(/\bc\b/);
    expect(pathSection).not.toMatch(/\bd\b/);
    expect(pathSection).not.toMatch(/\be\b/);
    expect(msg).toMatch(/3 transitive dependents blocked/);
  });

  it('reports the full path for a 3-phase cycle', async () => {
    // A -> B -> C -> A
    const phases: PipelinePhase[] = [
      { name: 'a', deps: ['c'], async execute() {} },
      { name: 'b', deps: ['a'], async execute() {} },
      { name: 'c', deps: ['b'], async execute() {} },
    ];

    let caught: Error | undefined;
    try {
      await runPipeline(phases, makeCtx());
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const msg = caught!.message;
    expect(msg).toMatch(/Cycle detected in pipeline phases: /);
    // All three names must appear
    expect(msg).toMatch(/\ba\b/);
    expect(msg).toMatch(/\bb\b/);
    expect(msg).toMatch(/\bc\b/);
    // Path uses the " -> " arrow separator
    expect(msg).toMatch(/ -> /);
    // No transitive-dependent suffix when every leftover IS a cycle member
    expect(msg).not.toMatch(/transitive dependent/);
  });

  it("emits a terminal 'error' progress event on cycle detection", async () => {
    const events: { phase: string; message: string; detail?: string }[] = [];
    const ctx: PipelineContext = {
      ...makeCtx(),
      onProgress: (p) => {
        events.push({ phase: p.phase, message: p.message, detail: p.detail });
      },
    };

    const phases: PipelinePhase[] = [
      { name: 'x', deps: ['y'], async execute() {} },
      { name: 'y', deps: ['x'], async execute() {} },
    ];

    await expect(runPipeline(phases, ctx)).rejects.toThrow(/Cycle detected/);

    const errorEvents = events.filter((e) => e.phase === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].detail).toMatch(/Cycle detected/);
  });

  it('executes a single root phase with no deps', async () => {
    const phase: PipelinePhase<string> = {
      name: 'root',
      deps: [],
      async execute() {
        return 'hello';
      },
    };

    const results = await runPipeline([phase], makeCtx());
    expect(results.get('root')?.output).toBe('hello');
  });

  it('handles a linear chain correctly', async () => {
    const order: string[] = [];

    const phases: PipelinePhase<number>[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      phases.push({
        name: `step${i}`,
        deps: i > 0 ? [`step${i - 1}`] : [],
        async execute(_ctx, deps) {
          if (idx > 0) {
            const prev = getPhaseOutput<number>(deps, `step${idx - 1}`);
            order.push(`step${idx}`);
            return prev + 1;
          }
          order.push(`step${idx}`);
          return 0;
        },
      });
    }

    const results = await runPipeline(phases, makeCtx());
    expect(results.get('step4')?.output).toBe(4);
    expect(order).toEqual(['step0', 'step1', 'step2', 'step3', 'step4']);
  });

  it('wraps phase Error with phase name and preserves cause', async () => {
    const original = new Error('boom');
    const phase: PipelinePhase = {
      name: 'failing',
      deps: [],
      async execute() {
        throw original;
      },
    };

    await expect(runPipeline([phase], makeCtx())).rejects.toThrow(/Phase 'failing' failed: boom/);

    try {
      await runPipeline([phase], makeCtx());
      throw new Error('expected runPipeline to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Phase 'failing' failed: boom/);
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it('surfaces phase name when phase throws a non-Error value', async () => {
    const phaseString: PipelinePhase = {
      name: 'string-thrower',
      deps: [],
      async execute() {
        throw 'oops';
      },
    };

    await expect(runPipeline([phaseString], makeCtx())).rejects.toThrow(
      /Phase 'string-thrower' failed: oops/,
    );

    const phaseNumber: PipelinePhase = {
      name: 'number-thrower',
      deps: [],
      async execute() {
        throw 42;
      },
    };

    await expect(runPipeline([phaseNumber], makeCtx())).rejects.toThrow(
      /Phase 'number-thrower' failed: 42/,
    );
  });

  it("emits a terminal 'error' progress event exactly once on phase failure", async () => {
    const events: { phase: string; message: string; detail?: string }[] = [];
    const ctx: PipelineContext = {
      ...makeCtx(),
      onProgress: (p) => {
        events.push({ phase: p.phase, message: p.message, detail: p.detail });
      },
    };

    const phase: PipelinePhase = {
      name: 'failing',
      deps: [],
      async execute() {
        throw new Error('kaboom');
      },
    };

    await expect(runPipeline([phase], ctx)).rejects.toThrow(/Phase 'failing' failed/);

    const errorEvents = events.filter((e) => e.phase === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].message).toMatch(/failing/);
    expect(errorEvents[0].detail).toBe('kaboom');
  });

  it('still rejects when onProgress handler throws during error reporting', async () => {
    const original = new Error('underlying');
    const ctx: PipelineContext = {
      ...makeCtx(),
      onProgress: () => {
        throw new Error('handler exploded');
      },
    };

    const phase: PipelinePhase = {
      name: 'failing',
      deps: [],
      async execute() {
        throw original;
      },
    };

    try {
      await runPipeline([phase], ctx);
      throw new Error('expected runPipeline to reject');
    } catch (err) {
      // The original phase error must win, not the handler's error.
      expect((err as Error).message).toMatch(/Phase 'failing' failed: underlying/);
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it('only exposes declared deps to each phase', async () => {
    const phaseA: PipelinePhase<string> = {
      name: 'a',
      deps: [],
      async execute() {
        return 'resultA';
      },
    };

    const phaseB: PipelinePhase<string> = {
      name: 'b',
      deps: ['a'],
      async execute() {
        return 'resultB';
      },
    };

    // C depends on B but not A — should not see A's result
    const phaseC: PipelinePhase<string> = {
      name: 'c',
      deps: ['b'],
      async execute(_ctx, deps) {
        expect(deps.has('b')).toBe(true);
        expect(deps.has('a')).toBe(false);
        return 'resultC';
      },
    };

    await runPipeline([phaseA, phaseB, phaseC], makeCtx());
  });
});

describe('getPhaseOutput', () => {
  it('retrieves typed output from dependency map', () => {
    const deps = new Map<string, PhaseResult<unknown>>();
    deps.set('test', { phaseName: 'test', output: { value: 42 }, durationMs: 0 });

    const result = getPhaseOutput<{ value: number }>(deps, 'test');
    expect(result.value).toBe(42);
  });

  it('throws for missing phase', () => {
    const deps = new Map<string, PhaseResult<unknown>>();

    expect(() => getPhaseOutput(deps, 'missing')).toThrow(/Phase 'missing' not found/);
  });
});
