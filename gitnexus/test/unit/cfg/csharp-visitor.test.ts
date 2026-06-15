import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createCsharpCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/csharp.js';
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
import { augmentForPostDom } from '../../../src/core/ingestion/cfg/synthetic-escape.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';

// U3 — the C# CfgVisitor, one hazard per test (KTD5: real-parser regression,
// NOT snapshot-pinning). Each fixture's distinctive statement text (step(),
// done(), handle(e), …) lets us locate the block for a region by text and assert
// the control-flow topology around it.

// tree-sitter-c-sharp declares `main: "bindings/node"` (no extension) — load the
// explicit subpath, mirroring parser-loader.ts (#1013).
const csGrammar = createRequire(import.meta.url)(
  'tree-sitter-c-sharp/bindings/node/index.js',
) as Parameters<typeof makeCfgHarness>[0];

const cs: CfgHarness = makeCfgHarness(csGrammar, createCsharpCfgVisitor(), 'fixture.cs');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

const wrap = (body: string): string => `class C { void M(${''}) { ${body} } }`;

describe('C# CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = cs.cfgOf(`class C { void M() { a(); b(); c(); } }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = cs.cfgOf(`class C { void M() {} }`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('expression-bodied method: single block returns its value', () => {
    const cfg = cs.cfgOf(`class C { int M(int n) => n * 2; }`);
    const body = block(cfg, 'n * 2');
    expect(cfg.edges).toContainEqual({ from: body, to: cfg.exitIndex, kind: 'return' });
  });

  it('constructor and local function are CFG-bearing functions', () => {
    const cfgs = cs.cfgsOf(
      `class C { C(int a) { x = a; } void Outer() { int L(int z) { return z; } L(1); } }`,
    );
    // constructor C, Outer, and the local function L = 3 CFGs.
    expect(cfgs.length).toBeGreaterThanOrEqual(3);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('unmodeled member shape (no body) → graceful partial, no throw', () => {
    // An abstract method has no body block → buildFunctionCfg returns undefined,
    // never throws; a property (not a function) is not collected at all.
    const root = cs.parse(`abstract class C { public abstract void M(); int P => 1; }`);
    const fns = cs.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createCsharpCfgVisitor().buildFunctionCfg(fn, 'f.cs')).not.toThrow();
    }
  });
});

