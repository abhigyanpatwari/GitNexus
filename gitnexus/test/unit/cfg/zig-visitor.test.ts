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
  emitFileCfgs,
  emitFileReachingDefs,
  emitFileCdg,
} from '../../../src/core/ingestion/cfg/emit.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

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
