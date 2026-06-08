import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';

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

const block = (cfg: FunctionCfg, substr: string): number => {
  const b = cfg.blocks.find((bl) => bl.text.includes(substr));
  if (!b) throw new Error(`no block containing ${JSON.stringify(substr)}`);
  return b.index;
};

const edgeKinds = (cfg: FunctionCfg): Set<string> => new Set(cfg.edges.map((e) => e.kind));

/** Does control reach `to` from `from` following edges? */
function reaches(cfg: FunctionCfg, from: number, to: number): boolean {
  const adj = new Map<number, number[]>();
  for (const e of cfg.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop() as number;
    if (n === to) return true;
    for (const nx of adj.get(n) ?? []) if (!seen.has(nx)) (seen.add(nx), stack.push(nx));
  }
  return seen.has(to);
}

const reachable = (cfg: FunctionCfg, idx: number): boolean => reaches(cfg, cfg.entryIndex, idx);

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
