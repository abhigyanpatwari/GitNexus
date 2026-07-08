import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { emitFileCfgs } from '../../../src/core/ingestion/cfg/emit.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { CfgVisitor, FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';

// U7 — acceptance fixtures for the CFG layer (#2081 M1).
//   AC1: the 10-function fixture's CFG node/edge set matches a committed snapshot.
//   AC2: every BasicBlock is reachable from its function ENTRY (no dead code).
//   AC3: try/throw/finally + labeled break/continue topologies are correct.
// (AC4 — flag-off byte-identical graph — is the existing
// pipeline-graph-golden.test.ts, run with --pdg off.)

const FIXTURES = path.join(__dirname, 'fixtures');

const visitor = ((): CfgVisitor<SyntaxNode> => {
  const v = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!v) throw new Error('no cfgVisitor');
  return v;
})();

function cfgsOfFile(file: string): readonly FunctionCfg[] {
  const source = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return collectFunctionCfgs(parser.parse(source).rootNode, visitor, file).cfgs;
}

/** Deterministic, line-anchored serialization of a function's CFG. */
function serialize(cfg: FunctionCfg): Record<string, unknown> {
  return {
    startLine: cfg.functionStartLine,
    blocks: cfg.blocks.length,
    entry: cfg.entryIndex,
    exit: cfg.exitIndex,
    edges: cfg.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort((x, y) => (x < y ? -1 : 1)),
  };
}

interface Rel {
  sourceId: string;
  targetId: string;
}
function recordingGraph(): { graph: KnowledgeGraph; nodeIds: string[]; rels: Rel[] } {
  const nodeIds: string[] = [];
  const rels: Rel[] = [];
  const graph = {
    addNode: (n: { id: string }) => nodeIds.push(n.id),
    addRelationship: (r: Rel) => rels.push(r),
  } as unknown as KnowledgeGraph;
  return { graph, nodeIds, rels };
}

function reaches(adj: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop() as string;
    if (n === to) return true;
    for (const nx of adj.get(n) ?? []) if (!seen.has(nx)) (seen.add(nx), stack.push(nx));
  }
  return seen.has(to);
}

describe('U7 — AC1: ten-functions fixture CFG snapshot', () => {
  it('matches the committed CFG node/edge set', () => {
    const cfgs = cfgsOfFile('ten-functions.ts');
    // 10 M1 functions + 2 M2 additions (early-exit finally, shadowing — #2082 U5)
    expect(cfgs).toHaveLength(12);
    expect(cfgs.map(serialize)).toMatchSnapshot();
  });
});

describe('U7 — AC2: every BasicBlock reachable from its function ENTRY', () => {
  it('holds for all fixture functions (no dead code in the fixture)', () => {
    const cfgs = cfgsOfFile('ten-functions.ts');
    const { graph, nodeIds, rels } = recordingGraph();
    emitFileCfgs(graph, cfgs);

    const adj = new Map<string, string[]>();
    for (const e of rels)
      (adj.get(e.sourceId) ?? adj.set(e.sourceId, []).get(e.sourceId)!).push(e.targetId);

    for (const cfg of cfgs) {
      const prefix = `BasicBlock:ten-functions.ts:${cfg.functionStartLine}:${cfg.functionStartColumn}:`;
      const entryId = `${prefix}${cfg.entryIndex}`;
      for (const id of nodeIds.filter((i) => i.startsWith(prefix))) {
        expect(reaches(adj, entryId, id), `${id} unreachable from ENTRY`).toBe(true);
      }
    }
  });
});

describe('U7 — AC3: hazard topologies', () => {
  function blockAdj(cfg: FunctionCfg): { adj: Map<number, number[]> } {
    const adj = new Map<number, number[]>();
    for (const e of cfg.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    return { adj };
  }
  const blockWith = (cfg: FunctionCfg, sub: string): number => {
    const b = cfg.blocks.find((bl) => bl.text.includes(sub));
    if (!b) throw new Error(`no block with ${sub}`);
    return b.index;
  };
  const reachIdx = (cfg: FunctionCfg, from: number, to: number): boolean => {
    const { adj } = blockAdj(cfg);
    const seen = new Set([from]);
    const st = [from];
    while (st.length) {
      const n = st.pop() as number;
      if (n === to) return true;
      for (const nx of adj.get(n) ?? []) if (!seen.has(nx)) (seen.add(nx), st.push(nx));
    }
    return false;
  };

  it('try/throw/finally: normal + exceptional both flow through finally to the post-try block', () => {
    const cfgs = cfgsOfFile('hazards.ts');
    const fn = cfgs.find((c) => c.blocks.some((b) => b.text.includes('cleanup();')))!;
    const fin = blockWith(fn, 'cleanup();');
    const after = blockWith(fn, 'afterTry();');
    const work = blockWith(fn, 'work();');
    const handler = blockWith(fn, 'handle();');
    expect(fn.edges.some((e) => e.kind === 'throw')).toBe(true);
    expect(reachIdx(fn, work, fin)).toBe(true); // normal path → finally
    expect(reachIdx(fn, work, handler)).toBe(true); // exceptional → catch
    expect(reachIdx(fn, handler, fin)).toBe(true); // catch → finally
    expect(reachIdx(fn, fin, after)).toBe(true); // finally → continuation
  });

  it('labeled break escapes both loops to the post-loop block, not the inner exit', () => {
    const cfgs = cfgsOfFile('hazards.ts');
    const fn = cfgs.find((c) => c.blocks.some((b) => b.text.includes('break outer;')))!;
    const brk = blockWith(fn, 'break outer;');
    expect(reachIdx(fn, brk, blockWith(fn, 'done();'))).toBe(true);
    expect(reachIdx(fn, brk, blockWith(fn, 'afterInner();'))).toBe(false);
    expect(fn.edges.some((e) => e.kind === 'break')).toBe(true);
  });

  it('labeled continue returns to the OUTER loop header (not the nearest)', () => {
    const cfgs = cfgsOfFile('hazards.ts');
    const fn = cfgs.find((c) => c.blocks.some((b) => b.text.includes('continue outer;')))!;
    const cont = blockWith(fn, 'continue outer;');
    // outer loop iterates `xs`; its header is the only block whose text holds "xs"
    const outerHeader = blockWith(fn, 'xs');
    expect(
      fn.edges.some((e) => e.from === cont && e.to === outerHeader && e.kind === 'continue'),
    ).toBe(true);
  });
});
