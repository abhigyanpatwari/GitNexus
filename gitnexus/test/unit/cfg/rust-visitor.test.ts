import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createRustCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/rust.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import {
  makeCfgHarness,
  type CfgHarness,
  block,
  edgeKinds,
  reaches,
  bindingIdx,
} from '../../helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';

// U7 — the Rust CfgVisitor, one hazard per test (real-parser regression, NOT
// snapshot-pinning). Each fixture's distinctive statement text (step(), done(),
// one(), …) lets us locate the block for a region by text and assert the
// control-flow topology around it. Rust is the EXPRESSION-oriented target —
// `loop {}` (the canonical infinite loop, NO condition) is the load-bearing
// EXIT-reachability case, and the `?` operator is an early-return edge.

const rustGrammar = createRequire(import.meta.url)('tree-sitter-rust') as Parameters<
  typeof makeCfgHarness
>[0];

const rust: CfgHarness = makeCfgHarness(rustGrammar, createRustCfgVisitor(), 'fixture.rs');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

describe('Rust CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = rust.cfgOf(`fn f() { a(); b(); c(); }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = rust.cfgOf(`fn f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('fn, method (impl), and closure are all CFG-bearing', () => {
    const cfgs = rust.cfgsOf(
      `fn f() { x(); }\nstruct S;\nimpl S { fn m(&self) { y(); } }\nfn g() { let c = || { z(); }; use_it(c); }`,
    );
    expect(cfgs.length).toBeGreaterThanOrEqual(4); // f, m, g, the closure
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('trait method signature / no body → undefined, never throws', () => {
    const root = rust.parse(`trait T { fn m(&self); }`);
    const fns = rust.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createRustCfgVisitor().buildFunctionCfg(fn, 'f.rs')).not.toThrow();
    }
  });

  it('two same-line fns get distinct functionStartColumn', () => {
    const cfgs = rust.cfgsOf(`fn a() { x(); } fn b() { y(); }`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine);
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn);
  });
});

describe('Rust CfgVisitor — if / else / if let', () => {
  it('if/else if/else: every arm reaches EXIT, both senses present', () => {
    const cfg = rust.cfgOf(
      `fn f(x: i32) { if x > 0 { a(); } else if x < 0 { b(); } else { c(); } }`,
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
  });

  it('both arms reach a common join after the if', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) { if x > 0 { a(); } else { b(); } c(); }`);
    const join = block(cfg, 'c()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
  });

  it('if let Some(n) = opt { … } defines n (cond-true), else reachable', () => {
    const cfg = rust.cfgOf(
      `fn f(opt: Option<i32>) { if let Some(n) = opt { use_n(n); } else { none(); } }`,
    );
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'opt'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'none()'), cfg.exitIndex)).toBe(true);
  });

  it('if let with a let-chain (let PAT = e && cond) still binds + branches', () => {
    const cfg = rust.cfgOf(`fn f(opt: Option<i32>) { if let Some(n) = opt && n > 0 { both(); } }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'both()'), cfg.exitIndex)).toBe(true);
  });
});

