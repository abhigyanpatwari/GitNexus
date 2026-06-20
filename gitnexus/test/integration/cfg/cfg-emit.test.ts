import { describe, it, expect, vi } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import {
  emitFileCfgs,
  emitFileReachingDefs,
  emitFileCdg,
  POST_DOMINATE_DEBUG_ENV,
} from '../../../src/core/ingestion/cfg/emit.js';
import { decodeReachingDefReason } from '../../../src/core/ingestion/cfg/reaching-def-reason-codec.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type {
  BasicBlockData,
  CfgEdgeData,
  CfgVisitor,
  FunctionCfg,
} from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';

// U4 — emit BasicBlock nodes + CFG edges from the worker-built side-channel
// (R5, R6). Tests the pure emit helper against a recording graph: id shape
// (KTD3), edge `type`/`reason`, the AC2 reachability property, and the
// per-function edge cap's no-silent-truncation contract. The flag-gated
// run.ts wiring + full runPipelineFromRepo round-trip are covered in U7.

interface RecordedNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}
interface RecordedRel {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  reason: string;
}

function recordingGraph(): { graph: KnowledgeGraph; nodes: RecordedNode[]; rels: RecordedRel[] } {
  const nodes: RecordedNode[] = [];
  const rels: RecordedRel[] = [];
  const graph = {
    addNode: (n: RecordedNode) => nodes.push(n),
    addRelationship: (r: RecordedRel) => rels.push(r),
  } as unknown as KnowledgeGraph;
  return { graph, nodes, rels };
}

function tsRoot(code: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code).rootNode;
}

const visitor = (): CfgVisitor<SyntaxNode> => {
  const v = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!v) throw new Error('no cfgVisitor');
  return v;
};

const cfgsOf = (code: string, filePath = 'f.ts'): readonly FunctionCfg[] =>
  collectFunctionCfgs(tsRoot(code), visitor(), filePath).cfgs;

describe('U4 — emitFileCfgs node/edge shape', () => {
  it('emits BasicBlock nodes (KTD3 id, no name) + CFG edges carrying the kind in reason', () => {
    const cfgs = cfgsOf(`function f(x: number) { if (x) { a(); } else { b(); } }`, 'src/f.ts');
    const { graph, nodes, rels } = recordingGraph();
    const r = emitFileCfgs(graph, cfgs);

    expect(r.blocks).toBe(nodes.length);
    expect(r.edges).toBe(rels.length);
    expect(nodes.length).toBeGreaterThan(0);

    // every node is a BasicBlock with the KTD3 id
    // `BasicBlock:<file>:<funcStartLine>:<funcStartCol>:<idx>`
    for (const n of nodes) {
      expect(n.label).toBe('BasicBlock');
      expect(n.id).toMatch(/^BasicBlock:src\/f\.ts:\d+:\d+:\d+$/);
      expect(n.properties.filePath).toBe('src/f.ts');
      expect(n.properties.name).toBe(''); // no name column
    }
    // every edge is type 'CFG' and its reason is a CfgEdgeKind
    const kinds = new Set(rels.map((e) => e.reason));
    expect(rels.every((e) => e.type === 'CFG')).toBe(true);
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
  });

  it('block ids are unique across two functions in the same file (funcStart disambiguates)', () => {
    const cfgs = cfgsOf(`function a() { x(); }\nfunction b() { y(); }`, 'm.ts');
    const { graph, nodes } = recordingGraph();
    emitFileCfgs(graph, cfgs);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no collisions
  });

  it('two functions sharing a start LINE get distinct ids (start-column disambiguates)', () => {
    // Both arrows begin on line 1; without the start-column segment in the id
    // their block indices (each restarting at 0) collide and graph.addNode's
    // first-writer-wins silently drops the second function's blocks.
    const cfgs = cfgsOf(`const h = { a: () => foo(), b: () => bar() };`, 'one-line.ts');
    expect(cfgs.length).toBe(2);
    expect(cfgs[0].functionStartLine).toBe(cfgs[1].functionStartLine); // same line
    expect(cfgs[0].functionStartColumn).not.toBe(cfgs[1].functionStartColumn); // diff column
    const { graph, nodes } = recordingGraph();
    emitFileCfgs(graph, cfgs);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no collision despite shared line
    expect(nodes.length).toBe(cfgs[0].blocks.length + cfgs[1].blocks.length); // all blocks survive
  });
});

