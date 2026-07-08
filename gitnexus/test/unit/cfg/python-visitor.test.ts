import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createPythonCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/python.js';
import type { FunctionCfg, SiteRecord } from '../../../src/core/ingestion/cfg/types.js';
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

// The Python CfgVisitor — one hazard per test (real-parser regression, NOT
// snapshot-pinning). Each fixture's distinctive statement text (a(), one(),
// done(), …) lets us locate the block for a region by text and assert the
// control-flow topology around it. Python is the most structurally divergent
// target: indentation blocks, elif, for/while-else, with, try/except/else/finally,
// match/case. The `while True:` EXIT-reachability + CDG regressions are
// load-bearing.

const pyGrammar = createRequire(import.meta.url)('tree-sitter-python') as Parameters<
  typeof makeCfgHarness
>[0];

const py: CfgHarness = makeCfgHarness(pyGrammar, createPythonCfgVisitor(), 'fixture.py');

const hasDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.defs.includes(idx)));
const hasUse = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => s.uses.includes(idx)));
const hasMayDef = (cfg: FunctionCfg, idx: number): boolean =>
  cfg.blocks.some((bl) => bl.statements?.some((s) => (s.mayDefs ?? []).includes(idx)));

/** An edge {from, to, kind} exists. */
const hasEdge = (cfg: FunctionCfg, from: number, to: number, kind: string): boolean =>
  cfg.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

