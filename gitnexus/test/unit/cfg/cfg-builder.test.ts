import { describe, it, expect } from 'vitest';
import {
  CfgBuilder,
  CfgNestingDepthError,
  MAX_CFG_NESTING_DEPTH,
  reachableBlocks,
} from '../../../src/core/ingestion/cfg/cfg-builder.js';
import { ControlFlowContext } from '../../../src/core/ingestion/cfg/control-flow-context.js';

// The CFG core is AST-agnostic — these tests drive the builder + context the
// way the TS/JS visitor (U2) will, on the classic control-flow topologies the
// S2 spike validated. They pin block/edge accounting and reachability (R1, R9)
// before any tree-sitter coupling exists.

describe('CfgBuilder', () => {
  it('straight-line body: ENTRY → block → EXIT, all reachable', () => {
    const b = new CfgBuilder('f.ts', 1, 3);
    const body = b.newBlock(2, 2, 'g();');
    b.edge(b.entryIndex, body, 'seq');
    b.edge(body, b.exitIndex, 'seq');
    const cfg = b.finish();
    expect(cfg.blocks).toHaveLength(3); // entry, exit, body
    expect(cfg.entryIndex).toBe(0);
    expect(reachableBlocks(cfg).size).toBe(3);
  });

  it('empty function: ENTRY → EXIT only', () => {
    const b = new CfgBuilder('f.ts', 1, 1);
    b.edge(b.entryIndex, b.exitIndex, 'seq');
    const cfg = b.finish();
    expect(cfg.blocks).toHaveLength(2);
    expect(reachableBlocks(cfg)).toEqual(new Set([b.entryIndex, b.exitIndex]));
  });

  it('if/else diamond: both branches reach the join', () => {
    const b = new CfgBuilder('f.ts', 1, 6);
    const thenB = b.newBlock(2, 2, 'a();');
    const elseB = b.newBlock(4, 4, 'b();');
    const join = b.newBlock(6, 6, 'c();');
    b.edge(b.entryIndex, thenB, 'cond-true');
    b.edge(b.entryIndex, elseB, 'cond-false');
    b.connect([thenB, elseB], join, 'seq');
    b.edge(join, b.exitIndex, 'seq');
    const cfg = b.finish();
    const reach = reachableBlocks(cfg);
    expect(reach.has(thenB) && reach.has(elseB) && reach.has(join)).toBe(true);
    // join has two predecessors
    expect(cfg.edges.filter((e) => e.to === join)).toHaveLength(2);
  });

  it('while loop: body back-edges to header; header exits the loop', () => {
    const b = new CfgBuilder('f.ts', 1, 4);
    const header = b.newBlock(1, 1, 'while(x)');
    const body = b.newBlock(2, 2, 'x--;');
    b.edge(b.entryIndex, header, 'seq');
    b.edge(header, body, 'cond-true');
    b.edge(body, header, 'loop-back');
    b.edge(header, b.exitIndex, 'cond-false');
    const cfg = b.finish();
    expect(cfg.edges).toContainEqual({ from: body, to: header, kind: 'loop-back' });
    expect(reachableBlocks(cfg).size).toBe(4); // all reachable
  });

  it('mid-block return wires to EXIT; trailing block still emitted but unreachable-by-fallthrough', () => {
    const b = new CfgBuilder('f.ts', 1, 4);
    const ret = b.newBlock(2, 2, 'return 1;');
    const dead = b.newBlock(3, 3, 'g();'); // after return — no fallthrough edge into it
    b.edge(b.entryIndex, ret, 'seq');
    b.edge(ret, b.exitIndex, 'return');
    b.edge(dead, b.exitIndex, 'seq');
    const cfg = b.finish();
    const reach = reachableBlocks(cfg);
    expect(reach.has(ret)).toBe(true);
    expect(reach.has(dead)).toBe(false); // emitted, but not reachable from ENTRY
  });

  it('edge() is idempotent on (from,to,kind)', () => {
    const b = new CfgBuilder('f.ts', 1, 2);
    const x = b.newBlock(1, 1, 'x');
    b.edge(b.entryIndex, x, 'seq');
    b.edge(b.entryIndex, x, 'seq'); // duplicate
    b.connect([b.entryIndex], x, 'seq'); // duplicate via connect
    expect(b.finish().edges.filter((e) => e.from === b.entryIndex && e.to === x)).toHaveLength(1);
  });

  it('finish() indexes blocks contiguously from 0', () => {
    const b = new CfgBuilder('f.ts', 1, 2);
    b.newBlock(1, 1, 'a');
    b.newBlock(2, 2, 'b');
    const cfg = b.finish();
    expect(cfg.blocks.map((bl) => bl.index)).toEqual([0, 1, 2, 3]);
    expect(cfg.blocks[cfg.entryIndex].kind).toBe('entry');
    expect(cfg.blocks[cfg.exitIndex].kind).toBe('exit');
  });
});

