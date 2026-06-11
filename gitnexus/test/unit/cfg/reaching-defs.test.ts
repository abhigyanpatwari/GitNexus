import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import {
  computeReachingDefs,
  type DefUseFact,
} from '../../../src/core/ingestion/cfg/reaching-defs.js';
import type {
  BasicBlockData,
  BindingEntry,
  CfgEdgeData,
  FunctionCfg,
  StatementFacts,
} from '../../../src/core/ingestion/cfg/types.js';

// U3 (#2082 M2) — the GEN/KILL fixpoint + intra-block statement sweep. The
// classic lattice hazards (kill ordering, branch-merge union, loop-carried
// defs, self-loops, unreachable blocks) are pinned on hand-built FunctionCfg
// literals with zero tree-sitter dependency, mirroring cfg-builder.test.ts;
// shadowing/try-finally acceptance runs parser-direct through the U1 harvest.

// ── hand-built CFG helpers ──────────────────────────────────────────────────

interface BlockSpec {
  readonly kind?: BasicBlockData['kind'];
  readonly stmts?: StatementFacts[];
}

function mkCfg(blocks: BlockSpec[], edges: [number, number][], bindings: string[]): FunctionCfg {
  const bindingTable: BindingEntry[] = bindings.map((name, i) => ({
    name,
    declLine: i + 1,
    declColumn: 0,
    kind: 'let',
  }));
  return {
    filePath: 'hand.ts',
    functionStartLine: 1,
    functionEndLine: 99,
    functionStartColumn: 0,
    entryIndex: 0,
    exitIndex: 1,
    blocks: blocks.map((b, index) => ({
      index,
      startLine: index + 1,
      endLine: index + 1,
      text: '',
      kind: b.kind ?? (index === 0 ? 'entry' : index === 1 ? 'exit' : 'normal'),
      statements: b.stmts ?? [],
    })),
    edges: edges.map(([from, to]) => ({ from, to, kind: 'seq' }) as CfgEdgeData),
    bindings: bindingTable,
  };
}

const stmt = (line: number, defs: number[] = [], uses: number[] = []): StatementFacts => ({
  line,
  defs,
  uses,
});

/** Compact "defBlock:defStmt->useBlock:useStmt:binding" rendering for asserts. */
const render = (facts: readonly DefUseFact[]): string[] =>
  facts.map(
    (f) =>
      `${f.def.blockIndex}:${f.def.stmtIndex}->${f.use.blockIndex}:${f.use.stmtIndex}:${f.bindingIdx}`,
  );

// ── parser-direct helpers (shadowing / finally acceptance) ──────────────────

const visitor = createTypeScriptCfgVisitor();

function cfgOf(code: string, index = 0): FunctionCfg {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const root = parser.parse(code).rootNode as SyntaxNode;
  const fns: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as SyntaxNode;
    if (TS_FUNCTION_TYPES.has(n.type)) fns.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  const cfg = visitor.buildFunctionCfg(fns[index], 'fixture.ts');
  if (!cfg) throw new Error('no cfg');
  return cfg;
}

const nameIdx = (cfg: FunctionCfg, name: string): number[] =>
  (cfg.bindings ?? []).map((b, i) => (b.name === name ? i : -1)).filter((i) => i >= 0);

// ── tests ───────────────────────────────────────────────────────────────────

