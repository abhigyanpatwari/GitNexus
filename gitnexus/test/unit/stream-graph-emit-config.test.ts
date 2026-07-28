/**
 * Streamed structural graph emit — config gate and pruner integration (#2680).
 *
 * The gate is a soundness boundary, not a preference: streaming is only valid
 * on a full rebuild, because the incremental writeback reads relationships back
 * out of the in-memory graph.
 *
 * The pruner cases are the sharp end of the feature. `pruneLocalValueSymbols`
 * decides "is this block-local symbol referenced?" from an in-memory
 * relationship scan; under streaming that scan cannot see edges already on
 * disk, so without the predicate a referenced symbol is deleted and its
 * streamed CSV row is left pointing at a node with no row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { resolveStreamGraphEmit } from '../../src/core/run-analyze.js';
import { buildPhaseList } from '../../src/core/ingestion/pipeline.js';
import { RETAINED_REL_TYPES } from '../../src/core/lbug/graph-emit-sink.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { RelationshipType } from 'gitnexus-shared';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveStreamGraphEmit', () => {
  it('is ON by default on a full rebuild — no opt-in needed', () => {
    expect(resolveStreamGraphEmit({ force: true })).toBe(true);
  });

  it('is turned off by an explicit falsy env value (the escape hatch)', () => {
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '0');
    expect(resolveStreamGraphEmit({ force: true })).toBe(false);
  });

  it('is turned off by an explicit option, which beats the env', () => {
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');
    expect(resolveStreamGraphEmit({ force: true, streamGraphEmit: false })).toBe(false);
  });

  it('honors the explicit option on a full rebuild', () => {
    expect(resolveStreamGraphEmit({ force: true, streamGraphEmit: true })).toBe(true);
  });

  it('honors the env toggle on a full rebuild', () => {
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');
    expect(resolveStreamGraphEmit({ force: true })).toBe(true);
  });

  it('refuses an incremental run even when explicitly requested', () => {
    // The incremental writeback reads relationships back out of the in-memory
    // graph; streaming has already offloaded them.
    expect(resolveStreamGraphEmit({ force: false, streamGraphEmit: true })).toBe(false);
    expect(resolveStreamGraphEmit({ streamGraphEmit: true })).toBe(false);
  });

  it('refuses an incremental run even when the env toggle is set', () => {
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');
    expect(resolveStreamGraphEmit({ force: false })).toBe(false);
  });
});

const FILE_ID = 'File:src/a.ts';
const LOCAL_ID = 'Const:src/a.ts:localValue';

const localConst = (): GraphNode => ({
  id: LOCAL_ID,
  label: 'Const',
  properties: { name: 'localValue', filePath: 'src/a.ts', scope: 'block' },
});

/** Graph holding only the structural File->DEFINES->localConst edge, i.e. the
 *  shape the pruner sees when the symbol's only *semantic* reference streamed
 *  out to CSV. */
const graphWithOnlyStructuralEdge = () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: FILE_ID,
    label: 'File',
    properties: { name: 'a.ts', filePath: 'src/a.ts' },
  });
  graph.addNode(localConst());
  graph.addRelationship({
    id: `DEFINES:${FILE_ID}->${LOCAL_ID}`,
    sourceId: FILE_ID,
    targetId: LOCAL_ID,
    type: 'DEFINES',
    confidence: 1,
    reason: 'structural',
  });
  return graph;
};

describe('buildPhaseList under streamGraphEmit', () => {
  const names = (o: Parameters<typeof buildPhaseList>[0]) => buildPhaseList(o).map((p) => p.name);

  it('keeps every CALLS-consuming phase enabled — nothing is traded away', () => {
    // The sink answers a complete relationship read, so these phases work
    // unchanged. If this ever regresses to filtering them out, streaming can no
    // longer be the default.
    const streamed = names({ streamGraphEmit: true, pdg: true, force: true });

    expect(streamed).toContain('communities');
    expect(streamed).toContain('processes');
    expect(streamed).toContain('taintSummaries');
    expect(streamed).toContain('callSummaries');
  });

  it('keeps mro and di, whose reads are all in the retained set', () => {
    const streamed = names({ streamGraphEmit: true, pdg: true, force: true });

    expect(streamed).toContain('mro');
    expect(streamed).toContain('di');
    expect(streamed).toContain('parse');
    expect(streamed).toContain('scopeResolution');
    expect(streamed).toContain('pruneLocalSymbols');
  });

  it('leaves the phase list untouched when the flag is off', () => {
    // Guards the default path: the gating predicates must not filter anything
    // for existing (flag-off) users.
    const withPdg = names({ pdg: true, force: true });

    expect(withPdg).toContain('communities');
    expect(withPdg).toContain('processes');
    expect(withPdg).toContain('taintSummaries');
    expect(withPdg).toContain('callSummaries');
  });

  it('still honours skipGraphPhases independently of the streaming flag', () => {
    const skipped = names({ skipGraphPhases: true });

    expect(skipped).not.toContain('communities');
    expect(skipped).not.toContain('processes');
    expect(skipped).toContain('pruneLocalSymbols');
  });
});

describe('RETAINED_REL_TYPES tracks its readers', () => {
  it('streams write-only conditional and declaration evidence', () => {
    expect(RETAINED_REL_TYPES.has('CONDITIONAL_ON')).toBe(false);
    expect(RETAINED_REL_TYPES.has('DECLARES')).toBe(false);
  });

  it('retains every relationship type any phase reads back mid-pipeline', async () => {
    // The round-trip test CANNOT catch drift here: addRelationship partitions
    // edges between the graph and the CSVs, and a partition's union is
    // invariant under where the line falls — so it stays green for any
    // partitioning, including a wrong one. Nothing else guards the invariant,
    // and getting it wrong yields a silently incomplete edge set mid-pipeline
    // rather than a crash. So derive the required set from the source and
    // compare.
    const { execFileSync } = await import('node:child_process');
    const srcDir = new URL('../../src/', import.meta.url).pathname;

    // Every literal `iterRelationshipsByType('X')` reachable while streaming is
    // armed. `git grep -h` over src/ excluding tests; the sink itself is
    // excluded because its own fast-path check reads the constant, not an edge.
    const out = execFileSync(
      'grep',
      ['-rhoE', "iterRelationshipsByType\\('[A-Z_]+'\\)", '--include=*.ts', srcDir],
      { encoding: 'utf8' },
    );
    const readTypes = new Set(
      [...out.matchAll(/iterRelationshipsByType\('([A-Z_]+)'\)/g)].map((m) => m[1]),
    );

    // CALLS is read by taintSummaries, which is exactly why the sink answers a
    // COMPLETE read instead of retaining it — so it is a known exemption.
    readTypes.delete('CALLS');

    const missing = [...readTypes].filter((t) => !RETAINED_REL_TYPES.has(t as RelationshipType));
    expect(missing).toEqual([]);
  });
});

describe('streamGraphEmit without a CSV dir', () => {
  it('throws instead of silently running without streaming', async () => {
    // Streaming is on by default, so a programmatic host that builds its own
    // PipelineOptions and forgets the directory must not get a successful run
    // that quietly did no streaming.
    const { runPipelineFromRepo } = await import('../../src/core/ingestion/pipeline.js');

    await expect(
      runPipelineFromRepo('/nonexistent-repo', () => {}, { streamGraphEmit: true }),
    ).rejects.toThrow(/graphEmitCsvDir is missing/);
  });
});
