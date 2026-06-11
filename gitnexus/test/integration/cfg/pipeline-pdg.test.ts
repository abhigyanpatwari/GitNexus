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

function counts(result: PipelineResult): { basicBlocks: number; cfgEdges: number } {
  let basicBlocks = 0;
  result.graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') basicBlocks++;
  });
  let cfgEdges = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'CFG') cfgEdges++;
  }
  return { basicBlocks, cfgEdges };
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
    const { basicBlocks, cfgEdges } = counts(result);
    expect(basicBlocks).toBeGreaterThan(0);
    expect(cfgEdges).toBeGreaterThan(0);
    // CFG edges connect BasicBlocks to BasicBlocks — both endpoints exist.
    const blockIds = new Set<string>();
    result.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') blockIds.add(n.id);
    });
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'CFG') continue;
      expect(blockIds.has(rel.sourceId)).toBe(true);
      expect(blockIds.has(rel.targetId)).toBe(true);
    }
  }, 60000);

  it('with --pdg off (default): emits zero BasicBlock nodes and zero CFG edges', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {});
    const { basicBlocks, cfgEdges } = counts(result);
    expect(basicBlocks).toBe(0);
    expect(cfgEdges).toBe(0);
  }, 60000);
});
