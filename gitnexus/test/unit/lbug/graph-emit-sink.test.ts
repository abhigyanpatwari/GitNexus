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
    sink.beginStreaming();

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
    sink.beginStreaming();

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
    sink.beginStreaming();

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
    sink.beginStreaming();

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

  it('throws rather than silently dropping an undeclared endpoint-label pair (#2769)', () => {
    // Before #2769's fix, this pair reached COPY, failed the bulk insert, and
    // the per-edge fallback swallowed the failure into `catch {}` — the run
    // still exited 0 with the edge silently missing. Both endpoints are valid
    // node tables (so the validTables gate above does not catch it); the pair
    // itself is simply absent from RELATION_SCHEMA.
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();

    const undeclared: GraphRelationship = {
      id: 'CALLS:Static:a->Static:b',
      sourceId: 'Static:src/a.ts:A',
      targetId: 'Static:src/a.ts:B',
      type: 'CALLS',
      confidence: 1,
      reason: 'direct',
    };
    expect(() => sink.addRelationship(undeclared)).toThrow(
      /Relationship label pair Static→Static is not declared/,
    );
  });
});

describe('GraphEmitSink arming', () => {
  it('retains everything in the graph until armed', () => {
    // The pre-parse phases are not all write-only: mapCobolToGraph scans CALLS
    // edges and removes the unresolved ones. If the sink streamed from
    // construction, that scan would see nothing and COBOL cross-program calls
    // would silently stop resolving.
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);

    sink.addRelationship(rel('CALLS', 'a', 'b'));

    expect(real.relationshipCount).toBe(1);
    expect(sink.finalize()).toMatchObject({ totalRows: 0 });
  });

  it('removal of a pre-arm CALLS edge still works (the COBOL path)', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    const unresolved = rel('CALLS', 'a', 'b');
    sink.addRelationship(unresolved);

    expect(sink.removeRelationship(unresolved.id)).toBe(true);
    expect(real.relationshipCount).toBe(0);
    sink.finalize();
  });
});

describe('GraphEmitSink dedup', () => {
  it('writes a duplicate relationship id exactly once', async () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();

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
    sink.beginStreaming();
    const streamed = rel('CALLS', 'a', 'b');
    sink.addRelationship(streamed);

    expect(() => sink.removeRelationship(streamed.id)).toThrow(StreamedRelationshipRemovalError);
    sink.finalize();
  });

  it('still removes a retained edge normally', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();
    const retained = rel('DEFINES', 'a', 'b');
    sink.addRelationship(retained);

    expect(sink.removeRelationship(retained.id)).toBe(true);
    expect(real.relationshipCount).toBe(0);
    sink.finalize();
  });
});

describe('GraphEmitSink reads are complete', () => {
  it('iterRelationships returns streamed edges alongside retained ones', () => {
    // This is the property that lets streaming be the default: every consumer
    // (communities, processes, taint, the pruner) reads through this and must
    // see the whole graph, not just what stayed in memory.
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();

    sink.addRelationship(rel('DEFINES', 'file', 'fn')); // retained
    sink.addRelationship(rel('CALLS', 'a', 'b')); // streamed
    sink.addRelationship(rel('ACCESSES', 'b', 'c')); // streamed

    const seen = [...sink.iterRelationships()];
    expect(seen.map((r) => r.type).sort()).toEqual(['ACCESSES', 'CALLS', 'DEFINES']);
    expect(sink.relationshipCount).toBe(3);
    // The real graph still holds only the retained one — the saving is real.
    expect(real.relationshipCount).toBe(1);
    sink.finalize();
  });

  it('preserves endpoints and confidence on a streamed edge', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();
    sink.addRelationship({ ...rel('CALLS', 'caller', 'callee'), confidence: 0.25 });

    expect([...sink.iterRelationships()]).toMatchObject([
      { sourceId: fnId('caller'), targetId: fnId('callee'), type: 'CALLS', confidence: 0.25 },
    ]);
    sink.finalize();
  });

  it('iterRelationshipsByType finds a streamed type', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();
    sink.addRelationship(rel('CALLS', 'a', 'b'));
    sink.addRelationship(rel('ACCESSES', 'a', 'c'));

    expect([...sink.iterRelationshipsByType('CALLS')]).toHaveLength(1);
    expect([...sink.iterRelationshipsByType('ACCESSES')]).toHaveLength(1);
    expect([...sink.iterRelationshipsByType('EXTENDS')]).toEqual([]);
    sink.finalize();
  });

  it('forEachRelationship visits streamed edges too', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();
    sink.addRelationship(rel('CALLS', 'a', 'b'));

    const visited: string[] = [];
    sink.forEachRelationship((r) => visited.push(r.type));
    expect(visited).toEqual(['CALLS']);
    sink.finalize();
  });
});

