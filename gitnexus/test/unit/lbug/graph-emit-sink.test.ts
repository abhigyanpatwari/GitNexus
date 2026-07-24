/**
 * GraphEmitSink unit tests (issue #2680).
 *
 * Verifies the streaming structural emit sink:
 *  - routes non-retained relationships to bounded CSV-on-disk and never stores
 *    them, while retained types reach the real graph untouched;
 *  - dedups by relationship id (the whole-graph emit does, and COPY into a
 *    PK-bearing table would violate on a repeat) — PdgEmitSink relies on an
 *    upstream per-file guarantee that does NOT exist for structural edges;
 *  - refuses to silently forget a streamed edge on removeRelationship;
 *  - exposes the streamed-endpoint predicate the local-symbol pruner needs to
 *    avoid pruning a node that a streamed edge still references;
 *  - fails loudly rather than handing a truncated CSV to the bulk COPY.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import {
  GraphEmitSink,
  RETAINED_REL_TYPES,
  StreamedRelationshipRemovalError,
} from '../../../src/core/lbug/graph-emit-sink.js';
import type { GraphRelationship } from 'gitnexus-shared';

const fnId = (name: string): string => `Function:src/a.ts:${name}`;

const rel = (
  type: GraphRelationship['type'],
  from: string,
  to: string,
  suffix = '',
): GraphRelationship => ({
  id: `${type}:${fnId(from)}->${fnId(to)}${suffix}`,
  sourceId: fnId(from),
  targetId: fnId(to),
  type,
  confidence: 1,
  reason: 'direct',
});

const dataRows = async (csvPath: string): Promise<string[]> => {
  const text = await fsp.readFile(csvPath, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .slice(1); // drop header
};

let tmpRoot: string;
let csvDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-emit-sink-'));
  csvDir = path.join(tmpRoot, 'streamed');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GraphEmitSink routing', () => {
  it('streams a non-retained type to CSV and keeps it out of the graph', async () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    sink.addRelationship(rel('CALLS', 'a', 'b'));
    const manifest = sink.finalize();

    expect(real.relationshipCount).toBe(0);
    expect(manifest).toMatchObject({ totalRows: 1 });
    const pair = manifest.relsByPair.get('Function|Function');
    expect(pair).toMatchObject({ rows: 1 });
    expect(await dataRows(pair!.csvPath)).toHaveLength(1);
  });

  it('delegates every retained type to the real graph and writes no CSV', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    for (const type of RETAINED_REL_TYPES) {
      sink.addRelationship(rel(type, 'a', 'b', `:${type}`));
    }
    const manifest = sink.finalize();

    expect(real.relationshipCount).toBe(RETAINED_REL_TYPES.size);
    expect(manifest).toMatchObject({ totalRows: 0 });
    expect(manifest.relsByPair.size).toBe(0);
  });

  it('never streams nodes — they stay in the real graph', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    sink.addNode({
      id: fnId('a'),
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts', startLine: 1, endLine: 2 },
    });
    sink.finalize();

    expect(real.nodeCount).toBe(1);
    expect(fs.readdirSync(csvDir)).toEqual([]);
  });

  it('skips edges whose endpoint labels are not valid node tables', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    sink.addRelationship({
      id: 'CALLS:bogus->alsobogus',
      sourceId: 'NotATable:src/a.ts:x',
      targetId: 'NotATable:src/a.ts:y',
      type: 'CALLS',
      confidence: 1,
      reason: 'direct',
    });
    const manifest = sink.finalize();

    expect(manifest).toMatchObject({ totalRows: 0 });
    expect(real.relationshipCount).toBe(0);
  });
});

describe('GraphEmitSink dedup', () => {
  it('writes a duplicate relationship id exactly once', async () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    const duplicated = rel('CALLS', 'a', 'b');
    sink.addRelationship(duplicated);
    sink.addRelationship(duplicated);
    sink.addRelationship({ ...duplicated });
    const manifest = sink.finalize();

    // A second row would violate the relationship table's PK on COPY.
    expect(manifest).toMatchObject({ totalRows: 1 });
    expect(await dataRows(manifest.relsByPair.get('Function|Function')!.csvPath)).toHaveLength(1);
  });
});

describe('GraphEmitSink removal safety', () => {
  it('throws rather than silently forgetting an already-streamed edge', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    const streamed = rel('CALLS', 'a', 'b');
    sink.addRelationship(streamed);

    expect(() => sink.removeRelationship(streamed.id)).toThrow(StreamedRelationshipRemovalError);
    sink.finalize();
  });

  it('still removes a retained edge normally', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    const retained = rel('DEFINES', 'a', 'b');
    sink.addRelationship(retained);

    expect(sink.removeRelationship(retained.id)).toBe(true);
    expect(real.relationshipCount).toBe(0);
    sink.finalize();
  });
});

describe('GraphEmitSink streamed-endpoint predicate', () => {
  it('reports both endpoints of a streamed edge as semantically referenced', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.addRelationship(rel('CALLS', 'caller', 'callee'));

    // Both directions matter: the pruner treats any outgoing edge as semantic,
    // and any incoming edge as semantic unless it is File->DEFINES — and
    // DEFINES is retained, so no streamed edge is ever one.
    expect(sink.hasStreamedSemanticEdge(fnId('caller'))).toBe(true);
    expect(sink.hasStreamedSemanticEdge(fnId('callee'))).toBe(true);
    expect(sink.hasStreamedSemanticEdge(fnId('unrelated'))).toBe(false);
    sink.finalize();
  });

  it('does not report endpoints of a retained edge (those stay scannable)', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.addRelationship(rel('DEFINES', 'file', 'sym'));

    expect(sink.hasStreamedSemanticEdge(fnId('file'))).toBe(false);
    sink.finalize();
  });
});

describe('GraphEmitSink IO faults', () => {
  it('surfaces a writer-open failure from finalize instead of a partial manifest', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.addRelationship(rel('CALLS', 'a', 'b'));

    // Destroy the CSV dir so the next pair's writer cannot be opened, the way
    // an out-of-fds (EMFILE) or disk-full run would fail mid-emit.
    fs.rmSync(csvDir, { recursive: true, force: true });
    expect(() =>
      sink.addRelationship({
        id: 'CALLS:File:src/a.ts->Function:src/a.ts:b',
        sourceId: 'File:src/a.ts',
        targetId: fnId('b'),
        type: 'CALLS',
        confidence: 1,
        reason: 'direct',
      }),
    ).toThrow();

    expect(() => sink.finalize()).toThrow(/streamed CSV writer\(s\) hit an IO error/);
  });

  it('refuses a second finalize', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.finalize();
    expect(() => sink.finalize()).toThrow(/called twice/);
  });
});
