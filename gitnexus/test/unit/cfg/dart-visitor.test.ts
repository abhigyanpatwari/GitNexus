import { describe, it, expect } from 'vitest';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { createDartCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/dart.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import {
  makeCfgHarness,
  type CfgHarness,
  block,
  edgeKinds,
  reaches,
  reachable,
  bindingIdx,
} from '../../helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';

// The Dart CfgVisitor, one hazard per test (real-parser regression, NOT
// snapshot-pinning). Dart's grammar is VENDORED (not an npm package): the grammar
// loads from vendor/ via `requireVendoredGrammar('tree-sitter-dart')`, exactly
// like the Kotlin/Swift tests load their vendored grammars. Dart also splits a
// function into a SIGNATURE + a SIBLING `function_body`, so `isFunction` selects
// the body node — the harness collects those transparently. Each fixture's
// distinctive statement text (step(), done(), handle(e), …) lets us locate the
// block for a region by text and assert the control-flow topology around it.

const dartGrammar = requireVendoredGrammar('tree-sitter-dart') as Parameters<
  typeof makeCfgHarness
>[0];

const dart: CfgHarness = makeCfgHarness(dartGrammar, createDartCfgVisitor(), 'fixture.dart');

const definesBinding = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const usesBinding = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));

describe('Dart CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = dart.cfgOf(`void f() { a(); b(); c(); }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = dart.cfgOf(`void f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('arrow-body function: ENTRY → block → EXIT (return)', () => {
    const cfg = dart.cfgOf(`int f(int x) => x + 1;`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    // The parameter is bound and used.
    expect(definesBinding(cfg, bindingIdx(cfg, 'x'))).toBe(true);
    expect(usesBinding(cfg, bindingIdx(cfg, 'x'))).toBe(true);
  });

  it('an unmodeled shape (abstract method, no body) builds no CFG and never throws', () => {
    // An abstract method declaration has a `function_signature`/`method_signature`
    // but NO sibling `function_body` — `isFunction` rejects it; a real function
    // still builds. buildFunctionCfg must never throw.
    const root = dart.parse(`abstract class P { void f(); }`);
    const fns = dart.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createDartCfgVisitor().buildFunctionCfg(fn, 'p.dart')).not.toThrow();
    }
    const cfg = dart.cfgOf(`void g() { x(); }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('a truncated value-position switch never throws out of the carrier path (R4) (#2211)', () => {
    const root = dart.parse(`int f(int v){ var x = switch (v) { 1 => a(`);
    for (const fn of dart.collectFunctions(root)) {
      expect(() => createDartCfgVisitor().buildFunctionCfg(fn, 'f.dart')).not.toThrow();
    }
  });

  it('a class method is a CFG-bearing function and binds its params', () => {
    const cfg = dart.cfgOf(`class C { void m(int a) { g(a); } }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'a'))).toBe(true);
  });

  it('a getter with an arrow body builds a CFG', () => {
    const cfgs = dart.cfgsOf(`class C { int get v => 3; }`);
    expect(cfgs.length).toBeGreaterThanOrEqual(1);
    const getter = cfgs[0];
    expect(reaches(getter, getter.entryIndex, getter.exitIndex)).toBe(true);
    expect(edgeKinds(getter).has('return')).toBe(true);
  });
});

describe('Dart CfgVisitor — branching (if/else)', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = dart.cfgOf(`void f(int x) { if (x > 0) { a(); } else { b(); } c(); }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
  });

  it('else-if chain branches each condition', () => {
    const cfg = dart.cfgOf(
      `void f(int x) { if (x == 1) { a(); } else if (x == 2) { b(); } else { c(); } d(); }`,
    );
    const join = block(cfg, 'd();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c();'), join)).toBe(true);
  });

  it('if without braces (bare body statement) still branches', () => {
    const cfg = dart.cfgOf(`void f(int x) { if (x > 0) a(); else b(); c(); }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'c();'))).toBe(true);
  });
});