describe('collectFunctionCfgs — lineOffset → file coordinates (#2195 P1, Vue SFC)', () => {
  it('shifts functionStartLine + block + statement lines by lineOffset', () => {
    const code = `function f(x: number) { if (x) { a(); } else { b(); } }`;
    const base = collectFunctionCfgs(tsRoot(code), visitor(), 'x.vue').cfgs;
    const shifted = collectFunctionCfgs(tsRoot(code), visitor(), 'x.vue', 0, 5).cfgs;
    expect(base.length).toBeGreaterThan(0);
    expect(shifted).toHaveLength(base.length);
    expect(shifted[0].functionStartLine).toBe(base[0].functionStartLine + 5);
    expect(shifted[0].functionEndLine).toBe(base[0].functionEndLine + 5);
    // functionStartColumn is a COLUMN, not a line — unchanged.
    expect(shifted[0].functionStartColumn).toBe(base[0].functionStartColumn);
    for (let i = 0; i < base[0].blocks.length; i++) {
      expect(shifted[0].blocks[i].startLine).toBe(base[0].blocks[i].startLine + 5);
      expect(shifted[0].blocks[i].endLine).toBe(base[0].blocks[i].endLine + 5);
    }
    // per-statement source lines shift too (file-accurate taint/explain hops).
    const stmtLines = (cfgs: readonly FunctionCfg[]): number[] =>
      cfgs[0].blocks.flatMap((b) => (b.statements ?? []).map((s) => s.line));
    expect(stmtLines(shifted)).toEqual(stmtLines(base).map((l) => l + 5));
  });

  it('lineOffset 0 is a byte-identical no-op (non-embedded files unchanged)', () => {
    const code = `function g() { while (true) { tick(); } }`;
    const withZero = collectFunctionCfgs(tsRoot(code), visitor(), 'g.ts', 0, 0).cfgs;
    const omitted = collectFunctionCfgs(tsRoot(code), visitor(), 'g.ts').cfgs;
    expect(JSON.stringify(withZero)).toBe(JSON.stringify(omitted));
  });
});

describe('U4 — AC2: every BasicBlock is reachable from its function ENTRY', () => {
  // Fixtures deliberately contain no dead code, so the reachability closure
  // from each function's ENTRY (block index 0) must cover all of its blocks.
  const FIXTURE = `
    function branch(x: number) { if (x) { a(); } else { b(); } c(); }
    function loop(xs: number[]) { for (const y of xs) { use(y); } done(); }
    function multi(x: number) {
      switch (x) { case 1: one(); break; default: other(); }
      tail();
    }
  `;

  it('reachability closure from ENTRY covers every emitted block per function', () => {
    const cfgs = cfgsOf(FIXTURE, 'r.ts');
    const { graph, nodes, rels } = recordingGraph();
    emitFileCfgs(graph, cfgs);

    const adj = new Map<string, string[]>();
    for (const e of rels)
      (adj.get(e.sourceId) ?? adj.set(e.sourceId, []).get(e.sourceId)!).push(e.targetId);

    for (const cfg of cfgs) {
      const prefix = `BasicBlock:r.ts:${cfg.functionStartLine}:${cfg.functionStartColumn}:`;
      const entryId = `${prefix}${cfg.entryIndex}`;
      const fnNodeIds = nodes.map((n) => n.id).filter((id) => id.startsWith(prefix));
      // BFS from ENTRY
      const seen = new Set([entryId]);
      const stack = [entryId];
      while (stack.length) {
        const n = stack.pop() as string;
        for (const nx of adj.get(n) ?? []) if (!seen.has(nx)) (seen.add(nx), stack.push(nx));
      }
      for (const id of fnNodeIds) {
        expect(seen.has(id), `${id} unreachable from ENTRY`).toBe(true);
      }
    }
  });
});

