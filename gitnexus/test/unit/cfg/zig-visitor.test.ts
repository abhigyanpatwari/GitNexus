import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { zigProvider } from '../../../src/core/ingestion/languages/zig.js';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { isOptionalGrammarRequired } from '../../helpers/optional-grammar.js';
import { makeCfgHarness, block, reaches, bindingIdx, allSites } from '../../helpers/cfg-harness.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import {
  basicBlockId,
  emitFileCfgs,
  emitFileReachingDefs,
  emitFileCdg,
} from '../../../src/core/ingestion/cfg/emit.js';
import { decodeReachingDefReason } from '../../../src/core/ingestion/cfg/reaching-def-reason-codec.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

/**
 * Backward dependence slice over the EMITTED graph (production REACHING_DEF + CDG
 * emitters): from the block whose text contains `from`, follow each incoming
 * REACHING_DEF edge to its defining block and each incoming CDG edge to its
 * controller. Reports the parameters whose entry definitions the slice reaches and
 * the controller blocks it visited.
 */
function backwardSlice(
  cfg: FunctionCfg,
  from: string,
  followed: readonly string[] = ['REACHING_DEF', 'CDG'],
) {
  const graph = createKnowledgeGraph();
  emitFileReachingDefs(graph, [cfg]);
  emitFileCdg(graph, [cfg]);
  const id = (index: number) =>
    basicBlockId(cfg.filePath, cfg.functionStartLine, cfg.functionStartColumn, index);
  const indexOf = new Map(cfg.blocks.map((b) => [id(b.index), b.index]));
  const incoming = new Map<number, { type: string; source: number; reason: string }[]>();
  for (const r of graph.iterRelationships()) {
    if (!followed.includes(r.type)) continue;
    const target = indexOf.get(r.targetId)!;
    const list = incoming.get(target) ?? [];
    list.push({ type: r.type, source: indexOf.get(r.sourceId)!, reason: r.reason });
    incoming.set(target, list);
  }
  const visited = new Set<number>([block(cfg, from)]);
  const queue = [...visited];
  const entryDefs = new Set<string>();
  const controllers = new Set<string>();
  for (const current of queue) {
    for (const edge of incoming.get(current) ?? []) {
      if (edge.type === 'CDG') controllers.add(cfg.blocks[edge.source].text);
      else if (edge.source === cfg.entryIndex)
        entryDefs.add(decodeReachingDefReason(edge.reason).name);
      if (!visited.has(edge.source)) {
        visited.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  return { entryDefs: [...entryDefs].sort(), controllers: [...controllers].sort() };
}

let grammar: ReturnType<typeof requireVendoredGrammar> | undefined;
try {
  grammar = requireVendoredGrammar('tree-sitter-zig');
} catch {
  /* optional grammar */
}

describe.skipIf(!isOptionalGrammarRequired(SupportedLanguages.Zig))(
  'Zig CFG grammar presence',
  () => {
    it('loads the required vendored grammar', () => expect(grammar).toBeDefined());
  },
);

describe.skipIf(!grammar)('Zig provider CFG / shared PDG pipeline', () => {
  const harness = () => {
    expect(zigProvider.cfgVisitor, 'Zig must opt into the existing CFG pipeline').toBeDefined();
    return makeCfgHarness(grammar!, zigProvider.cfgVisitor!, 'fixture.zig');
  };

  it('registers its visitor and preserves owning function spans', () => {
    const h = harness();
    const cfgs = h.cfgsOf('fn a() void {} fn b() void { work(); }');
    expect(cfgs).toHaveLength(2);
    expect(cfgs[1].functionStartColumn).toBeGreaterThan(cfgs[0].functionStartColumn);
    expect(reaches(cfgs[0], cfgs[0].entryIndex, cfgs[0].exitIndex)).toBe(true);
  });

  it('feeds real branch control and reaching definitions to the shared solvers', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, input: i32) i32 {
      var value: i32 = input;
      if (flag) { value = 1; } else { value = 2; }
      return value;
    }`);
    const rd = computeReachingDefs(cfg);
    const value = bindingIdx(cfg, 'value');
    const returning = block(cfg, 'return value');
    expect(rd.status).toBe('computed');
    expect(
      new Set(
        rd.facts
          .filter((f) => f.bindingIdx === value && f.use.blockIndex === returning)
          .map((f) => cfg.blocks[f.def.blockIndex].text),
      ),
    ).toEqual(new Set(['value = 1;', 'value = 2;']));
    const cdg = computeControlDependence(cfg);
    expect(cdg.edges).toContainEqual({
      controllerBlock: block(cfg, 'flag'),
      dependentBlock: block(cfg, 'value = 1;'),
      label: 'T',
    });
    expect(cdg.edges).toContainEqual({
      controllerBlock: block(cfg, 'flag'),
      dependentBlock: block(cfg, 'value = 2;'),
      label: 'F',
    });
  });

  it('routes labeled continue through while updates, and break bypasses loop else', () => {
    const cfg = harness().cfgOf(`fn f(n: usize) void {
      var i: usize = 0;
      outer: while (i < n) : (i += 1) {
        if (skip(i)) continue :outer;
        if (stop(i)) break :outer;
        step(i);
      } else { exhausted(); }
      done();
    }`);
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'continue :outer'),
      to: block(cfg, 'i += 1'),
      kind: 'continue',
    });
    expect(reaches(cfg, block(cfg, 'break :outer'), block(cfg, 'exhausted()'))).toBe(false);
    expect(reaches(cfg, block(cfg, 'break :outer'), block(cfg, 'done()'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('keeps breaks in a while continuation inside that loop and runs its cleanup', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, stop: bool) void {
      while (flag) : ({
        defer cleanup();
        if (stop) break;
        update();
      }) { work(); continue; } else { exhausted(); }
      done();
    }`);
    const brk = block(cfg, 'break');
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
    expect(reaches(cfg, brk, block(cfg, 'exhausted()'))).toBe(false);
    expect(reaches(cfg, brk, block(cfg, 'update()'))).toBe(false);
    const cleanup = cfg.edges.find((edge) => edge.from === brk && edge.kind === 'break');
    expect(cfg.blocks[cleanup!.to].text).toContain('cleanup()');
    expect(reaches(cfg, block(cfg, 'continue'), block(cfg, 'update()'))).toBe(true);
    expect(computeControlDependence(cfg).edges).toContainEqual({
      controllerBlock: block(cfg, 'stop'),
      dependentBlock: brk,
      label: 'T',
    });
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('binds for payloads to their body and has a structural infinite-loop escape', () => {
    const cfg = harness().cfgOf(`fn f(xs: []i32) void {
      for (xs, 0..) |*item, index| { use(item, index); } else { empty(); }
      while (true) { tick(); }
    }`);
    for (const name of ['item', 'index']) {
      const idx = bindingIdx(cfg, name);
      expect(cfg.blocks.some((b) => b.statements?.some((s) => s.defs.includes(idx)))).toBe(true);
      expect(computeReachingDefs(cfg).facts.some((f) => f.bindingIdx === idx)).toBe(true);
    }
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(
      computeControlDependence(cfg).edges.some((e) => e.dependentBlock === block(cfg, 'tick()')),
    ).toBe(true);
  });

  it('keeps distinct block shadows and sibling payloads out of one another', () => {
    const cfg = harness().cfgOf(`fn f(value: i32, first: ?i32, second: ?i32) void {
      { const value = 2; inner(value); }
      if (first) |item| { one(item); }
      if (second) |item| { two(item); }
      outer(value);
    }`);
    const values = cfg.bindings!.flatMap((b, i) => (b.name === 'value' ? [i] : []));
    const items = cfg.bindings!.flatMap((b, i) => (b.name === 'item' ? [i] : []));
    expect(values).toHaveLength(2);
    expect(items).toHaveLength(2);
    const rd = computeReachingDefs(cfg);
    expect(
      rd.facts
        .filter((f) => f.use.blockIndex === block(cfg, 'outer(value)'))
        .map((f) => f.bindingIdx),
    ).toContain(values[0]);
    expect(
      rd.facts
        .filter((f) => f.use.blockIndex === block(cfg, 'outer(value)'))
        .map((f) => f.bindingIdx),
    ).not.toContain(values[1]);
    expect(cfg.bindings!.filter((b) => b.kind === 'param').map((b) => b.formalIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  it('keeps if error captures separate from success captures', () => {
    const cfg = harness().cfgOf(
      'fn f(result: anyerror!i32) void { if (result) |v| { use(v); } else |err| { fail(err); } }',
    );
    const rd = computeReachingDefs(cfg);
    expect(
      rd.facts.some(
        (f) => f.bindingIdx === bindingIdx(cfg, 'v') && f.use.blockIndex === block(cfg, 'use(v)'),
      ),
    ).toBe(true);
    expect(
      rd.facts.some(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'err') && f.use.blockIndex === block(cfg, 'fail(err)'),
      ),
    ).toBe(true);
  });

  it('models switch and value-position if arms without fallthrough', () => {
    const cfg = harness().cfgOf(`fn f(n: i32, flag: bool) i32 {
      const selected = if (flag) left(n) else right(n);
      return switch (selected) { 0 => zero(), 1...3 => small(), else => other(), };
    }`);
    expect(reaches(cfg, block(cfg, 'left(n)'), block(cfg, 'right(n)'))).toBe(false);
    expect(reaches(cfg, block(cfg, 'zero()'), block(cfg, 'small()'))).toBe(false);
    expect(reaches(cfg, block(cfg, 'zero()'), cfg.exitIndex)).toBe(true);
    expect(
      allSites(cfg)
        .filter((s) => s.kind === 'call')
        .map((s) => s.callee)
        .sort(),
    ).toEqual(['left', 'other', 'right', 'small', 'zero']);
  });

  it.each([
    [
      'if expression',
      'return x',
      ['flag', 'input'],
      `fn f(flag: bool, input: i32) i32 {
      const x = if (flag) input else 0;
      return x;
    }`,
    ],
    [
      'if payload',
      'return x',
      ['opt', 'other'],
      `fn f(opt: ?i32, other: i32) i32 {
      const x = if (opt) |v| v else other;
      return x;
    }`,
    ],
    [
      'switch expression',
      'return x',
      ['a', 'b', 'kind'],
      `fn f(kind: i32, a: i32, b: i32) i32 {
      const x = switch (kind) { 0 => a, else => b, };
      return x;
    }`,
    ],
    [
      'switch payload',
      'return x',
      ['u'],
      `fn f(u: Union) i32 {
      const x = switch (u) { .one => |v| v, else => 0, };
      return x;
    }`,
    ],
    [
      'orelse',
      'return x',
      ['fallback', 'maybe'],
      `fn f(maybe: ?i32, fallback: i32) i32 {
      const x = maybe orelse fallback;
      return x;
    }`,
    ],
    [
      'catch with payload',
      'return x',
      ['input', 'other'],
      `fn f(input: i32, other: i32) i32 {
      const x = read(input) catch |err| handle(err, other);
      return x;
    }`,
    ],
    [
      'try',
      'return x',
      ['input'],
      `fn f(input: i32) !i32 {
      const x = try read(input);
      return x;
    }`,
    ],
    [
      'labeled block',
      'return x',
      ['flag', 'input'],
      `fn f(flag: bool, input: i32) i32 {
      const x = blk: { if (flag) break :blk input; break :blk 0; };
      return x;
    }`,
    ],
    [
      'compound assignment',
      'return x',
      ['flag', 'input'],
      `fn f(flag: bool, input: i32) i32 {
      var x: i32 = 0;
      x += if (flag) input else 1;
      return x;
    }`,
    ],
    [
      'returned value',
      'return if',
      ['flag', 'input'],
      `fn f(flag: bool, input: i32) i32 {
      return if (flag) input else 0;
    }`,
    ],
    [
      'call argument',
      'return x',
      ['flag', 'input'],
      `fn f(flag: bool, input: i32) i32 {
      const x = pick(if (flag) input else 0);
      return x;
    }`,
    ],
    [
      'branch condition',
      'return x',
      ['a', 'b', 'input'],
      `fn f(a: bool, b: bool, input: i32) i32 {
      var x: i32 = 0;
      if (a and b) { x = input; }
      return x;
    }`,
    ],
    [
      'else-if chain',
      'return x',
      ['a', 'b', 'p', 'q', 'r'],
      `fn f(a: bool, b: bool, p: i32, q: i32, r: i32) i32 {
      const x = if (a) p else if (b) q else r;
      return x;
    }`,
    ],
    [
      'loop break value',
      'return x',
      ['limit', 'seed'],
      `fn f(limit: i32, seed: i32) i32 {
      const x = while (cond(limit)) { break seed; } else 0;
      return x;
    }`,
    ],
    [
      'loop else value',
      'return x',
      ['fallback'],
      `fn f(limit: i32, fallback: i32) i32 {
      const x = while (cond(limit)) { work(); } else fallback;
      return x;
    }`,
    ],
    [
      'labeled switch continue',
      'return x',
      ['first', 'next'],
      `fn f(first: i32, next: i32) i32 {
      const x = dispatch: switch (first) { 0 => continue :dispatch next, else => |v| break :dispatch v, };
      return x;
    }`,
    ],
    [
      'store target',
      'obj.field =',
      ['flag', 'input', 'obj'],
      `fn f(flag: bool, input: i32, obj: Object) Object {
      obj.field = if (flag) input else 0;
      return obj;
    }`,
    ],
  ])(
    'carries %s results into the destination definition (backward slice)',
    (_name, from, expected, source) => {
      const cfg = harness().cfgOf(source);
      const slice = backwardSlice(cfg, from);
      expect(computeReachingDefs(cfg).status).toBe('computed');
      expect(slice.entryDefs).toEqual(expect.arrayContaining(expected));
    },
  );

  it.each([
    ['if', 'use(v)', ['opt'], 'fn f(opt: ?i32) void { if (opt) |v| { use(v); } }'],
    [
      'else error',
      'fail(err)',
      ['result'],
      'fn f(result: anyerror!i32) void { if (result) |v| { use(v); } else |err| { fail(err); } }',
    ],
    ['for', 'use(item)', ['xs'], 'fn f(xs: []i32) void { for (xs) |item| { use(item); } }'],
    [
      'while',
      'use(v)',
      ['cursor'],
      'fn f(cursor: Cursor) void { while (cursor.next()) |v| { use(v); } }',
    ],
    [
      'switch',
      'use(v)',
      ['u'],
      'fn f(u: Union) void { switch (u) { .one => |v| use(v), else => {}, } }',
    ],
    [
      'catch',
      'handle(err)',
      ['input'],
      'fn f(input: i32) void { _ = read(input) catch |err| handle(err); }',
    ],
  ])('binds a %s capture to the value it unwraps', (_name, from, expected, source) => {
    // Data dependence only: the capture's arm is also control-dependent on the operand.
    expect(backwardSlice(harness().cfgOf(source), from, ['REACHING_DEF']).entryDefs).toEqual(
      expect.arrayContaining(expected),
    );
  });

  it('keeps a prior definition live on the arm that leaves the destination untouched', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, input: i32) i32 {
      var x: i32 = 0;
      x = if (flag) input else x;
      return x;
    }`);
    const rd = computeReachingDefs(cfg);
    const defs = rd.facts
      .filter(
        (f) => f.bindingIdx === bindingIdx(cfg, 'x') && f.use.blockIndex === block(cfg, 'return x'),
      )
      .map((f) => cfg.blocks[f.def.blockIndex].text);
    expect(new Set(defs)).toEqual(new Set(['input', 'x']));
    const alternative = cfg.blocks.find((b) => b.text === 'x')!;
    expect(
      rd.facts.some(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'x') &&
          f.use.blockIndex === alternative.index &&
          cfg.blocks[f.def.blockIndex].text === 'var x: i32 = 0;',
      ),
    ).toBe(true);
  });

  it('carries a try value by data dependence, not only through its error branch', () => {
    const cfg = harness().cfgOf(`fn f(input: i32) !i32 {
      const x = try read(input);
      return x;
    }`);
    expect(backwardSlice(cfg, 'return x', ['REACHING_DEF']).entryDefs).toEqual(['input']);
  });

  it('puts the controlling condition into the backward slice of a value-position if', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, input: i32) i32 {
      const x = if (flag) input else 0;
      return x;
    }`);
    expect(backwardSlice(cfg, 'return x').controllers).toContain('flag');
  });

  it('records each arm call once and routes its result to the destination', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, n: i32) i32 {
      const picked = if (flag) left(n) else try right(n);
      return picked;
    }`);
    const calls = allSites(cfg).filter((s) => s.kind === 'call');
    expect(calls.map((s) => s.callee).sort()).toEqual(['left', 'right']);
    for (const call of calls) expect(call.resultDefs).toEqual([bindingIdx(cfg, 'picked')]);
  });

  it('keeps value flow in nested control arms', () => {
    const cfg = harness().cfgOf(`fn f(a: bool, b: bool, p: i32, q: i32, r: i32) i32 {
      const x = if (a) (if (b) p else q) else r;
      return x;
    }`);
    expect(backwardSlice(cfg, 'return x').entryDefs).toEqual(['a', 'b', 'p', 'q', 'r']);
  });

  it('resolves labeled block values and labeled switch continues', () => {
    const cfg = harness().cfgOf(`fn f(n: i32) i32 {
      const x = value: { if (n == 0) break :value 1; break :value n; };
      dispatch: switch (x) { 0 => continue :dispatch 1, else => break :dispatch, }
      return x;
    }`);
    expect(reaches(cfg, block(cfg, 'break :value 1'), block(cfg, 'return x'))).toBe(true);
    const continued = cfg.edges.find(
      (e) => e.from === block(cfg, 'continue :dispatch') && e.kind === 'continue',
    );
    expect(continued).toBeDefined();
    expect(cfg.blocks[continued!.to].text).toBe('x');
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('runs block defers on normal exit in reverse order, before following statements', () => {
    const cfg = harness().cfgOf(`fn f() void {
      { defer first(); defer second(); work(); }
      after();
    }`);
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'work()'),
      to: block(cfg, 'second()'),
      kind: 'seq',
    });
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'second()'),
      to: block(cfg, 'first()'),
      kind: 'seq',
    });
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'first()'),
      to: block(cfg, 'after()'),
      kind: 'seq',
    });
    expect(allSites(cfg).map((s) => s.callee)).toEqual(['work', 'second', 'first', 'after']);
  });

  it('runs only crossed defers on break and preserves branch-local registration', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool) void {
      defer outer();
      while (flag) { defer inner(); break; }
      if (flag) { defer branch(); work(); }
      after();
    }`);
    const brk = block(cfg, 'break');
    expect(cfg.edges).toContainEqual({ from: brk, to: block(cfg, 'inner()'), kind: 'break' });
    expect(reaches(cfg, block(cfg, 'outer()'), block(cfg, 'after()'))).toBe(false);
    const branchCleanup = block(cfg, 'branch()');
    expect(
      computeControlDependence(cfg).edges.some((e) => e.dependentBlock === branchCleanup),
    ).toBe(true);
  });

  it('runs loop-body cleanup before continue reaches the while update', () => {
    const cfg = harness().cfgOf(
      'fn f(flag: bool) void { defer outer(); while (flag) : (update()) { defer inner(); continue; } after(); }',
    );
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'continue'),
      to: block(cfg, 'inner()'),
      kind: 'continue',
    });
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'inner()'),
      to: block(cfg, 'update()'),
      kind: 'finally-continue',
    });
    expect(reaches(cfg, block(cfg, 'outer()'), block(cfg, 'update()'))).toBe(false);
  });

  it('runs errdefer only on error-return paths and binds its error capture', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool) !i32 {
      defer always();
      errdefer |err| report(err);
      if (flag) return error.Failed;
      return 1;
    }`);
    expect(reaches(cfg, block(cfg, 'return error.Failed'), block(cfg, 'report(err)'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'return 1'), block(cfg, 'report(err)'))).toBe(false);
    expect(
      computeReachingDefs(cfg).facts.some(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'err') && f.use.blockIndex === block(cfg, 'report(err)'),
      ),
    ).toBe(true);
    expect(allSites(cfg).filter((s) => s.callee === 'always')).toHaveLength(2);
  });

  it('models try propagation and catch recovery without pretending ordinary calls throw', () => {
    const cfg = harness().cfgOf(`fn f(input: i32) !i32 {
      errdefer fail();
      const a = try read(input);
      const b = recover(a) catch |err| fallback(err);
      observe(b);
      return b;
    }`);
    expect(
      cfg.edges.some((e) => e.from === block(cfg, 'try read(input)') && e.kind === 'throw'),
    ).toBe(true);
    expect(reaches(cfg, block(cfg, 'fallback(err)'), block(cfg, 'observe(b)'))).toBe(true);
    expect(cfg.edges.some((e) => e.from === block(cfg, 'observe(b)') && e.kind === 'throw')).toBe(
      false,
    );
    expect(allSites(cfg).find((s) => s.callee === 'read')?.resultDefs).toEqual([
      bindingIdx(cfg, 'a'),
    ]);
  });

  it.each(['error{Oops}!i32', 'Result'])(
    'runs errdefer for explicit errors with return type %s',
    (returnType) => {
      const cfg = harness().cfgOf(`const Result = error{Oops}!i32;
        fn f(flag: bool) ${returnType} {
          errdefer cleanup();
          if (flag) return error.Oops;
          return 1;
        }`);
      const cleanup = block(cfg, 'cleanup()');
      expect(reaches(cfg, block(cfg, 'return error.Oops'), cleanup)).toBe(true);
      expect(reaches(cfg, block(cfg, 'return 1'), cleanup)).toBe(false);
    },
  );

  it('preserves success and error cleanup paths for an unknown aliased result', () => {
    const cfg = harness().cfgOf(`const Result = error{Oops}!void;
      fn f(value: Result) Result { errdefer cleanup(); return value; }`);
    const returning = block(cfg, 'return value');
    expect(reaches(cfg, returning, block(cfg, 'cleanup()'))).toBe(true);
    expect(cfg.edges).toContainEqual({ from: returning, to: cfg.exitIndex, kind: 'return' });
  });

  it('counts unsupported CFGs while preserving supported functions and bodyless declarations', () => {
    const root = harness().parse(`extern fn external() void;
      fn normal() void { work(); }
      fn hasAssembly() void { asm volatile ("nop"); }`);
    expect(root.hasError).toBe(false);
    const result = collectFunctionCfgs(root, zigProvider.cfgVisitor!, 'fixture.zig');
    expect(result.cfgs).toHaveLength(1);
    expect(allSites(result.cfgs[0]).map((site) => site.callee)).toEqual(['work']);
    expect(result.skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 1 });
  });

  it('harvests scalar assignments, receiver uses, nested call provenance and source anchors', () => {
    const cfg = harness().cfgOf(`fn f(input: i32, obj: Object) void {
      var value = input;
      value += input;
      obj.field = value;
      const out = obj.send(clean(value));
      _ = out;
    }`);
    expect(
      cfg.bindings!.some((b) => b.name === '_' || b.name === 'field' || b.name === 'send'),
    ).toBe(false);
    const assignment = cfg.blocks[block(cfg, 'value += input')].statements![0];
    expect(assignment.defs).toContain(bindingIdx(cfg, 'value'));
    expect(assignment.uses).toContain(bindingIdx(cfg, 'value'));
    expect(cfg.blocks[block(cfg, 'obj.field = value')].statements![0].defs).not.toContain(
      bindingIdx(cfg, 'obj'),
    );
    const sites = allSites(cfg);
    expect(sites.find((s) => s.callee === 'obj.send')).toMatchObject({
      receiver: bindingIdx(cfg, 'obj'),
      resultDefs: [bindingIdx(cfg, 'out')],
      at: [5, 18],
    });
    expect(sites.find((s) => s.callee === 'clean')?.parent).toEqual([0, 0]);
  });

  it('keeps short-circuit side effects conditional', () => {
    const cfg = harness().cfgOf(
      'fn f(flag: bool) void { var x: i32 = 0; _ = flag and blk: { x = 1; break :blk true; }; use(x); }',
    );
    const rd = computeReachingDefs(cfg);
    const defs = rd.facts.filter(
      (f) => f.bindingIdx === bindingIdx(cfg, 'x') && f.use.blockIndex === block(cfg, 'use(x)'),
    );
    expect(new Set(defs.map((f) => cfg.blocks[f.def.blockIndex].text))).toEqual(
      new Set(['var x: i32 = 0;', 'x = 1;']),
    );
  });

  it('collects nested methods separately and never harvests their bodies in the outer CFG', () => {
    const cfgs = harness().cfgsOf(
      'fn outer() void { const S = struct { fn inner() void { hidden(); } }; visible(); }',
    );
    expect(cfgs).toHaveLength(2);
    expect(allSites(cfgs[0]).map((s) => s.callee)).toEqual(['visible']);
    expect(allSites(cfgs[1]).map((s) => s.callee)).toEqual(['hidden']);
  });

  it('retains usable control dependence when all branch arms return', () => {
    const cfg = harness().cfgOf(
      'fn f(flag: bool) i32 { if (flag) { return 1; } else { return 2; } }',
    );
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(
      computeControlDependence(cfg).edges.some((e) => e.dependentBlock === block(cfg, 'return 1')),
    ).toBe(true);
  });

  it('skips malformed and unsupported function shapes without inventing precise flow', () => {
    const h = harness();
    expect(h.cfgsOf('extern fn external() void;')).toEqual([]);
    for (const body of ['break :unknown;', 'asm volatile ("nop");']) {
      const result = collectFunctionCfgs(
        h.parse(`fn f() void { ${body} }`),
        zigProvider.cfgVisitor!,
        'fixture.zig',
      );
      expect(result.cfgs).toEqual([]);
      expect(result.skipped.buildError).toBe(1);
    }
    expect(h.cfgsOf('fn f() void { if (')).toEqual([]);
  });

  it('treats anonymous unreachable expression arms as terminating traps without cleanup', () => {
    const cfg = harness().cfgOf(
      'fn f() i32 { defer cleanup(); const n = read() catch unreachable; return n; }',
    );
    const trap = cfg.blocks.find((b) => b.text === 'unreachable')?.index;
    expect(trap).toBeDefined();
    expect(reaches(cfg, trap!, block(cfg, 'cleanup()'))).toBe(false);
    expect(reaches(cfg, trap!, block(cfg, 'return n'))).toBe(false);
  });

  it('keeps null/undefined argument slots instead of shifting later binding positions', () => {
    const cfg = harness().cfgOf('fn f(input: i32) void { send(null, undefined, input); }');
    expect(allSites(cfg).find((s) => s.callee === 'send')?.args).toEqual([
      [],
      [],
      [bindingIdx(cfg, 'input')],
    ]);
  });

  it('harvests builtin callees and argument positions alongside ordinary calls', () => {
    const cfg = harness().cfgOf(`fn f(input: u32, obj: Object) void {
      const converted = @as(u64, input);
      obj.send(converted, @as(u64, input));
    }`);
    const sites = allSites(cfg);
    const builtins = sites.filter((site) => site.callee === '@as');
    expect(builtins).toHaveLength(2);
    expect(builtins[0]).toMatchObject({
      resultDefs: [bindingIdx(cfg, 'converted')],
      args: [[], [bindingIdx(cfg, 'input')]],
    });
    expect(builtins[1].args).toEqual([[], [bindingIdx(cfg, 'input')]]);
    expect(sites.find((site) => site.callee === 'obj.send')).toMatchObject({
      receiver: bindingIdx(cfg, 'obj'),
      args: [[bindingIdx(cfg, 'converted')], [[bindingIdx(cfg, 'input'), 1]]],
    });
    expect(builtins[1].parent).toEqual([0, 1]);
  });

  it('evaluates for iterable expressions once, outside the loop back edge', () => {
    const cfg = harness().cfgOf('fn f() void { for (items()) |item| { use(item); } }');
    expect(reaches(cfg, block(cfg, 'use(item)'), block(cfg, 'items()'))).toBe(false);
  });

  it('does not duplicate nested calls when a call argument contains control flow', () => {
    const cfg = harness().cfgOf(
      'fn f(flag: bool) !void { send(if (flag) left() else try right()); }',
    );
    expect(
      allSites(cfg)
        .map((s) => s.callee)
        .sort(),
    ).toEqual(['left', 'right', 'send']);
    expect(reaches(cfg, block(cfg, 'left()'), block(cfg, 'try right()'))).toBe(false);
  });

  it('does not let a switch capture unlabeled loop breaks or continues', () => {
    const cfg = harness().cfgOf(`fn f(flag: bool, value: i32) void {
      while (flag) : (update()) {
        dispatch: switch (value) { 0 => continue, else => break, }
        unreachable_tail();
      }
      after();
    }`);
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'continue'),
      to: block(cfg, 'update()'),
      kind: 'continue',
    });
    expect(reaches(cfg, block(cfg, 'break'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'break'), block(cfg, 'unreachable_tail()'))).toBe(false);
  });

  it('round-trips worker facts through generic CFG, reaching-def and CDG graph emission', () => {
    const h = harness();
    const root = h.parse(
      'fn f(flag: bool, input: i32) i32 { var value = input; if (flag) { value = 2; } return value; }',
    );
    const collected = collectFunctionCfgs(root, zigProvider.cfgVisitor!, 'roundtrip.zig');
    expect(collected.skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 });
    const cfgs = JSON.parse(JSON.stringify(collected.cfgs));
    const graph = createKnowledgeGraph();
    expect(emitFileCfgs(graph, cfgs).edges).toBeGreaterThan(0);
    expect(emitFileReachingDefs(graph, cfgs).edges).toBeGreaterThan(0);
    expect(emitFileCdg(graph, cfgs).edges).toBeGreaterThan(0);
    const relations = [...graph.iterRelationships()];
    expect(new Set(relations.map((r) => r.type))).toEqual(new Set(['CFG', 'REACHING_DEF', 'CDG']));
    for (const relationship of relations) {
      expect(graph.getNode(relationship.sourceId)?.label).toBe('BasicBlock');
      expect(graph.getNode(relationship.targetId)?.label).toBe('BasicBlock');
    }
  });
});