describe('computeReachingDefs — kill/gen fundamentals (hand-built)', () => {
  it('straight line: reassignment kills the prior def (R6)', () => {
    // block 2: x=1; x=2; y=x
    const cfg = mkCfg(
      [{}, {}, { stmts: [stmt(10, [0]), stmt(11, [0]), stmt(12, [1], [0])] }],
      [
        [0, 2],
        [2, 1],
      ],
      ['x', 'y'],
    );
    const r = computeReachingDefs(cfg);
    expect(r.status).toBe('computed');
    expect(render(r.facts)).toEqual(['2:1->2:2:0']); // ONLY the second def reaches
    expect(r.defCount).toBe(3);
    expect(r.useCount).toBe(1);
  });

  it('branch merge (diamond): defs from BOTH arms reach the join use', () => {
    // 0→2(def x)→{3,4 both def x}→5(use x)→1
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(10, [0])] },
        { stmts: [stmt(20, [0])] },
        { stmts: [stmt(30, [0])] },
        { stmts: [stmt(40, [], [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [2, 4],
        [3, 5],
        [4, 5],
        [5, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(render(r.facts).sort()).toEqual(['3:0->5:0:0', '4:0->5:0:0']);
  });

  it('loop back-edge: pre-loop def AND loop-carried redef both reach the header use', () => {
    // 0→2(def x)→3(use x = header)→4(def x, body)→3(back); 3→1(exit)
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(10, [0])] },
        { stmts: [stmt(20, [], [0])] },
        { stmts: [stmt(30, [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [3, 4],
        [4, 3],
        [3, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(render(r.facts).sort()).toEqual(['2:0->3:0:0', '4:0->3:0:0']);
  });

  it('self-loop block converges with the loop-carried def visible to its own use', () => {
    // block 2 loops to itself: use x; def x
    const cfg = mkCfg(
      [{}, {}, { stmts: [stmt(10, [], [0]), stmt(11, [0])] }],
      [
        [0, 2],
        [2, 2],
        [2, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    // the block's own def flows around the self-loop into its use
    expect(render(r.facts)).toEqual(['2:1->2:0:0']);
  });

  it('unreachable block: its defs reach nothing; reachable uses see only reachable defs', () => {
    // 2(def x)→3(use x); 4 is DISCONNECTED and also defs x
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(10, [0])] },
        { stmts: [stmt(20, [], [0])] },
        { stmts: [stmt(30, [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [3, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(render(r.facts)).toEqual(['2:0->3:0:0']);
  });

  it('intra-block sweep: a use BEFORE the same-block def sees the incoming def', () => {
    // 2: def x. 3: use x (stmt0); def x (stmt1); use x (stmt2)
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(10, [0])] },
        { stmts: [stmt(20, [], [0]), stmt(21, [0]), stmt(22, [], [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [3, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(render(r.facts).sort()).toEqual(['2:0->3:0:0', '3:1->3:2:0']);
  });

  it('def+use in one statement: the use sees prior defs AND the same-statement def', () => {
    // StatementFacts carries no intra-statement order, so `x += 1`
    // (read-then-write) and `if ((m = f()) && m.p)` (write-then-read) are
    // indistinguishable — the sweep emits BOTH the prior def and the
    // same-statement self-def (sound over-approximation; missing the
    // assign-and-test idiom's def→use would be a taint false negative).
    const cfg = mkCfg(
      [{}, {}, { stmts: [stmt(10, [0]), stmt(11, [0], [0])] }],
      [
        [0, 2],
        [2, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(render(r.facts).sort()).toEqual(['2:0->2:1:0', '2:1->2:1:0']);
  });
});

describe('computeReachingDefs — determinism and convergence', () => {
  it('permuted edge order produces byte-identical sorted facts', () => {
    const blocks: BlockSpec[] = [
      {},
      {},
      { stmts: [stmt(1, [0]), stmt(2, [1])] },
      { stmts: [stmt(3, [0], [1])] },
      { stmts: [stmt(4, [1], [0])] },
      { stmts: [stmt(5, [], [0, 1])] },
    ];
    const edges: [number, number][] = [
      [0, 2],
      [2, 3],
      [2, 4],
      [3, 5],
      [4, 5],
      [5, 3],
      [5, 1],
    ];
    const base = computeReachingDefs(mkCfg(blocks, edges, ['x', 'y']));
    for (let i = 0; i < 5; i++) {
      const shuffled = [...edges].reverse();
      shuffled.push(shuffled.shift() as [number, number]);
      const r = computeReachingDefs(mkCfg(blocks, shuffled, ['x', 'y']));
      expect(render(r.facts)).toEqual(render(base.facts));
    }
  });

  it('nested loops (depth 3) converge with loop-carried defs intact', () => {
    // 2 chains into three nested loop headers 3,4,5; innermost body 6 defs x.
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(1, [0])] },
        { stmts: [stmt(2, [], [0])] },
        { stmts: [stmt(3, [], [0])] },
        { stmts: [stmt(4, [], [0])] },
        { stmts: [stmt(5, [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
        [6, 5],
        [5, 4],
        [4, 3],
        [3, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    // every header use sees both the init def and the innermost redef
    for (const useBlock of [3, 4, 5]) {
      const defs = r.facts
        .filter((f) => f.use.blockIndex === useBlock)
        .map((f) => f.def.blockIndex);
      expect(new Set(defs)).toEqual(new Set([2, 6]));
    }
  });

  it('no-facts fallback: a CFG without statement facts reports no-facts, no throw', () => {
    const bare: FunctionCfg = {
      filePath: 'hand.ts',
      functionStartLine: 1,
      functionEndLine: 2,
      functionStartColumn: 0,
      entryIndex: 0,
      exitIndex: 1,
      blocks: [
        { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry' },
        { index: 1, startLine: 2, endLine: 2, text: '', kind: 'exit' },
      ],
      edges: [{ from: 0, to: 1, kind: 'seq' }],
    };
    const r = computeReachingDefs(bare);
    expect(r.status).toBe('no-facts');
    expect(r.facts).toEqual([]);
  });

  it('maxFacts truncation: deterministic prefix + truncated status', () => {
    // fan-out: 4 defs of x in parallel arms, then 4 uses → 16 facts
    const arms = [2, 3, 4, 5];
    const uses = [6, 7, 8, 9];
    const blocks: BlockSpec[] = [{}, {}];
    for (const a of arms) blocks[a] = { stmts: [stmt(a, [0])] };
    for (const u of uses) blocks[u] = { stmts: [stmt(u, [], [0])] };
    const edges: [number, number][] = [];
    for (const a of arms) edges.push([0, a], [a, 6]);
    edges.push([6, 7], [7, 8], [8, 9], [9, 1]);
    const full = computeReachingDefs(mkCfg(blocks, edges, ['x']));
    expect(full.status).toBe('computed');
    expect(full.facts).toHaveLength(16);

    const capped = computeReachingDefs(mkCfg(blocks, edges, ['x']), { maxFacts: 5 });
    expect(capped.status).toBe('truncated');
    expect(capped.facts).toHaveLength(5);
    // deterministic prefix: re-running yields the same truncated set
    const again = computeReachingDefs(mkCfg(blocks, edges, ['x']), { maxFacts: 5 });
    expect(render(again.facts)).toEqual(render(capped.facts));
    // telemetry counts are truncation-independent
    expect(capped.defCount).toBe(full.defCount);
    expect(capped.useCount).toBe(full.useCount);
  });
});

describe('computeReachingDefs — parser-direct acceptance (with U1/U2)', () => {
  it('shadowing: inner let does NOT kill the outer binding across the block (R4)', () => {
    const cfg = cfgOf(`function f() {
      let x = 1;
      { let x = 2; sink(x); }
      sink(x);
    }`);
    const [outer, inner] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const outerUse = r.facts.filter((f) => f.bindingIdx === outer);
    const innerUse = r.facts.filter((f) => f.bindingIdx === inner);
    expect(innerUse).toHaveLength(1);
    expect(outerUse).toHaveLength(1);
    // the trailing sink(x) sees the OUTER def — the inner block didn't kill it
    expect(outerUse[0].def.line).toBe(2);
    expect(outerUse[0].use.line).toBe(4);
  });

  it('try/catch over-approximation: a try-body def reaches a catch-body use (R10)', () => {
    const cfg = cfgOf(`function f() {
      let x = seed();
      try { x = risky(); } catch (e) { sink(x); }
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const catchUses = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 3);
    // BOTH the seed def and the try-body redef may reach the catch use
    expect(new Set(catchUses.map((f) => f.def.line))).toEqual(new Set([2, 3]));
  });

  it('finally redefinition on the early-exit/normal paths kills the original (R9 + U2)', () => {
    const cfg = cfgOf(`function f(c) {
      let x = 1;
      try {
        if (c) { return probe(x); }
      } finally {
        x = 2;
      }
      return sink(x);
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    // the early return's use happens BEFORE finally runs → sees x = 1 (line 2)
    const probeUse = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 4);
    expect(probeUse.map((f) => f.def.line)).toEqual([2]);
    // the post-try use sits behind the finally on EVERY path → sees ONLY x = 2
    const sinkUse = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 8);
    expect(sinkUse.map((f) => f.def.line)).toEqual([6]);
  });

  it('params reach their uses from the ENTRY record', () => {
    const cfg = cfgOf(`function f(a) { return a + 1; }`);
    const [a] = nameIdx(cfg, 'a');
    const r = computeReachingDefs(cfg);
    const fact = r.facts.find((f) => f.bindingIdx === a);
    expect(fact).toBeDefined();
    expect(fact!.def.blockIndex).toBe(cfg.entryIndex);
  });

  it('loop-carried accumulator: both the init and in-loop defs reach the post-loop use', () => {
    const cfg = cfgOf(`function f(xs) {
      let sum = 0;
      for (const x of xs) { sum += x; }
      return sum;
    }`);
    const [sum] = nameIdx(cfg, 'sum');
    const r = computeReachingDefs(cfg);
    const retUse = r.facts.filter((f) => f.bindingIdx === sum && f.use.line === 4);
    expect(new Set(retUse.map((f) => f.def.line))).toEqual(new Set([2, 3]));
  });
});

describe('computeReachingDefs — tri-review soundness fixes (#2160 review)', () => {
  it('may-def gen does NOT kill: prior def survives a conditional assignment (hand-built)', () => {
    // block 2: def x. block 3: stmt with MAY-def of x. block 4: use x.
    const cfg = mkCfg(
      [
        {},
        {},
        { stmts: [stmt(10, [0])] },
        { stmts: [{ line: 20, defs: [], uses: [], mayDefs: [0] }] },
        { stmts: [stmt(30, [], [0])] },
      ],
      [
        [0, 2],
        [2, 3],
        [3, 4],
        [4, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    // BOTH the unconditional def and the conditional one reach the use
    expect(render(r.facts).sort()).toEqual(['2:0->4:0:0', '3:0->4:0:0']);
  });

  it('short-circuit conditional def: the not-taken path keeps the prior def (parser-direct, P1)', () => {
    const cfg = cfgOf(`function f(a) {
      let x = source();
      if (a && (x = clean())) {}
      sink(x);
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const sinkUses = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 4);
    // BOTH source (line 2) and clean (line 3) reach sink — pre-fix, source was
    // falsely killed (taint false negative on the lazy-init idiom)
    expect(new Set(sinkUses.map((f) => f.def.line))).toEqual(new Set([2, 3]));
  });

  it('labeled non-loop block: break keeps the real continuation (parser-direct, P1)', () => {
    const cfg = cfgOf(`function f(c) {
      let x = 1;
      blk: { if (c) break blk; x = 2; }
      sink(x);
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const sinkUses = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 4);
    // the break path preserves x=1; the fall-through path redefines to x=2
    expect(new Set(sinkUses.map((f) => f.def.line))).toEqual(new Set([2, 3]));
  });

  it('doubly-labeled loop: `break outer` resolves to the loop exit, keeping post-loop facts (P1)', () => {
    const cfg = cfgOf(`function f(c) {
      let x = 1;
      outer: inner: do { if (c) break outer; x = 2; } while (g());
      sink(x);
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const sinkUses = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 4);
    expect(new Set(sinkUses.map((f) => f.def.line))).toEqual(new Set([2, 3]));
  });

  it('throw edges deliver INTERMEDIATE defs of a coalesced block to the handler (parser-direct, P1)', () => {
    const cfg = cfgOf(`function f(a) {
      let x = seed(a);
      try {
        x = parse(a);
        x = normalize(x);
      } catch (e) {
        sink(x);
      }
    }`);
    const [x] = nameIdx(cfg, 'x');
    const r = computeReachingDefs(cfg);
    const sinkUses = r.facts.filter((f) => f.bindingIdx === x && f.use.line === 7);
    // seed (pre-try), parse (intermediate — normalize may throw with parse's
    // value live), and normalize (its own RHS use may throw) all reach sink
    expect(new Set(sinkUses.map((f) => f.def.line))).toEqual(new Set([2, 4, 5]));
  });

  it('a block with ≥ STMT_STRIDE statements reports overflow with zero facts (no aliasing)', () => {
    const shared = { line: 1, defs: [], uses: [] };
    const huge = new Array(1 << 21).fill(shared);
    const cfg = mkCfg(
      [{}, {}, { stmts: huge as StatementFacts[] }],
      [
        [0, 2],
        [2, 1],
      ],
      ['x'],
    );
    const r = computeReachingDefs(cfg);
    expect(r.status).toBe('overflow');
    expect(r.facts).toEqual([]);
  });
});