describe('U4 — per-function edge cap (R6, no silent truncation)', () => {
  it('stops at the cap, records the dropped count, and warns', () => {
    const cfgs = cfgsOf(`function f(x: number) { if (x) { a(); } else { b(); } c(); }`);
    const total = cfgs[0].edges.length;
    expect(total).toBeGreaterThan(2);

    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileCfgs(graph, cfgs, 2, onWarn);

    expect(rels.length).toBe(2); // emitted exactly the cap
    expect(r.droppedEdges).toBe(total - 2);
    expect(r.cappedFunctions).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain(`dropped ${total - 2} of ${total}`);
  });

  it('cap of 0 means unlimited (emits every edge, no warning)', () => {
    const cfgs = cfgsOf(`function f(x: number) { if (x) { a(); } else { b(); } }`);
    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileCfgs(graph, cfgs, 0, onWarn);
    expect(rels.length).toBe(cfgs[0].edges.length);
    expect(r.droppedEdges).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('U4 — flag-off / empty input emits nothing', () => {
  it('no functions ⇒ zero nodes and edges', () => {
    const { graph, nodes, rels } = recordingGraph();
    const r = emitFileCfgs(graph, []);
    expect(nodes).toHaveLength(0);
    expect(rels).toHaveLength(0);
    expect(r.blocks).toBe(0);
    expect(r.edges).toBe(0);
  });
});

describe('U4 (#2082 M2) — emitFileReachingDefs', () => {
  it('persists deduped (blockPair, binding) edges; reason decodes to the variable name + FU-B-2 def/use lines', () => {
    const cfgs = cfgsOf(
      `function f(a) {
        let x = a;
        x = x + 1;
        return sink(x);
      }`,
      'src/rd.ts',
    );
    const { graph, rels } = recordingGraph();
    const r = emitFileReachingDefs(graph, cfgs);
    expect(r.edges).toBe(rels.length);
    expect(rels.length).toBeGreaterThan(0);
    for (const e of rels) {
      expect(e.type).toBe('REACHING_DEF');
      expect(e.sourceId).toMatch(/^BasicBlock:src\/rd\.ts:\d+:\d+:\d+$/);
      expect(e.targetId).toMatch(/^BasicBlock:src\/rd\.ts:\d+:\d+:\d+$/);
    }
    // FU-B-2: reason carries the plain source-level name FIRST (M0/S1 verdict)
    // plus a versioned def/use-line annotation — decode to recover the name.
    const names = new Set(rels.map((e) => decodeReachingDefReason(e.reason).name));
    expect(names.has('x')).toBe(true);
    expect(names.has('a')).toBe(true);
    // Every emitted edge carries the FU-B-2 line annotation (round-trips to
    // finite 1-based def/use source lines) — the substrate the statement-granular
    // projection walks.
    const decoded = rels.map((e) => decodeReachingDefReason(e.reason));
    for (const d of decoded) {
      expect(typeof d.defLine).toBe('number');
      expect(typeof d.useLine).toBe('number');
    }
    // The self-edge for `x` (def `let x = a` line 2 → use `x = x + 1` line 3)
    // captures the intra-block def@L→use@L' chain the block-pair dedup would lose.
    const xSelf = decoded.find((d) => d.name === 'x' && d.defLine !== d.useLine);
    expect(xSelf).toMatchObject({ name: 'x' });
    expect(Number(xSelf?.useLine)).toBeGreaterThan(Number(xSelf?.defLine));
  });

  it('same block pair, two bindings → two distinct edges (id collision-proofing)', () => {
    const cfgs = cfgsOf(`function f(a, b) { const c = a + b; use(c); }`, 'two.ts');
    const { graph, rels } = recordingGraph();
    emitFileReachingDefs(graph, cfgs);
    const ids = rels.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // a and b both flow ENTRY→body: same block pair, distinct edges by binding
    const entryToBody = rels.filter((e) => {
      const name = decodeReachingDefReason(e.reason).name;
      return name === 'a' || name === 'b';
    });
    expect(entryToBody.length).toBeGreaterThanOrEqual(2);
  });

  it('N statement-level facts on one (blockPair, binding) collapse to ONE edge', () => {
    // x defined once, used three times in the same straight-line block: three
    // facts, one persisted edge (the persisted columns cannot distinguish).
    const cfgs = cfgsOf(
      `function f() {
        let x = seed();
        a(x); b(x); c(x);
      }`,
      'dedup.ts',
    );
    const { graph, rels } = recordingGraph();
    const r = emitFileReachingDefs(graph, cfgs);
    const xEdges = rels.filter((e) => decodeReachingDefReason(e.reason).name === 'x');
    expect(xEdges).toHaveLength(1); // self-pair within the single body block
    expect(r.facts).toBeGreaterThan(rels.length); // facts > deduped edges
  });

  it('per-function edge cap: truncates deterministically, warns with top bindings (R7)', () => {
    const cfgs = cfgsOf(
      `function f(p, q) {
        let x = p;
        if (p) { x = q; } else { x = p + q; }
        s1(x); s2(p); s3(q);
      }`,
      'cap.ts',
    );
    const full = recordingGraph();
    const rFull = emitFileReachingDefs(full.graph, cfgs);
    expect(rFull.edges).toBeGreaterThan(2);

    const capped = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileReachingDefs(capped.graph, cfgs, 2, onWarn);
    expect(capped.rels).toHaveLength(2);
    // NOTE: not comparable to rFull.edges — the cap also scales maxFacts (4×),
    // so the capped run may dedup fewer facts. Within-run consistency only:
    expect(r.droppedEdges).toBeGreaterThan(0);
    expect(r.cappedFunctions).toBe(1);
    // cap=2 also tightens maxFacts (8) below this function's fact count, so
    // BOTH R7 layers may warn — assert on the edge-cap warn specifically.
    const capWarns = onWarn.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('REACHING_DEF edge cap'));
    expect(capWarns).toHaveLength(1);
    expect(capWarns[0]).toContain('top bindings');
    // deterministic truncation: same prefix on a second run
    const again = recordingGraph();
    emitFileReachingDefs(again.graph, cfgs, 2, vi.fn());
    expect(again.rels.map((e) => e.id)).toEqual(capped.rels.map((e) => e.id));
  });

  it('cap of 0 means unlimited (no warn)', () => {
    const cfgs = cfgsOf(`function f(a) { use(a); }`, 'u.ts');
    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    emitFileReachingDefs(graph, cfgs, 0, onWarn);
    expect(rels.length).toBeGreaterThan(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('fact-layer truncation warns even when the edge cap is never reached (R7 both layers)', () => {
    // 3 parallel arms defining x + several later uses → facts >> deduped edges.
    // Cap edges generously but squeeze maxFacts via a tiny edge cap × 4? No —
    // maxFacts derives from the edge cap (4×). Use a cap that bounds facts
    // below the fact count while edges stay under it: cap=3 ⇒ maxFacts=12.
    const cfgs = cfgsOf(
      `function f(c) {
        let x = 0;
        if (c === 1) { x = 1; } else if (c === 2) { x = 2; } else { x = 3; }
        u1(x); u2(x); u3(x); u4(x); u5(x);
      }`,
      'trunc.ts',
    );
    const probe = recordingGraph();
    const rProbe = emitFileReachingDefs(probe.graph, cfgs);
    expect(rProbe.facts).toBeGreaterThan(12); // 3 defs × 5 uses of x alone = 15+

    const { graph } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileReachingDefs(graph, cfgs, 1000, onWarn);
    // edge cap (1000) never reached…
    expect(r.cappedFunctions).toBe(0);
    // …but with cap=3 ⇒ maxFacts=12 < total facts, truncation warns:
    const tight = recordingGraph();
    const onWarnTight = vi.fn();
    const rTight = emitFileReachingDefs(tight.graph, cfgs, 3, onWarnTight);
    expect(rTight.truncatedFunctions).toBe(1);
    const messages = onWarnTight.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes('fact materialization'))).toBe(true);
  });

  it('no-facts CFGs (pre-M2 side channel) emit nothing and do not throw', () => {
    const bare = {
      filePath: 'old.ts',
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
    } as unknown as FunctionCfg;
    const { graph, rels } = recordingGraph();
    const r = emitFileReachingDefs(graph, [bare]);
    expect(rels).toHaveLength(0);
    expect(r.edges).toBe(0);
  });

  it('emitting the same function twice is idempotent by id (first-writer-wins safe)', () => {
    const cfgs = cfgsOf(`function f(a) { return a; }`, 'i.ts');
    const { graph, rels } = recordingGraph();
    emitFileReachingDefs(graph, cfgs);
    const firstIds = rels.map((e) => e.id);
    emitFileReachingDefs(graph, cfgs);
    // ids deterministic ⇒ the second pass produces the SAME ids (the real
    // KnowledgeGraph would no-op them; the recorder shows them duplicated)
    expect(rels.slice(firstIds.length).map((e) => e.id)).toEqual(firstIds);
  });
});

describe('U4 (#2085 M5) — emitFileCdg', () => {
  it('emits CDG edges between BasicBlocks with the branch label in reason', () => {
    // if/else diamond → both arms control-dependent on the branch (T and F)
    const cfgs = cfgsOf(
      `function f(x: number) { if (x) { a(); } else { b(); } c(); }`,
      'src/cdg.ts',
    );
    const { graph, rels } = recordingGraph();
    const r = emitFileCdg(graph, cfgs);

    expect(r.edges).toBe(rels.length);
    expect(rels.length).toBeGreaterThan(0);
    for (const e of rels) {
      expect(e.type).toBe('CDG');
      expect(e.sourceId).toMatch(/^BasicBlock:src\/cdg\.ts:\d+:\d+:\d+$/);
      expect(e.targetId).toMatch(/^BasicBlock:src\/cdg\.ts:\d+:\d+:\d+$/);
      expect(['T', 'F']).toContain(e.reason); // label rides reason (KTD3)
    }
    const labels = new Set(rels.map((e) => e.reason));
    expect(labels.has('T')).toBe(true);
    expect(labels.has('F')).toBe(true);
    expect(r.postDominateEdges).toBe(0); // debug env off
  });

  it('a straight-line function has no control dependence', () => {
    const cfgs = cfgsOf(`function f() { a(); b(); c(); }`, 'lin.ts');
    const { graph, rels } = recordingGraph();
    const r = emitFileCdg(graph, cfgs);
    expect(rels).toHaveLength(0);
    expect(r.edges).toBe(0);
  });

  it('deduped edge ids are unique and deterministic across runs', () => {
    const cfgs = cfgsOf(
      `function f(x: number, y: number) { if (x) { if (y) { a(); } else { b(); } } else { c(); } }`,
      'det.ts',
    );
    const first = recordingGraph();
    emitFileCdg(first.graph, cfgs);
    const ids = first.rels.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collisions
    const second = recordingGraph();
    emitFileCdg(second.graph, cfgs);
    expect(second.rels.map((e) => e.id)).toEqual(ids); // deterministic
  });

  it('per-function edge cap stops at the cap, records the drop, and warns (R6)', () => {
    const cfgs = cfgsOf(
      `function f(x: number, y: number) { if (x) { if (y) { a(); } else { b(); } } else { c(); } }`,
      'cap.ts',
    );
    const full = recordingGraph();
    const total = emitFileCdg(full.graph, cfgs).edges;
    expect(total).toBeGreaterThan(1);

    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileCdg(graph, cfgs, 1, onWarn);
    expect(rels.length).toBe(1); // emitted exactly the cap
    expect(r.droppedEdges).toBe(total - 1);
    expect(r.cappedFunctions).toBe(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain('CDG edge cap');
  });

  it('cap of 0 means unlimited (no warning)', () => {
    const cfgs = cfgsOf(`function f(x: number) { if (x) { a(); } else { b(); } }`, 'u.ts');
    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileCdg(graph, cfgs, 0, onWarn);
    expect(rels.length).toBe(r.edges);
    expect(r.droppedEdges).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('skips CDG for a CFG whose EXIT is unreachable from all blocks (#2188 unsound guard)', () => {
    // Hand-built exit-less loop: 0=entry → 1 ⇄ 2 spin forever; 3=exit is
    // disconnected. Post-dominance would be unsound there, so CDG is skipped —
    // while a normal sibling function in the same batch still emits CDG.
    const blocks: BasicBlockData[] = [0, 1, 2, 3].map((i) => ({
      index: i,
      startLine: i + 1,
      endLine: i + 1,
      text: '',
      kind: i === 0 ? 'entry' : i === 3 ? 'exit' : 'normal',
    }));
    const edges: CfgEdgeData[] = [
      { from: 0, to: 1, kind: 'seq' },
      { from: 1, to: 2, kind: 'seq' },
      { from: 2, to: 1, kind: 'seq' },
    ];
    const unsound: FunctionCfg = {
      filePath: 'spin.ts',
      functionStartLine: 1,
      functionStartColumn: 0,
      entryIndex: 0,
      exitIndex: 3,
      blocks,
      edges,
    };
    const sound = cfgsOf(
      `function f(x: number) { if (x) { a(); } else { b(); } c(); }`,
      'sound.ts',
    )[0];

    const { graph, rels } = recordingGraph();
    const onWarn = vi.fn();
    const r = emitFileCdg(graph, [unsound, sound], 0, onWarn);

    expect(r.skippedUnsoundFunctions).toBe(1);
    // No CDG edge originates from the unsound function...
    expect(rels.some((e) => e.sourceId.startsWith('BasicBlock:spin.ts:'))).toBe(false);
    // ...but the sound sibling still emitted CDG normally.
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.every((e) => e.sourceId.startsWith('BasicBlock:sound.ts:'))).toBe(true);
    expect(r.edges).toBe(rels.length);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain('EXIT not reachable');
  });

  it('emits POST_DOMINATE debug edges only when the env flag is set (KTD8)', () => {
    const cfgs = cfgsOf(`function f(x: number) { if (x) { a(); } else { b(); } c(); }`, 'pd.ts');

    // flag unset → no POST_DOMINATE edges
    const off = recordingGraph();
    const rOff = emitFileCdg(off.graph, cfgs);
    expect(off.rels.some((e) => e.type === 'POST_DOMINATE')).toBe(false);
    expect(rOff.postDominateEdges).toBe(0);

    // flag set → POST_DOMINATE edges appear (not counted against CDG cap)
    const prev = process.env[POST_DOMINATE_DEBUG_ENV];
    process.env[POST_DOMINATE_DEBUG_ENV] = '1';
    try {
      const on = recordingGraph();
      const rOn = emitFileCdg(on.graph, cfgs);
      const pd = on.rels.filter((e) => e.type === 'POST_DOMINATE');
      expect(pd.length).toBeGreaterThan(0);
      expect(rOn.postDominateEdges).toBe(pd.length);
      // CDG edge count is unchanged by the debug flag
      expect(rOn.edges).toBe(rOff.edges);

      // the case-insensitive 'true' OR-branch of postDominateDebugEnabled
      process.env[POST_DOMINATE_DEBUG_ENV] = 'TRUE';
      const onTrue = recordingGraph();
      const rOnTrue = emitFileCdg(onTrue.graph, cfgs);
      expect(rOnTrue.postDominateEdges).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env[POST_DOMINATE_DEBUG_ENV];
      else process.env[POST_DOMINATE_DEBUG_ENV] = prev;
    }
  });
});
