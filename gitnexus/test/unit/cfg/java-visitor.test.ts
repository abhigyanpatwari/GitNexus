import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createJavaCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/java.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import {
  makeCfgHarness,
  type CfgHarness,
  block,
  edgeKinds,
  reaches,
  reachable,
  bindingIdx,
  allSites,
  hasAnySites,
} from '../../helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';

// U4 — the Java CfgVisitor, one hazard per test (KTD5: real-parser regression,
// NOT snapshot-pinning). Each fixture's distinctive statement text (step(),
// done(), handle(e), …) lets us locate the block for a region by text and assert
// the control-flow topology around it.

const javaGrammar = createRequire(import.meta.url)('tree-sitter-java') as Parameters<
  typeof makeCfgHarness
>[0];

const java: CfgHarness = makeCfgHarness(javaGrammar, createJavaCfgVisitor(), 'fixture.java');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

const wrap = (body: string): string => `class C { void m(int x) { ${body} } }`;

describe('Java CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = java.cfgOf(`class C { void m() { a(); b(); c(); } }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = java.cfgOf(`class C { void m() {} }`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('constructor, compact constructor, and lambda are CFG-bearing functions', () => {
    const cfgs = java.cfgsOf(
      `class C { C(int a) { this.x = a; } void outer() { Runnable r = () -> { go(); }; r.run(); } }`,
    );
    // constructor C, outer, and the lambda = 3 CFGs.
    expect(cfgs.length).toBeGreaterThanOrEqual(3);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('record compact constructor is CFG-bearing', () => {
    const cfgs = java.cfgsOf(`record R(int a) { R { if (a < 0) throw new RuntimeException(); } }`);
    expect(cfgs.length).toBeGreaterThanOrEqual(1);
    for (const cfg of cfgs) expect(reachable(cfg, cfg.exitIndex)).toBe(true);
  });

  it('single-expression lambda: one block returns its value', () => {
    const cfgs = java.cfgsOf(
      `class C { void m() { java.util.function.Function<Integer,Integer> f = z -> z * 2; f.apply(1); } }`,
    );
    // The lambda's OWN cfg has a single body block whose text IS exactly the
    // expression (the enclosing method's block contains the whole lambda source).
    const lambda = cfgs.find((c) => c.blocks.some((b) => b.text === 'z * 2'));
    expect(lambda).toBeDefined();
    const body = lambda!.blocks.find((b) => b.text === 'z * 2')!.index;
    expect(lambda!.edges).toContainEqual({ from: body, to: lambda!.exitIndex, kind: 'return' });
  });

  it('abstract method (no body) → graceful undefined, no throw', () => {
    const root = java.parse(`abstract class C { abstract void m(); }`);
    const fns = java.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createJavaCfgVisitor().buildFunctionCfg(fn, 'f.java')).not.toThrow();
    }
  });
});