describe('C# CfgVisitor — branching', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = cs.cfgOf(wrap(`if (x > 0) { a(); } else { b(); } c();`).replace('M()', 'M(int x)'));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
  });

  it('else if chains through the nested alternative (no else_clause wrapper)', () => {
    const cfg = cs.cfgOf(
      `class C { void M(int x) { if (x > 0) { a(); } else if (x < 0) { b(); } else { c(); } } }`,
    );
    // all three arms reach EXIT; the else-if condition is its own block.
    expect(reaches(cfg, block(cfg, 'a();'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c();'), cfg.exitIndex)).toBe(true);
  });
});

describe('C# CfgVisitor — loops', () => {
  it('while loop: header + back-edge + exit', () => {
    const cfg = cs.cfgOf(`class C { void M(int x) { while (x > 0) { step(); } done(); } }`);
    const header = block(cfg, 'x > 0');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = cs.cfgOf(`class C { void M(int x) { do { step(); } while (x > 0); done(); } }`);
    const body = block(cfg, 'step();');
    const cond = block(cfg, 'x > 0');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(reaches(cfg, body, cond)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done();'))).toBe(true);
  });

  it('C-style for: init once, condition header, back-edge through update', () => {
    const cfg = cs.cfgOf(
      `class C { void M(int n) { for (int i = 0; i < n; i++) { step(); } done(); } }`,
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

  it('foreach: header + body + loop-back + exit; loop var is a def, source a use', () => {
    const cfg = cs.cfgOf(
      `class C { void M(int[] xs) { foreach (var x in xs) { use(x); } done(); } }`,
    );
    const body = block(cfg, 'use(x);');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done();'))).toBe(true);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = cs.cfgOf(`class C { void M(bool x) { while (true) { if (x) { g(); } } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('for (;;) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = cs.cfgOf(`class C { void M(bool x) { for (;;) { if (x) { g(); } } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('C# CfgVisitor — switch', () => {
  it('switch_statement: cases dispatch, break-terminated case rejoins after', () => {
    const cfg = cs.cfgOf(`class C { void M(int x) {
      switch (x) {
        case 1: one(); break;
        case 2: two(); break;
        default: other(); break;
      }
      after();
    } }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'after();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two();'), block(cfg, 'after();'))).toBe(true);
    // break-terminated case 1 does not fall into case 2.
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(false);
  });

  it('empty case section falls through to the next section', () => {
    const cfg = cs.cfgOf(`class C { void M(int x) {
      switch (x) { case 1: case 2: shared(); break; default: d(); break; }
      after();
    } }`);
    // case 1 (empty) reaches the shared body.
    expect(reaches(cfg, block(cfg, 'shared();'), block(cfg, 'after();'))).toBe(true);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
  });

  it('return switch_expression: each arm dispatches and returns the result (#2207)', () => {
    const cfg = cs.cfgOf(
      `class C { int M(int x) { return x switch { 1 => a(), 2 => b(), _ => c() }; } }`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    // every arm reaches EXIT (its value IS the returned result).
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
    // a() does NOT fall into b() (arms never fall through).
    expect(reaches(cfg, block(cfg, 'a()'), block(cfg, 'b()'))).toBe(false);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('value-position switch declaration is modeled, def bound at the join (#2207)', () => {
    const cfg = cs.cfgOf(
      `class C { int M(int x) { var y = x switch { 1 => a(), _ => b() }; use(y); return 0; } }`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // each arm rejoins and reaches the downstream use of the bound result.
    expect(reaches(cfg, block(cfg, 'a()'), block(cfg, 'use(y);'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), block(cfg, 'use(y);'))).toBe(true);
    const y = bindingIdx(cfg, 'y');
    expect(hasDef(cfg, y)).toBe(true);
    expect(hasUse(cfg, y)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('expression-bodied member `=> k switch {…}` models the arms (#2207)', () => {
    const cfg = cs.cfgOf(`class C { int G(int x) => x switch { 1 => a(), _ => b() }; }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('assignment-RHS / single-arm value switch stays inline (documented gap)', () => {
    const assign = cs.cfgOf(
      `class C { int M(int x) { int y = 0; y = x switch { 1 => 1, _ => 2 }; return y; } }`,
    );
    expect(edgeKinds(assign).has('switch-case')).toBe(false);
    expect(reaches(assign, assign.entryIndex, assign.exitIndex)).toBe(true);

    const oneArm = cs.cfgOf(`class C { int M(int x) { var y = x switch { _ => 0 }; return y; } }`);
    expect(edgeKinds(oneArm).has('switch-case')).toBe(false);
  });

  it('non-exhaustive switch expression (no `_` arm) keeps a no-match edge (EXIT reachable) (#2211)', () => {
    const cfg = cs.cfgOf(
      `class C { int M(int x) { var y = x switch { 1 => a(), 2 => b() }; return y; } }`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    // 2 arms + the conservative no-match path = 3 switch-case successors from the dispatch.
    const dispatchIdx = block(cfg, 'x');
    expect(cfg.edges.filter((e) => e.from === dispatchIdx && e.kind === 'switch-case').length).toBe(
      3,
    );
  });
});

describe('C# CfgVisitor — using / lock (deterministic finalizer)', () => {
  it('using runs the body then dispose on the NORMAL exit path', () => {
    const cfg = cs.cfgOf(`class C { void M() { using (var f = Open()) { read(f); } after(); } }`);
    const body = block(cfg, 'read(f);');
    const dispose = block(cfg, 'dispose');
    // body → dispose → after()  (normal completion threads through the dispose).
    expect(reaches(cfg, body, dispose)).toBe(true);
    expect(reaches(cfg, dispose, block(cfg, 'after();'))).toBe(true);
  });

  it('using disposes on the EXCEPTION path too (throw routes through dispose)', () => {
    const cfg = cs.cfgOf(`class C { void M() { using (var f = Open()) { risky(f); } } }`);
    const body = block(cfg, 'risky(f);');
    const dispose = block(cfg, 'dispose');
    // a throw in the protected body reaches the dispose finalizer.
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    expect(reaches(cfg, body, dispose)).toBe(true);
  });

  it('a return inside using crosses the dispose (finally-return completion edge)', () => {
    const cfg = cs.cfgOf(`class C { int M() { using (var f = Open()) { return read(f); } } }`);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });

  it('using var (C# 8 declaration form) disposes at enclosing-scope exit (#2206)', () => {
    const cfg = cs.cfgOf(`class C { void M() { using var f = Open(); read(f); } }`);
    const dispose = block(cfg, 'dispose');
    // the rest of the scope (read(f)) is protected; dispose runs at the end and on
    // the exception path.
    expect(reaches(cfg, block(cfg, 'read(f);'), dispose)).toBe(true);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
  });

  it('a return after a using var declaration crosses the dispose (finally-return, #2206)', () => {
    const cfg = cs.cfgOf(`class C { int M() { using var f = Open(); return read(f); } }`);
    expect(block(cfg, 'dispose')).toBeGreaterThanOrEqual(0);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });

  it('lock body runs then releases the monitor (finalizer semantics)', () => {
    const cfg = cs.cfgOf(`class C { void M(object sync) { lock (sync) { touch(); } after(); } }`);
    const body = block(cfg, 'touch();');
    const release = block(cfg, 'release');
    expect(reaches(cfg, body, release)).toBe(true);
    expect(reaches(cfg, release, block(cfg, 'after();'))).toBe(true);
  });
});

describe('C# CfgVisitor — try/catch/finally completion edges', () => {
  it('try/catch: a throw edge runs from each protected block to the handler', () => {
    const cfg = cs.cfgOf(`class C { void M() {
      try { risky(); deeper(); } catch (System.Exception e) { handle(e); }
      after();
    } }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e);');
    expect(reaches(cfg, block(cfg, 'risky();'), handler)).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('finally runs on normal completion of the try', () => {
    const cfg = cs.cfgOf(`class C { void M() {
      try { work(); } finally { cleanup(); }
      after();
    } }`);
    const body = block(cfg, 'work();');
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, body, fin)).toBe(true);
    expect(reaches(cfg, fin, block(cfg, 'after();'))).toBe(true);
  });

  it('return crossing a finally emits a finally-return completion edge', () => {
    const cfg = cs.cfgOf(`class C { int M() {
      try { return compute(); } finally { cleanup(); }
    } }`);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });

  it('break crossing a finally emits a finally-break completion edge', () => {
    const cfg = cs.cfgOf(`class C { void M(int n) {
      for (int i = 0; i < n; i++) {
        try { if (done()) break; } finally { tick(); }
      }
      after();
    } }`);
    expect(edgeKinds(cfg).has('finally-break')).toBe(true);
  });
});

describe('C# CfgVisitor — goto / labels', () => {
  it('backward goto wires to an already-seen label block', () => {
    const cfg = cs.cfgOf(
      `class C { void M() { int i = 0; top: work(); i++; if (i < 10) goto top; done(); } }`,
    );
    const gotoB = block(cfg, 'goto top;');
    const label = block(cfg, 'work();');
    expect(reaches(cfg, gotoB, label)).toBe(true);
    expect(cfg.edges.some((e) => e.from === gotoB && e.to === label)).toBe(true);
  });

  it('forward goto wires to a label that appears later', () => {
    const cfg = cs.cfgOf(`class C { void M(int x) { if (x > 0) goto end; work(); end: done(); } }`);
    const gotoB = block(cfg, 'goto end;');
    const label = block(cfg, 'done();');
    expect(reaches(cfg, gotoB, label)).toBe(true);
    expect(reachable(cfg, block(cfg, 'work();'))).toBe(true);
  });

  // #2197 U1 — an UNCONDITIONAL goto-cycle traps EXIT (the `goto start` has no
  // exit path); the synthetic-escape pass bridges it so CDG is emitted instead
  // of withheld. The conditional goto tests above already had an exit path.
  it('unconditional goto-cycle: bridged → EXIT reachable AND CDG emitted', () => {
    const cfg = cs.cfgOf(`class K { void handler(int a){ start: if(a>0){work();} goto start; } }`);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false); // trapped without the pass
    const view = augmentForPostDom(cfg);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
    expect(computeControlDependence(view).edges.length).toBeGreaterThan(0);
  });
});

describe('C# CfgVisitor — yield', () => {
  it('yield break terminates the iterator (routes to EXIT)', () => {
    const cfg = cs.cfgOf(`class C { System.Collections.Generic.IEnumerable<int> G(int x) {
      if (x < 0) { yield break; }
      yield return x;
    } }`);
    const yb = block(cfg, 'yield break;');
    expect(reaches(cfg, yb, cfg.exitIndex)).toBe(true);
    // yield break terminates its block — does not fall into yield return.
    expect(reaches(cfg, yb, block(cfg, 'yield return x;'))).toBe(false);
  });

  it('yield return continues to the next statement', () => {
    const cfg = cs.cfgOf(`class C { System.Collections.Generic.IEnumerable<int> G() {
      yield return 1;
      done();
    } }`);
    const yr = block(cfg, 'yield return 1;');
    expect(reaches(cfg, yr, block(cfg, 'done();'))).toBe(true);
  });
});

describe('C# CfgVisitor — def/use harvest', () => {
  it('local declaration: int x = a + b; use(x); → def of x + use of x', () => {
    const cfg = cs.cfgOf(`class C { void M(int a, int b) { int x = a + b; use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('c ?? (c = load()) records c as a MAY-def, not a must-kill', () => {
    const cfg = cs.cfgOf(`class C { void M(string c) { var v = c ?? (c = load()); use(v); } }`);
    const c = bindingIdx(cfg, 'c');
    expect(hasMayDef(cfg, c)).toBe(true);
  });

  it('a && (x = f()) records x as a may-def inside the short-circuit', () => {
    const cfg = cs.cfgOf(`class C { void M(bool a) { int x = 0; if (a && (x = g()) > 0) h(x); } }`);
    const x = bindingIdx(cfg, 'x');
    expect(hasMayDef(cfg, x)).toBe(true);
  });

  it('compound assignment reads AND writes the lvalue', () => {
    const cfg = cs.cfgOf(`class C { void M() { int z = 1; z += 3; } }`);
    const z = bindingIdx(cfg, 'z');
    expect(hasDef(cfg, z)).toBe(true);
    expect(hasUse(cfg, z)).toBe(true);
  });

  it('out var n records n as a callee-written def (#2195 P1)', () => {
    const cfg = cs.cfgOf(`class C { void M(string s) { int.TryParse(s, out var n); use(n); } }`);
    const n = bindingIdx(cfg, 'n');
    expect(hasDef(cfg, n)).toBe(true);
    expect(hasUse(cfg, n)).toBe(true);
  });

  it('var (a, b) = T() deconstruction declaration defines BOTH a and b (#2195 P1)', () => {
    const cfg = cs.cfgOf(`class C { void M() { var (a, b) = T(); use(a); use(b); } }`);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });
});

describe('C# CfgVisitor — functionStartColumn', () => {
  it('two same-line methods get distinct functionStartColumn', () => {
    const cfgs = cs.cfgsOf(`class C { int A() { return 1; } int B() { return 2; } }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});

describe('C# CfgVisitor — does not throw on exotic shapes', () => {
  it('lambda / anonymous method bodies build their own CFGs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfgs = cs.cfgsOf(`class C { void M() {
        System.Func<int, int> f = x => { if (x > 0) { return x; } return 0; };
        System.Action h = delegate () { act(); };
        f(1); h();
      } }`);
      expect(cfgs.length).toBeGreaterThanOrEqual(3); // M, lambda, anon method
      for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a truncated value-position switch never throws out of the carrier path (R4) (#2211)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = cs.parse(`class C { int M(int x) { var y = x switch { 1 => a(`);
      for (const fn of cs.collectFunctions(root)) {
        expect(() => createCsharpCfgVisitor().buildFunctionCfg(fn, 'f.cs')).not.toThrow();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// U6 — call-site `sites[]` taint substrate. INERT BY DESIGN: no C# taint model
// is registered, so these sites produce zero TAINTED edges; they only give the
// deferred per-language source/sink model something to match against.
describe('C# CfgVisitor — call-site sites[] substrate', () => {
  const cfgOf = (body: string): FunctionCfg =>
    cs.cfgOf(`class C { void f(int cmd, int x, int a) { ${body} } }`);

  it('a bare invocation records a `call` site with callee name + arg occurrence', () => {
    const cfg = cfgOf(`Exec(cmd);`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'Exec');
    expect(site).toBeDefined();
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'cmd'));
  });

  it('a member invocation (`db.Query(x)`) records the receiver + dotted callee', () => {
    const cfg = cfgOf(`db.Query(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'db.Query');
    expect(site).toBeDefined();
    expect(site?.receiver).toBe(bindingIdx(cfg, 'db'));
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
  });

  it('`new Foo(x)` records a `new` site with the type as callee', () => {
    const cfg = cfgOf(`var p = new Foo(x);`);
    const site = allSites(cfg).find((s) => s.kind === 'new');
    expect(site?.callee).toBe('Foo');
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
    expect(site?.resultDefs).toContain(bindingIdx(cfg, 'p'));
  });

  it('a nested invocation via-tags the inner site (sanitizer substrate)', () => {
    const cfg = cfgOf(`Exec(Escape(x));`);
    const sites = allSites(cfg);
    const exec = sites.findIndex((s) => s.callee === 'Exec');
    const escape = sites.findIndex((s) => s.callee === 'Escape');
    expect(exec).toBeGreaterThanOrEqual(0);
    expect(escape).toBeGreaterThanOrEqual(0);
    const x = bindingIdx(cfg, 'x');
    expect(sites[escape].args?.[0]).toContainEqual(x);
    expect(sites[exec].args?.[0]).toContainEqual([x, escape]);
  });

  it('a CFG-only function (no calls) emits NO sites key (omit-when-empty)', () => {
    const cfg = cs.cfgOf(`class C { void f(int a, int b) { int x = a + b; } }`);
    expect(hasAnySites(cfg)).toBe(false);
  });
});
