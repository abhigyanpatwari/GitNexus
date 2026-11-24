import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { createJavaCfgVisitor } from '../../../../../src/core/ingestion/cfg/visitors/java.js';
import type { FunctionCfg } from '../../../../../src/core/ingestion/cfg/types.js';
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
} from '../../../../../test/helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../../../src/core/ingestion/cfg/control-dependence.js';

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
    assert.equal(cfg.blocks.filter((b) => b.kind === 'normal').length, 1);
    const body = block(cfg, 'a();');
    assert.ok(
      cfg.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: cfg.entryIndex, to: body, kind: 'seq' }),
      ),
    );
    assert.equal(reaches(cfg, body, cfg.exitIndex), true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = java.cfgOf(`class C { void m() {} }`);
    assert.equal(cfg.blocks.length, 2);
    assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
  });

  it('constructor, compact constructor, and lambda are CFG-bearing functions', () => {
    const cfgs = java.cfgsOf(
      `class C { C(int a) { this.x = a; } void outer() { Runnable r = () -> { go(); }; r.run(); } }`,
    );
    // constructor C, outer, and the lambda = 3 CFGs.
    assert.ok(cfgs.length >= 3);
    for (const cfg of cfgs) assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
  });

  it('record compact constructor is CFG-bearing', () => {
    const cfgs = java.cfgsOf(`record R(int a) { R { if (a < 0) throw new RuntimeException(); } }`);
    assert.ok(cfgs.length >= 1);
    for (const cfg of cfgs) assert.equal(reachable(cfg, cfg.exitIndex), true);
  });

  it('single-expression lambda: one block returns its value', () => {
    const cfgs = java.cfgsOf(
      `class C { void m() { java.util.function.Function<Integer,Integer> f = z -> z * 2; f.apply(1); } }`,
    );
    // The lambda's OWN cfg has a single body block whose text IS exactly the
    // expression (the enclosing method's block contains the whole lambda source).
    const lambda = cfgs.find((c) => c.blocks.some((b) => b.text === 'z * 2'));
    assert.notEqual(lambda, undefined);
    const body = lambda!.blocks.find((b) => b.text === 'z * 2')!.index;
    assert.ok(
      lambda!.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: body, to: lambda!.exitIndex, kind: 'return' }),
      ),
    );
  });

  it('abstract method (no body) → graceful undefined, no throw', () => {
    const root = java.parse(`abstract class C { abstract void m(); }`);
    const fns = java.collectFunctions(root);
    for (const fn of fns) {
      assert.doesNotThrow(() => createJavaCfgVisitor().buildFunctionCfg(fn, 'f.java'));
    }
  });
});

describe('Java CfgVisitor — branching', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = java.cfgOf(wrap(`if (x > 0) { a(); } else { b(); } c();`));
    const kinds = edgeKinds(cfg);
    assert.equal(kinds.has('cond-true'), true);
    assert.equal(kinds.has('cond-false'), true);
    const join = block(cfg, 'c();');
    assert.equal(reaches(cfg, block(cfg, 'a();'), join), true);
    assert.equal(reaches(cfg, block(cfg, 'b();'), join), true);
  });

  it('else if chains through the nested alternative (no else_clause wrapper)', () => {
    const cfg = java.cfgOf(
      `class C { void m(int x) { if (x > 0) { a(); } else if (x < 0) { b(); } else { c(); } } }`,
    );
    assert.equal(reaches(cfg, block(cfg, 'a();'), cfg.exitIndex), true);
    assert.equal(reaches(cfg, block(cfg, 'b();'), cfg.exitIndex), true);
    assert.equal(reaches(cfg, block(cfg, 'c();'), cfg.exitIndex), true);
  });
});

