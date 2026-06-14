import { describe, it, expect } from 'vitest';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { createKotlinCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/kotlin.js';
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

// The Kotlin CfgVisitor, one hazard per test (real-parser regression, NOT
// snapshot-pinning). Kotlin's grammar is VENDORED (not an npm package): the
// grammar loads from vendor/ via `requireVendoredGrammar('tree-sitter-kotlin')`,
// exactly like the Swift test loads the vendored tree-sitter-swift. Each fixture's
// distinctive statement text (step(), done(), handle(e), …) lets us locate the
// block for a region by text and assert the control-flow topology around it.

const kotlinGrammar = requireVendoredGrammar('tree-sitter-kotlin') as Parameters<
  typeof makeCfgHarness
>[0];

const kotlin: CfgHarness = makeCfgHarness(kotlinGrammar, createKotlinCfgVisitor(), 'fixture.kt');

const definesBinding = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const usesBinding = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));

describe('Kotlin CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = kotlin.cfgOf(`fun f() { a(); b(); c() }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = kotlin.cfgOf(`fun f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('expression-body function: ENTRY → block → EXIT', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) = x + 1`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    // The parameter is bound and used.
    expect(definesBinding(cfg, bindingIdx(cfg, 'x'))).toBe(true);
  });

  it('an unmodeled shape produces a graceful partial CFG (never throws)', () => {
    // An abstract / interface method (no body) — buildFunctionCfg must return
    // undefined rather than throw; a real function still builds.
    const root = kotlin.parse(`interface P { fun f() }`);
    const fns = kotlin.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createKotlinCfgVisitor().buildFunctionCfg(fn, 'p.kt')).not.toThrow();
    }
    const cfg = kotlin.cfgOf(`fun g() { x() }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('a class method is a CFG-bearing function', () => {
    const cfg = kotlin.cfgOf(`class C { fun m(a: Int) { g(a) } }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'a'))).toBe(true);
  });
});

