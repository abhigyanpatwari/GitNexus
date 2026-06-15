/**
 * PdgEmitSink unit tests (issue #2202 U2).
 *
 * Verifies the streaming PDG emit sink:
 *  - routes BasicBlock nodes + PDG edges to bounded CSV-on-disk;
 *  - delegates structural nodes/edges + the whole-program TAINT_PATH edge to
 *    the real graph (never streamed);
 *  - is byte-identical (set-wise) to the whole-graph `streamAllCSVsToDisk`
 *    emit for the same node/edge set (the issue's byte-identity acceptance);
 *  - never accumulates the PDG layer in the in-memory graph (the RSS bound).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { streamAllCSVsToDisk, buildBasicBlockRow } from '../../../src/core/lbug/csv-generator.js';
import { PdgEmitSink } from '../../../src/core/lbug/pdg-emit-sink.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

const bbNode = (fp: string, idx: number, line: number): GraphNode => ({
  id: `BasicBlock:${fp}:1:0:${idx}`,
  label: 'BasicBlock',
  properties: { name: '', filePath: fp, startLine: line, endLine: line + 1, text: `blk ${idx}` },
});

const pdgEdge = (
  fp: string,
  from: number,
  to: number,
  type: GraphRelationship['type'],
  reason: string,
): GraphRelationship => ({
  id: `${type}:${fp}:${from}->${to}`,
  sourceId: `BasicBlock:${fp}:1:0:${from}`,
  targetId: `BasicBlock:${fp}:1:0:${to}`,
  type,
  confidence: 1,
  reason,
});

/** Sorted non-empty lines of a CSV file (order-independent comparison). */
const sortedLines = async (csvPath: string): Promise<string[]> => {
  const text = await fsp.readFile(csvPath, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-sink-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('PdgEmitSink — routing', () => {
  it('routes BasicBlock nodes and PDG edges to CSV, never to the real graph', () => {
    const real = createKnowledgeGraph();
    const sink = new PdgEmitSink(real, path.join(tmpRoot, 'pdg-csv'));

    sink.addNode(bbNode('a.ts', 0, 1));
    sink.addNode(bbNode('a.ts', 1, 5));
    sink.addRelationship(pdgEdge('a.ts', 0, 1, 'CFG', 'seq'));
    sink.addRelationship(pdgEdge('a.ts', 0, 1, 'REACHING_DEF', 'x:1:0'));

    // PDG layer must not land in the in-memory graph (the RSS bound).
    expect(real.nodeCount).toBe(0);
    expect(real.relationshipCount).toBe(0);
    expect(sink.nodeCount).toBe(0);

    sink.finalize();
  });

  it('delegates structural nodes, CALLS, and the whole-program TAINT_PATH edge to the real graph', () => {
    const real = createKnowledgeGraph();
    const sink = new PdgEmitSink(real, path.join(tmpRoot, 'pdg-csv'));

    sink.addNode({
      id: 'Function:a.ts:fn:1',
      label: 'Function',
      properties: { name: 'fn', filePath: 'a.ts', startLine: 1, endLine: 9 },
    });
    sink.addRelationship({
      id: 'CALLS:1',
      sourceId: 'Function:a.ts:fn:1',
      targetId: 'Function:a.ts:fn2:9',
      type: 'CALLS',
      confidence: 1,
      reason: '',
    });
    // TAINT_PATH is a whole-program (Function→Function) edge — NOT streamed.
    sink.addRelationship({
      id: 'TAINT_PATH:1',
      sourceId: 'Function:a.ts:fn:1',
      targetId: 'Function:a.ts:fn2:9',
      type: 'TAINT_PATH',
      confidence: 0.9,
      reason: 'src->sink',
    });

    expect(real.nodeCount).toBe(1);
    expect(real.relationshipCount).toBe(2);
    expect(real.getNode('Function:a.ts:fn:1')).toBeDefined();

    const manifest = sink.finalize();
    // No BasicBlock node CSV was created (no BasicBlock nodes were routed).
    expect(manifest.nodeFiles.size).toBe(0);
    expect(manifest.relsByPair.size).toBe(0);
  });
});

describe('PdgEmitSink — byte-identity vs whole-graph emit', () => {
  it('streamed CSV line set equals streamAllCSVsToDisk for the same nodes/edges', async () => {
    const fp = 'a.ts';
    const nodes = [bbNode(fp, 0, 1), bbNode(fp, 1, 5), bbNode(fp, 2, 9)];
    const edges: GraphRelationship[] = [
      pdgEdge(fp, 0, 1, 'CFG', 'seq'),
      pdgEdge(fp, 1, 2, 'CFG', 'cond-true'),
      pdgEdge(fp, 0, 2, 'REACHING_DEF', 'x:1:0'),
      pdgEdge(fp, 1, 2, 'CDG', 'T'),
      pdgEdge(fp, 0, 1, 'POST_DOMINATE', ''),
      pdgEdge(fp, 0, 2, 'TAINTED', 'taint'),
      pdgEdge(fp, 1, 2, 'SANITIZES', 'clean'),
    ];

    // Whole-graph path: add to a plain graph, run streamAllCSVsToDisk.
    const wholeGraph = createKnowledgeGraph();
    for (const n of nodes) wholeGraph.addNode(n);
    for (const e of edges) wholeGraph.addRelationship(e);
    const wholeDir = path.join(tmpRoot, 'csv');
    await streamAllCSVsToDisk(wholeGraph, path.join(tmpRoot, 'no-such-repo'), wholeDir);

    // Streamed path: route the same set through the sink.
    const pdgDir = path.join(tmpRoot, 'pdg-csv');
    const sink = new PdgEmitSink(createKnowledgeGraph(), pdgDir);
    for (const n of nodes) sink.addNode(n);
    for (const e of edges) sink.addRelationship(e);
    const manifest = sink.finalize();

    // BasicBlock node CSV: identical line set.
    expect(await sortedLines(path.join(pdgDir, 'basicblock.csv'))).toEqual(
      await sortedLines(path.join(wholeDir, 'basicblock.csv')),
    );

    // PDG edges all route to the BasicBlock|BasicBlock pair file: identical set.
    expect(await sortedLines(path.join(pdgDir, 'rel_BasicBlock_BasicBlock.csv'))).toEqual(
      await sortedLines(path.join(wholeDir, 'rel_BasicBlock_BasicBlock.csv')),
    );

    // Manifest reports the streamed files + row counts.
    expect(manifest.nodeFiles.get('BasicBlock')?.rows).toBe(nodes.length);
    expect(manifest.relsByPair.get('BasicBlock|BasicBlock')?.rows).toBe(edges.length);
  });

  it('emits rows via the shared builder (buildBasicBlockRow)', async () => {
    const pdgDir = path.join(tmpRoot, 'pdg-csv');
    const sink = new PdgEmitSink(createKnowledgeGraph(), pdgDir);
    const n = bbNode('a.ts', 0, 3);
    sink.addNode(n);
    sink.finalize();
    const lines = await sortedLines(path.join(pdgDir, 'basicblock.csv'));
    // header + one data row; the data row is exactly buildBasicBlockRow(n).
    expect(lines).toContain(buildBasicBlockRow(n));
  });
});

describe('PdgEmitSink — bounded retention', () => {
  it('flushes incrementally so the graph never holds the PDG layer', async () => {
    const real = createKnowledgeGraph();
    const pdgDir = path.join(tmpRoot, 'pdg-csv');
    const sink = new PdgEmitSink(real, pdgDir, 2); // tiny chunk to force flushes

    const TOTAL = 50;
    for (let i = 0; i < TOTAL; i++) sink.addNode(bbNode('a.ts', i, i));

    // Mid-stream (before finalize): rows have already been flushed to disk,
    // proving the writer is not buffering the whole layer in memory.
    const midText = fs.readFileSync(path.join(pdgDir, 'basicblock.csv'), 'utf8');
    const midDataRows = midText.split('\n').filter((l) => l.length > 0).length - 1; // minus header
    expect(midDataRows).toBeGreaterThan(0);
    expect(midDataRows).toBeLessThanOrEqual(TOTAL);

    // The in-memory graph never received a single BasicBlock.
    expect(real.nodeCount).toBe(0);

    const manifest = sink.finalize();
    expect(manifest.nodeFiles.get('BasicBlock')?.rows).toBe(TOTAL);
    const finalRows = (await sortedLines(path.join(pdgDir, 'basicblock.csv'))).length - 1;
    expect(finalRows).toBe(TOTAL);
  });

  it('finalize twice throws', () => {
    const sink = new PdgEmitSink(createKnowledgeGraph(), path.join(tmpRoot, 'pdg-csv'));
    sink.finalize();
    expect(() => sink.finalize()).toThrow(/twice/);
  });
});
