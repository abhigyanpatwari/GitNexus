import { describe, it, expect } from 'vitest';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { createSwiftCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/swift.js';
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

// The Swift CfgVisitor, one hazard per test (real-parser regression, NOT
// snapshot-pinning). Swift's grammar is VENDORED (not an npm package): the
// grammar loads from vendor/ via `requireVendoredGrammar('tree-sitter-swift')`,
// exactly like the C/C++ test loads the vendored tree-sitter-c. Each fixture's
// distinctive statement text (step(), done(), handle(e), …) lets us locate the
// block for a region by text and assert the control-flow topology around it.

const swiftGrammar = requireVendoredGrammar('tree-sitter-swift') as Parameters<
  typeof makeCfgHarness
>[0];

const swift: CfgHarness = makeCfgHarness(swiftGrammar, createSwiftCfgVisitor(), 'fixture.swift');

describe('Swift CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = swift.cfgOf(`func f() { a(); b(); c() }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = swift.cfgOf(`func f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('an unmodeled shape produces a graceful partial CFG (never throws)', () => {
    // A protocol method requirement (`func f()`) has no body — buildFunctionCfg
    // must return undefined rather than throw; a real function still builds.
    const root = swift.parse(`protocol P { func f() }`);
    const fns = swift.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createSwiftCfgVisitor().buildFunctionCfg(fn, 'p.swift')).not.toThrow();
    }
    // A normal function still builds a well-formed CFG.
    const cfg = swift.cfgOf(`func g() { x() }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('a truncated value-position if never throws out of the carrier path (R4) (#2211)', () => {
    const root = swift.parse(`func f(v: Int) { let x = if v > 0 {`);
    for (const fn of swift.collectFunctions(root)) {
      expect(() => createSwiftCfgVisitor().buildFunctionCfg(fn, 'f.swift')).not.toThrow();
    }
  });

  it('init and deinit are CFG-bearing functions', () => {
    const cfgs = swift.cfgsOf(`class C { init(x: Int) { self.x = x } ; deinit { cleanup() } }`);
    expect(cfgs).toHaveLength(2);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });
});

describe('Swift CfgVisitor — branching', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = swift.cfgOf(`func f(x: Int) { if x > 0 { a() } else { b() } ; c() }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
  });

  it('else-if chain branches each condition', () => {
    const cfg = swift.cfgOf(
      `func f(x: Int) { if x == 1 { a() } else if x == 2 { b() } else { c() } ; d() }`,
    );
    const join = block(cfg, 'd()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), join)).toBe(true);
  });

  it('if let binds the optional and reaches both arms', () => {
    const cfg = swift.cfgOf(`func f(opt: Int?) { if let y = opt { use(y) } ; after() }`);
    // `y` is a binding defined by the optional binding.
    const y = bindingIdx(cfg, 'y');
    const defined = cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(y)));
    expect(defined).toBe(true);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reachable(cfg, block(cfg, 'use(y)'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'after()'))).toBe(true);
  });
});

describe('Swift CfgVisitor — guard', () => {
  it('guard let ... else { return }: the else DIVERGES, the body CONTINUES', () => {
    const cfg = swift.cfgOf(
      `func f(opt: Int?) -> Int { guard let y = opt else { return 0 } ; use(y) ; return y }`,
    );
    const header = block(cfg, 'guard');
    const elseBlk = block(cfg, 'return 0');
    // The else is the cond-false (diverging) arm and returns.
    expect(cfg.edges).toContainEqual({ from: header, to: elseBlk, kind: 'cond-false' });
    expect(reaches(cfg, elseBlk, cfg.exitIndex)).toBe(true);
    // The guarded body continues straight-line on the success path.
    expect(reaches(cfg, header, block(cfg, 'use(y)'))).toBe(true);
    // `y` is bound by the guard and used after it.
    const y = bindingIdx(cfg, 'y');
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(y)))).toBe(true);
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(y)))).toBe(true);
  });

  it('guard case .some(let v) binds v as a real local def, not a synthetic global (#2206)', () => {
    const cfg = swift.cfgOf(
      `func f(e: E) { guard case .some(let v) = e else { return } ; use(v) }`,
    );
    const v = bindingIdx(cfg, 'v');
    // The case-pattern binder must be a real local with a def (or may-def) from
    // the matched subject — previously it resolved to a synthetic global with only
    // a use, which silently breaks taint propagation from the subject.
    const defined = cfg.blocks.some((bl) =>
      bl.statements?.some((s) => s.defs.includes(v) || (s.mayDefs ?? []).includes(v)),
    );
    expect(defined).toBe(true);
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(v)))).toBe(true);
  });
});