describe('Rust CfgVisitor — loop {} (infinite, the EXIT-reachability hazard)', () => {
  it('loop {} with no break keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The plan's load-bearing CDG probe: `loop {}` is the canonical Rust infinite
    // loop with NO condition. A structural escape edge must keep EXIT
    // reverse-reachable or the CDG pass is silently skipped for the function.
    const cfg = rust.cfgOf(`fn f(x: bool) { loop { if x { g(); } } }`);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true); // the structural escape edge
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    // The inner `if` is a real control point — CDG is only computed when EXIT
    // stays reverse-reachable, so a non-empty CDG proves the escape edge works.
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('loop { … break; } reaches EXIT via the break', () => {
    const cfg = rust.cfgOf(`fn f() { loop { work(); break; } done(); }`);
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, 'break');
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
    expect(reaches(cfg, brk, cfg.exitIndex)).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('let v = loop { break 42; }; (break with a value) is a break edge', () => {
    const cfg = rust.cfgOf(`fn f() { let v = loop { break 42; }; use_v(v); }`);
    expect(edgeKinds(cfg).has('break')).toBe(true);
    // `break 42` still terminates the loop and reaches the post-loop continuation.
    expect(reaches(cfg, block(cfg, 'break 42'), block(cfg, 'use_v(v)'))).toBe(true);
  });
});

describe('Rust CfgVisitor — while / while let / for', () => {
  it('while cond {}: header + back-edge + exit', () => {
    const cfg = rust.cfgOf(`fn f(x: bool) { while x { step(); } done(); }`);
    const header = block(cfg, 'x');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
  });

  it('while let Some(n) = next() { … }: header binds n (may-def), uses next', () => {
    const cfg = rust.cfgOf(`fn f() { while let Some(n) = next() { use_n(n); } done(); }`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    // `while let` re-tests, so the binding is a MAY-def (it doesn't bind on the
    // exit iteration), not falsely killing a prior def.
    expect(hasMayDef(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'use_n(n)'), block(cfg, 'done()'))).toBe(true);
  });

  it('for item in xs {}: loop var is a def, source a use, back-edge present', () => {
    const cfg = rust.cfgOf(`fn f(xs: Vec<i32>) { for item in xs { use_item(item); } done(); }`);
    const body = block(cfg, 'use_item(item)');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'item'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'xs'))).toBe(true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done()'))).toBe(true);
  });

  it('while true {} still emits the structural escape edge (EXIT reachable)', () => {
    const cfg = rust.cfgOf(`fn f() { while true { if cond() { g(); } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Rust CfgVisitor — match (no fallthrough) + guards', () => {
  it('match arms do NOT fall through; each body rejoins after the match', () => {
    const cfg = rust.cfgOf(
      `fn f(x: i32) {
        match x {
          1 => one(),
          2 => two(),
          _ => other(),
        }
        after();
      }`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
    // arm 1 does NOT fall into arm 2 (no fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
  });

  it('a guarded arm (n if n > 0) harvests the guard onto the dispatch block', () => {
    const cfg = rust.cfgOf(
      `fn f(x: i32) {
        match x {
          n if n > 0 => pos(n),
          _ => other(),
        }
        after();
      }`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // the guard test `n > 0` is a use on the dispatch header (n binds in the arm).
    expect(hasUse(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'pos(n)'), block(cfg, 'after()'))).toBe(true);
  });

  it('a match-arm pattern binding is harvested as a (may-)def from the subject (#2206)', () => {
    const cfg = rust.cfgOf(
      `fn f(x: E) {
        match x {
          Some(n) => use_n(n),
          _ => z(),
        }
      }`,
    );
    // `n` binds from the matched subject, so it must be a (may-)def, not only a
    // use — else taint cannot propagate from the subject into the arm body.
    expect(hasMayDef(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'n'))).toBe(true);
  });

  it('a match with NO `_` arm keeps a no-match path to the exit', () => {
    const cfg = rust.cfgOf(`fn f(x: i32) { match x { 1 => a(), 2 => b(), } after(); }`);
    expect(reaches(cfg, cfg.entryIndex, block(cfg, 'after()'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Rust CfgVisitor — labeled break / continue', () => {
  it("break 'outer from a nested loop targets the OUTER loop", () => {
    const cfg = rust.cfgOf(
      `fn f() {
        'outer: for i in 0..10 {
          for j in 0..10 {
            if cond() { break 'outer; }
          }
        }
        done();
      }`,
    );
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, "break 'outer");
    // the labeled break reaches the post-loop `done()`, skipping BOTH loops.
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
  });

  it("continue 'outer re-tests the OUTER loop", () => {
    const cfg = rust.cfgOf(
      `fn f() {
        'outer: for i in 0..10 {
          for j in 0..10 {
            if cond() { continue 'outer; }
          }
        }
      }`,
    );
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    const outerHeader = block(cfg, 'for i in 0..10');
    expect(reaches(cfg, block(cfg, "continue 'outer"), outerHeader)).toBe(true);
  });

  it('a plain (unlabeled) break exits the INNER loop only', () => {
    const cfg = rust.cfgOf(
      `fn f() {
        for i in 0..10 {
          inner();
          for j in 0..10 { if cond() { break; } }
          tail();
        }
        done();
      }`,
    );
    const brk = block(cfg, 'break');
    // the unlabeled break lands AFTER the inner loop, so `tail()` is reachable.
    expect(reaches(cfg, brk, block(cfg, 'tail()'))).toBe(true);
  });
});

describe('Rust CfgVisitor — return and the ? operator', () => {
  it('return Some(n) flows directly to EXIT (return edge)', () => {
    const cfg = rust.cfgOf(`fn f(n: i32) -> Option<i32> { if n > 0 { return Some(n); } Some(0) }`);
    expect(edgeKinds(cfg).has('return')).toBe(true);
    expect(reaches(cfg, block(cfg, 'return Some(n)'), cfg.exitIndex)).toBe(true);
  });

  it('the ? operator emits an early-return (throw) edge to EXIT', () => {
    const cfg = rust.cfgOf(
      `fn f(opt: Option<i32>) -> Option<i32> { let n = opt?; use_n(n); Some(n) }`,
    );
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    // the `?`-bearing block has a direct early-exit edge to EXIT (Err/None path)...
    const tryBlock = block(cfg, 'opt?');
    expect(cfg.edges).toContainEqual({ from: tryBlock, to: cfg.exitIndex, kind: 'throw' });
    // ...while the Ok path falls through to `use_n(n)`.
    expect(reaches(cfg, tryBlock, block(cfg, 'use_n(n)'))).toBe(true);
  });
});

describe('Rust CfgVisitor — def/use harvest (patterns)', () => {
  it('let x = …; use(x) → def then use', () => {
    const cfg = rust.cfgOf(`fn f(a: i32, b: i32) { let x = a + b; use_x(x); }`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('let (a, b) = pair() defines BOTH a and b (tuple destructuring)', () => {
    const cfg = rust.cfgOf(`fn f() { let (a, b) = pair(); use_ab(a, b); }`);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('let Point { x, y } = pt() defines both struct fields', () => {
    const cfg = rust.cfgOf(`fn f() { let Point { x, y } = pt(); use_xy(x, y); }`);
    expect(hasDef(cfg, bindingIdx(cfg, 'x'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'y'))).toBe(true);
  });

  it('let Some(n) = opt() in a let_else defines n (the tuple-struct inner binds, not the path)', () => {
    const cfg = rust.cfgOf(
      `fn f(opt: Option<i32>) { let Some(n) = opt() else { return; }; use_n(n); }`,
    );
    expect(hasDef(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'n'))).toBe(true);
    // the let_else `else { return; }` jumps to EXIT.
    expect(edgeKinds(cfg).has('return')).toBe(true);
  });

  it('compound assignment (x += 1) reads AND writes the lvalue', () => {
    const cfg = rust.cfgOf(`fn f() { let mut x = 1; x += 3; use_x(x); }`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('plain assignment (x = p) defines x; a field write (obj.f = …) is NOT a scalar def', () => {
    const cfg = rust.cfgOf(
      `fn f(p: i32, obj: T) { let mut x = 0; x = p; obj.field = 1; use_x(x); }`,
    );
    expect(hasDef(cfg, bindingIdx(cfg, 'x'))).toBe(true);
    // `obj` is used (its field is written), never a scalar def for `field`.
    expect(hasUse(cfg, bindingIdx(cfg, 'obj'))).toBe(true);
  });

  it('the wildcard `_` binds nothing', () => {
    const cfg = rust.cfgOf(`fn f() { let _ = compute(); done(); }`);
    expect((cfg.bindings ?? []).some((b) => b.name === '_')).toBe(false);
  });

  it('a closure body is opaque to the enclosing function harvest (own CFG)', () => {
    const cfgs = rust.cfgsOf(
      `fn f() { let cb = || { let inner = 1; use_inner(inner); }; call(cb); }`,
    );
    // The OUTER fn has a `cb` binding but NOT `inner` (the closure body is opaque).
    const outer = cfgs.find((c) => (c.bindings ?? []).some((b) => b.name === 'cb'));
    expect(outer).toBeDefined();
    expect((outer!.bindings ?? []).some((b) => b.name === 'inner')).toBe(false);
    // The closure has its OWN CFG where `inner` is a real def.
    const inner = cfgs.find((c) => (c.bindings ?? []).some((b) => b.name === 'inner'));
    expect(inner).toBeDefined();
    expect(hasDef(inner!, bindingIdx(inner!, 'inner'))).toBe(true);
  });
});

describe('Rust CfgVisitor — graceful degradation', () => {
  it('an unmodeled / malformed shape never throws (returns a partial CFG)', () => {
    // Macros are opaque token trees; any control flow they expand is invisible,
    // but the visitor must still produce a valid partial CFG, never throw.
    const cfg = rust.cfgOf(`fn f() { println!("{}", compute()); vec![1, 2, 3]; done(); }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });
});