describe('Java CfgVisitor — branching', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = java.cfgOf(wrap(`if (x > 0) { a(); } else { b(); } c();`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
  });

  it('else if chains through the nested alternative (no else_clause wrapper)', () => {
    const cfg = java.cfgOf(
      `class C { void m(int x) { if (x > 0) { a(); } else if (x < 0) { b(); } else { c(); } } }`,
    );
    expect(reaches(cfg, block(cfg, 'a();'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c();'), cfg.exitIndex)).toBe(true);
  });
});

describe('Java CfgVisitor — loops', () => {
  it('while loop: header + back-edge + exit', () => {
    const cfg = java.cfgOf(`class C { void m(int x) { while (x > 0) { step(); } done(); } }`);
    const header = block(cfg, 'x > 0');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = java.cfgOf(`class C { void m(int x) { do { step(); } while (x > 0); done(); } }`);
    const body = block(cfg, 'step();');
    const cond = block(cfg, 'x > 0');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(reaches(cfg, body, cond)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done();'))).toBe(true);
  });

  it('classic for: init once, condition header, back-edge through update', () => {
    const cfg = java.cfgOf(
      `class C { void m(int n) { for (int i = 0; i < n; i++) { step(); } done(); } }`,
    );
    const init = block(cfg, 'int i = 0');
    const header = block(cfg, 'i < n');
    const incr = block(cfg, 'i++');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: init, kind: 'seq' });
    expect(reaches(cfg, body, incr)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: incr, to: header, kind: 'loop-back' });
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('enhanced for (for-each): header + body + loop-back + exit; loop var is a def', () => {
    const cfg = java.cfgOf(`class C { void m(int[] xs) { for (int v : xs) { use(v); } done(); } }`);
    const body = block(cfg, 'use(v);');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done();'))).toBe(true);
    const v = bindingIdx(cfg, 'v');
    expect(hasDef(cfg, v)).toBe(true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = java.cfgOf(`class C { void m(boolean x) { while (true) { if (x) { g(); } } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('for (;;) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = java.cfgOf(`class C { void m(boolean x) { for (;;) { if (x) { g(); } } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Java CfgVisitor — labeled break/continue', () => {
  it('break outer; from a nested loop targets the labeled (outer) frame', () => {
    const cfg = java.cfgOf(`class C { void m() {
      outer:
      for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 3; j++) {
          if (hit()) break outer;
          inner();
        }
        afterInner();
      }
      done();
    } }`);
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, 'break outer;');
    // The labeled break skips past BOTH loops to the post-outer-loop continuation
    // (done()), not just the inner loop's exit (afterInner()).
    expect(reaches(cfg, brk, block(cfg, 'done();'))).toBe(true);
    // It must NOT route back into the outer loop body's afterInner().
    expect(reaches(cfg, brk, block(cfg, 'afterInner();'))).toBe(false);
  });

  it('continue outer; from a nested loop continues the labeled (outer) loop', () => {
    const cfg = java.cfgOf(`class C { void m() {
      outer:
      for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 3; j++) {
          if (skip()) continue outer;
          inner();
        }
      }
      done();
    } }`);
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    expect(reaches(cfg, block(cfg, 'continue outer;'), block(cfg, 'i < 3'))).toBe(true);
  });

  it('unlabeled break does NOT match a labeled BLOCK frame', () => {
    // `blk:` labels a plain block; an UNLABELED break here is a compile error in
    // real Java, but the CFG must still route it to EXIT (no labeled-block match),
    // and a labeled `break blk;` must reach the post-block join.
    const cfg = java.cfgOf(`class C { void m() {
      blk: {
        if (cond()) break blk;
        work();
      }
      done();
    } }`);
    const brk = block(cfg, 'break blk;');
    // labeled break reaches the join after the labeled block (done()).
    expect(reaches(cfg, brk, block(cfg, 'done();'))).toBe(true);
    // work() after the break is still reachable (false arm of the if).
    expect(reachable(cfg, block(cfg, 'work();'))).toBe(true);
  });
});

describe('Java CfgVisitor — switch', () => {
  it('classic colon switch: break-terminated case rejoins, fallthrough on break-less', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) {
        case 1: one(); break;
        case 2: two(); break;
        default: other();
      }
      after();
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'after();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two();'), block(cfg, 'after();'))).toBe(true);
    // break-terminated case 1 does not fall into case 2.
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(false);
  });

  it('empty colon case falls through to the next case (fallthrough edge)', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) { case 1: case 2: shared(); break; default: d(); }
      after();
    } }`);
    expect(reaches(cfg, block(cfg, 'shared();'), block(cfg, 'after();'))).toBe(true);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // a break-less default flows to after().
    expect(reaches(cfg, block(cfg, 'd();'), block(cfg, 'after();'))).toBe(true);
  });

  it('a non-break case FALLS THROUGH to the next case (classic semantics)', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) { case 1: one(); case 2: two(); break; default: d(); }
      after();
    } }`);
    // case 1 has no break → it falls into case 2's body.
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(true);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
  });

  it('arrow switch: each rule rejoins after the switch, no fallthrough', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) {
        case 1 -> a();
        case 2, 3 -> b();
        default -> c();
      }
      after();
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'after();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), block(cfg, 'after();'))).toBe(true);
    // arrow rule a() does NOT fall into b().
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'b();'))).toBe(false);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(false);
  });

  it('switch case-test is recorded as a may-def/use on the dispatch block', () => {
    const cfg = java.cfgOf(`class C { void m(int x, int k) {
      switch (x) { case 1: a(); break; default: b(); }
    } }`);
    // The dispatch block (switch value `x`) uses x; the case-test constants carry
    // no bindings, but a value-bearing dispatch records the discriminant use.
    const x = bindingIdx(cfg, 'x');
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('value-position switch declaration is modeled as a dispatch, def bound at the join (#2207)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = switch (x) { case 1 -> 10; default -> { yield 20; } };
      use(r);
    } }`);
    // The arms are now real CFG blocks reached by switch-case dispatch edges.
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // Each arm rejoins and reaches the use of the bound result.
    expect(reaches(cfg, block(cfg, '10'), block(cfg, 'use(r);'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'yield 20;'), block(cfg, 'use(r);'))).toBe(true);
    // `r` is defined (at the continuation) and used downstream — the chain is live.
    const r = bindingIdx(cfg, 'r');
    expect(hasDef(cfg, r)).toBe(true);
    expect(hasUse(cfg, r)).toBe(true);
    // Modeling the arms yields control dependence (the whole point of #2207).
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('return switch (…) {…} models each arm as returning the function result (#2207)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      return switch (x) { case 1 -> a(); case 2 -> b(); default -> c(); };
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    // every arm reaches EXIT (its value IS the returned result).
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('value-position switch with ONE group stays inline (no real control dependence)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = switch (x) { default -> 0; };
      use(r);
    } }`);
    // A single-arm switch carries no branch — it coalesces into the declaration block.
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('assignment-RHS value switch stays inline (documented remaining gap)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = 0;
      r = switch (x) { case 1 -> 10; default -> 20; };
      use(r);
    } }`);
    // Only declaration / return carriers are modeled; an assignment RHS coalesces.
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('statement switch with a yield arm builds a dispatch with a yield block', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      switch (x) {
        case 1: yield 10;
        default: yield 20;
      }
    } }`);
    // statement-position switch breaks a block → switch-case dispatch edges.
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
  });

  it('colon-form value switch: yield ends the arm, NO fallthrough; every arm is CDG-dependent (#2211)', () => {
    const cfg = java.cfgOf(`class C { int m(int k) {
      int x = switch (k) { case 1: yield one(); case 2: yield two(); default: yield zero(); };
      use(x);
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // a `yield` exits the switch — it does NOT fall through to the next colon group.
    expect(edgeKinds(cfg).has('fallthrough')).toBe(false);
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
    // every arm rejoins and reaches the downstream use of the bound result.
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'use(x);'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'use(x);'))).toBe(true);
    // each arm is control-dependent on the dispatch — pin the SPECIFIC pairs.
    const dispatch = block(cfg, 'k');
    const cdg = computeControlDependence(cfg);
    expect(
      cdg.edges.some(
        (e) => e.controllerBlock === dispatch && e.dependentBlock === block(cfg, 'one()'),
      ),
    ).toBe(true);
    expect(
      cdg.edges.some(
        (e) => e.controllerBlock === dispatch && e.dependentBlock === block(cfg, 'two()'),
      ),
    ).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('return switch (…) inside try/finally threads the finalizer per arm (#2211)', () => {
    const cfg = java.cfgOf(`class C { int m(int k) {
      try {
        return switch (k) { case 1 -> a(); default -> b(); };
      } finally { cleanup(); }
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // each arm's return threads the finally before EXIT.
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), block(cfg, 'cleanup();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), block(cfg, 'cleanup();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Java CfgVisitor — try / catch / finally / try-with-resources', () => {
  it('try/catch: a throw edge runs from each protected block to the handler', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { risky(); deeper(); } catch (java.lang.Exception e) { handle(e); }
      after();
    } }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e);');
    expect(reaches(cfg, block(cfg, 'risky();'), handler)).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('finally runs on normal completion of the try', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { work(); } finally { cleanup(); }
      after();
    } }`);
    const body = block(cfg, 'work();');
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, body, fin)).toBe(true);
    expect(reaches(cfg, fin, block(cfg, 'after();'))).toBe(true);
  });

  it('return crossing a finally emits a finally-return completion edge', () => {
    const cfg = java.cfgOf(`class C { int m() {
      try { return compute(); } finally { cleanup(); }
    } }`);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });

  it('break crossing a finally emits a finally-break completion edge', () => {
    const cfg = java.cfgOf(`class C { void m(int n) {
      for (int i = 0; i < n; i++) {
        try { if (done()) break; } finally { tick(); }
      }
      after();
    } }`);
    expect(edgeKinds(cfg).has('finally-break')).toBe(true);
  });

  it('try-with-resources closes resources on the NORMAL exit path', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try (var r = open()) { read(r); }
      after();
    } }`);
    const body = block(cfg, 'read(r);');
    const close = block(cfg, 'close');
    // body → close → after() (normal completion threads through the close).
    expect(reaches(cfg, body, close)).toBe(true);
    expect(reaches(cfg, close, block(cfg, 'after();'))).toBe(true);
  });

  it('try-with-resources closes resources on the EXCEPTION path too', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try (var r = open()) { risky(r); }
    } }`);
    const body = block(cfg, 'risky(r);');
    const close = block(cfg, 'close');
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    expect(reaches(cfg, body, close)).toBe(true);
  });

  it('a return inside try-with-resources crosses the close (finally-return)', () => {
    const cfg = java.cfgOf(`class C { int m() {
      try (var r = open()) { return read(r); }
    } }`);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });

  it('multi-catch (A | B) binds the exception name as a def in the handler', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { x(); } catch (java.io.IOException | java.lang.RuntimeException e) { handle(e); }
    } }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const e = bindingIdx(cfg, 'e');
    expect(hasDef(cfg, e)).toBe(true);
  });
});

describe('Java CfgVisitor — synchronized (deterministic finalizer)', () => {
  it('synchronized body runs then releases the monitor on the normal path', () => {
    const cfg = java.cfgOf(`class C { void m(Object lock) {
      synchronized (lock) { touch(); }
      after();
    } }`);
    const body = block(cfg, 'touch();');
    const release = block(cfg, 'release');
    expect(reaches(cfg, body, release)).toBe(true);
    expect(reaches(cfg, release, block(cfg, 'after();'))).toBe(true);
  });

  it('synchronized releases the monitor on the exception path (throw → release)', () => {
    const cfg = java.cfgOf(`class C { void m(Object lock) { synchronized (lock) { risky(); } } }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const body = block(cfg, 'risky();');
    const release = block(cfg, 'release');
    expect(reaches(cfg, body, release)).toBe(true);
  });

  it('a return inside synchronized crosses the release (finally-return)', () => {
    const cfg = java.cfgOf(
      `class C { int m(Object lock) { synchronized (lock) { return get(); } } }`,
    );
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });
});

