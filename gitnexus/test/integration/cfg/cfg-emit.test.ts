import { describe, it, expect, vi } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { emitFileCfgs } from '../../../src/core/ingestion/cfg/emit.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { CfgVisitor, FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
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
