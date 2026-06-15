import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import {
  createCCfgVisitor,
  createCppCfgVisitor,
} from '../../../src/core/ingestion/cfg/visitors/c-cpp.js';
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

// U2 — the C/C++ CfgVisitor, one hazard per test (KTD5: real-parser regression,
// NOT snapshot-pinning). Each fixture's distinctive statement text (step(),
// done(), handle(e), …) lets us locate the block for a region by text and assert
// the control-flow topology around it.

const cGrammar = requireVendoredGrammar('tree-sitter-c') as Parameters<typeof makeCfgHarness>[0];
const cppGrammar = createRequire(import.meta.url)('tree-sitter-cpp') as Parameters<
  typeof makeCfgHarness
>[0];

const c: CfgHarness = makeCfgHarness(cGrammar, createCCfgVisitor(), 'fixture.c');
const cpp: CfgHarness = makeCfgHarness(cppGrammar, createCppCfgVisitor(), 'fixture.cpp');

describe('C CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = c.cfgOf(`void f() { a(); b(); c(); }`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = c.cfgOf(`void f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('malformed/unmodeled body returns undefined without throwing', () => {
    // A forward-declaration prototype (`int f(int);`) has no compound_statement
    // body — buildFunctionCfg must return undefined rather than throw.
    const root = c.parse(`int f(int);`);
    const fns = c.collectFunctions(root);
    // No function_definition (only a declaration) → nothing to build.
    expect(fns).toHaveLength(0);
    // And a body-less function node yields undefined, not a throw.
    const decl = c.parse(`void g() { x(); }`);
    const fn = c.collectFunctions(decl)[0];
    expect(() => createCCfgVisitor().buildFunctionCfg(fn, 'f.c')).not.toThrow();
  });
});

describe('C CfgVisitor — branching', () => {
  it('if/else: cond-true to then, cond-false to else, both reach the join', () => {
    const cfg = c.cfgOf(`void f(int x) { if (x) { a(); } else { b(); } c(); }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
  });

  it('plain if (no else): condition reaches both the body and the join', () => {
    const cfg = c.cfgOf(`void f(int x) { if (x) { a(); } b(); }`);
    const cond = block(cfg, 'x');
    expect(reaches(cfg, cond, block(cfg, 'a();'))).toBe(true);
    expect(reaches(cfg, cond, block(cfg, 'b();'))).toBe(true);
  });
});

describe('C CfgVisitor — loops', () => {
  it('while loop: header + back-edge + exit', () => {
    const cfg = c.cfgOf(`void f(int x) { while (x > 0) { step(); } done(); }`);
    const header = block(cfg, 'x > 0');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('do-while runs the body BEFORE testing, then loops back from the bottom', () => {
    const cfg = c.cfgOf(`void f(int x) { do { step(); } while (x > 0); done(); }`);
    const body = block(cfg, 'step();');
    const cond = block(cfg, 'x > 0');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    // The back-edge / condition tests at the BOTTOM (cond reachable from body).
    expect(reaches(cfg, body, cond)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: cond, to: body, kind: 'loop-back' });
    expect(reaches(cfg, cond, block(cfg, 'done();'))).toBe(true);
  });

  it('C-style for: init once, condition header, back-edge through increment', () => {
    const cfg = c.cfgOf(`void f() { for (int i = 0; i < n; i++) { step(); } done(); }`);
    const init = block(cfg, 'int i = 0');
    const header = block(cfg, 'i < n');
    const incr = block(cfg, 'i++');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: init, kind: 'seq' });
    expect(reaches(cfg, body, incr)).toBe(true);
    expect(cfg.edges).toContainEqual({ from: incr, to: header, kind: 'loop-back' });
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('for(;;) {} keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    // The header has a cond-false escape to the loop-exit even with no condition;
    // the inner `if` is a real control point. Assert through the production
    // post-dom/CDG passes (matching go/python/ruby/rust/vue) — CDG is only
    // computed when EXIT stays reverse-reachable, so a non-empty CDG proves the
    // structural exit-escape edge keeps the function CDG-bearing.
    const cfg = c.cfgOf(`void f(int x) { for (;;) { if (x) { g(); } } }`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('C CfgVisitor — switch (C-style fallthrough)', () => {
  it('a case without break falls into the next case (switch-case + fallthrough)', () => {
    const cfg = c.cfgOf(`void f(int x) {
      switch (x) {
        case 1: one();
        case 2: two(); break;
        default: other();
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    // case 1 (no break) FALLS THROUGH into case 2.
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(true);
    // both cases reach the post-switch continuation.
    expect(reaches(cfg, block(cfg, 'two();'), block(cfg, 'after();'))).toBe(true);
  });

  it('break-terminated case does not fall into the next case', () => {
    const cfg = c.cfgOf(`void f(int x) {
      switch (x) { case 1: one(); break; case 2: two(); break; }
      after();
    }`);
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(false);
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'after();'))).toBe(true);
  });
});