describe('Swift CfgVisitor — loops', () => {
  it('for-in: header + body + loop-back + exit', () => {
    const cfg = swift.cfgOf(`func f() { for item in items { step() } ; done() }`);
    const header = block(cfg, 'for item in items');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
    // The loop pattern binds `item`.
    const item = bindingIdx(cfg, 'item');
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(item)))).toBe(true);
  });

  it('while: header tests first, body loops back', () => {
    const cfg = swift.cfgOf(`func f() { while cond() { step() } ; done() }`);
    const header = block(cfg, 'while cond()');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
  });

  it('repeat-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = swift.cfgOf(`func f() { repeat { step() } while cond() ; done() }`);
    const body = block(cfg, 'step()');
    const cond = block(cfg, 'while cond()');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(reaches(cfg, body, cond)).toBe(true); // condition tests at the bottom
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done()'))).toBe(true);
  });

  it('while true {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = swift.cfgOf(`func f(x: Bool) { while true { if x { g() } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('repeat {} while true keeps EXIT reverse-reachable', () => {
    const cfg = swift.cfgOf(`func f() { repeat { work() } while true }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });
});

describe('Swift CfgVisitor — switch (no implicit fallthrough)', () => {
  it('a case without fallthrough rejoins after the switch (no fall into next case)', () => {
    const cfg = swift.cfgOf(`func f(x: Int) {
      switch x {
      case 1: one()
      case 2: two()
      default: other()
      }
      after()
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // case 1 does NOT fall into case 2 (Swift has no implicit fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
    // every case reaches the post-switch continuation.
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
  });

  it('an explicit `fallthrough` spills into the next case', () => {
    const cfg = swift.cfgOf(`func f(x: Int) {
      switch x {
      case 1:
        one()
        fallthrough
      case 2:
        two()
      default:
        other()
      }
      after()
    }`);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    // case 1 (explicit fallthrough) FALLS THROUGH into case 2.
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(true);
  });

  it('a `where` guard on a case is harvested onto the dispatch block', () => {
    const cfg = swift.cfgOf(`func f(x: Int) {
      switch x {
      case let n where n > 0: pos()
      default: other()
      }
    }`);
    // `x` (the subject) is used at the dispatch; the where guard uses are harvested.
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reachable(cfg, block(cfg, 'pos()'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'other()'))).toBe(true);
  });
});

describe('Swift CfgVisitor — value-position if/switch (Swift 5.9, #2207)', () => {
  const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
    cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
  const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
    cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));

  it('`let x = if … else …` is modeled as a branch; def bound at the join', () => {
    const cfg = swift.cfgOf(`func f(v: Int) {
      let x = if v > 0 { hi() } else { lo() }
      use(x)
    }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(reaches(cfg, block(cfg, 'hi()'), block(cfg, 'use(x)'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'lo()'), block(cfg, 'use(x)'))).toBe(true);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('`let y = switch v { … }` is modeled as a dispatch', () => {
    const cfg = swift.cfgOf(`func f(v: Int) {
      let y = switch v { case 1: one() ; default: other() }
      use(y)
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'use(y)'))).toBe(true);
    const y = bindingIdx(cfg, 'y');
    expect(hasDef(cfg, y)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('`return if … else …` models each arm as returning the result', () => {
    const cfg = swift.cfgOf(`func f(v: Int) -> Int {
      return if v > 0 { a() } else { b() }
    }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), cfg.exitIndex)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('an else-less `if` value / plain binding stays inline (no real control dependence)', () => {
    // `let x = g()` is a plain binding — no branch.
    const cfg = swift.cfgOf(`func f(v: Int) { let x = g()\n use(x) }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(false);
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('a single-entry value switch stays inline (below the >= 2 modeling threshold) (#2211)', () => {
    // `isModelableValueBranch` requires >= 2 `switch_entry`; a one-entry value
    // switch carries no real control dependence, so the decl coalesces inline.
    const cfg = swift.cfgOf(`func f(v: Int) { let x = switch v { default: g() }\n use(x) }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Swift CfgVisitor — do/catch (error handling)', () => {
  it('do/catch: a throw edge runs from each protected block to the handler', () => {
    const cfg = swift.cfgOf(`func f() {
      do { try risky() ; deeper() } catch let e { handle(e) }
      after()
    }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e)');
    expect(reaches(cfg, block(cfg, 'try risky()'), handler)).toBe(true);
    // after() is still reachable (handler completion rejoins).
    expect(reachable(cfg, block(cfg, 'after()'))).toBe(true);
    // the catch binds the error `e`.
    const e = bindingIdx(cfg, 'e');
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(e)))).toBe(true);
  });

  it('a throw with NO enclosing do/catch routes to EXIT and ends its block', () => {
    const cfg = swift.cfgOf(`func f(x: Bool) throws { if x { throw E.bad } ; done() }`);
    const thr = block(cfg, 'throw E.bad');
    expect(cfg.edges).toContainEqual({ from: thr, to: cfg.exitIndex, kind: 'throw' });
    // throw terminates its block — control does not fall into done() from it.
    expect(reaches(cfg, thr, block(cfg, 'done()'))).toBe(false);
    expect(reachable(cfg, block(cfg, 'done()'))).toBe(true); // via the if false branch
  });

  it('multi-catch: EVERY catch handler is reachable from ENTRY (#2195)', () => {
    // The protected body can throw an error matching ANY clause, so the 2nd..Nth
    // catch must not be orphaned — the bug routed the throw edge only to the
    // first handler, leaving later handlers unreachable from ENTRY.
    const cfg = swift.cfgOf(`func f() { do { try r() } catch A { ha() } catch { hb() } }`);
    expect(reachable(cfg, block(cfg, 'ha()'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'hb()'))).toBe(true);
    // the protected `try r()` reaches both handlers.
    expect(reaches(cfg, block(cfg, 'try r()'), block(cfg, 'hb()'))).toBe(true);
  });
});