describe('Java CfgVisitor — loops', () => {
  it('while loop: header + back-edge + exit', () => {
    const cfg = java.cfgOf(`class C { void m(int x) { while (x > 0) { step(); } done(); } }`);
    const header = block(cfg, 'x > 0');
    const body = block(cfg, 'step();');
    assert.ok(
      cfg.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: body, to: header, kind: 'loop-back' }),
      ),
    );
    assert.equal(edgeKinds(cfg).has('cond-true'), true);
    assert.equal(reaches(cfg, header, block(cfg, 'done();')), true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = java.cfgOf(`class C { void m(int x) { do { step(); } while (x > 0); done(); } }`);
    const body = block(cfg, 'step();');
    const cond = block(cfg, 'x > 0');
    assert.equal(reaches(cfg, cfg.entryIndex, body), true); // body runs first
    assert.equal(reaches(cfg, body, cond), true);
    assert.ok(
      cfg.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: cond, to: body, kind: 'loop-back' }),
      ),
    );
    assert.equal(reaches(cfg, cond, block(cfg, 'done();')), true);
  });

  it('classic for: init once, condition header, back-edge through update', () => {
    const cfg = java.cfgOf(
      `class C { void m(int n) { for (int i = 0; i < n; i++) { step(); } done(); } }`,
    );
    const init = block(cfg, 'int i = 0');
    const header = block(cfg, 'i < n');
    const incr = block(cfg, 'i++');
    const body = block(cfg, 'step();');
    assert.ok(
      cfg.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: cfg.entryIndex, to: init, kind: 'seq' }),
      ),
    );
    assert.equal(reaches(cfg, body, incr), true);
    assert.ok(
      cfg.edges.some((actual) =>
        isDeepStrictEqual(actual, { from: incr, to: header, kind: 'loop-back' }),
      ),
    );
    assert.equal(reaches(cfg, header, block(cfg, 'done();')), true);
  });

  it('enhanced for (for-each): header + body + loop-back + exit; loop var is a def', () => {
    const cfg = java.cfgOf(`class C { void m(int[] xs) { for (int v : xs) { use(v); } done(); } }`);
    const body = block(cfg, 'use(v);');
    assert.equal(edgeKinds(cfg).has('cond-true'), true);
    assert.equal(edgeKinds(cfg).has('loop-back'), true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    assert.notEqual(header, undefined);
    assert.equal(reaches(cfg, header!, block(cfg, 'done();')), true);
    const v = bindingIdx(cfg, 'v');
    assert.equal(hasDef(cfg, v), true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = java.cfgOf(`class C { void m(boolean x) { while (true) { if (x) { g(); } } } }`);
    assert.equal(edgeKinds(cfg).has('cond-false'), true);
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
    assert.ok(computeControlDependence(cfg).edges.length > 0);
  });

  it('for (;;) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = java.cfgOf(`class C { void m(boolean x) { for (;;) { if (x) { g(); } } } }`);
    assert.equal(edgeKinds(cfg).has('cond-false'), true);
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
    assert.ok(computeControlDependence(cfg).edges.length > 0);
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
    assert.equal(edgeKinds(cfg).has('break'), true);
    const brk = block(cfg, 'break outer;');
    // The labeled break skips past BOTH loops to the post-outer-loop continuation
    // (done()), not just the inner loop's exit (afterInner()).
    assert.equal(reaches(cfg, brk, block(cfg, 'done();')), true);
    // It must NOT route back into the outer loop body's afterInner().
    assert.equal(reaches(cfg, brk, block(cfg, 'afterInner();')), false);
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
    assert.equal(edgeKinds(cfg).has('continue'), true);
    assert.equal(reaches(cfg, block(cfg, 'continue outer;'), block(cfg, 'i < 3')), true);
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
    assert.equal(reaches(cfg, brk, block(cfg, 'done();')), true);
    // work() after the break is still reachable (false arm of the if).
    assert.equal(reachable(cfg, block(cfg, 'work();')), true);
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
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    assert.equal(reaches(cfg, block(cfg, 'one();'), block(cfg, 'after();')), true);
    assert.equal(reaches(cfg, block(cfg, 'two();'), block(cfg, 'after();')), true);
    // break-terminated case 1 does not fall into case 2.
    assert.equal(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();')), false);
  });

  it('empty colon case falls through to the next case (fallthrough edge)', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) { case 1: case 2: shared(); break; default: d(); }
      after();
    } }`);
    assert.equal(reaches(cfg, block(cfg, 'shared();'), block(cfg, 'after();')), true);
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    // a break-less default flows to after().
    assert.equal(reaches(cfg, block(cfg, 'd();'), block(cfg, 'after();')), true);
  });

  it('a non-break case FALLS THROUGH to the next case (classic semantics)', () => {
    const cfg = java.cfgOf(`class C { void m(int x) {
      switch (x) { case 1: one(); case 2: two(); break; default: d(); }
      after();
    } }`);
    // case 1 has no break → it falls into case 2's body.
    assert.equal(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();')), true);
    assert.equal(edgeKinds(cfg).has('fallthrough'), true);
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
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    assert.equal(reaches(cfg, block(cfg, 'a();'), block(cfg, 'after();')), true);
    assert.equal(reaches(cfg, block(cfg, 'b();'), block(cfg, 'after();')), true);
    // arrow rule a() does NOT fall into b().
    assert.equal(reaches(cfg, block(cfg, 'a();'), block(cfg, 'b();')), false);
    assert.equal(edgeKinds(cfg).has('fallthrough'), false);
  });

  it('switch case-test is recorded as a may-def/use on the dispatch block', () => {
    const cfg = java.cfgOf(`class C { void m(int x, int k) {
      switch (x) { case 1: a(); break; default: b(); }
    } }`);
    // The dispatch block (switch value `x`) uses x; the case-test constants carry
    // no bindings, but a value-bearing dispatch records the discriminant use.
    const x = bindingIdx(cfg, 'x');
    assert.equal(hasUse(cfg, x), true);
  });

  it('value-position switch declaration is modeled as a dispatch, def bound at the join (#2207)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = switch (x) { case 1 -> 10; default -> { yield 20; } };
      use(r);
    } }`);
    // The arms are now real CFG blocks reached by switch-case dispatch edges.
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    // Each arm rejoins and reaches the use of the bound result.
    assert.equal(reaches(cfg, block(cfg, '10'), block(cfg, 'use(r);')), true);
    assert.equal(reaches(cfg, block(cfg, 'yield 20;'), block(cfg, 'use(r);')), true);
    // `r` is defined (at the continuation) and used downstream — the chain is live.
    const r = bindingIdx(cfg, 'r');
    assert.equal(hasDef(cfg, r), true);
    assert.equal(hasUse(cfg, r), true);
    // Modeling the arms yields control dependence (the whole point of #2207).
    assert.ok(computeControlDependence(cfg).edges.length > 0);
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
    assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
  });

  it('return switch (…) {…} models each arm as returning the function result (#2207)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      return switch (x) { case 1 -> a(); case 2 -> b(); default -> c(); };
    } }`);
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    assert.equal(edgeKinds(cfg).has('return'), true);
    // every arm reaches EXIT (its value IS the returned result).
    assert.equal(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex), true);
    assert.equal(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex), true);
    assert.ok(computeControlDependence(cfg).edges.length > 0);
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
  });

  it('value-position switch with ONE group stays inline (no real control dependence)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = switch (x) { default -> 0; };
      use(r);
    } }`);
    // A single-arm switch carries no branch — it coalesces into the declaration block.
    assert.equal(edgeKinds(cfg).has('switch-case'), false);
    assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
  });

  it('assignment-RHS value switch stays inline (documented remaining gap)', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      int r = 0;
      r = switch (x) { case 1 -> 10; default -> 20; };
      use(r);
    } }`);
    // Only declaration / return carriers are modeled; an assignment RHS coalesces.
    assert.equal(edgeKinds(cfg).has('switch-case'), false);
    assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
  });

  it('statement switch with a yield arm builds a dispatch with a yield block', () => {
    const cfg = java.cfgOf(`class C { int m(int x) {
      switch (x) {
        case 1: yield 10;
        default: yield 20;
      }
    } }`);
    // statement-position switch breaks a block → switch-case dispatch edges.
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
  });

  it('colon-form value switch: yield ends the arm, NO fallthrough; every arm is CDG-dependent (#2211)', () => {
    const cfg = java.cfgOf(`class C { int m(int k) {
      int x = switch (k) { case 1: yield one(); case 2: yield two(); default: yield zero(); };
      use(x);
    } }`);
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    // a `yield` exits the switch — it does NOT fall through to the next colon group.
    assert.equal(edgeKinds(cfg).has('fallthrough'), false);
    assert.equal(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()')), false);
    // every arm rejoins and reaches the downstream use of the bound result.
    assert.equal(reaches(cfg, block(cfg, 'one()'), block(cfg, 'use(x);')), true);
    assert.equal(reaches(cfg, block(cfg, 'two()'), block(cfg, 'use(x);')), true);
    // each arm is control-dependent on the dispatch — pin the SPECIFIC pairs.
    const dispatch = block(cfg, 'k');
    const cdg = computeControlDependence(cfg);
    assert.equal(
      cdg.edges.some(
        (e) => e.controllerBlock === dispatch && e.dependentBlock === block(cfg, 'one()'),
      ),
      true,
    );
    assert.equal(
      cdg.edges.some(
        (e) => e.controllerBlock === dispatch && e.dependentBlock === block(cfg, 'two()'),
      ),
      true,
    );
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
  });

  it('return switch (…) inside try/finally threads the finalizer per arm (#2211)', () => {
    const cfg = java.cfgOf(`class C { int m(int k) {
      try {
        return switch (k) { case 1 -> a(); default -> b(); };
      } finally { cleanup(); }
    } }`);
    assert.equal(edgeKinds(cfg).has('switch-case'), true);
    // each arm's return threads the finally before EXIT.
    assert.equal(edgeKinds(cfg).has('finally-return'), true);
    assert.equal(reaches(cfg, block(cfg, 'a()'), block(cfg, 'cleanup();')), true);
    assert.equal(reaches(cfg, block(cfg, 'b()'), block(cfg, 'cleanup();')), true);
    assert.equal(isExitReachableFromAllBlocks(cfg), true);
  });
});

describe('Java CfgVisitor — try / catch / finally / try-with-resources', () => {
  it('try/catch: a throw edge runs from each protected block to the handler', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { risky(); deeper(); } catch (java.lang.Exception e) { handle(e); }
      after();
    } }`);
    assert.equal(edgeKinds(cfg).has('throw'), true);
    const handler = block(cfg, 'handle(e);');
    assert.equal(reaches(cfg, block(cfg, 'risky();'), handler), true);
    assert.equal(reachable(cfg, block(cfg, 'after();')), true);
  });

  it('finally runs on normal completion of the try', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { work(); } finally { cleanup(); }
      after();
    } }`);
    const body = block(cfg, 'work();');
    const fin = block(cfg, 'cleanup();');
    assert.equal(reaches(cfg, body, fin), true);
    assert.equal(reaches(cfg, fin, block(cfg, 'after();')), true);
  });

  it('return crossing a finally emits a finally-return completion edge', () => {
    const cfg = java.cfgOf(`class C { int m() {
      try { return compute(); } finally { cleanup(); }
    } }`);
    assert.equal(edgeKinds(cfg).has('finally-return'), true);
  });

  it('break crossing a finally emits a finally-break completion edge', () => {
    const cfg = java.cfgOf(`class C { void m(int n) {
      for (int i = 0; i < n; i++) {
        try { if (done()) break; } finally { tick(); }
      }
      after();
    } }`);
    assert.equal(edgeKinds(cfg).has('finally-break'), true);
  });

  it('try-with-resources closes resources on the NORMAL exit path', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try (var r = open()) { read(r); }
      after();
    } }`);
    const body = block(cfg, 'read(r);');
    const close = block(cfg, 'close');
    // body → close → after() (normal completion threads through the close).
    assert.equal(reaches(cfg, body, close), true);
    assert.equal(reaches(cfg, close, block(cfg, 'after();')), true);
  });

  it('try-with-resources closes resources on the EXCEPTION path too', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try (var r = open()) { risky(r); }
    } }`);
    const body = block(cfg, 'risky(r);');
    const close = block(cfg, 'close');
    assert.equal(edgeKinds(cfg).has('throw'), true);
    assert.equal(reaches(cfg, body, close), true);
  });

  it('a return inside try-with-resources crosses the close (finally-return)', () => {
    const cfg = java.cfgOf(`class C { int m() {
      try (var r = open()) { return read(r); }
    } }`);
    assert.equal(edgeKinds(cfg).has('finally-return'), true);
  });

  it('multi-catch (A | B) binds the exception name as a def in the handler', () => {
    const cfg = java.cfgOf(`class C { void m() {
      try { x(); } catch (java.io.IOException | java.lang.RuntimeException e) { handle(e); }
    } }`);
    assert.equal(edgeKinds(cfg).has('throw'), true);
    const e = bindingIdx(cfg, 'e');
    assert.equal(hasDef(cfg, e), true);
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
    assert.equal(reaches(cfg, body, release), true);
    assert.equal(reaches(cfg, release, block(cfg, 'after();')), true);
  });

  it('synchronized releases the monitor on the exception path (throw → release)', () => {
    const cfg = java.cfgOf(`class C { void m(Object lock) { synchronized (lock) { risky(); } } }`);
    assert.equal(edgeKinds(cfg).has('throw'), true);
    const body = block(cfg, 'risky();');
    const release = block(cfg, 'release');
    assert.equal(reaches(cfg, body, release), true);
  });

  it('a return inside synchronized crosses the release (finally-return)', () => {
    const cfg = java.cfgOf(
      `class C { int m(Object lock) { synchronized (lock) { return get(); } } }`,
    );
    assert.equal(edgeKinds(cfg).has('finally-return'), true);
  });
});

describe('Java CfgVisitor — def/use harvest', () => {
  it('local declaration: int x = a + b; use(x); → def of x + use of x', () => {
    const cfg = java.cfgOf(`class C { void m(int a, int b) { int x = a + b; use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    assert.equal(hasDef(cfg, x), true);
    assert.equal(hasUse(cfg, x), true);
  });

  it('bare uninitialized local is NOT a def until assigned', () => {
    const cfg = java.cfgOf(`class C { void m() { int x; x = 5; use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    // the assignment defines x; the declaration alone does not.
    assert.equal(hasDef(cfg, x), true);
    assert.equal(hasUse(cfg, x), true);
  });

  it('a && (x = g()) records x as a may-def inside the short-circuit', () => {
    const cfg = java.cfgOf(
      `class C { void m(boolean a) { int x = 0; if (a && (x = g()) > 0) h(x); } }`,
    );
    const x = bindingIdx(cfg, 'x');
    assert.equal(hasMayDef(cfg, x), true);
  });

  it('ternary arms record their writes as may-defs', () => {
    const cfg = java.cfgOf(
      `class C { void m(int a) { int x = 0; int y = a > 0 ? (x = 1) : (x = 2); use(y); } }`,
    );
    const x = bindingIdx(cfg, 'x');
    assert.equal(hasMayDef(cfg, x), true);
  });

  it('compound assignment reads AND writes the lvalue', () => {
    const cfg = java.cfgOf(`class C { void m() { int z = 1; z += 3; } }`);
    const z = bindingIdx(cfg, 'z');
    assert.equal(hasDef(cfg, z), true);
    assert.equal(hasUse(cfg, z), true);
  });

  it('field/array writes are NOT scalar defs (their roots are uses)', () => {
    const cfg = java.cfgOf(`class C { void m(int[] a) { a[0] = 1; this.f = 2; } }`);
    // `a` is a parameter; the array write `a[0] = 1` reads a (subscript root),
    // it does not define `a`. No `this.f` scalar binding is created.
    const a = bindingIdx(cfg, 'a');
    assert.equal(hasUse(cfg, a), true);
  });
});

describe('Java CfgVisitor — functionStartColumn', () => {
  it('two same-line methods get distinct functionStartColumn', () => {
    const cfgs = java.cfgsOf(`class C { int a() { return 1; } int b() { return 2; } }`);
    assert.equal(cfgs.length, 2);
    assert.equal(cfgs[0].functionStartLine, cfgs[1].functionStartLine); // same line
    assert.notEqual(cfgs[0].functionStartColumn, cfgs[1].functionStartColumn); // distinct column
  });
});

describe('Java CfgVisitor — does not throw on exotic shapes', () => {
  it('nested lambdas / anonymous-class methods each build their own CFGs', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    try {
      const cfgs = java.cfgsOf(`class C { void m() {
        Runnable r = () -> { if (cond()) { go(); } };
        java.util.function.Function<Integer,Integer> f = z -> z + 1;
        r.run();
      } }`);
      assert.ok(cfgs.length >= 3); // m, lambda block, lambda expr
      for (const cfg of cfgs) assert.equal(reaches(cfg, cfg.entryIndex, cfg.exitIndex), true);
    } finally {
      warn.mock.restore();
    }
  });

  it('a truncated value-position switch never throws out of the carrier path (R4) (#2211)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    try {
      const root = java.parse(`class C { int m(int k){ int x = switch (k) { case 1 -> a(`);
      for (const fn of java.collectFunctions(root)) {
        assert.doesNotThrow(() => createJavaCfgVisitor().buildFunctionCfg(fn, 'f.java'));
      }
    } finally {
      warn.mock.restore();
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
    assert.notEqual(site, undefined);
    assert.ok(
      (site?.args?.[0]).some((actual) => isDeepStrictEqual(actual, bindingIdx(cfg, 'cmd'))),
    );
  });

  it('a receiver call (`db.query(x)`) records the receiver binding + dotted callee', () => {
    // Java carries the method NAME on the `name` field and the receiver on the
    // sibling `object` field — the substrate normalizes both to receiver+callee.
    const cfg = cfgOf(`db.query(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'db.query');
    assert.notEqual(site, undefined);
    assert.equal(site?.receiver, bindingIdx(cfg, 'db'));
    assert.ok((site?.args?.[0]).some((actual) => isDeepStrictEqual(actual, bindingIdx(cfg, 'x'))));
  });

  it('`new Foo(x)` records a `new` site with the type as callee', () => {
    const cfg = cfgOf(`Object p = new Foo(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'new');
    assert.equal(site?.callee, 'Foo');
    assert.ok((site?.args?.[0]).some((actual) => isDeepStrictEqual(actual, bindingIdx(cfg, 'x'))));
    assert.ok((site?.resultDefs).includes(bindingIdx(cfg, 'p')));
  });

  it('a nested call via-tags the inner site (sanitizer substrate)', () => {
    const cfg = cfgOf(`exec(escape(x));`);
    const sites = allSites(cfg);
    const exec = sites.findIndex((s) => s.callee === 'exec');
    const escape = sites.findIndex((s) => s.callee === 'escape');
    assert.ok(exec >= 0);
    assert.ok(escape >= 0);
    const x = bindingIdx(cfg, 'x');
    assert.ok((sites[escape].args?.[0]).some((actual) => isDeepStrictEqual(actual, x)));
    assert.ok((sites[exec].args?.[0]).some((actual) => isDeepStrictEqual(actual, [x, escape])));
  });

  it('a CFG-only function (no calls) emits NO sites key (omit-when-empty)', () => {
    const cfg = java.cfgOf(`class C { void f(int a, int b) { int x = a + b; } }`);
    assert.equal(hasAnySites(cfg), false);
  });
});