describe('GraphEmitSink IO faults', () => {
  it('surfaces a writer-open failure from finalize instead of a partial manifest', () => {
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();
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
    sink.beginStreaming();
    sink.finalize();
    expect(() => sink.finalize()).toThrow(/called twice/);
  });
});

describe('dedup key exactness', () => {
  const endpoints = { sourceId: fnId('f'), targetId: fnId('g') };
  const withId = (id: string): GraphRelationship => ({
    id,
    ...endpoints,
    type: 'CALLS',
    confidence: 1,
    reason: 'direct',
  });

  it('keeps two ids that differ only in how many tail segments they carry', () => {
    // Regression: the dedup key packs the id's trailing numeric segments, and an
    // absent second segment defaults to 0. Without the segment COUNT in the key,
    // `:7` and `:7:0` collapse onto one key and the second edge is silently
    // discarded — a lost relationship with no error. Distinct ids must never
    // collapse; identical ones must (see the duplicate test above).
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();

    sink.addRelationship(withId(`rel:CALLS:${endpoints.sourceId}->${endpoints.targetId}:7`));
    sink.addRelationship(withId(`rel:CALLS:${endpoints.sourceId}->${endpoints.targetId}:7:0`));

    expect(sink.relationshipCount).toBe(2);
    expect(sink.finalize()).toMatchObject({ totalRows: 2 });
  });

  it('keeps two call sites between the same pair', () => {
    // The `:line:col` case from emit-references — same endpoints and type, so
    // identical CSV rows; only the id distinguishes them, and the whole-graph
    // emit keeps both.
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();

    sink.addRelationship(withId(`rel:CALLS:${endpoints.sourceId}->${endpoints.targetId}:10:4`));
    sink.addRelationship(withId(`rel:CALLS:${endpoints.sourceId}->${endpoints.targetId}:99:7`));

    expect(sink.relationshipCount).toBe(2);
    sink.finalize();
  });

  it('still collapses a genuinely repeated id', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();
    const id = `rel:CALLS:${endpoints.sourceId}->${endpoints.targetId}:10:4`;

    sink.addRelationship(withId(id));
    sink.addRelationship(withId(id));

    expect(sink.relationshipCount).toBe(1);
    sink.finalize();
  });

  it('falls back to the full id for a non-numeric tail', () => {
    // `rel:imports:...:${localName}` has a textual tail; the compact form does
    // not apply and the id must be stored verbatim rather than truncated.
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();

    sink.addRelationship(withId(`rel:IMPORTS:${endpoints.sourceId}->${endpoints.targetId}:alpha`));
    sink.addRelationship(withId(`rel:IMPORTS:${endpoints.sourceId}->${endpoints.targetId}:beta`));

    expect(sink.relationshipCount).toBe(2);
    sink.finalize();
  });
});

describe('removeRelationship contract divergence', () => {
  it('throws for an absent id once streaming has begun, by design', () => {
    // KnowledgeGraph.removeRelationship returns false for an id it does not
    // hold. The sink cannot rebuild a compact dedup key from a bare id, so it
    // refuses to answer "false" for something that might already be on disk and
    // unrecallable. Pinned so the divergence stays deliberate.
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();
    sink.addRelationship(rel('CALLS', 'a', 'b'));

    expect(() => sink.removeRelationship('rel:CALLS:never:emitted')).toThrow(
      StreamedRelationshipRemovalError,
    );
    sink.finalize();
  });

  it('returns false for an absent id before anything has streamed', () => {
    const sink = new GraphEmitSink(createKnowledgeGraph(), csvDir);
    sink.beginStreaming();

    expect(sink.removeRelationship('rel:CALLS:never:emitted')).toBe(false);
    sink.finalize();
  });
});

describe('field scan matches the object scan', () => {
  it('yields the same (source, target, type, confidence) tuples either way', () => {
    // Guards the five whole-graph scans converted to forEachRelationshipFields:
    // a divergence between the two forms would silently skew community
    // detection, process extraction and the pruner.
    const real = createKnowledgeGraph();
    const sink = new GraphEmitSink(real, csvDir);
    sink.beginStreaming();
    sink.addRelationship(rel('DEFINES', 'file', 'fn'));
    sink.addRelationship(rel('CALLS', 'a', 'b'));
    sink.addRelationship({ ...rel('ACCESSES', 'b', 'c'), confidence: 0.5 });

    const viaObjects = [...sink.iterRelationships()]
      .map((r) => `${r.sourceId}|${r.targetId}|${r.type}|${r.confidence}`)
      .sort();
    const viaFields: string[] = [];
    sink.forEachRelationshipFields((s, t, ty, c) => viaFields.push(`${s}|${t}|${ty}|${c}`));

    expect(viaFields.sort()).toEqual(viaObjects);
    sink.finalize();
  });
});
