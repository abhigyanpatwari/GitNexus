import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { block, edgeKinds, reaches, reachable } from '../../helpers/cfg-harness.js';

// U2 — the TS/JS CfgVisitor, one hazard per test. Each fixture's distinctive
// statement text (markerWork(), handleErr(), cleanup(), …) lets us find the
// block for a region by text and assert the control-flow topology around it
// (R2, R10). The classic CFG hazards — loops/back-edges, switch fallthrough,
// try/finally post-domination, labeled jumps — are where builders break.

const visitor = createTypeScriptCfgVisitor();

function parse(code: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code).rootNode;
}

function collectFunctions(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as SyntaxNode;
    if (TS_FUNCTION_TYPES.has(n.type)) out.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

/** Build the CFG for the first (outermost-first by traversal) function in code. */
function cfgOf(code: string, index = 0): FunctionCfg {
  const fns = collectFunctions(parse(code));
  const fn = fns[index];
  if (!fn) throw new Error(`no function at index ${index}`);
  const cfg = visitor.buildFunctionCfg(fn, 'fixture.ts');
  if (!cfg) throw new Error('buildFunctionCfg returned undefined');
  return cfg;
}

describe('TS/JS CfgVisitor — structure', () => {
  it('straight-line body: ENTRY → block → EXIT', () => {
    const cfg = cfgOf(`function f() { a(); b(); c(); }`);
    // a/b/c coalesce into one basic block
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toHaveLength(1);
    const body = block(cfg, 'a();');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true);
    expect(reaches(cfg, body, cfg.exitIndex)).toBe(true);
  });

  it('empty body: ENTRY → EXIT', () => {
    const cfg = cfgOf(`function f() {}`);
    expect(cfg.blocks).toHaveLength(2);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
  });

  it('expression-bodied arrow returns its expression', () => {
    const cfg = cfgOf(`const f = (x: number) => x + 1;`);
    const expr = block(cfg, 'x + 1');
    expect(cfg.edges).toContainEqual({ from: expr, to: cfg.exitIndex, kind: 'return' });
  });
});

describe('TS/JS CfgVisitor — branching', () => {
  it('if/else diamond emits cond-true + cond-false, both reach the join', () => {
    const cfg = cfgOf(`function f(x) { if (x) { a(); } else { b(); } c(); }`);
    const kinds = edgeKinds(cfg);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    const join = block(cfg, 'c();');
    expect(reaches(cfg, block(cfg, 'a();'), join)).toBe(true);
    expect(reaches(cfg, block(cfg, 'b();'), join)).toBe(true);
  });

  it('else-if chain: all three arms reachable and rejoin', () => {
    const cfg = cfgOf(`function f(x) {
      if (x === 1) { a(); }
      else if (x === 2) { b(); }
      else { c(); }
      d();
    }`);
    const join = block(cfg, 'd();');
    for (const arm of ['a();', 'b();', 'c();']) {
      expect(reachable(cfg, block(cfg, arm))).toBe(true);
      expect(reaches(cfg, block(cfg, arm), join)).toBe(true);
    }
  });

  it('plain if (no else): condition reaches both the body and the join', () => {
    const cfg = cfgOf(`function f(x) { if (x) { a(); } b(); }`);
    const cond = block(cfg, 'x'); // condition block
    const then = block(cfg, 'a();');
    const join = block(cfg, 'b();');
    expect(reaches(cfg, cond, then)).toBe(true);
    expect(reaches(cfg, cond, join)).toBe(true);
    expect(reaches(cfg, then, join)).toBe(true);
  });
});