describe('Python CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT (seq)', () => {
    const cfg = py.cfgOf(`def f():\n    a()\n    b()\n    c()\n`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a()');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: body, kind: 'seq' });
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body (pass only): ENTRY → block → EXIT', () => {
    const cfg = py.cfgOf(`def f():\n    pass\n`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('function and lambda are both CFG-bearing', () => {
    const cfgs = py.cfgsOf(`def f():\n    x()\n\ng = lambda y: y + 1\n`);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('async def is the same node; its body builds a CFG', () => {
    const cfg = py.cfgOf(`async def f(c):\n    await c\n    work()\n`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    expect(reachable(cfg, block(cfg, 'work()'))).toBe(true);
  });

  it('unmodeled / no-body shape → undefined, never throws', () => {
    const root = py.parse(`class C:\n    x = 1\n`);
    const fns = py.collectFunctions(root);
    for (const fn of fns) {
      expect(() => createPythonCfgVisitor().buildFunctionCfg(fn, 'f.py')).not.toThrow();
    }
  });
});

describe('Python CfgVisitor — if / elif / else', () => {
  it('if/elif/else: branch senses; every arm reaches the join', () => {
    const cfg = py.cfgOf(
      `def f(x):\n    if x > 0:\n        a()\n    elif x < 0:\n        b()\n    else:\n        c()\n    after()\n`,
    );
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'after()');
    expect(reaches(cfg, block(cfg, 'a()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b()'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'c()'), join)).toBe(true);
    // the if-true arm is reached by cond-true; the elif chains on cond-false.
    const ifHeader = block(cfg, 'x > 0');
    const elifHeader = block(cfg, 'x < 0');
    expect(hasEdge(cfg, ifHeader, block(cfg, 'a()'), 'cond-true')).toBe(true);
    expect(hasEdge(cfg, ifHeader, elifHeader, 'cond-false')).toBe(true);
    expect(hasEdge(cfg, elifHeader, block(cfg, 'b()'), 'cond-true')).toBe(true);
    expect(hasEdge(cfg, elifHeader, block(cfg, 'c()'), 'cond-false')).toBe(true);
  });

  it('if with no else: cond-true to the body, seq fall-through to the join', () => {
    // Mirrors the shared TS/Go visitor contract: a no-else `if` emits only the
    // taken `cond-true` arm; the not-taken path falls through to the join as
    // `seq`, which the CDG pass treats as the complement (false) arm.
    const cfg = py.cfgOf(`def f(x):\n    if x:\n        a()\n    after()\n`);
    const header = cfg.blocks.find((b) => b.text === 'x')!.index;
    const after = block(cfg, 'after()');
    expect(hasEdge(cfg, header, block(cfg, 'a()'), 'cond-true')).toBe(true);
    // both the taken arm and the fall-through reach the join.
    expect(reaches(cfg, header, after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'a()'), after)).toBe(true);
    // the `if` is a real control point — CDG is non-empty.
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Python CfgVisitor — for / while with the loop else', () => {
  it('for: header + body + loop-back; loop var is a def, iterable a use', () => {
    const cfg = py.cfgOf(`def f(xs):\n    for i in xs:\n        step(i)\n    done()\n`);
    const body = block(cfg, 'step(i)');
    expect(edgeKinds(cfg).has('cond-true')).toBe(true);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const header = cfg.edges.find((e) => e.kind === 'loop-back' && e.from === body)?.to;
    expect(header).toBeDefined();
    expect(reaches(cfg, header!, block(cfg, 'done()'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'i'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'xs'))).toBe(true);
  });

  it('for-else: the else runs on NORMAL completion (cond-false), NOT on break', () => {
    const cfg = py.cfgOf(
      `def f(xs):\n    for i in xs:\n        if i:\n            break\n    else:\n        noBreak()\n    after()\n`,
    );
    const header = cfg.blocks.find((b) => b.text.startsWith('for '))!.index;
    const elseB = block(cfg, 'noBreak()');
    const breakB = block(cfg, 'break');
    // the else is on the cond-false (normal completion) edge from the header...
    expect(hasEdge(cfg, header, elseB, 'cond-false')).toBe(true);
    // ...and the break does NOT route through the else.
    expect(reaches(cfg, breakB, elseB)).toBe(false);
    // both the else and the break reach the post-loop join.
    expect(reaches(cfg, elseB, block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, breakB, block(cfg, 'after()'))).toBe(true);
  });

  it('while-else: same else-on-normal-completion / not-on-break semantics', () => {
    const cfg = py.cfgOf(
      `def f(x):\n    while x > 0:\n        if cond():\n            break\n        x -= 1\n    else:\n        clean()\n    after()\n`,
    );
    const header = block(cfg, 'x > 0');
    const elseB = block(cfg, 'clean()');
    const breakB = block(cfg, 'break');
    expect(hasEdge(cfg, header, elseB, 'cond-false')).toBe(true);
    expect(reaches(cfg, breakB, elseB)).toBe(false);
    expect(reaches(cfg, breakB, block(cfg, 'after()'))).toBe(true);
  });

  it('while True: keeps EXIT reverse-reachable AND emits CDG > 0', () => {
    const cfg = py.cfgOf(`def f(x):\n    while True:\n        if x:\n            g()\n`);
    expect(edgeKinds(cfg).has('cond-false')).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });

  it('continue re-tests the loop header', () => {
    const cfg = py.cfgOf(
      `def f(xs):\n    for i in xs:\n        if i:\n            continue\n        use(i)\n`,
    );
    const header = cfg.blocks.find((b) => b.text.startsWith('for '))!.index;
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    expect(reaches(cfg, block(cfg, 'continue'), header)).toBe(true);
  });
});

describe('Python CfgVisitor — with (deterministic dispose on normal AND exception exit)', () => {
  it('with runs the body then __exit__ (dispose) on the normal path', () => {
    const cfg = py.cfgOf(`def f():\n    with open('x') as fh:\n        use(fh)\n    after()\n`);
    const dispose = cfg.blocks.find((b) => b.text.startsWith('with '))!.index;
    const body = block(cfg, 'use(fh)');
    // body → dispose → after on the normal path.
    expect(reaches(cfg, body, dispose)).toBe(true);
    expect(reaches(cfg, dispose, block(cfg, 'after()'))).toBe(true);
    // the `as fh` alias is a def.
    expect(hasDef(cfg, bindingIdx(cfg, 'fh'))).toBe(true);
  });

  it('with runs __exit__ on the EXCEPTION path too (body raises → dispose via throw)', () => {
    const cfg = py.cfgOf(`def f():\n    with lock() as l:\n        boom()\n    after()\n`);
    const dispose = cfg.blocks.find((b) => b.text.startsWith('with '))!.index;
    const body = block(cfg, 'boom()');
    // an exception inside the body routes to the dispose via a throw edge.
    expect(hasEdge(cfg, body, dispose, 'throw')).toBe(true);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
  });

  it('return inside a with threads through the dispose', () => {
    const cfg = py.cfgOf(`def f():\n    with open('x') as fh:\n        return read(fh)\n`);
    const dispose = cfg.blocks.find((b) => b.text.startsWith('with '))!.index;
    const ret = block(cfg, 'return read(fh)');
    expect(reaches(cfg, ret, dispose)).toBe(true);
    expect(reaches(cfg, dispose, cfg.exitIndex)).toBe(true);
  });
});

describe('Python CfgVisitor — try / except / else / finally', () => {
  it('try/except/else/finally: completion edges; finally runs on all paths', () => {
    const cfg = py.cfgOf(
      `def f():\n    try:\n        body()\n    except ValueError as e:\n        handle(e)\n    else:\n        noerr()\n    finally:\n        cleanup()\n    after()\n`,
    );
    const finallyB = block(cfg, 'cleanup()');
    expect(reaches(cfg, block(cfg, 'body()'), finallyB)).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle(e)'), finallyB)).toBe(true);
    expect(reaches(cfg, block(cfg, 'noerr()'), finallyB)).toBe(true);
    expect(reaches(cfg, finallyB, block(cfg, 'after()'))).toBe(true);
    // the protected body can throw to the handler.
    expect(edgeKinds(cfg).has('throw')).toBe(true);
    // the else runs only after the body (no exception).
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'noerr()'))).toBe(true);
    // `except E as e` binds e (catch-kind).
    expect(hasDef(cfg, bindingIdx(cfg, 'e'))).toBe(true);
  });

  it('except group (except*) is a handler from the body', () => {
    const cfg = py.cfgOf(
      `def f():\n    try:\n        body()\n    except* ValueError as e:\n        handle(e)\n    after()\n`,
    );
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handle(e)'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'handle(e)'), block(cfg, 'after()'))).toBe(true);
    expect(edgeKinds(cfg).has('throw')).toBe(true);
  });

  it('multiple except clauses are both reachable from the protected body', () => {
    const cfg = py.cfgOf(
      `def f():\n    try:\n        body()\n    except ValueError:\n        handleV()\n    except (TypeError, KeyError):\n        handleT()\n    after()\n`,
    );
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handleV()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'body()'), block(cfg, 'handleT()'))).toBe(true);
  });

  it('return inside try threads through finally', () => {
    const cfg = py.cfgOf(
      `def f(x):\n    try:\n        if x:\n            return 1\n        body()\n    finally:\n        cleanup()\n`,
    );
    const finallyB = block(cfg, 'cleanup()');
    expect(reaches(cfg, block(cfg, 'return 1'), finallyB)).toBe(true);
    expect(edgeKinds(cfg).has('finally-return')).toBe(true);
    expect(reaches(cfg, finallyB, cfg.exitIndex)).toBe(true);
  });
});