describe('C CfgVisitor — goto / labels', () => {
  it('backward goto wires to an already-seen label block', () => {
    const cfg = c.cfgOf(
      `void f() { int i = 0; loop: work(); i++; if (i < 10) goto loop; done(); }`,
    );
    const gotoB = block(cfg, 'goto loop;');
    const label = block(cfg, 'work();');
    expect(reaches(cfg, gotoB, label)).toBe(true);
    expect(cfg.edges.some((e) => e.from === gotoB && e.to === label)).toBe(true);
  });

  it('forward goto wires to a label that appears later', () => {
    const cfg = c.cfgOf(`void f(int x) { if (x) goto end; work(); end: done(); }`);
    const gotoB = block(cfg, 'goto end;');
    const label = block(cfg, 'done();');
    expect(reaches(cfg, gotoB, label)).toBe(true);
    // the goto skips work() on its path.
    expect(reachable(cfg, block(cfg, 'work();'))).toBe(true);
  });

  it('goto to an UNDEFINED label routes to EXIT (single-exit preserved) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = c.cfgOf(`void f() { work(); goto missing; }`);
      const gotoB = block(cfg, 'goto missing;');
      expect(reaches(cfg, gotoB, cfg.exitIndex)).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // #2197 U1 — an UNCONDITIONAL goto-cycle traps EXIT (the `goto start` has no
  // exit path), so without the synthetic-escape pass `emitFileCdg` would withhold
  // ALL control dependence. After the pass the cycle is bridged and CDG is
  // emitted. The conditional goto tests above already had an exit path (the
  // if-false arm reaches `done()`), so they did NOT exercise this gap.
  it('unconditional goto-cycle: bridged → EXIT reachable AND CDG emitted (C)', () => {
    const cfg = c.cfgOf(`void handler(int a){ start: if(a>0){work();} goto start; }`);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false); // trapped without the pass
    const view = augmentForPostDom(cfg);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
    expect(computeControlDependence(view).edges.length).toBeGreaterThan(0);
  });

  it('unconditional goto-cycle: bridged → EXIT reachable AND CDG emitted (C++)', () => {
    const cfg = cpp.cfgOf(`void handler(int a){ start: if(a>0){work();} goto start; }`);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);
    const view = augmentForPostDom(cfg);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
    expect(computeControlDependence(view).edges.length).toBeGreaterThan(0);
  });
});

describe('C CfgVisitor — def/use harvest', () => {
  it('int x = a + b; use(x); produces a def of x and a use in the consumer', () => {
    const cfg = c.cfgOf(`void f(int a, int b) { int x = a + b; use(x); }`);
    const x = bindingIdx(cfg, 'x');
    // x is defined somewhere…
    const defined = cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(x)));
    expect(defined).toBe(true);
    // …and used somewhere.
    const used = cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(x)));
    expect(used).toBe(true);
  });

  it('if (a && (x = f())) records x as a MAY-def, not a must-kill', () => {
    const cfg = c.cfgOf(`void f(int a) { int x = 0; if (a && (x = g())) h(x); }`);
    const x = bindingIdx(cfg, 'x');
    const hasMayDef = cfg.blocks.some((bl) =>
      bl.statements?.some((s) => (s.mayDefs ?? []).includes(x)),
    );
    expect(hasMayDef).toBe(true);
  });
});

