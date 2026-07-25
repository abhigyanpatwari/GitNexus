/**
 * Streamed structural emit — differential set-identity (issue #2680).
 *
 * The acceptance property: for the same node/edge set, the rows that reach the
 * bulk COPY must be IDENTICAL whether streaming is on or off. With streaming
 * on those rows arrive from two places — the residual in-memory graph (via
 * `streamAllCSVsToDisk`) plus the sink's per-pair CSVs — and their union has to
 * equal the single whole-graph emit.
 *
 * Modelled on `pdg-emit-streaming-roundtrip.test.ts`, which likewise drives the
 * sink directly rather than running `analyze`: the guarantee under test is
 * about emitted rows, and going through the worker pool would add a large
 * amount of unrelated machinery without strengthening the assertion.
 *
 * Guarantee is set-level, not byte-level: streamed rows are written in emit
 * order and are not re-sorted, so file bytes may differ while the row SET (and
 * therefore the loaded graph) does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { GraphEmitSink } from '../../src/core/lbug/graph-emit-sink.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

const FILE_PATH = 'src/mod.ts';

const fileNode = (): GraphNode => ({
  id: `File:${FILE_PATH}`,
  label: 'File',
  properties: { name: 'mod.ts', filePath: FILE_PATH },
});

const fnNode = (n: number): GraphNode => ({
  id: `Function:${FILE_PATH}:fn${n}`,
  label: 'Function',
  properties: {
    name: `fn${n}`,
    filePath: FILE_PATH,
    startLine: n,
    endLine: n + 1,
    isExported: false,
  },
});

const classNode = (n: number): GraphNode => ({
  id: `Class:${FILE_PATH}:Cls${n}`,
  label: 'Class',
  properties: { name: `Cls${n}`, filePath: FILE_PATH, startLine: n, endLine: n + 5 },
});

const edge = (
  type: GraphRelationship['type'],
  sourceId: string,
  targetId: string,
): GraphRelationship => ({
  id: `${type}:${sourceId}->${targetId}`,
  sourceId,
  targetId,
  type,
  confidence: 1,
  reason: 'test',
});

/** A mix deliberately spanning both sides of RETAINED_REL_TYPES, plus a
 *  duplicate id and a self-edge — the cases where a naive sink diverges. */
const buildFixture = (
  graph: KnowledgeGraph,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } => {
  const nodes: GraphNode[] = [fileNode(), classNode(1), classNode(2)];
  for (let i = 0; i < 12; i++) nodes.push(fnNode(i));

  const relationships: GraphRelationship[] = [];
  for (const n of nodes) relationships.push(edge('DEFINES', `File:${FILE_PATH}`, n.id)); // retained
  for (let i = 0; i < 11; i++) {
    relationships.push(
      edge('CALLS', `Function:${FILE_PATH}:fn${i}`, `Function:${FILE_PATH}:fn${i + 1}`),
    ); // streamed
    relationships.push(edge('ACCESSES', `Function:${FILE_PATH}:fn${i}`, `Class:${FILE_PATH}:Cls1`)); // streamed
  }
  relationships.push(edge('EXTENDS', `Class:${FILE_PATH}:Cls2`, `Class:${FILE_PATH}:Cls1`)); // retained
  relationships.push(edge('IMPORTS', `File:${FILE_PATH}`, `Class:${FILE_PATH}:Cls1`)); // streamed
  // Self-edge and an exact duplicate id — both must appear exactly once.
  relationships.push(edge('CALLS', `Function:${FILE_PATH}:fn0`, `Function:${FILE_PATH}:fn0`));
  relationships.push(edge('CALLS', `Function:${FILE_PATH}:fn0`, `Function:${FILE_PATH}:fn1`));

  for (const n of nodes) graph.addNode(n);
  for (const r of relationships) graph.addRelationship(r);
  return { nodes, relationships };
};

/** Every relationship row emitted for a graph, as a sorted `pairKey\0row` set. */
const relRowsFromCsvDir = async (csvDir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const name of await fsp.readdir(csvDir)) {
    if (!name.startsWith('rel_') || !name.endsWith('.csv')) continue;
    const pairKey = name.slice('rel_'.length, -'.csv'.length);
    const text = await fsp.readFile(path.join(csvDir, name), 'utf8');
    for (const line of text.split('\n').slice(1)) {
      if (line.length > 0) out.push(`${pairKey}\u0000${line}`);
    }
  }
  return out.sort();
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-emit-roundtrip-'));
  fs.mkdirSync(path.join(tmpRoot, 'repo'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'repo', 'src-placeholder'), '');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('streamed structural emit is set-identical to the whole-graph emit', () => {
  it('emits the same relationship row set with the flag on and off', async () => {
    const repoPath = path.join(tmpRoot, 'repo');

    // ── Arm A: streaming OFF — one whole-graph emit over everything.
    const graphOff = createKnowledgeGraph();
    buildFixture(graphOff);
    const csvDirOff = path.join(tmpRoot, 'csv-off');
    await streamAllCSVsToDisk(graphOff, repoPath, csvDirOff);
    const rowsOff = await relRowsFromCsvDir(csvDirOff);

    // ── Arm B: streaming ON — retained edges stay in the graph and are emitted
    // by streamAllCSVsToDisk; the rest were streamed by the sink.
    const realOn = createKnowledgeGraph();
    const sinkCsvDir = path.join(tmpRoot, 'csv-sink');
    const sink = new GraphEmitSink(realOn, sinkCsvDir);
    sink.beginStreaming();
    buildFixture(sink);
    const manifest = sink.finalize();

    const csvDirOn = path.join(tmpRoot, 'csv-on');
    await streamAllCSVsToDisk(realOn, repoPath, csvDirOn);

    const rowsOn = [
      ...(await relRowsFromCsvDir(csvDirOn)),
      ...(await relRowsFromCsvDir(sinkCsvDir)),
    ].sort();

    // The union of (residual graph emit + streamed CSVs) is the whole-graph emit.
    expect(rowsOn).toEqual(rowsOff);

    // And the split is real — this is what buys the memory, so assert it rather
    // than let a sink that streamed nothing pass the equality above.
    expect(manifest.totalRows).toBeGreaterThan(0);
    expect(realOn.relationshipCount).toBeGreaterThan(0);
    expect(realOn.relationshipCount).toBeLessThan(graphOff.relationshipCount);
    expect(realOn.relationshipCount + manifest.totalRows).toBe(graphOff.relationshipCount);
  });

  it('emits an identical node row set — nodes are never streamed', async () => {
    const repoPath = path.join(tmpRoot, 'repo');

    const graphOff = createKnowledgeGraph();
    buildFixture(graphOff);
    const csvDirOff = path.join(tmpRoot, 'csv-off');
    const resultOff = await streamAllCSVsToDisk(graphOff, repoPath, csvDirOff);

    const realOn = createKnowledgeGraph();
    const sink = new GraphEmitSink(realOn, path.join(tmpRoot, 'csv-sink'));
    sink.beginStreaming();
    buildFixture(sink);
    sink.finalize();
    const csvDirOn = path.join(tmpRoot, 'csv-on');
    const resultOn = await streamAllCSVsToDisk(realOn, repoPath, csvDirOn);

    expect(realOn.nodeCount).toBe(graphOff.nodeCount);
    expect([...resultOn.nodeFiles.keys()].sort()).toEqual([...resultOff.nodeFiles.keys()].sort());
  });
});