describe('Python CfgVisitor — match / case (no fallthrough)', () => {
  it('match dispatches across cases; no fallthrough between case bodies', () => {
    const cfg = py.cfgOf(
      `def f(x):\n    match x:\n        case 1:\n            one()\n        case 2:\n            two()\n        case _:\n            other()\n    after()\n`,
    );
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    // each case body rejoins after the match...
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'two()'), block(cfg, 'after()'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'other()'), block(cfg, 'after()'))).toBe(true);
    // ...but case 1 does NOT fall into case 2 (no implicit fallthrough).
    expect(reaches(cfg, block(cfg, 'one()'), block(cfg, 'two()'))).toBe(false);
  });

  it('match with no wildcard keeps EXIT reverse-reachable (no-match path)', () => {
    const cfg = py.cfgOf(
      `def f(x):\n    match x:\n        case 1:\n            one()\n        case 2:\n            two()\n    after()\n`,
    );
    // the dispatch reaches the exit directly (no `case _`) so after() is reachable.
    const dispatch = cfg.blocks.find((b) => b.text.startsWith('match '))!.index;
    expect(reaches(cfg, dispatch, block(cfg, 'after()'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('a case guard is harvested as a conditional use on the dispatch', () => {
    const cfg = py.cfgOf(
      `def f(x, k):\n    match x:\n        case y if y > k:\n            use(y)\n        case _:\n            other()\n`,
    );
    expect(hasUse(cfg, bindingIdx(cfg, 'k'))).toBe(true);
  });
});

describe('Python CfgVisitor — def/use harvest', () => {
  it('x = a then use(x): def then use', () => {
    const cfg = py.cfgOf(`def f(a):\n    x = a\n    use(x)\n`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('tuple unpack a, b = f() defines BOTH a and b', () => {
    const cfg = py.cfgOf(`def f():\n    a, b = load()\n    use(a, b)\n`);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'b'))).toBe(true);
  });

  it('list unpack [c, d] = pair() and star target first, *rest = seq() define all', () => {
    const cfg = py.cfgOf(`def f():\n    [c, d] = pair()\n    first, *rest = seq()\n`);
    expect(hasDef(cfg, bindingIdx(cfg, 'c'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'd'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'first'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'rest'))).toBe(true);
  });

  it('augmented assignment x += 1 reads AND writes the lvalue', () => {
    const cfg = py.cfgOf(`def f():\n    x = 1\n    x += 3\n`);
    const x = bindingIdx(cfg, 'x');
    expect(hasDef(cfg, x)).toBe(true);
    expect(hasUse(cfg, x)).toBe(true);
  });

  it('walrus (n := f()) defines n; the condition uses it', () => {
    const cfg = py.cfgOf(`def f():\n    if (n := compute()) > 0:\n        use(n)\n`);
    const n = bindingIdx(cfg, 'n');
    expect(hasDef(cfg, n)).toBe(true);
    expect(hasUse(cfg, n)).toBe(true);
  });

  it('comprehension target [i for i in xs] defines i; xs is a use', () => {
    const cfg = py.cfgOf(`def f(xs):\n    a = [i for i in xs if i > 0]\n    use(a)\n`);
    expect(hasDef(cfg, bindingIdx(cfg, 'i'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'xs'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
  });

  it('with ... as t defines t; for ... in src uses src', () => {
    const cfg = py.cfgOf(`def f(src):\n    with src as t:\n        use(t)\n`);
    expect(hasDef(cfg, bindingIdx(cfg, 't'))).toBe(true);
    expect(hasUse(cfg, bindingIdx(cfg, 'src'))).toBe(true);
  });

  it('a walrus in a ternary arm is a may-def (conditional context)', () => {
    const cfg = py.cfgOf(`def f(c, p, q):\n    x = (a := p) if c else (b := q)\n    use(x)\n`);
    // both arm walruses are conditionally evaluated → may-defs, not must-defs.
    expect(hasMayDef(cfg, bindingIdx(cfg, 'a'))).toBe(true);
    expect(hasMayDef(cfg, bindingIdx(cfg, 'b'))).toBe(true);
    expect(hasDef(cfg, bindingIdx(cfg, 'a'))).toBe(false);
  });

  it('a walrus in an or/and right operand is a may-def', () => {
    const cfg = py.cfgOf(`def f(a, b):\n    z = a or (w := b)\n    use(z)\n`);
    expect(hasMayDef(cfg, bindingIdx(cfg, 'w'))).toBe(true);
  });

  it('attribute write obj.f = 1 is NOT a scalar def; root is a use', () => {
    const cfg = py.cfgOf(`def f(obj):\n    obj.field = 1\n    use(obj)\n`);
    expect(hasUse(cfg, bindingIdx(cfg, 'obj'))).toBe(true);
    // no `field` binding exists (member writes are not scalar defs).
    expect((cfg.bindings ?? []).some((b) => b.name === 'field')).toBe(false);
  });

  it('parameters (incl. *args / **kwargs / defaults) define at ENTRY', () => {
    const cfg = py.cfgOf(`def f(a, b=1, *args, **kwargs):\n    use(a, b, args, kwargs)\n`);
    for (const name of ['a', 'b', 'args', 'kwargs']) {
      expect(hasDef(cfg, bindingIdx(cfg, name))).toBe(true);
    }
  });

  it('global names resolve to a shared synthetic module binding (no false local)', () => {
    const cfg = py.cfgOf(`def f():\n    global G\n    G = 1\n    use(G)\n`);
    const g = bindingIdx(cfg, 'G');
    expect((cfg.bindings ?? [])[g].synthetic).toBe(true);
    expect(hasUse(cfg, g)).toBe(true);
  });
});

describe('Python CfgVisitor — functionStartColumn', () => {
  it('two same-line lambdas get distinct functionStartColumn', () => {
    const cfgs = py.cfgsOf(`d = {"a": lambda: x(), "b": lambda: y()}\n`);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine);
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn);
  });
});

describe('Python CfgVisitor — production CDG probe (plan-required)', () => {
  it('while True / nested if gives exitReachable=true and CDG edges > 0', () => {
    const cfg = py.cfgOf(`def f(x):\n    while True:\n        if x:\n            g()\n`);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
  });
});

describe('Python CfgVisitor — taint-site substrate', () => {
  it('harvests call, member-read, argument, receiver, and result-def sites', () => {
    const cfg = py.cfgOf(
      `def f(request, db):\n    db.query(request.args)\n    value = sanitize(request.form)\n`,
    );
    const request = bindingIdx(cfg, 'request');
    const db = bindingIdx(cfg, 'db');
    const value = bindingIdx(cfg, 'value');
    const sites: SiteRecord[] = cfg.blocks.flatMap((b) =>
      (b.statements ?? []).flatMap((s) => [...(s.sites ?? [])]),
    );

    const query = sites.find((s) => s.kind === 'call' && s.callee === 'db.query');
    expect(query?.receiver).toBe(db);
    expect(query?.args?.[0]).toContain(request);
    expect(query?.at).toEqual([2, 4]);

    expect(
      sites.some((s) => s.kind === 'member-read' && s.object === request && s.property === 'args'),
    ).toBe(true);

    const sanitize = sites.find((s) => s.kind === 'call' && s.callee === 'sanitize');
    expect(sanitize?.resultDefs).toEqual([value]);
    expect(sanitize?.at).toEqual([3, 12]);
  });
});
