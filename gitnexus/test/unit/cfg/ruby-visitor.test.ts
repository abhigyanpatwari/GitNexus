import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createRubyCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/ruby.js';
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

// The Ruby CfgVisitor — one hazard per test (real-parser regression, NOT
// snapshot-pinning). Each fixture's distinctive statement text (one(), done(),
// after(), …) lets us locate the block for a region by text and assert the
// control-flow topology around it. Ruby is structurally close to Python:
// keyword/`end`-delimited blocks, statement-modifier forms, begin/rescue/else/
// ensure, case/when + case/in. The `while true` EXIT-reachability + CDG
// regressions are load-bearing.

const rubyGrammar = createRequire(import.meta.url)('tree-sitter-ruby') as Parameters<
  typeof makeCfgHarness
>[0];

const rb: CfgHarness = makeCfgHarness(rubyGrammar, createRubyCfgVisitor(), 'fixture.rb');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

/** An edge {from, to, kind} exists. */
const hasEdge = (cfg: FunctionCfg, from: number, to: number, kind: string): boolean =>
  cfg.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

describe('Ruby CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = rb.cfgOf(`def f\n  a()\n  b()\n  c()\nend\n`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(hasEdge(cfg, cfg.entryIndex, body, 'seq')).toBe(true);
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty method body: ENTRY → EXIT, never throws', () => {
    const cfg = rb.cfgOf(`def f\nend\n`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('method, singleton_method, block and lambda are all CFG-bearing', () => {
    const cfgs = rb.cfgsOf(
      `def f\n  x()\nend\n\ndef self.g\n  y()\nend\n\n[1].each { |n| use(n) }\n\nh = ->(q) { q + 1 }\n`,
    );
    expect(cfgs.length).toBeGreaterThanOrEqual(4);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('unmodeled / no-method shape → never throws', () => {
    const root = rb.parse(`class C\n  X = 1\nend\n`);
    const fns = rb.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createRubyCfgVisitor().buildFunctionCfg(fn, 'f.rb')).not.toThrow();
    }
  });
});

