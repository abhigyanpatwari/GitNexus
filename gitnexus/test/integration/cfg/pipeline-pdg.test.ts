import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';

// U7 — end-to-end proof that the `--pdg` opt-in reaches BOTH sinks: the parse
// worker builds a per-function CFG (workerData.pdg) and scope-resolution emits
// BasicBlock nodes + CFG edges from it (the run gate). Runs the real pipeline
// (workers + scope-resolution) on a tiny repo and inspects the in-memory graph.
// The flag-off run proves the gate: zero CFG nodes/edges (cf. AC4 golden).

const FIXTURE = path.join(__dirname, 'fixtures', 'pdg-repo');

function counts(result: PipelineResult): {
  basicBlocks: number;
  cfgEdges: number;
  reachingDefs: number;
} {
  let basicBlocks = 0;
  result.graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') basicBlocks++;
  });
  let cfgEdges = 0;
  let reachingDefs = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'CFG') cfgEdges++;
    if (rel.type === 'REACHING_DEF') reachingDefs++;
  }
  return { basicBlocks, cfgEdges, reachingDefs };
}

const tmpDirs: string[] = [];
function freshRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdg-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

describe('U7 — end-to-end --pdg pipeline', () => {
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('with --pdg on: emits BasicBlock nodes + CFG edges into the graph', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const { basicBlocks, cfgEdges, reachingDefs } = counts(result);
    expect(basicBlocks).toBeGreaterThan(0);
    expect(cfgEdges).toBeGreaterThan(0);
    // M2 (#2082 U5): the def→use projection rides the same gate — the fixture
    // has a loop-carried accumulator (`sum`), so facts must exist.
    expect(reachingDefs).toBeGreaterThan(0);
    // CFG edges connect BasicBlocks to BasicBlocks — both endpoints exist.
    const blockIds = new Set<string>();
    result.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') blockIds.add(n.id);
    });
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'CFG' && rel.type !== 'REACHING_DEF') continue;
      expect(blockIds.has(rel.sourceId)).toBe(true);
      expect(blockIds.has(rel.targetId)).toBe(true);
      if (rel.type === 'REACHING_DEF') {
        // reason carries the plain variable name (M0/S1 verdict)
        expect(typeof rel.reason).toBe('string');
        expect(rel.reason.length).toBeGreaterThan(0);
      }
    }
  }, 60000);

  it('with --pdg off (default): emits zero BasicBlock nodes and zero CFG edges', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {});
    const { basicBlocks, cfgEdges, reachingDefs } = counts(result);
    expect(basicBlocks).toBe(0);
    expect(cfgEdges).toBe(0);
    expect(reachingDefs).toBe(0);
  }, 60000);
});