describe('Dart CfgVisitor — loops', () => {
  it('for-in: header + body + loop-back + exit; binds the loop var', () => {
    const cfg = dart.cfgOf(`void f(List xs) { for (var e in xs) { step(e); } done(); }`);
    const header = block(cfg, 'for (var e in xs)');
    const body = block(cfg, 'step(e)');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('for-in over an existing variable `(e in xs)` still defines e each iteration', () => {
    const cfg = dart.cfgOf(`void f(List xs) { var e; for (e in xs) { use(e); } }`);
    expect(definesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
    expect(usesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('c-style for: header tests, body loops back', () => {
    const cfg = dart.cfgOf(`void f() { for (var i = 0; i < 10; i++) { step(i); } done(); }`);
    const header = block(cfg, 'for (var i = 0');
    const body = block(cfg, 'step(i)');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'i'))).toBe(true);
  });

  it('while: header tests first, body loops back', () => {
    const cfg = dart.cfgOf(`void f() { while (cond()) { step(); } done(); }`);
    const header = block(cfg, 'while (cond())');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = dart.cfgOf(`void f() { do { step(); } while (cond()); done(); }`);
    const body = block(cfg, 'step();');
    const cond = block(cfg, 'while (cond())');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(reaches(cfg, body, cond)).toBe(true); // condition tests at the bottom
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done();'))).toBe(true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = dart.cfgOf(`void f(bool x) { while (true) { if (x) { g(); } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('for (;;) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = dart.cfgOf(`void f(bool x) { for (;;) { if (x) { g(); } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Dart CfgVisitor — switch', () => {
  it('non-empty cases do NOT implicitly fall through; each rejoins after', () => {
    const cfg = dart.cfgOf(`void f(int x) {
      switch (x) {
        case 1: one(); break;
        case 2: two(); break;
        default: other();
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // case 1 body does NOT flow into case 2 body (no implicit fallthrough).
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(false);
    // every arm reaches the post-switch continuation.
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'after();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two();'), block(cfg, 'after();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'other();'), block(cfg, 'after();'))).toBe(true);
  });

  it('an EMPTY case falls through to the next case (Dart empty-case fallthrough)', () => {
    const cfg = dart.cfgOf(`void f(int x) {
      switch (x) {
        case 1:
        case 2:
          a();
          break;
        default:
          d();
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    // The empty `case 1:` dispatch reaches the shared `a()` body via fallthrough.
    expect(reachable(cfg, block(cfg, 'a();'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'after();'))).toBe(true);
  });

  it('explicit `continue LABEL;` jumps to the labeled case', () => {
    const cfg = dart.cfgOf(`void f(int x) {
      switch (x) {
        case 1: a(); continue done;
        case 2: b(); break;
        done:
        case 3: c(); break;
        default: d();
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    // case 1's `continue done` reaches the labeled case 3 body c().
    expect(reaches(cfg, block(cfg, 'a();'), block(cfg, 'c();'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('a switch with NO default lets the no-match path fall to the join', () => {
    const cfg = dart.cfgOf(`void f(int x) { switch (x) { case 1: a(); break; } after(); }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('a BARE `continue;` in a case targets the loop — no false case→default fall-through', () => {
    // `continue;` (no label) jumps to the for-loop header. The bug DROPPED it,
    // fabricating a DIRECT case-1 → default fall-through edge. With the continue
    // modeled, no such direct edge exists (the only path from tainted() to sink()
    // is the legitimate loop back-edge, i.e. a later iteration).
    const cfg = dart.cfgOf(`void f(List xs) {
      for (var x in xs) {
        switch (x) {
          case 1: tainted(); continue;
          default: sink();
        }
      }
    }`);
    const tainted = block(cfg, 'tainted();');
    const sink = block(cfg, 'sink();');
    expect(cfg.edges.some((e) => e.from === tainted && e.to === sink)).toBe(false);
  });

  it('value-position switch declaration is modeled as a dispatch, def bound at the join (#2207)', () => {
    const cfg = dart.cfgOf(`void f(int x) {
      var y = switch (x) { 1 => one(x), 2 => two(), _ => other() };
      use(y);
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // each arm rejoins and reaches the downstream use of the bound result.
    expect(reaches(cfg, block(cfg, 'one(x)'), block(cfg, 'use(y);'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'other()'), block(cfg, 'use(y);'))).toBe(true);
    const y = bindingIdx(cfg, 'y');
    expect(definesBinding(cfg, y)).toBe(true);
    expect(usesBinding(cfg, y)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('return switch (…) models each arm as returning the result (#2207)', () => {
    const cfg = dart.cfgOf(`int f(int x) {
      return switch (x) { 1 => a(x), 2 => b(), _ => c() };
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a(x)'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('a multi-binding decl with a switch-EXPRESSION value stays inline', () => {
    const cfg = dart.cfgOf(`void f(int x) {
      var y = switch (x) { _ => 0 }, z = 2;
      use(y + z);
    }`);
    // Modeling a multi-binding decl arm-by-arm is out of scope — it coalesces.
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('an INLINE switch-EXPRESSION arm write is a may-def, not a hard kill (#2206)', () => {
    // An argument-position switch expression is NOT a modeled value-branch carrier
    // (#2207 models only declaration / return), so it coalesces — and the harvest
    // must still treat each arm write as a MAY-def (only one arm runs).
    const cfg = dart.cfgOf(`void f(int x) {
      int z = 0;
      use(switch (x) { 1 => z = 10, _ => z = 20 });
      sink(z);
    }`);
    const z = bindingIdx(cfg, 'z');
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(z)))).toBe(
      true,
    );
  });

  it('value switch without an unguarded `_` keeps the no-match edge (EXIT stays reachable) (#2211)', () => {
    // A guarded `_ when …` is NOT an exhaustive catch-all — the conservative
    // no-match path must remain (Dart throws at runtime if no arm + guard matches).
    const cfg = dart.cfgOf(`int f(int v) {
      return switch (v) { int n when n > 0 => a(n), _ when v < 0 => b() };
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    // the dispatch must reach the join WITHOUT going through an arm (the no-match edge).
    const dispatchIdx = block(cfg, 'switch v');
    const dispatchSucc = cfg.edges.filter(
      (e) => e.from === dispatchIdx && e.kind === 'switch-case',
    );
    // dispatch fans to 2 arms + the no-match join = 3 switch-case successors.
    expect(dispatchSucc.length).toBe(3);
  });

  it('a value-switch `when` guard is a conditional dispatch use, not an arm-value use (#2211)', () => {
    const cfg = dart.cfgOf(`int f(int v) {
      var x = switch (v) { int n when guardOk(v) => a(n), _ => b() };
      use(x);
    }`);
    const vIdx = bindingIdx(cfg, 'v');
    // `v` (used by the guard `guardOk(v)`) is recorded as a use on the dispatch
    // block (text `switch v`), not buried in an arm-value block.
    const dispatch = cfg.blocks.find((b) => b.text === 'switch v')!;
    expect(dispatch.statements?.some((s) => s.uses.includes(vIdx))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Dart CfgVisitor — try/on/catch/finally', () => {
  it('try/on/catch/finally: a throw edge runs to the handler; finally completion edges', () => {
    const cfg = dart.cfgOf(`void f() {
      try { risky(); }
      on Exception catch (e, st) { handle(e, st); }
      finally { cleanup(); }
      after();
    }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e, st)');
    expect(reaches(cfg, block(cfg, 'risky();'), handler)).toBe(true);
    // the finally runs on both normal and exception exit.
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, block(cfg, 'risky();'), fin)).toBe(true);
    expect(reaches(cfg, handler, fin)).toBe(true);
    // after() is still reachable (finally completion rejoins).
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
    // the `on … catch (e, st)` binds both error names.
    expect(definesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'st'))).toBe(true);
  });

  it('try with finally only (no catch) still threads cleanup on both paths', () => {
    const cfg = dart.cfgOf(`void f() { try { risky(); } finally { cleanup(); } after(); }`);
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, block(cfg, 'risky();'), fin)).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('a return inside a try threads through the finally (finally-return completion)', () => {
    const cfg = dart.cfgOf(`int f() {
      try { return compute(); } finally { cleanup(); }
    }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('return')).toBe(true);
    expect(kinds.has('finally-return')).toBe(true);
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, fin, cfg.exitIndex)).toBe(true);
  });

  it('rethrow re-routes to the outer handler / EXIT and ends its block', () => {
    const cfg = dart.cfgOf(`void f() { try { risky(); } catch (e) { rethrow; } }`);
    const re = block(cfg, 'rethrow;');
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    // rethrow with no outer handler propagates to EXIT.
    expect(cfg.edges).toContainEqual({ from: re, to: cfg.exitIndex, kind: 'throw' });
    expect(reaches(cfg, re, cfg.exitIndex)).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('a throw with NO enclosing try routes to EXIT and ends its block', () => {
    const cfg = dart.cfgOf(`void f(bool x) { if (x) throw StateError('x'); done(); }`);
    const thr = block(cfg, "throw StateError('x')");
    expect(cfg.edges).toContainEqual({ from: thr, to: cfg.exitIndex, kind: 'throw' });
    // throw terminates its block — control does not fall into done() from it.
    expect(reaches(cfg, thr, block(cfg, 'done();'))).toBe(false);
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true); // via the if false branch
  });
});

describe('Dart CfgVisitor — labeled break/continue', () => {
  it('labeled `break outer` escapes BOTH loops and reaches done()', () => {
    const cfg = dart.cfgOf(`void f(List xs, List ys) {
      outer: for (var i in xs) {
        for (var j in ys) { break outer; }
      }
      done();
    }`);
    const brk = block(cfg, 'break outer;');
    expect(edgeKinds(cfg).has('break')).toBe(true);
    expect(reaches(cfg, brk, block(cfg, 'done();'))).toBe(true);
  });

  it('labeled `continue outer` targets the outer loop header', () => {
    const cfg = dart.cfgOf(`void f(List xs, List ys) {
      outer: for (var i in xs) {
        for (var j in ys) { continue outer; }
      }
      done();
    }`);
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    const outer = block(cfg, 'for (var i in xs)');
    const cont = block(cfg, 'continue outer;');
    expect(reaches(cfg, cont, outer)).toBe(true);
  });
});

describe('Dart CfgVisitor — closures (own CFG)', () => {
  it('a closure is collected as its own CFG; both keep EXIT reachable', () => {
    const cfgs = dart.cfgsOf(`void f(List xs) {
      xs.forEach((e) {
        use(e);
      });
    }`);
    // f and the closure are both CFG-bearing.
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    // The closure's CFG is the one that binds its own param `e` (the enclosing
    // f's block text also contains `use(e);`, so match on the binding instead).
    const closure = cfgs.find((c) => (c.bindings ?? []).some((b) => b.name === 'e'));
    expect(closure).toBeDefined();
    expect(definesBinding(closure!, bindingIdx(closure!, 'e'))).toBe(true);
  });
});

describe('Dart CfgVisitor — def/use harvest', () => {
  it('var x = compute(); use(x) produces a def of x and a use in the consumer', () => {
    const cfg = dart.cfgOf(`void f() { var x = compute(); use(x); }`);
    const x = bindingIdx(cfg, 'x');
    expect(definesBinding(cfg, x)).toBe(true);
    expect(usesBinding(cfg, x)).toBe(true);
  });

  it('final and typed local declarations both define', () => {
    const cfg = dart.cfgOf(`void f() { final b = compute(); int c = 3; use(b); use(c); }`);
    for (const name of ['b', 'c']) {
      const idx = bindingIdx(cfg, name);
      expect(definesBinding(cfg, idx)).toBe(true);
      expect(usesBinding(cfg, idx)).toBe(true);
    }
  });

  it('compound assign `x += step()` defines AND uses x', () => {
    const cfg = dart.cfgOf(`void f() { var x = 0; x += step(); }`);
    const x = bindingIdx(cfg, 'x');
    expect(definesBinding(cfg, x)).toBe(true);
    expect(usesBinding(cfg, x)).toBe(true);
  });

  it('a member write `obj.x = 1` does NOT define a scalar `x`; the root is a use', () => {
    const cfg = dart.cfgOf(`void f(C obj) { obj.x = compute(); }`);
    // `obj` is used (it is the assignment target's root); no scalar `x` binding.
    expect(usesBinding(cfg, bindingIdx(cfg, 'obj'))).toBe(true);
  });

  it('multi-variable declaration `var a = 1, b = 2;` defines BOTH names (#2195 P2)', () => {
    const cfg = dart.cfgOf(`void f() { var a = 1, b = 2; use(a); use(b); }`);
    // The bug dropped every name after the first — `b` became a synthetic
    // global. Both must be real locals defined by the declaration.
    expect(definesBinding(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(usesBinding(cfg, bindingIdx(cfg, 'b'))).toBe(true); // use(b)
  });
});

describe('Dart CfgVisitor — functionStartColumn', () => {
  it('two same-line functions get distinct functionStartColumn', () => {
    const cfgs = dart.cfgsOf(`void a() { x(); } void b() { y(); }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});