describe('Java CfgVisitor — def/use harvest', () => {
  it('local declaration: int x = a + b; use(x); → def of x + use of x', () => {
    const cfg = java.cfgOf(`class C { void m(int a, int b) { int x = a + b; use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('bare uninitialized local is NOT a def until assigned', () => {
    const cfg = java.cfgOf(`class C { void m() { int x; x = 5; use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    // the assignment defines x; the declaration alone does not.
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('a && (x = g()) records x as a may-def inside the short-circuit', () => {
    const cfg = java.cfgOf(
      `class C { void m(boolean a) { int x = 0; if (a && (x = g()) > 0) h(x); } }`,
    );
    const x = bindingIdx(cfg, 'x');
    expect(hasMayDef(cfg, x)).toBe(true);
  });

  it('ternary arms record their writes as may-defs', () => {
    const cfg = java.cfgOf(
      `class C { void m(int a) { int x = 0; int y = a > 0 ? (x = 1) : (x = 2); use(y); } }`,
    );
    const x = bindingIdx(cfg, 'x');
    expect(hasMayDef(cfg, x)).toBe(true);
  });

  it('compound assignment reads AND writes the lvalue', () => {
    const cfg = java.cfgOf(`class C { void m() { int z = 1; z += 3; } }`);
    const z = bindingIdx(cfg, 'z');
    expect(hasDef(cfg, z)).toBe(true);
    expect(hasUse(cfg, z)).toBe(true);
  });

  it('field/array writes are NOT scalar defs (their roots are uses)', () => {
    const cfg = java.cfgOf(`class C { void m(int[] a) { a[0] = 1; this.f = 2; } }`);
    // `a` is a parameter; the array write `a[0] = 1` reads a (subscript root),
    // it does not define `a`. No `this.f` scalar binding is created.
    const a = bindingIdx(cfg, 'a');
    expect(hasUse(cfg, a)).toBe(true);
  });
});

describe('Java CfgVisitor — functionStartColumn', () => {
  it('two same-line methods get distinct functionStartColumn', () => {
    const cfgs = java.cfgsOf(`class C { int a() { return 1; } int b() { return 2; } }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});

describe('Java CfgVisitor — does not throw on exotic shapes', () => {
  it('nested lambdas / anonymous-class methods each build their own CFGs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfgs = java.cfgsOf(`class C { void m() {
        Runnable r = () -> { if (cond()) { go(); } };
        java.util.function.Function<Integer,Integer> f = z -> z + 1;
        r.run();
      } }`);
      expect(cfgs.length).toBeGreaterThanOrEqual(3); // m, lambda block, lambda expr
      for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a truncated value-position switch never throws out of the carrier path (R4) (#2211)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = java.parse(`class C { int m(int k){ int x = switch (k) { case 1 -> a(`);
      for (const fn of java.collectFunctions(root)) {
        expect(() => createJavaCfgVisitor().buildFunctionCfg(fn, 'f.java')).not.toThrow();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// U6 — call-site `sites[]` taint substrate. INERT BY DESIGN: no Java taint model
// is registered, so these sites produce zero TAINTED edges; they only give the
// deferred per-language source/sink model something to match against.
describe('Java CfgVisitor — call-site sites[] substrate', () => {
  const cfgOf = (body: string): FunctionCfg =>
    java.cfgOf(`class C { void f(int cmd, int x, int a) { ${body} } }`);

  it('a bare method call records a `call` site with callee + arg occurrence', () => {
    const cfg = cfgOf(`exec(cmd);`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'exec');
    expect(site).toBeDefined();
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'cmd'));
  });

  it('a receiver call (`db.query(x)`) records the receiver binding + dotted callee', () => {
    // Java carries the method NAME on the `name` field and the receiver on the
    // sibling `object` field — the substrate normalizes both to receiver+callee.
    const cfg = cfgOf(`db.query(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'db.query');
    expect(site).toBeDefined();
    expect(site?.receiver).toBe(bindingIdx(cfg, 'db'));
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
  });

  it('`new Foo(x)` records a `new` site with the type as callee', () => {
    const cfg = cfgOf(`Object p = new Foo(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'new');
    expect(site?.callee).toBe('Foo');
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
    expect(site?.resultDefs).toContain(bindingIdx(cfg, 'p'));
  });

  it('a nested call via-tags the inner site (sanitizer substrate)', () => {
    const cfg = cfgOf(`exec(escape(x));`);
    const sites = allSites(cfg);
    const exec = sites.findIndex((s) => s.callee === 'exec');
    const escape = sites.findIndex((s) => s.callee === 'escape');
    expect(exec).toBeGreaterThanOrEqual(0);
    expect(escape).toBeGreaterThanOrEqual(0);
    const x = bindingIdx(cfg, 'x');
    expect(sites[escape].args?.[0]).toContainEqual(x);
    expect(sites[exec].args?.[0]).toContainEqual([x, escape]);
  });

  it('a CFG-only function (no calls) emits NO sites key (omit-when-empty)', () => {
    const cfg = java.cfgOf(`class C { void f(int a, int b) { int x = a + b; } }`);
    expect(hasAnySites(cfg)).toBe(false);
  });
});