describe('Kotlin CfgVisitor — branching (if/else)', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) { if (x > 0) { a() } else { b() }; c() }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
  });

  it('else-if chain branches each condition', () => {
    const cfg = kotlin.cfgOf(
      `fun f(x: Int) { if (x == 1) { a() } else if (x == 2) { b() } else { c() }; d() }`,
    );
    const join = block(cfg, 'd()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), join)).toBe(true);
  });

  it('if without braces (bare control_structure_body) still branches', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) { if (x > 0) a() else b(); c() }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), block(cfg, 'c()'))).toBe(true);
  });

  it('an if used as an expression VALUE stays inline (not modeled as a branch)', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) { val y = if (x > 0) 1 else 2; use(y) }`);
    // The value-position if has no branch edges; the assignment coalesces.
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'y'))).toBe(true);
  });
});

describe('Kotlin CfgVisitor — when (no fallthrough)', () => {
  it('when with subject: each arm dispatches and rejoins after (no fallthrough)', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) {
      when (x) {
        1 -> one()
        2 -> two()
        else -> other()
      }
      after()
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // arm 1 does NOT fall into arm 2 (Kotlin when has no fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
    // every arm reaches the post-when continuation.
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'other()'), block(cfg, 'after()'))).toBe(true);
  });

  it('when WITHOUT subject (guard form) dispatches each condition', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) {
      when {
        x > 0 -> pos()
        else -> nonpos()
      }
      after()
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reachable(cfg, block(cfg, 'pos()'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'nonpos()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'pos()'), block(cfg, 'after()'))).toBe(true);
  });

  it('a when with NO else lets the no-match path fall to the join', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Int) { when (x) { 1 -> a() }; after() }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // the dispatch can reach after() without entering arm 1 (no-match path).
    expect(reachable(cfg, block(cfg, 'after()'))).toBe(true);
  });
});

describe('Kotlin CfgVisitor — loops', () => {
  it('for-in: header + body + loop-back + exit; binds the loop var', () => {
    const cfg = kotlin.cfgOf(`fun f(xs: List<Int>) { for (x in xs) { step(x) }; done() }`);
    const header = block(cfg, 'for (x in xs)');
    const body = block(cfg, 'step(x)');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
    expect(definesBinding(cfg, bindingIdx(cfg, 'x'))).toBe(true);
  });

  it('while: header tests first, body loops back', () => {
    const cfg = kotlin.cfgOf(`fun f() { while (cond()) { step() }; done() }`);
    const header = block(cfg, 'while (cond())');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = kotlin.cfgOf(`fun f() { do { step() } while (cond()); done() }`);
    const body = block(cfg, 'step()');
    const cond = block(cfg, 'while (cond())');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(reaches(cfg, body, cond)).toBe(true); // condition tests at the bottom
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done()'))).toBe(true);
  });

  it('while (true) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The inner `if` is a real control point; assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = kotlin.cfgOf(`fun f(x: Boolean) { while (true) { if (x) { g() } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('do {} while (true) keeps EXIT reverse-reachable', () => {
    const cfg = kotlin.cfgOf(`fun f() { do { work() } while (true) }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });
});

describe('Kotlin CfgVisitor — try/catch/finally', () => {
  it('try/catch/finally: a throw edge runs to the handler; finally completion edges', () => {
    const cfg = kotlin.cfgOf(`fun f() {
      try { risky() } catch (e: Exception) { handle(e) } finally { cleanup() }
      after()
    }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e)');
    expect(reaches(cfg, block(cfg, 'risky()'), handler)).toBe(true);
    // the finally runs on both normal and exception exit.
    const fin = block(cfg, 'cleanup()');
    expect(reaches(cfg, block(cfg, 'risky()'), fin)).toBe(true);
    expect(reaches(cfg, handler, fin)).toBe(true);
    // after() is still reachable (finally completion rejoins).
    expect(reachable(cfg, block(cfg, 'after()'))).toBe(true);
    // the catch binds the error `e`.
    expect(definesBinding(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('a return inside a try threads through the finally (finally-return completion)', () => {
    const cfg = kotlin.cfgOf(`fun f(): Int {
      try { return compute() } finally { cleanup() }
    }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('return')).toBe(true);
    expect(kinds.has('finally-return')).toBe(true);
    const fin = block(cfg, 'cleanup()');
    expect(reaches(cfg, fin, cfg.exitIndex)).toBe(true);
  });

  it('a throw with NO enclosing try/catch routes to EXIT and ends its block', () => {
    const cfg = kotlin.cfgOf(`fun f(x: Boolean) { if (x) throw RuntimeException(); done() }`);
    const thr = block(cfg, 'throw RuntimeException()');
    expect(cfg.edges).toContainEqual({ from: thr, to: cfg.exitIndex, kind: 'throw' });
    // throw terminates its block — control does not fall into done() from it.
    expect(reaches(cfg, thr, block(cfg, 'done()'))).toBe(false);
    expect(reachable(cfg, block(cfg, 'done()'))).toBe(true); // via the if false branch
  });
});

describe('Kotlin CfgVisitor — labeled break/continue', () => {
  it('labeled break@outer escapes BOTH loops and reaches done()', () => {
    const cfg = kotlin.cfgOf(`fun f(xs: List<Int>, ys: List<Int>) {
      outer@ for (i in xs) {
        for (j in ys) { break@outer }
      }
      done()
    }`);
    const brk = block(cfg, 'break@outer');
    expect(edgeKinds(cfg).has('break')).toBe(true);
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
  });

  it('continue@loop targets the outer loop header', () => {
    const cfg = kotlin.cfgOf(`fun f(xs: List<Int>, ys: List<Int>) {
      loop@ for (i in xs) {
        for (j in ys) { continue@loop }
      }
      done()
    }`);
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    const outer = block(cfg, 'for (i in xs)');
    const cont = block(cfg, 'continue@loop');
    expect(reaches(cfg, cont, outer)).toBe(true);
  });
});

describe('Kotlin CfgVisitor — lambdas (own CFG)', () => {
  it('a lambda is collected as its own CFG; return@label routes to the lambda EXIT', () => {
    const cfgs = kotlin.cfgsOf(`fun f(xs: List<Int>) {
      xs.forEach { x ->
        if (x < 0) return@forEach
        use(x)
      }
    }`);
    // f and the lambda are both CFG-bearing.
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    // The lambda's CFG (the one containing return@forEach) keeps EXIT reachable.
    const lambdaCfg = cfgs.find((c) => c.blocks.some((b) => b.text.includes('return@forEach')));
    expect(lambdaCfg).toBeDefined();
    const ret = lambdaCfg!.blocks.find((b) => b.text.includes('return@forEach'))!.index;
    expect(reaches(lambdaCfg!, ret, lambdaCfg!.exitIndex)).toBe(true);
  });
});

describe('Kotlin CfgVisitor — def/use harvest', () => {
  it('val x = compute(); use(x) produces a def of x and a use in the consumer', () => {
    const cfg = kotlin.cfgOf(`fun f() { val x = compute(); use(x) }`);
    const x = bindingIdx(cfg, 'x');
    expect(definesBinding(cfg, x)).toBe(true);
    expect(usesBinding(cfg, x)).toBe(true);
  });

  it('destructuring `val (a, b) = p` defines both names', () => {
    const cfg = kotlin.cfgOf(`fun f(p: Pair<Int, Int>) { val (a, b) = p; use(a); use(b) }`);
    for (const name of ['a', 'b']) {
      const idx = bindingIdx(cfg, name);
      expect(definesBinding(cfg, idx)).toBe(true);
    }
  });

  it('var reassignment defines the variable again', () => {
    const cfg = kotlin.cfgOf(`fun f() { var y = 0; y = compute(); use(y) }`);
    const y = bindingIdx(cfg, 'y');
    expect(definesBinding(cfg, y)).toBe(true);
    expect(usesBinding(cfg, y)).toBe(true);
  });

  it('compound assign `x += 1` defines AND uses x', () => {
    const cfg = kotlin.cfgOf(`fun f() { var x = 0; x += step() }`);
    const x = bindingIdx(cfg, 'x');
    expect(definesBinding(cfg, x)).toBe(true);
    expect(usesBinding(cfg, x)).toBe(true);
  });
});

describe('Kotlin CfgVisitor — functionStartColumn', () => {
  it('two same-line functions get distinct functionStartColumn', () => {
    const cfgs = kotlin.cfgsOf(`fun a() { x() }; fun b() { y() }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});