describe('TS/JS CfgVisitor — loops', () => {
  it('while loop has a back-edge and an exit', () => {
    const cfg = cfgOf(`function f(x) { while (x > 0) { step(); } done(); }`);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    const body = block(cfg, 'step();');
    const header = block(cfg, 'x > 0');
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(reaches(cfg, header, block(cfg, 'done();'))).toBe(true);
  });

  it('do-while runs the body before testing and loops back', () => {
    const cfg = cfgOf(`function f(x) { do { step(); } while (x > 0); done(); }`);
    const body = block(cfg, 'step();');
    expect(reaches(cfg, cfg.entryIndex, body)).toBe(true); // body runs first
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(reaches(cfg, body, block(cfg, 'done();'))).toBe(true);
  });

  it('C-style for: init once, condition header, back-edge through increment', () => {
    const cfg = cfgOf(`function f() { for (let i = 0; i < n; i++) { step(); } done(); }`);
    const init = block(cfg, 'let i = 0');
    const incr = block(cfg, 'i++');
    const body = block(cfg, 'step();');
    expect(cfg.edges).toContainEqual({ from: cfg.entryIndex, to: init, kind: 'seq' });
    expect(reaches(cfg, body, incr)).toBe(true); // body → increment
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(reaches(cfg, incr, block(cfg, 'done();'))).toBe(true);
  });

  it('for-of loop builds a header/back-edge/exit', () => {
    const cfg = cfgOf(`function f(xs) { for (const x of xs) { use(x); } done(); }`);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(reaches(cfg, block(cfg, 'use(x)'), block(cfg, 'done();'))).toBe(true);
  });

  it('for-in loop builds a header/back-edge/exit', () => {
    const cfg = cfgOf(`function f(o) { for (const k in o) { use(k); } done(); }`);
    expect(edgeKinds(cfg).has('loop-back')).toBe(true);
    expect(reaches(cfg, block(cfg, 'use(k)'), block(cfg, 'done();'))).toBe(true);
  });

  it('for without increment: body carries the loop-back, no phantom header self-loop (#2099 F5)', () => {
    const cfg = cfgOf(`function f() { for (let i = 0; i < 3;) { i += 1; } done(); }`);
    const header = block(cfg, 'i < 3');
    const body = block(cfg, 'i += 1');
    // The ONLY loop-back is the real back-edge body→header; a header→header
    // self-loop would model a path that re-tests without running the body.
    expect(cfg.edges.filter((e) => e.kind === 'loop-back')).toEqual([
      { from: body, to: header, kind: 'loop-back' },
    ]);
    expect(cfg.edges.some((e) => e.from === header && e.to === header)).toBe(false);
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true);
  });

  it('for(;;) with conditional break: loop-back on the body, break reaches the join (#2099 F5)', () => {
    const cfg = cfgOf(`function f() { for (;;) { if (x) break; work(); } done(); }`);
    const work = block(cfg, 'work()');
    const loopBacks = cfg.edges.filter((e) => e.kind === 'loop-back');
    expect(loopBacks).toEqual([expect.objectContaining({ from: work })]);
    const header = loopBacks[0].to;
    expect(cfg.edges.some((e) => e.from === header && e.to === header)).toBe(false);
    expect(edgeKinds(cfg).has('break')).toBe(true);
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true);
  });

  it('for with increment keeps seq-to-increment and loop-back on the increment (F5 regression guard)', () => {
    const cfg = cfgOf(`function f() { for (let i = 0; i < 3; i++) { work(); } done(); }`);
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'work()'),
      to: block(cfg, 'i++'),
      kind: 'seq',
    });
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'i++'),
      to: block(cfg, 'i < 3'),
      kind: 'loop-back',
    });
  });

  it('empty body without increment keeps the genuine header self-loop', () => {
    const cfg = cfgOf(`function f() { for (let i = 0; i < 3;) {} done(); }`);
    const header = block(cfg, 'i < 3');
    expect(cfg.edges).toContainEqual({ from: header, to: header, kind: 'loop-back' });
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true);
  });
});