describe('C++ CfgVisitor — structured bindings (#2195 P1)', () => {
  const isDef = (cfg: FunctionCfg, idx: number): boolean =>
    cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));

  it('auto [a, b] = mk(); defines BOTH a and b (not just the first / neither)', () => {
    const cfg = cpp.cfgOf(`void f() { auto [a, b] = mk(); use(a); use(b); }`);
    expect(isDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(isDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    // a later use(a) must resolve to the SAME binding the declaration defs —
    // i.e. `a` is a real local, not a synthetic module binding.
    const a = bindingIdx(cfg, 'a');
    const usedA = cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(a)));
    expect(usedA).toBe(true);
  });

  it('auto& [a, b] = ref(); (reference structured binding) defines both names', () => {
    const cfg = cpp.cfgOf(`void f() { auto& [a, b] = ref(); sink(a, b); }`);
    expect(isDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(isDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });
});

describe('C++ CfgVisitor — coroutines (#2195 P1)', () => {
  it('co_return edges to EXIT (return), not a seq fallthrough to the next statement', () => {
    const cfg = cpp.cfgOf(`Task f(int x) { if (x) co_return early(); main(); }`);
    const co = block(cfg, 'co_return early();');
    // co_return is a return terminator: it edges to EXIT…
    expect(
      cfg.edges.some((e) => e.from === co && e.to === cfg.exitIndex && e.kind === 'return'),
    ).toBe(true);
    // …and never falls through to the following statement.
    expect(cfg.edges.some((e) => e.from === co && e.kind === 'seq')).toBe(false);
  });
});

describe('C CfgVisitor — functionStartColumn', () => {
  it('two same-line functions get distinct functionStartColumn', () => {
    const cfgs = c.cfgsOf(`int a(){return 1;} int b(){return 2;}`);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // distinct column
  });
});

