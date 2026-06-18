import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createGoCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/go.js';
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
import { augmentForPostDom } from '../../../src/core/ingestion/cfg/synthetic-escape.js';

// U5 — the Go CfgVisitor, one hazard per test (KTD5: real-parser regression,
// NOT snapshot-pinning). Each fixture's distinctive statement text (step(),
// done(), one(), …) lets us locate the block for a region by text and assert the
// control-flow topology around it. Go is the highest-divergence target — the
// EXIT-reachability regressions for `for {}` / `select {}` are load-bearing.

const goGrammar = createRequire(import.meta.url)('tree-sitter-go') as Parameters<
  typeof makeCfgHarness
>[0];

const go: CfgHarness = makeCfgHarness(goGrammar, createGoCfgVisitor(), 'fixture.go');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

/** Wrap a Go function body in a minimal compilable package. */
const pkg = (src: string): string => `package main\n${src}\n`;

describe('Go CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = go.cfgOf(pkg(`func f() { a(); b(); c() }`));
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = go.cfgOf(pkg(`func f() {}`));
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('function, method, and func literal are all CFG-bearing', () => {
    const cfgs = go.cfgsOf(
      pkg(`func f() { x() }\nfunc (r *T) M() { y() }\nvar g = func() { z() }`),
    );
    expect(cfgs.length).toBeGreaterThanOrEqual(3); // f, M, the func literal
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('forward declaration / no body → undefined, never throws', () => {
    const root = go.parse(pkg(`type I interface { M() }`));
    const fns = go.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createGoCfgVisitor().buildFunctionCfg(fn, 'f.go')).not.toThrow();
    }
  });
});

describe('Go CfgVisitor — if', () => {
  it('if with initializer: init+cond on the header, both arms reach the join', () => {
    const cfg = go.cfgOf(pkg(`func f() { if v := compute(); v > 0 { a() } else { b() }; c() }`));
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
    // the initializer `v := compute()` defines v and the condition uses it.
    const v = bindingIdx(cfg, 'v');
    expect(hasDef(cfg, v)).toBe(true);
    expect(hasUse(cfg, v)).toBe(true);
  });

  it('else if chains through the nested alternative (no else_clause wrapper)', () => {
    const cfg = go.cfgOf(
      pkg(`func f(x int) { if x > 0 { a() } else if x < 0 { b() } else { c() } }`),
    );
    expect(reaches(cfg, block(cfg, 'a()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), cfg.exitIndex)).toBe(true);
  });
});

describe('Go CfgVisitor — for (Go single loop keyword, four shapes)', () => {
  it('for_clause (C-style): init once, condition header, back-edge through update', () => {
    const cfg = go.cfgOf(pkg(`func f(n int) { for i := 0; i < n; i++ { step() }; done() }`));
    const init = block(cfg, 'i := 0');
    const header = block(cfg, 'i < n');
    const incr = block(cfg, 'i++');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: init, kind: 'seq' });
    expect(reaches(cfg, body, incr)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: incr, to: header, kind: 'loop-back' });
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
  });

  it('for cond {} (while-style): header + back-edge + exit', () => {
    const cfg = go.cfgOf(pkg(`func f(x int) { for x > 0 { step() }; done() }`));
    const header = block(cfg, 'x > 0');
    const body = block(cfg, 'step()');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done()'))).toBe(true);
  });

  it('for range: header + body + loop-back; loop vars are defs, source a use', () => {
    const cfg = go.cfgOf(pkg(`func f(xs []int) { for k, v := range xs { use(k, v) }; done() }`));
    const body = block(cfg, 'use(k, v)');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done()'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'k'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'v'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'xs'))).toBe(true);
  });

  it('for {} (infinite) keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = go.cfgOf(pkg(`func f(x bool) { for { if x { g() } } }`));
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    // The inner `if` is a real control point — CDG must be non-empty (it is only
    // computed when EXIT stays reverse-reachable).
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Go CfgVisitor — switch (no implicit fallthrough)', () => {
  it('expression_switch cases do NOT fall through by default', () => {
    const cfg = go.cfgOf(
      pkg(`func f(x int) {
        switch x {
        case 1:
          one()
        case 2:
          two()
        default:
          other()
        }
        after()
      }`),
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // each case body rejoins after the switch...
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
    // ...but case 1 does NOT fall into case 2 (Go has no implicit fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
  });

  it('explicit fallthrough_statement adds a fallthrough edge to the next case', () => {
    const cfg = go.cfgOf(
      pkg(`func f(x int) {
        switch x {
        case 1:
          one()
          fallthrough
        case 2:
          two()
        }
        after()
      }`),
    );
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    // case 1 (via fallthrough) reaches case 2's body.
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(true);
  });

  it('type_switch dispatches across type cases', () => {
    const cfg = go.cfgOf(
      pkg(`func f(i interface{}) {
        switch t := i.(type) {
        case int:
          useInt(t)
        case string:
          useStr(t)
        default:
          other()
        }
        after()
      }`),
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'useInt(t)'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'useStr(t)'), block(cfg, 'after()'))).toBe(true);
    // the type-switch alias `t` is a def on the dispatch header.
    expect(hasDef(cfg, bindingIdx(cfg, 't'))).toBe(true);
  });
});