describe('ControlFlowContext', () => {
  it('plain break/continue resolve to the nearest loop', () => {
    const ctx = new ControlFlowContext();
    ctx.pushLoop(/*continueTo*/ 10, /*breakTo*/ 20);
    expect(ctx.continueTarget()).toBe(10);
    expect(ctx.breakTarget()).toBe(20);
    ctx.pop();
    expect(ctx.breakTarget()).toBeUndefined();
  });

  it('break resolves to the nearest switch; continue skips switches to the loop', () => {
    const ctx = new ControlFlowContext();
    ctx.pushLoop(100, 200); // outer loop
    ctx.pushSwitch(30); // inner switch
    expect(ctx.breakTarget()).toBe(30); // break → switch
    expect(ctx.continueTarget()).toBe(100); // continue skips switch → loop
    ctx.pop();
    expect(ctx.breakTarget()).toBe(200);
  });

  it('labeled break/continue resolve to the labeled loop, not the nearest', () => {
    const ctx = new ControlFlowContext();
    ctx.pushLoop(/*outer*/ 100, 200, 'outer');
    ctx.pushLoop(/*inner*/ 110, 210);
    expect(ctx.breakTarget('outer')).toBe(200);
    expect(ctx.continueTarget('outer')).toBe(100);
    expect(ctx.breakTarget()).toBe(210); // unlabeled → nearest (inner)
  });
});

describe('CfgBuilder — nesting-depth guard (#2195)', () => {
  it('throws a typed CfgNestingDepthError carrying the limit once the depth exceeds the cap', () => {
    const b = new CfgBuilder('f.ts', 1, 1);
    // Drive enterNesting up to the cap — exactly MAX is allowed, MAX+1 bails.
    for (let i = 0; i < MAX_CFG_NESTING_DEPTH; i++) b.enterNesting();
    // Capture unconditionally: a `catch`-only assertion would silently pass if a
    // future change stopped throwing (the error never surfaces). `caught` stays
    // undefined and the instanceof check fails loudly if no throw occurs.
    let caught: unknown;
    try {
      b.enterNesting();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CfgNestingDepthError);
    expect((caught as CfgNestingDepthError).limit).toBe(MAX_CFG_NESTING_DEPTH);
  });

  it('withNesting balances the counter on return AND on throw (sibling scopes do not accumulate)', () => {
    const b = new CfgBuilder('f.ts', 1, 1);
    // Run/throw a shallow scope many more times than the cap: withNesting's
    // finally keeps the live depth at 0, so width (sibling blocks) never trips
    // the guard — including the throwing path (the finally must still fire).
    for (let i = 0; i < MAX_CFG_NESTING_DEPTH * 3; i++) {
      expect(b.withNesting(() => 7)).toBe(7);
      expect(() =>
        b.withNesting(() => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
    }
    // Depth is back to 0, so one more scope is fine.
    expect(() => b.withNesting(() => 0)).not.toThrow();
  });

  it('exitNesting unwinds the counter so sibling scopes do not accumulate', () => {
    const b = new CfgBuilder('f.ts', 1, 1);
    for (let i = 0; i < MAX_CFG_NESTING_DEPTH * 3; i++) {
      b.enterNesting();
      b.exitNesting();
    }
    expect(() => b.enterNesting()).not.toThrow();
  });
});