describe('Ruby CfgVisitor — if / elsif / else / unless', () => {
  it('if/elsif/else: branch senses; every arm reaches the join', () => {
    const cfg = rb.cfgOf(
      `def f(x)\n  if x > 0\n    a()\n  elsif x < 0\n    b()\n  else\n    c()\n  end\n  after()\nend\n`,
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'after()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), join)).toBe(true);
    const ifHeader = block(cfg, 'x > 0');
    const elifHeader = block(cfg, 'x < 0');
    expect(hasEdge(cfg, ifHeader, block(cfg, 'a()'), 'cond-true')).toBe(true);
    expect(hasEdge(cfg, ifHeader, elifHeader, 'cond-false')).toBe(true);
    expect(hasEdge(cfg, elifHeader, block(cfg, 'b()'), 'cond-true')).toBe(true);
    expect(hasEdge(cfg, elifHeader, block(cfg, 'c()'), 'cond-false')).toBe(true);
  });

  it('unless inverts the branch sense (body is the cond-false arm)', () => {
    const cfg = rb.cfgOf(`def f(x)\n  unless x\n    u()\n  end\n  after()\nend\n`);
    const header = cfg.blocks.find((b) => b.text === 'x')!.index;
    // unless's body runs when the condition is FALSE.
    expect(hasEdge(cfg, header, block(cfg, 'u()'), 'cond-false')).toBe(true);
    expect(reaches(cfg, header, block(cfg, 'after()'))).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('if with no else: cond-true to the body, fall-through to the join', () => {
    const cfg = rb.cfgOf(`def f(x)\n  if x\n    a()\n  end\n  after()\nend\n`);
    const header = cfg.blocks.find((b) => b.text === 'x')!.index;
    const after = block(cfg, 'after()');
    expect(hasEdge(cfg, header, block(cfg, 'a()'), 'cond-true')).toBe(true);
    expect(reaches(cfg, header, after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), after)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Ruby CfgVisitor — statement-modifier forms', () => {
  it('`x = 1 if c` runs the body on cond-true; complement falls through', () => {
    const cfg = rb.cfgOf(`def f(c)\n  y = 1 if c\n  after()\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    const header = cfg.blocks.find((b) => b.text === 'c')!.index;
    const body = block(cfg, 'y = 1');
    expect(hasEdge(cfg, header, body, 'cond-true')).toBe(true);
    // both the taken body and the complement reach the join.
    expect(reaches(cfg, header, block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, body, block(cfg, 'after()'))).toBe(true);
  });

  it('`step() while c` is a modifier loop: cond-true / loop-back / cond-false', () => {
    const cfg = rb.cfgOf(`def f(c)\n  step() while c\n  after()\nend\n`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const header = cfg.blocks.find((b) => b.text === 'c')!.index;
    expect(reaches(cfg, block(cfg, 'step()'), header)).toBe(true);
  });
});

describe('Ruby CfgVisitor — while / until / for / loop', () => {
  it('while: header + body + loop-back; exit reachable', () => {
    const cfg = rb.cfgOf(`def f(x)\n  while x > 0\n    x -= 1\n  end\n  done()\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const body = block(cfg, 'x -= 1');
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done()'))).toBe(true);
  });

  it('until inverts: body runs while the condition is false, exit on cond-false', () => {
    const cfg = rb.cfgOf(`def f\n  until done\n    step()\n  end\n  after()\nend\n`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true); // header → body
    expect(kinds.has('loop-back')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true); // header → loop exit
    const body = block(cfg, 'step()');
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'after()'))).toBe(true);
  });

  it('for x in xs: loop var is a def, iterable a use; loop-back + exit', () => {
    const cfg = rb.cfgOf(`def f(xs)\n  for i in xs\n    use(i)\n  end\n  done()\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'i'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'xs'))).toBe(true);
    const body = block(cfg, 'use(i)');
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(reaches(cfg, header!, block(cfg, 'done()'))).toBe(true);
  });

  it('`while true` keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = rb.cfgOf(`def f(x)\n  while true\n    g() if x\n  end\nend\n`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('`loop do … end` block keeps its own EXIT reverse-reachable', () => {
    // `loop do … end` parses as a call carrying a do_block — the block is its own
    // CFG. The block body's normal fall-off reaches the block EXIT (structural
    // escape), so the post-dominator pass is not silently skipped for it.
    const cfgs = rb.cfgsOf(`def f\n  loop do\n    work()\n  end\nend\n`);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Ruby CfgVisitor — case / when (no fallthrough)', () => {
  it('case/when dispatches across cases; no fallthrough between case bodies', () => {
    const cfg = rb.cfgOf(
      `def f(x)\n  case x\n  when 1\n    one()\n  when 2\n    two()\n  else\n    other()\n  end\n  after()\nend\n`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'other()'), block(cfg, 'after()'))).toBe(true);
    // case 1 does NOT fall into case 2 (no implicit fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
  });

  it('case/when with no else keeps EXIT reverse-reachable (no-match path)', () => {
    const cfg = rb.cfgOf(
      `def f(x)\n  case x\n  when 1\n    one()\n  when 2\n    two()\n  end\n  after()\nend\n`,
    );
    const dispatch = cfg.blocks.find((b) => b.text.startsWith('case '))!.index;
    expect(reaches(cfg, dispatch, block(cfg, 'after()'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });
});

describe('Ruby CfgVisitor — case / in (pattern matching, no fallthrough)', () => {
  it('case/in dispatches; the array-pattern binds, no fallthrough', () => {
    const cfg = rb.cfgOf(
      `def f(obj)\n  case obj\n  in [a, b]\n    pair(a, b)\n  in Integer\n    int()\n  else\n    no()\n  end\nend\n`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(reaches(cfg, block(cfg, 'pair(a, b)'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'int()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'no()'), cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, block(cfg, 'pair(a, b)'), block(cfg, 'int()'))).toBe(false);
  });

  it('an in-clause guard is harvested as a conditional use on the dispatch', () => {
    const cfg = rb.cfgOf(
      `def f(x, k)\n  case x\n  in Integer if x > k\n    use(x)\n  else\n    other()\n  end\nend\n`,
    );
    expect(hasUse(cfg, bindingIdx(cfg, 'k'))).toBe(true);
  });
});

describe('Ruby CfgVisitor — begin / rescue / else / ensure', () => {
  it('begin/rescue/else/ensure: completion edges; ensure runs on all paths', () => {
    const cfg = rb.cfgOf(
      `def f\n  begin\n    body()\n  rescue StandardError => e\n    handle(e)\n  else\n    noerr()\n  ensure\n    cleanup()\n  end\n  after()\nend\n`,
    );
    const ensureB = block(cfg, 'cleanup()');
    expect(reaches(cfg, block(cfg, 'body()'), ensureB)).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle(e)'), ensureB)).toBe(true);
    expect(reaches(cfg, block(cfg, 'noerr()'), ensureB)).toBe(true);
    expect(reaches(cfg, ensureB, block(cfg, 'after()'))).toBe(true);
    // the protected body can throw to the handler.
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handle(e)'))).toBe(true);
    // the else runs only after the body (no exception).
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'noerr()'))).toBe(true);
    // `rescue ... => e` binds e (catch-kind).
    expect(hasDef(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('method-level implicit begin: a bare def + rescue/ensure threads correctly', () => {
    const cfg = rb.cfgOf(`def f\n  risky()\nrescue => e\n  handle()\nensure\n  done()\nend\n`);
    const ensureB = block(cfg, 'done()');
    expect(reaches(cfg, block(cfg, 'risky()'), block(cfg, 'handle()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle()'), ensureB)).toBe(true);
    expect(reaches(cfg, ensureB, cfg.exitIndex)).toBe(true);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
  });

  it('multiple rescue clauses are both reachable from the protected body', () => {
    const cfg = rb.cfgOf(
      `def f\n  begin\n    body()\n  rescue TypeError\n    handleT()\n  rescue KeyError\n    handleK()\n  end\nend\n`,
    );
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handleT()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handleK()'))).toBe(true);
  });

  it('return inside begin threads through ensure (finally-return)', () => {
    const cfg = rb.cfgOf(
      `def f(x)\n  begin\n    return 1 if x\n    body()\n  ensure\n    cleanup()\n  end\nend\n`,
    );
    const ensureB = block(cfg, 'cleanup()');
    expect(reaches(cfg, block(cfg, 'return 1'), ensureB)).toBe(true);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
    expect(reaches(cfg, ensureB, cfg.exitIndex)).toBe(true);
  });

  it('retry re-enters the begin protected body (loop-back)', () => {
    const cfg = rb.cfgOf(`def f\n  begin\n    risky()\n  rescue\n    retry\n  end\nend\n`);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const retryB = block(cfg, 'retry');
    const bodyB = block(cfg, 'risky()');
    expect(hasEdge(cfg, retryB, bodyB, 'loop-back')).toBe(true);
  });
});

describe('Ruby CfgVisitor — block jumps (next / break / redo)', () => {
  it('next ≈ continue, break exits, redo re-enters the block body', () => {
    // The block (`do … end`) is its own CFG; inspect it (index 1, after the method).
    const cfgs = rb.cfgsOf(
      `def f(xs)\n  xs.each do |n|\n    next if n == 1\n    break if n == 2\n    redo if n == 3\n    use(n)\n  end\nend\n`,
    );
    const blk = cfgs[1];
    const kinds = new Set(blk.edges.map((e) => e.kind));
    expect(kinds.has('continue')).toBe(true); // next
    expect(kinds.has('break')).toBe(true); // break
    expect(kinds.has('loop-back')).toBe(true); // redo re-enters the body
    // block param |n| is a def.
    expect(hasDef(blk, bindingIdx(blk, 'n'))).toBe(true);
    // redo loops back to the block body entry, NOT to EXIT.
    const redoB = blk.blocks.find((b) => b.text === 'redo')!.index;
    expect(blk.edges.some((e) => e.from === redoB && e.kind === 'loop-back')).toBe(true);
  });
});

describe('Ruby CfgVisitor — def/use harvest', () => {
  it('x = 1 then use(x): def then use', () => {
    const cfg = rb.cfgOf(`def f\n  x = 1\n  use(x)\nend\n`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('multiple assignment a, b = f() defines BOTH a and b', () => {
    const cfg = rb.cfgOf(`def f\n  a, b = load()\n  use(a, b)\nend\n`);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('operator-assign x += 1 reads AND writes the lvalue', () => {
    const cfg = rb.cfgOf(`def f\n  x = 1\n  x += 3\nend\n`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('block param |x| defines x', () => {
    const cfgs = rb.cfgsOf(`def f(xs)\n  xs.map { |item| item * 2 }\nend\n`);
    const blk = cfgs[1];
    expect(hasDef(blk, bindingIdx(blk, 'item'))).toBe(true);
    expect(hasUse(blk, bindingIdx(blk, 'item'))).toBe(true);
  });

  it('method params (incl. defaults / *splat / **kwsplat / &block / keyword) define at ENTRY', () => {
    const cfg = rb.cfgOf(
      `def f(a, b = 1, *rest, key:, **opts, &blk)\n  use(a, b, rest, key, opts)\nend\n`,
    );
    for (const name of ['a', 'b', 'rest', 'key', 'opts', 'blk']) {
      expect(hasDef(cfg, bindingIdx(cfg, name))).toBe(true);
    }
  });

  it('an assignment in an && right operand is a may-def (conditional context)', () => {
    const cfg = rb.cfgOf(`def f(a, b)\n  z = a && (w = b)\n  use(z)\nend\n`);
    expect(hasMayDef(cfg, bindingIdx(cfg, 'w'))).toBe(true);
    // not a must-def — the not-taken short-circuit path skips it.
    expect(hasDef(cfg, bindingIdx(cfg, 'w'))).toBe(false);
  });

  it('instance/class/global var writes are NOT scalar local defs', () => {
    const cfg = rb.cfgOf(`def f\n  @ivar = 1\n  @@cvar = 2\n  $g = 3\nend\n`);
    for (const name of ['@ivar', '@@cvar', '$g']) {
      expect((cfg.bindings ?? []).some((b) => b.name === name)).toBe(false);
    }
  });
});

describe('Ruby CfgVisitor — value-position branches (#2205)', () => {
  it('x = if c then a else b end models both arms (cond-true/cond-false), binds x', () => {
    const cfg = rb.cfgOf(`def f(c)\n  x = if c then a() else b() end\n  use(x)\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(hasDef(cfg, bindingIdx(cfg, 'x'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'x'))).toBe(true);
  });

  it('x = case k when ... end models each arm (switch-case), binds x', () => {
    const cfg = rb.cfgOf(
      `def f(k)\n  x = case k\n  when 1 then a()\n  else b()\n  end\n  use(x)\nend\n`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    expect(hasDef(cfg, bindingIdx(cfg, 'x'))).toBe(true);
  });

  it('implicit return of a bare if (last expression) is modeled as a branch', () => {
    // The idiomatic Ruby "return a conditional" — a bare if/case as the method's
    // last expression — is statement position and already branches.
    const cfg = rb.cfgOf(`def f(c)\n  if c then a() else b() end\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('x = if c then a end (no else) still branches — the then is control-dependent on c', () => {
    const cfg = rb.cfgOf(`def f(c)\n  x = if c then a() end\n  use(x)\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('a plain assignment (no branch RHS) still coalesces — no branch edges', () => {
    const cfg = rb.cfgOf(`def f\n  x = foo()\n  use(x)\nend\n`);
    expect(edgeKinds(cfg).has('cond-true')).toBe(false);
    expect(edgeKinds(cfg).has('switch-case')).toBe(false);
  });
});

describe('Ruby CfgVisitor — functionStartColumn', () => {
  it('two same-line blocks get distinct functionStartColumn', () => {
    const cfgs = rb.cfgsOf(`a.map { |x| x() }; b.map { |y| y() }\n`);
    const blocks = cfgs.filter((c) => c.functionStartLine === 1);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0].functionStartColumn).not.toBe(blocks[1].functionStartColumn);
  });
});

describe('Ruby CfgVisitor — production CDG probe (plan-required)', () => {
  it('while true / nested-if gives exitReachable=true and CDG edges > 0', () => {
    const cfg = rb.cfgOf(`def f(x)\n  while true\n    g() if x\n  end\nend\n`);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Ruby CfgVisitor — call sites ARE harvested (this unit)', () => {
  it('statements carry a sites key for each call (see harvest.test.ts for the shapes)', () => {
    const cfg = rb.cfgOf(`def f(cmd)\n  exec(cmd)\n  x = escape(cmd)\n  use(x)\nend\n`);
    const callees = cfg.blocks
      .flatMap((b) => b.statements ?? [])
      .flatMap((s) => s.sites ?? [])
      .filter((site) => site.kind === 'call')
      .map((site) => site.callee);
    // `exec`, `escape`, and `use` each open a call site (the taint substrate).
    expect(callees).toContain('exec');
    expect(callees).toContain('escape');
    expect(callees).toContain('use');
  });
});