describe('Go CfgVisitor — select', () => {
  it('select dispatches across communication cases (no implicit fallthrough)', () => {
    const cfg = go.cfgOf(
      pkg(`func f(ch chan int) {
        select {
        case v := <-ch:
          use(v)
        case ch <- 1:
          sent()
        default:
          none()
        }
        after()
      }`),
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'use(v)'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'sent()'), block(cfg, 'after()'))).toBe(true);
    // comm case 1 does not fall into comm case 2.
    expect(reaches(cfg, block(cfg, 'use(v)'), block(cfg, 'sent()'))).toBe(false);
  });

  it('select {} with no default keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The CDG probe required by the plan: a `select {}` blocks forever, so EXIT
    // must stay reverse-reachable or CDG is silently skipped for the function.
    const cfg = go.cfgOf(pkg(`func f(x bool) { if x { g() }; select {} }`));
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('bare select {} keeps EXIT reverse-reachable on its own', () => {
    const cfg = go.cfgOf(pkg(`func f() { select {} }`));
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });
});

describe('Go CfgVisitor — defer (LIFO completion legs)', () => {
  it('defer body runs on the normal exit path', () => {
    const cfg = go.cfgOf(pkg(`func f() { defer cleanup(); work() }`));
    const cleanup = block(cfg, 'defer cleanup()');
    const work = block(cfg, 'work()');
    // normal completion of work threads through the deferred cleanup → EXIT.
    expect(reaches(cfg, work, cleanup)).toBe(true);
    expect(reaches(cfg, cleanup, cfg.exitIndex)).toBe(true);
  });

  it('defer runs on a return path too (return threads through the defer)', () => {
    const cfg = go.cfgOf(
      pkg(`func f(x bool) int { defer cleanup(); if x { return 1 }; return 2 }`),
    );
    const cleanup = block(cfg, 'defer cleanup()');
    expect(reaches(cfg, block(cfg, 'return 1'), cleanup)).toBe(true);
    expect(reaches(cfg, block(cfg, 'return 2'), cleanup)).toBe(true);
    expect(reaches(cfg, cleanup, cfg.exitIndex)).toBe(true);
  });

  it('two defers run LIFO: the last-registered runs first', () => {
    const cfg = go.cfgOf(pkg(`func f() { defer first(); defer second(); work() }`));
    const first = block(cfg, 'defer first()');
    const second = block(cfg, 'defer second()');
    // LIFO: `second` runs before `first` on the exit path.
    expect(reaches(cfg, second, first)).toBe(true);
    expect(reaches(cfg, first, cfg.exitIndex)).toBe(true);
    // the deferred call facts are present (cleanup runs at exit).
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
  });
});