describe('TS/JS CfgVisitor — switch', () => {
  it('break-terminated cases dispatch to the exit, no fallthrough', () => {
    const cfg = cfgOf(`function f(x) {
      switch (x) {
        case 1: one(); break;
        case 2: two(); break;
        default: other();
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('switch-case')).toBe(true);
    const after = block(cfg, 'after();');
    expect(reaches(cfg, block(cfg, 'one();'), after)).toBe(true);
    expect(reaches(cfg, block(cfg, 'two();'), after)).toBe(true);
    // case 1 does NOT fall into case 2 (break severs it)
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(false);
  });

  it('fallthrough: a case without break flows into the next case', () => {
    const cfg = cfgOf(`function f(x) {
      switch (x) {
        case 1: one();
        case 2: two(); break;
      }
      after();
    }`);
    expect(edgeKinds(cfg).has('fallthrough')).toBe(true);
    expect(reaches(cfg, block(cfg, 'one();'), block(cfg, 'two();'))).toBe(true);
  });
});

describe('TS/JS CfgVisitor — try/catch/finally (R10)', () => {
  it('normal completion AND a throw both flow through finally; finally reaches the post-try block', () => {
    const cfg = cfgOf(`function f() {
      try {
        work();
        risky();
      } catch (e) {
        handleErr();
      } finally {
        cleanup();
      }
      afterTry();
    }`);
    const fin = block(cfg, 'cleanup();');
    const after = block(cfg, 'afterTry();');
    const work = block(cfg, 'work();');
    const handler = block(cfg, 'handleErr();');

    expect(edgeKinds(cfg).has('throw')).toBe(true);
    // normal path: try body → finally
    expect(reaches(cfg, work, fin)).toBe(true);
    // exceptional path: try body → catch → finally
    expect(reaches(cfg, work, handler)).toBe(true);
    expect(reaches(cfg, handler, fin)).toBe(true);
    // finally post-dominates and reaches the continuation
    expect(reaches(cfg, fin, after)).toBe(true);
  });

  it('try/finally with no catch: a throw still flows through finally', () => {
    const cfg = cfgOf(`function f() {
      try { risky(); } finally { cleanup(); }
      afterTry();
    }`);
    const fin = block(cfg, 'cleanup();');
    expect(reaches(cfg, block(cfg, 'risky();'), fin)).toBe(true);
    expect(reaches(cfg, fin, block(cfg, 'afterTry();'))).toBe(true);
  });

  it('an INTERIOR block of a branched try body reaches the handler (not just the body entry)', () => {
    // Regression guard: the exceptional edge must cover every protected-region
    // block, else a throw from inside a branch is invisible to the catch (a
    // taint false-negative into `catch` for the downstream PDG analysis).
    const cfg = cfgOf(`function f(x) {
      try {
        guardEntry();
        if (x) { deep(); }
      } catch (e) { handler(e); }
    }`);
    const handler = block(cfg, 'handler(e);');
    expect(reaches(cfg, block(cfg, 'deep();'), handler)).toBe(true); // interior → handler
    expect(reaches(cfg, block(cfg, 'guardEntry();'), handler)).toBe(true);
  });

  // #2099 F2 — an empty `catch {}` still CATCHES. The synthesized catch block
  // has empty text, so locate it as the target of a throw-kind edge.
  const throwTargets = (cfg: FunctionCfg): Set<number> =>
    new Set(cfg.edges.filter((e) => e.kind === 'throw').map((e) => e.to));

  it('empty catch {} swallows: throw lands in the catch, after-code reachable, no escape to EXIT (#2099 F2)', () => {
    const cfg = cfgOf(`function f() { try { throw new Error('x'); } catch {} after(); }`);
    const targets = throwTargets(cfg);
    expect(targets.has(cfg.exitIndex)).toBe(false); // swallowed — never escapes
    expect(targets.size).toBe(1);
    const synth = [...targets][0];
    expect(cfg.blocks[synth].text).toBe('');
    expect(cfg.blocks[synth].kind).toBe('normal');
    expect(reaches(cfg, synth, block(cfg, 'after();'))).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('empty catch (e) {} with a binding behaves the same as catch {}', () => {
    const cfg = cfgOf(`function f() { try { throw new Error('x'); } catch (e) {} after(); }`);
    expect(throwTargets(cfg).has(cfg.exitIndex)).toBe(false);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('comment-only catch body counts as empty (comments are filtered)', () => {
    const cfg = cfgOf(
      `function f() { try { throw new Error('x'); } catch { /* ignore */ } after(); }`,
    );
    expect(throwTargets(cfg).has(cfg.exitIndex)).toBe(false);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('empty catch + finally: catch flows into finally, no spurious re-propagation past it', () => {
    const cfg = cfgOf(`function f() {
      try { throw new Error('x'); } catch {} finally { fin(); }
      after();
    }`);
    const fin = block(cfg, 'fin();');
    // The swallowing catch exists, so the no-catch re-propagation gate must
    // not fire: finally's exit goes to the continuation, never throw→EXIT.
    expect(
      cfg.edges.some((e) => e.from === fin && e.to === cfg.exitIndex && e.kind === 'throw'),
    ).toBe(false);
    const synth = [...throwTargets(cfg)].filter((t) => t !== fin);
    expect(synth.length).toBeGreaterThan(0);
    expect(reaches(cfg, synth[0], fin)).toBe(true);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });

  it('non-empty catch is unchanged by the empty-catch synthesis (F2 regression guard)', () => {
    const cfg = cfgOf(`function f() { try { a(); } catch (e) { h(); } after(); }`);
    // The throw lands on the handler ENTRY — since M2 that is the catch-param
    // binding block (a facts-only block in front of the body), which flows
    // into the body. Assert the path, not block identity.
    const handlerEntries = [...throwTargets(cfg)];
    expect(handlerEntries.length).toBeGreaterThan(0);
    for (const t of handlerEntries) {
      expect(reaches(cfg, t, block(cfg, 'h();'))).toBe(true);
    }
    expect(reaches(cfg, block(cfg, 'h();'), block(cfg, 'after();'))).toBe(true);
  });

  it('empty try + empty catch does not crash; after-code reachable from ENTRY', () => {
    const cfg = cfgOf(`function f() { try {} catch {} after(); }`);
    expect(reachable(cfg, block(cfg, 'after();'))).toBe(true);
  });
});

describe('TS/JS CfgVisitor — non-local jumps (R10)', () => {
  it('early return wires to EXIT and ends its block', () => {
    const cfg = cfgOf(`function f(x) { if (x) { return; } tail(); }`);
    const ret = block(cfg, 'return;');
    expect(cfg.edges).toContainEqual({ from: ret, to: cfg.exitIndex, kind: 'return' });
  });

  it('labeled break resolves to the outer loop exit, not the inner loop', () => {
    const cfg = cfgOf(`function f(xs, ys) {
      outer: for (const x of xs) {
        for (const y of ys) {
          if (x === y) { break outer; }
          inner();
        }
        afterInner();
      }
      done();
    }`);
    expect(edgeKinds(cfg).has('break')).toBe(true);
    const brk = block(cfg, 'break outer;');
    const done = block(cfg, 'done();');
    // break outer escapes BOTH loops → reaches the post-loop block
    expect(reaches(cfg, brk, done)).toBe(true);
    // and does NOT route back through afterInner() (that's the inner loop's normal exit)
    expect(reaches(cfg, brk, block(cfg, 'afterInner();'))).toBe(false);
  });

  it('labeled continue resolves to the labeled loop header', () => {
    const cfg = cfgOf(`function f(xs, ys) {
      outer: for (const x of xs) {
        for (const y of ys) {
          if (x === y) { continue outer; }
          inner();
        }
      }
    }`);
    expect(edgeKinds(cfg).has('continue')).toBe(true);
    const cont = block(cfg, 'continue outer;');
    const outerHeader = block(cfg, 'x … xs');
    expect(
      cfg.edges.some((e) => e.from === cont && e.to === outerHeader && e.kind === 'continue'),
    ).toBe(true);
  });

  it('an unresolved labeled jump (stacked outer label) routes to EXIT, not a dangling sink', () => {
    // `break outer` can't resolve (the outer label is unmodeled in M1), but the
    // block must still reach EXIT so the graph stays single-exit for the
    // downstream post-dominator / PDG computation — never a stranded sink.
    const cfg = cfgOf(`function f(xs, ys) {
      outer: inner: for (const x of xs) {
        for (const y of ys) { if (x === y) { break outer; } body(); }
      }
    }`);
    const brk = block(cfg, 'break outer;');
    expect(edgeKinds(cfg).has('break')).toBe(true);
    expect(reaches(cfg, brk, cfg.exitIndex)).toBe(true); // not stranded
  });

  it('a standalone throw (no enclosing try) wires to EXIT and ends its block', () => {
    const cfg = cfgOf(`function f(x) { if (x) { throw new Error(); } done(); }`);
    const thr = block(cfg, 'throw new Error();');
    expect(cfg.edges).toContainEqual({ from: thr, to: cfg.exitIndex, kind: 'throw' });
    // the throw terminates its block — control does not fall into done()
    expect(reaches(cfg, thr, block(cfg, 'done();'))).toBe(false);
    // done() is still reachable via the if's false branch
    expect(reachable(cfg, block(cfg, 'done();'))).toBe(true);
  });

  it('code after an unconditional return is emitted but unreachable from ENTRY', () => {
    const cfg = cfgOf(`function f() { first(); return 1; dead(); }`);
    const dead = block(cfg, 'dead();');
    expect(reachable(cfg, dead)).toBe(false); // emitted, but no edge reaches it
    expect(reachable(cfg, block(cfg, 'first();'))).toBe(true);
  });
});

describe('TS/JS CfgVisitor — function-type coverage', () => {
  // TS_FUNCTION_TYPES spans more than function_declaration/arrow. Confirm the
  // body-walk produces a well-formed CFG for async / generator / method bodies.
  it('builds a CFG for async functions, generators, and class methods', () => {
    const code = `
      async function af(x) { if (x) { await a(); } done(); }
      function* gf(xs) { for (const x of xs) { yield x; } }
      class C { m(x) { if (x) { p(); } else { q(); } } async am() { await z(); } }
    `;
    const fns = collectFunctions(parse(code));
    // af, gf, m, am — four CFG-bearing functions
    const cfgs = fns.map((fn) => visitor.buildFunctionCfg(fn, 'ft.ts')).filter((c) => c);
    expect(cfgs.length).toBe(4);
    for (const cfg of cfgs) {
      expect(cfg).toBeDefined();
      if (!cfg) continue;
      expect(cfg.blocks[cfg.entryIndex].kind).toBe('entry');
      expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    }
  });
});

describe('TS/JS CfgVisitor — AC1: 10-function fixture', () => {
  const TEN_FN = `
    function straight() { a(); b(); }
    function withIf(x) { if (x) { a(); } else { b(); } }
    function withElseIf(x) { if (x===1) { a(); } else if (x===2) { b(); } else { c(); } }
    function withWhile(x) { while (x) { step(); } }
    function withFor() { for (let i=0;i<n;i++) { step(); } }
    function withForOf(xs) { for (const x of xs) { use(x); } }
    function withSwitch(x) { switch (x) { case 1: one(); break; default: other(); } }
    function withTry() { try { work(); } catch (e) { oops(); } finally { fin(); } }
    function withReturn(x) { if (x) { return 1; } return 2; }
    function withLabeled(xs, ys) { outer: for (const x of xs) { for (const y of ys) { break outer; } } }
  `;

  it('produces one CFG per function, each with a reachable EXIT and contiguous block indices', () => {
    const fns = collectFunctions(parse(TEN_FN)).filter((f) => f.type === 'function_declaration');
    expect(fns).toHaveLength(10);
    for (const fn of fns) {
      const cfg = visitor.buildFunctionCfg(fn, 'fixture.ts');
      expect(cfg).toBeDefined();
      if (!cfg) continue;
      // ENTRY is index 0; indices are contiguous 0..n-1
      expect(cfg.blocks.map((b) => b.index)).toEqual(cfg.blocks.map((_, i) => i));
      expect(cfg.blocks[cfg.entryIndex].kind).toBe('entry');
      expect(cfg.blocks[cfg.exitIndex].kind).toBe('exit');
      // EXIT is reachable from ENTRY for every function
      expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
      // No edge endpoint is out of range
      for (const e of cfg.edges) {
        expect(e.from).toBeGreaterThanOrEqual(0);
        expect(e.to).toBeLessThan(cfg.blocks.length);
      }
    }
  });
});

describe('TS/JS CfgVisitor — early exits through finally (#2082 M2 U2)', () => {
  const edges = (cfg: FunctionCfg) => cfg.edges;
  const edgesFrom = (cfg: FunctionCfg, from: number) => cfg.edges.filter((e) => e.from === from);

  it('return inside try-with-finally routes through finally; no direct try→EXIT return edge', () => {
    const cfg = cfgOf(`function f() { try { return 1; } finally { cleanup(); } }`);
    const ret = block(cfg, 'return 1');
    const fin = block(cfg, 'cleanup()');
    expect(edges(cfg)).toContainEqual({ from: ret, to: fin, kind: 'return' });
    expect(edges(cfg)).toContainEqual({ from: fin, to: cfg.exitIndex, kind: 'finally-return' });
    expect(edges(cfg)).not.toContainEqual({ from: ret, to: cfg.exitIndex, kind: 'return' });
  });

  it('break/continue crossing a finally thread through it with finally-* completion kinds', () => {
    const cfg = cfgOf(`function f(xs) {
      for (const x of xs) {
        try { if (x) { break; } else { continue; } } finally { f1(); }
      }
    }`);
    const fin = block(cfg, 'f1()');
    const brk = block(cfg, 'break');
    const cont = block(cfg, 'continue');
    expect(edges(cfg)).toContainEqual({ from: brk, to: fin, kind: 'break' });
    expect(edges(cfg)).toContainEqual({ from: cont, to: fin, kind: 'continue' });
    const fromFin = edgesFrom(cfg, fin).map((e) => e.kind);
    expect(fromFin).toContain('finally-break');
    expect(fromFin).toContain('finally-continue');
  });

  it('nested finallys chain: return threads a() then b() then EXIT', () => {
    const cfg = cfgOf(`function f() { try { try { return; } finally { a(); } } finally { b(); } }`);
    const ret = block(cfg, 'return');
    const finA = block(cfg, 'a()');
    const finB = block(cfg, 'b()');
    expect(edges(cfg)).toContainEqual({ from: ret, to: finA, kind: 'return' });
    expect(edges(cfg)).toContainEqual({ from: finA, to: finB, kind: 'finally-return' });
    expect(edges(cfg)).toContainEqual({ from: finB, to: cfg.exitIndex, kind: 'finally-return' });
  });

  it('returns in try AND catch share one deduped finally-return completion edge', () => {
    const cfg = cfgOf(`function f() {
      try { return t(); } catch (e) { return c(); } finally { f1(); }
    }`);
    const fin = block(cfg, 'f1()');
    const completions = edgesFrom(cfg, fin).filter((e) => e.kind === 'finally-return');
    expect(completions).toEqual([{ from: fin, to: cfg.exitIndex, kind: 'finally-return' }]);
    expect(edges(cfg)).toContainEqual({ from: block(cfg, 't()'), to: fin, kind: 'return' });
    expect(edges(cfg)).toContainEqual({ from: block(cfg, 'c()'), to: fin, kind: 'return' });
  });

  it('return inside catch with NO finally keeps its direct edge to EXIT', () => {
    const cfg = cfgOf(`function f() { try { t(); } catch (e) { return 1; } }`);
    const ret = block(cfg, 'return 1');
    expect(edges(cfg)).toContainEqual({ from: ret, to: cfg.exitIndex, kind: 'return' });
    expect(edgeKinds(cfg).has('finally-return')).toBe(false);
  });

  it('normal completion still routes through finally exactly once', () => {
    const cfg = cfgOf(`function f() { try { work(); } finally { fin(); } done(); }`);
    const body = block(cfg, 'work()');
    const fin = block(cfg, 'fin()');
    const seqs = edges(cfg).filter((e) => e.from === body && e.to === fin && e.kind === 'seq');
    expect(seqs).toHaveLength(1);
    expect(reaches(cfg, fin, block(cfg, 'done()'))).toBe(true);
  });

  it('kind invariant: no bare jump edge originates from a finally exit block', () => {
    const cfg = cfgOf(`function f(xs) {
      for (const x of xs) { try { if (x) return 1; break; } finally { f1(); } }
    }`);
    const fin = block(cfg, 'f1()');
    for (const e of edgesFrom(cfg, fin)) {
      expect(['return', 'break', 'continue']).not.toContain(e.kind);
    }
  });

  it('non-crossing break (loop wholly inside try) keeps its direct edge — no finally threading', () => {
    const cfg = cfgOf(`function f(xs) {
      try { for (const x of xs) { break; } post(); } finally { f1(); }
    }`);
    const brk = block(cfg, 'break');
    const fin = block(cfg, 'f1()');
    const brkEdges = edgesFrom(cfg, brk).filter((e) => e.kind === 'break');
    expect(brkEdges).toHaveLength(1);
    expect(brkEdges[0].to).not.toBe(fin);
    // the break's continuation (post()) is reachable WITHOUT passing the finally
    expect(reaches(cfg, brkEdges[0].to, block(cfg, 'post()'))).toBe(true);
    expect(edgeKinds(cfg).has('finally-break')).toBe(false);
    // normal try completion still routes through finally
    expect(edges(cfg)).toContainEqual({
      from: block(cfg, 'post()'),
      to: fin,
      kind: 'seq',
    });
  });

  it('labeled break crossing the finally DOES thread', () => {
    const cfg = cfgOf(`function f(xs) {
      outer: for (const x of xs) {
        try { break outer; } finally { f1(); }
      }
    }`);
    const brk = block(cfg, 'break outer');
    const fin = block(cfg, 'f1()');
    expect(edges(cfg)).toContainEqual({ from: brk, to: fin, kind: 'break' });
    expect(edgesFrom(cfg, fin).some((e) => e.kind === 'finally-break')).toBe(true);
  });

  it('empty finally: jump keeps its direct edge, no finally-* kinds, no throw', () => {
    const cfg = cfgOf(`function f() { try { return 1; } finally {} }`);
    const ret = block(cfg, 'return 1');
    expect(edges(cfg)).toContainEqual({ from: ret, to: cfg.exitIndex, kind: 'return' });
    expect(edgeKinds(cfg).has('finally-return')).toBe(false);
  });

  it('finally that itself returns: its return wins; no dangling completion edges', () => {
    const cfg = cfgOf(`function f() { try { return 1; } finally { return 2; } }`);
    const finRet = block(cfg, 'return 2');
    expect(edges(cfg)).toContainEqual({ from: finRet, to: cfg.exitIndex, kind: 'return' });
    // the pending completion had no finally exits to attach to
    expect(edgeKinds(cfg).has('finally-return')).toBe(false);
    // every edge endpoint is in range (no dangling)
    for (const e of edges(cfg)) {
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(cfg.blocks.length);
    }
  });

  it('single-exit invariant: EXIT reachable, all blocks have a path onward', () => {
    const cfg = cfgOf(`function f(xs) {
      outer: for (const x of xs) {
        try {
          try { if (x) { continue outer; } return g(x); } finally { a(); }
        } finally { b(); }
      }
    }`);
    expect(reaches(cfg, cfg.entryIndex, cfg.exitIndex)).toBe(true);
    for (const b of cfg.blocks) {
      if (b.index === cfg.exitIndex) continue;
      if (!reachable(cfg, b.index)) continue; // unreachable blocks exempt
      expect(reaches(cfg, b.index, cfg.exitIndex)).toBe(true);
    }
  });
});

describe('TS/JS CfgVisitor — labeled statements modeled generically (#2160 review)', () => {
  it('break to a labeled non-loop block targets the synthesized join, not EXIT', () => {
    const cfg = cfgOf(`function f(c) {
      let x = 1;
      blk: { if (c) { break blk; } x = 2; }
      sink(x);
    }`);
    const brk = block(cfg, 'break blk');
    const sink = block(cfg, 'sink(x)');
    const brkEdges = cfg.edges.filter((e) => e.from === brk && e.kind === 'break');
    expect(brkEdges).toHaveLength(1);
    expect(brkEdges[0].to).not.toBe(cfg.exitIndex);
    // the break's target flows into the post-construct continuation
    expect(reaches(cfg, brkEdges[0].to, sink)).toBe(true);
  });

  it('doubly-labeled loop: break to the OUTER label resolves to the loop exit', () => {
    const cfg = cfgOf(`function f(c) {
      outer: inner: do { if (c) { break outer; } work(); } while (g());
      done();
    }`);
    const brk = block(cfg, 'break outer');
    const done = block(cfg, 'done()');
    const brkEdges = cfg.edges.filter((e) => e.from === brk && e.kind === 'break');
    expect(brkEdges).toHaveLength(1);
    expect(brkEdges[0].to).not.toBe(cfg.exitIndex);
    expect(reaches(cfg, brkEdges[0].to, done)).toBe(true);
  });

  it('labeled break crossing a finally still threads it (labels + finalizers compose)', () => {
    const cfg = cfgOf(`function f(c) {
      blk: {
        try { if (c) { break blk; } } finally { f1(); }
        rest();
      }
      after();
    }`);
    const brk = block(cfg, 'break blk');
    const fin = block(cfg, 'f1()');
    expect(cfg.edges).toContainEqual({ from: brk, to: fin, kind: 'break' });
    const completions = cfg.edges.filter((e) => e.from === fin && e.kind === 'finally-break');
    expect(completions).toHaveLength(1);
    // the completion resumes at the block's join → after() reachable, rest() skipped on that path
    expect(reaches(cfg, completions[0].to, block(cfg, 'after()'))).toBe(true);
    expect(completions[0].to).not.toBe(block(cfg, 'rest()'));
  });

  it('an unlabeled break inside a labeled block still targets the enclosing loop', () => {
    const cfg = cfgOf(`function f(xs) {
      for (const x of xs) {
        blk: { if (x) { break; } }
        body();
      }
      done();
    }`);
    const brk = block(cfg, 'break');
    const brkEdges = cfg.edges.filter((e) => e.from === brk && e.kind === 'break');
    expect(brkEdges).toHaveLength(1);
    // targets the LOOP exit (reaches done() without re-entering body())
    expect(reaches(cfg, brkEdges[0].to, block(cfg, 'done()'))).toBe(true);
  });
});