describe('Swift CfgVisitor — defer (LIFO scope-exit)', () => {
  it('a defer runs at scope exit: the return threads through the deferred block', () => {
    const cfg = swift.cfgOf(`func f() { defer { cleanup() } ; work() ; return }`);
    const kinds = edgeKinds(cfg);
    // The deferred completion threads as return + finally-return.
    expect(kinds.has('return')).toBe(true);
    const deferBlk = block(cfg, 'defer { cleanup() }');
    // The deferred block reaches EXIT (it runs on scope exit).
    expect(reaches(cfg, deferBlk, cfg.exitIndex)).toBe(true);
    // The explicit return reaches the deferred block.
    const ret = block(cfg, 'return');
    expect(reaches(cfg, ret, deferBlk)).toBe(true);
  });
});

describe('Swift CfgVisitor — labeled break/continue', () => {
  it('labeled break targets the OUTER loop, not the inner one', () => {
    const cfg = swift.cfgOf(`func f() {
      outer: for i in xs {
        for j in ys { break outer }
      }
      done()
    }`);
    const brk = block(cfg, 'break outer');
    expect(edgeKinds(cfg).has('break')).toBe(true);
    // the labeled break escapes BOTH loops and reaches done().
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
  });
});

describe('Swift CfgVisitor — def/use harvest', () => {
  it('let x = compute(); use(x) produces a def of x and a use in the consumer', () => {
    const cfg = swift.cfgOf(`func f() { let x = compute() ; use(x) }`);
    const x = bindingIdx(cfg, 'x');
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(x)))).toBe(true);
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(x)))).toBe(true);
  });

  it('tuple destructuring `let (a, b) = pair` defines both names', () => {
    const cfg = swift.cfgOf(`func f(pair: (Int, Int)) { let (a, b) = pair ; use(a) ; use(b) }`);
    for (const name of ['a', 'b']) {
      const idx = bindingIdx(cfg, name);
      expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)))).toBe(true);
    }
  });

  it('closures are collected as their own CFG (opaque in the enclosing function)', () => {
    const cfgs = swift.cfgsOf(`func f() { items.forEach { item in if item > 0 { use(item) } } }`);
    // f and the closure are both CFG-bearing.
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('switch `case let n` binds n as a (may-)def, not a synthetic global (#2195 P2)', () => {
    const cfg = swift.cfgOf(
      `func f(x: Int) { switch x { case let n where n > 0: use(n); default: break } }`,
    );
    const n = bindingIdx(cfg, 'n');
    // The case value-binding defines n (a may-def — the case may not match);
    // the bug left n a synthetic module binding with no def at all.
    const defined = cfg.blocks.some((bl) =>
      bl.statements?.some((s) => s.defs.includes(n) || (s.mayDefs ?? []).includes(n)),
    );
    expect(defined).toBe(true);
    // use(n) (and the `where n > 0` guard) read n.
    expect(cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(n)))).toBe(true);
  });
});

describe('Swift CfgVisitor — functionStartColumn', () => {
  it('two same-line functions get distinct functionStartColumn', () => {
    const cfgs = swift.cfgsOf(`func a() { x() }; func b() { y() }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});