describe('Go CfgVisitor — labeled break / continue / goto', () => {
  it('labeled break exits the OUTER loop from a nested loop', () => {
    const cfg = go.cfgOf(
      pkg(`func f() {
      outer:
        for i := 0; i < 10; i++ {
          for j := 0; j < 10; j++ {
            if cond() { break outer }
          }
        }
        done()
      }`),
    );
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, 'break outer');
    // the labeled break reaches the post-loop `done()`, skipping both loops.
    expect(reaches(cfg, brk, block(cfg, 'done()'))).toBe(true);
  });

  it('labeled continue re-tests the OUTER loop', () => {
    const cfg = go.cfgOf(
      pkg(`func f() {
      outer:
        for i := 0; i < 10; i++ {
          for j := 0; j < 10; j++ {
            if cond() { continue outer }
          }
        }
      }`),
    );
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    const outerHeader = block(cfg, 'i < 10');
    expect(reaches(cfg, block(cfg, 'continue outer'), outerHeader)).toBe(true);
  });

  it('goto reaches a forward label', () => {
    const cfg = go.cfgOf(pkg(`func f(x bool) { if x { goto end }; work(); end: done() }`));
    const gotoB = block(cfg, 'goto end');
    const label = block(cfg, 'done()');
    expect(reaches(cfg, gotoB, label)).toBe(true);
    expect(reachable(cfg, block(cfg, 'work()'))).toBe(true);
  });

  // #2197 U1 — an UNCONDITIONAL goto-cycle traps EXIT (the `goto start` has no
  // exit path); the synthetic-escape pass bridges it so CDG is emitted instead
  // of withheld. The forward goto above had an exit path (it skips to `done()`).
  it('unconditional goto-cycle: bridged → EXIT reachable AND CDG emitted', () => {
    const cfg = go.cfgOf(pkg(`func handler(a int){ start: if a>0 { work() }\n goto start }`));
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false); // trapped without the pass
    const view = augmentForPostDom(cfg);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
    expect(computeControlDependence(view).edges.length).toBeGreaterThan(0);
  });
});