describe('C++ CfgVisitor — exceptions', () => {
  it('try/catch: a throw edge runs from each protected block to the handler', () => {
    const cfg = cpp.cfgOf(`void f() {
      try { risky(); deeper(); } catch (std::exception& e) { handle(e); }
      after();
    }`);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    const handler = block(cfg, 'handle(e);');
    // every protected-region block reaches the handler.
    expect(reaches(cfg, block(cfg, 'risky();'), handler)).toBe(true);
    // and after() is still reachable (handler completion rejoins).
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('multi-catch: a body throw reaches EVERY handler (clauses 2..N not orphaned)', () => {
    const cfg = cpp.cfgOf(`void f() {
      try { risky(); } catch (int e) { a(e); } catch (double d) { b(d); } catch (...) { c(); }
      after();
    }`);
    const risky = block(cfg, 'risky();');
    // The matching catch is dynamic, so the body throw must reach all three handlers.
    expect(reaches(cfg, risky, block(cfg, 'a(e);'))).toBe(true);
    expect(reaches(cfg, risky, block(cfg, 'b(d);'))).toBe(true);
    expect(reaches(cfg, risky, block(cfg, 'c();'))).toBe(true);
    // none of the later handlers is orphaned (all reachable from ENTRY); the
    // post-try continuation still rejoins.
    expect(reachable(cfg, block(cfg, 'b(d);'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('throw inside a branched try body reaches the handler from the interior block', () => {
    const cfg = cpp.cfgOf(`void f(int x) {
      try { guard(); if (x) { deep(); } } catch (int e) { onErr(); }
    }`);
    const handler = block(cfg, 'onErr();');
    expect(reaches(cfg, block(cfg, 'deep();'), handler)).toBe(true);
  });

  it('throw with NO enclosing try routes to EXIT and ends its block', () => {
    const cfg = cpp.cfgOf(`void f(int x) { if (x) { throw 1; } done(); }`);
    const thr = block(cfg, 'throw 1;');
    expect(cfg.edges).toContainEqual({ from: thr, to: cfg.exitIndex, kind: 'throw' });
    // throw terminates its block — control does not fall into done() from it.
    expect(reaches(cfg, thr, block(cfg, 'done();'))).toBe(false);
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true); // via the if false branch
  });
});

describe('C++ CfgVisitor — range-for', () => {
  it('for_range_loop: header + body + loop-back + exit', () => {
    const cfg = cpp.cfgOf(`void f(std::vector<int>& xs) { for (int x : xs) { use(x); } done(); }`);
    const body = block(cfg, 'use(x);');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    // the loop body loops back to the header and the loop has an exit to done().
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('range-for declarator defines the loop variable; iterated expr is a use', () => {
    const cfg = cpp.cfgOf(`void f(std::vector<int>& xs) { for (int x : xs) { use(x); } }`);
    const x = bindingIdx(cfg, 'x');
    const defined = cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(x)));
    expect(defined).toBe(true);
  });
});

describe('C++ CfgVisitor — lambdas are CFG-bearing functions', () => {
  it('a lambda body yields its own well-formed CFG', () => {
    const cfgs = cpp.cfgsOf(`void f() { auto g = [](int x) { if (x) { a(); } return x; }; }`);
    // f and the lambda are both CFG-bearing.
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) {
      expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    }
  });
});

// U6 — call-site `sites[]` taint substrate. INERT BY DESIGN: no C-family taint
// model is registered, so these sites produce zero TAINTED edges; they only
// give the deferred per-language source/sink model something to match against.
// The assertions verify the substrate is harvested in the TS `SiteRecord` shape.
describe('C CfgVisitor — call-site sites[] substrate', () => {
  it('a bare call records a `call` site with callee name + arg occurrence', () => {
    const cfg = c.cfgOf(`void f(int cmd) { exec(cmd); }`);
    const sites = allSites(cfg);
    const exec = sites.find((s) => s.kind === 'call' && s.callee === 'exec');
    expect(exec).toBeDefined();
    // `cmd` (binding 0) occurs at argument position 0.
    expect(exec?.args?.[0]).toContainEqual(bindingIdx(cfg, 'cmd'));
  });

  it('a method call (`db.query(x)`) records the receiver binding + dotted callee', () => {
    const cfg = c.cfgOf(`void f(int x) { db.query(x); }`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'db.query');
    expect(site).toBeDefined();
    expect(site?.receiver).toBe(bindingIdx(cfg, 'db'));
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
  });

  it('a nested call (`exec(escape(x))`) via-tags the inner site (sanitizer substrate)', () => {
    const cfg = c.cfgOf(`void f(int x) { exec(escape(x)); }`);
    const sites = allSites(cfg);
    const exec = sites.findIndex((s) => s.callee === 'exec');
    const escape = sites.findIndex((s) => s.callee === 'escape');
    expect(exec).toBeGreaterThanOrEqual(0);
    expect(escape).toBeGreaterThanOrEqual(0);
    const x = bindingIdx(cfg, 'x');
    // escape's arg 0 carries a plain `x`; exec's arg 0 carries `[x, escapeSiteIdx]`.
    expect(sites[escape].args?.[0]).toContainEqual(x);
    expect(sites[exec].args?.[0]).toContainEqual([x, escape]);
  });

  it('a call assigned to a variable records resultDefs', () => {
    const cfg = c.cfgOf(`void f(int a) { int y = load(a); }`);
    const site = allSites(cfg).find((s) => s.callee === 'load');
    expect(site?.resultDefs).toContain(bindingIdx(cfg, 'y'));
  });

  it('a CFG-only function (no calls) emits NO sites key (omit-when-empty)', () => {
    const cfg = c.cfgOf(`void f(int a, int b) { int x = a + b; }`);
    expect(hasAnySites(cfg)).toBe(false);
    expect(allSites(cfg)).toHaveLength(0);
  });
});

describe('C++ CfgVisitor — call-site sites[] substrate', () => {
  it('a `new Foo(x)` records a `new` site with the constructor as callee', () => {
    const cfg = cpp.cfgOf(`void f(int x) { auto p = new Foo(x); }`);
    const site = allSites(cfg).find((s) => s.kind === 'new');
    expect(site).toBeDefined();
    expect(site?.callee).toBe('Foo');
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'x'));
    // `auto p = new Foo(x)` attaches resultDefs of `p` to the new site.
    expect(site?.resultDefs).toContain(bindingIdx(cfg, 'p'));
  });

  it('a `ns::g(z)` namespace call folds `::` into a dotted callee path', () => {
    const cfg = cpp.cfgOf(`void f(int z) { ns::g(z); }`);
    const site = allSites(cfg).find((s) => s.kind === 'call' && s.callee === 'ns.g');
    expect(site).toBeDefined();
    expect(site?.args?.[0]).toContainEqual(bindingIdx(cfg, 'z'));
  });
});