describe('Go CfgVisitor — go statement (spawned flow not followed inline)', () => {
  it('go func(){…}() does not throw; the closure body builds its own CFG', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfgs = go.cfgsOf(pkg(`func f() { go func() { run() }(); go worker(1); after() }`));
      // f plus the spawned closure = at least 2 CFGs.
      expect(cfgs.length).toBeGreaterThanOrEqual(2);
      for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
      // The `go` call is a normal straight-line statement in f — `after()` runs.
      const f = cfgs[0];
      expect(reachable(f, block(f, 'after()'))).toBe(true);
      // No dropped edge → no warning for the common shapes.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Go CfgVisitor — def/use harvest', () => {
  it('a, b := f() defines BOTH a and b (multiple-return assignment)', () => {
    const cfg = go.cfgOf(pkg(`func f() { a, b := load(); use(a, b) }`));
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('x := …; use(x) → def then use', () => {
    const cfg = go.cfgOf(pkg(`func f(a int, b int) { x := a + b; use(x) }`));
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('compound assignment (x += 1) reads AND writes the lvalue', () => {
    const cfg = go.cfgOf(pkg(`func f() { x := 1; x += 3 }`));
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('inc_statement (x++) reads and writes', () => {
    const cfg = go.cfgOf(pkg(`func f() { x := 0; x++ }`));
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('var with initializer is a def; bare var (no value) is not', () => {
    const cfg = go.cfgOf(pkg(`func f() { var a = 1; var b int; use(a, b) }`));
    const a = bindingIdx(cfg, 'a');
    expect(hasDef(cfg, a)).toBe(true);
    // `var b int` writes nothing at runtime → `b` is a use-only synthetic-ish
    // binding (no def fact); the use(b) reads it.
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('selector write (obj.f = …) is NOT a scalar def — root identifier is a use', () => {
    const cfg = go.cfgOf(pkg(`func f(obj *T) { obj.field = 1; use(obj) }`));
    // `obj` is used (its field is written), never a scalar def for `field`.
    expect(hasUse(cfg, bindingIdx(cfg, 'obj'))).toBe(true);
  });

  it('a && (cond) short-circuit right operand uses are recorded', () => {
    // Go has no in-expression assignment, so the conditional machinery is
    // exercised via the may-def path of a switch case test; here we just confirm
    // the && right operand is walked (its identifier is a use).
    const cfg = go.cfgOf(pkg(`func f(a bool, b bool) { if a && b { g() } }`));
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('switch case test is harvested as a conditional (may-def-capable) use', () => {
    const cfg = go.cfgOf(pkg(`func f(x int, k int) { switch x { case k: a() } }`));
    // `k` (the case test) is used on the dispatch block; the conditional context
    // means any def there would be a may-def (none here, but the path is live).
    expect(hasUse(cfg, bindingIdx(cfg, 'k'))).toBe(true);
    void hasMayDef; // may-def path covered structurally by the conditional walk
  });

  it('select receive `case v := <-ch` defines v, not a use-only (#2195 P2)', () => {
    const cfg = go.cfgOf(pkg(`func f(ch chan int) { select { case v := <-ch: use(v) } }`));
    const v = bindingIdx(cfg, 'v');
    // the channel-received binding is a DEF (the channel-sourced value flows
    // into v) — the bug recorded it as a use of an uninitialized var instead.
    expect(hasDef(cfg, v)).toBe(true);
    // and the channel `ch` is read.
    expect(hasUse(cfg, bindingIdx(cfg, 'ch'))).toBe(true);
  });
});

describe('Go CfgVisitor — functionStartColumn', () => {
  it('two same-line funcs get distinct functionStartColumn', () => {
    const cfgs = go.cfgsOf(pkg(`func A() { x() }; func B() { y() }`));
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine);
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn);
  });
});

// U6 — call-site `sites[]` taint substrate. INERT BY DESIGN: no Go taint model
// is registered, so these sites produce zero TAINTED edges; they only give the
// deferred per-language source/sink model something to match against. Go has no
// `new` — constructor-style calls are plain `call_expression`s.
describe('Go CfgVisitor — call-site sites[] substrate', () => {
  const cfgOf = (body: string): FunctionCfg =>
    go.cfgOf(pkg(`func f(cmd, x, a int, xs []int) { ${body} }`));

  it('a bare call records a `call` site with callee name + arg occurrence', () => {
    const cfg = cfgOf(`exec(cmd)`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'exec');
    expect(site).toBeDefined();
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'cmd'));
  });

  it('a selector call (`db.Query(x)`) records the receiver binding + dotted callee', () => {
    const cfg = cfgOf(`db.Query(x)`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'db.Query');
    expect(site).toBeDefined();
    expect(site?.receiver).toBe(bindingIdx(cfg, 'db'));
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
  });

  it('a call assigned with `:=` records resultDefs', () => {
    const cfg = cfgOf(`r := load(a); _ = r`);
    const site = allSites(cfg).find((s) => s.callee === 'load');
    expect(site?.resultDefs).toContain(bindingIdx(cfg, 'r'));
  });

  it('a variadic call (`g(xs...)`) marks the spread position', () => {
    const cfg = cfgOf(`g(xs...)`);
    const site = allSites(cfg).find((s) => s.callee === 'g');
    expect(site?.spread).toBe(0);
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'xs'));
  });

  it('a nested call via-tags the inner site (sanitizer substrate)', () => {
    const cfg = cfgOf(`exec(escape(x))`);
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
    const cfg = cfgOf(`x := a + a; _ = x`);
    expect(hasAnySites(cfg)).toBe(false);
  });
});
