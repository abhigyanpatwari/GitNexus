/**
 * End-to-end proof of streaming/chunked PDG graph emit (issue #2202).
 *
 * Runs the real pipeline (workers + scope-resolution) on the pdg-repo fixture
 * TWICE — a non-streamed baseline and a streamed run — and asserts:
 *   - the streamed run's in-memory graph holds ZERO BasicBlock nodes and ZERO
 *     intra-file PDG edges (the bulky layer was flushed to CSV, never resident
 *     — the O(chunk) RSS bound, R1);
 *   - the streamed run produces a `pdgEmitManifest` whose BasicBlock + PDG-edge
 *     row counts EQUAL the baseline's resident counts (same emitted SET, R2);
 *   - the baseline (streaming off) still emits the PDG layer into the graph,
 *     i.e. the default path is unchanged (R3).
 *
 * Both runs use a durable parse cache (streaming requires `parseCache.storagePath`
 * for its CSV dir), differing ONLY in `streamPdgEmit`, so streaming is the only
 * variable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { loadParseCache } from '../../../src/storage/parse-cache.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'pdg-repo');
// A `.vue` SFC importing a `.ts` module: the TS module is PDG-emitted in BOTH
// the TypeScript pass and the Vue context pass (review #8a, cross-pass dedup).
const VUE_TS_FIXTURE = path.join(__dirname, 'fixtures', 'vue-ts-pdg');
const PDG_EDGE_TYPES = new Set([
  'CFG',
  'REACHING_DEF',
  'CDG',
  'POST_DOMINATE',
  'TAINTED',
  'SANITIZES',
]);

const tmpDirs: string[] = [];
function freshRepo(fixture: string = FIXTURE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdg-stream-'));
  fs.cpSync(fixture, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
function freshStorage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdg-store-'));
  tmpDirs.push(dir);
  return dir;
}

function pdgCounts(result: PipelineResult): { basicBlocks: number; pdgEdges: number } {
  let basicBlocks = 0;
  result.graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') basicBlocks++;
  });
  let pdgEdges = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (PDG_EDGE_TYPES.has(rel.type)) pdgEdges++;
  }
  return { basicBlocks, pdgEdges };
}

describe('#2202 — streaming PDG emit end-to-end', () => {
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('streams the PDG layer out of the graph while preserving the emitted set', async () => {
    // ── Baseline: --pdg on, streaming OFF (durable cache, same as streamed) ──
    const baseStorage = freshStorage();
    const baseline = await runPipelineFromRepo(freshRepo(), () => {}, {
      pdg: true,
      parseCache: await loadParseCache(baseStorage),
    });
    const base = pdgCounts(baseline);
    // R3 / sanity: the default path still materializes the PDG layer in-graph.
    expect(base.basicBlocks).toBeGreaterThan(0);
    expect(base.pdgEdges).toBeGreaterThan(0);
    expect(baseline.pdgEmitManifest).toBeUndefined();

    // ── Streamed: --pdg on, streaming ON ─────────────────────────────────
    const streamStorage = freshStorage();
    const streamed = await runPipelineFromRepo(freshRepo(), () => {}, {
      pdg: true,
      streamPdgEmit: true,
      parseCache: await loadParseCache(streamStorage),
    });
    const streamedCounts = pdgCounts(streamed);

    // R1: the bulky PDG layer never accumulated in the in-memory graph.
    expect(streamedCounts.basicBlocks).toBe(0);
    expect(streamedCounts.pdgEdges).toBe(0);

    // R2: the streamed manifest carries the SAME emitted set as the baseline.
    const manifest = streamed.pdgEmitManifest;
    expect(manifest).toBeDefined();
    const bbRows = manifest!.nodeFiles.get('BasicBlock')?.rows ?? 0;
    expect(bbRows).toBe(base.basicBlocks);
    let manifestEdgeRows = 0;
    for (const [, meta] of manifest!.relsByPair) manifestEdgeRows += meta.rows;
    expect(manifestEdgeRows).toBe(base.pdgEdges);

    // The streamed BasicBlock CSV exists on disk under the storage dir.
    const bbCsv = manifest!.nodeFiles.get('BasicBlock')?.csvPath;
    expect(bbCsv).toBeDefined();
    expect(fs.existsSync(bbCsv!)).toBe(true);
  });

  it('collapses the real Vue+TS cross-pass double-emit to one streamed copy (review #8a)', async () => {
    // A `.ts` module imported by a `.vue` SFC is PDG-emitted in BOTH the
    // TypeScript pass and the Vue context pass (the Vue provider's
    // `collectScopeContextPaths` follows the import) over the same worker-built
    // `cfgSideChannel` → identical ids. The in-memory graph dedups those by id
    // (Map first-writer-wins); the streaming sink is dedup-free, so the emit
    // loop dedups per FILE via `pdgEmittedFiles`. Without that dedup the streamed
    // manifest would carry shared.ts's blocks TWICE (verified out-of-band: 33 →
    // 61 BasicBlock rows). This asserts the streamed SET equals the Map-deduped
    // baseline — the load-bearing dedup regression guard.
    const baseStorage = freshStorage();
    const baseline = await runPipelineFromRepo(freshRepo(VUE_TS_FIXTURE), () => {}, {
      pdg: true,
      parseCache: await loadParseCache(baseStorage),
    });
    const base = pdgCounts(baseline);
    // Both files contribute blocks — the cross-pass case is actually present.
    expect(base.basicBlocks).toBeGreaterThan(0);
    expect(base.pdgEdges).toBeGreaterThan(0);

    const streamStorage = freshStorage();
    const streamed = await runPipelineFromRepo(freshRepo(VUE_TS_FIXTURE), () => {}, {
      pdg: true,
      streamPdgEmit: true,
      parseCache: await loadParseCache(streamStorage),
    });
    // Streamed graph holds none of the PDG layer.
    const streamedCounts = pdgCounts(streamed);
    expect(streamedCounts.basicBlocks).toBe(0);
    expect(streamedCounts.pdgEdges).toBe(0);

    // The streamed manifest carries each file's PDG layer EXACTLY ONCE — equal
    // to the Map-deduped baseline. A broken per-file dedup would double the
    // shared module's rows and fail here.
    const manifest = streamed.pdgEmitManifest;
    expect(manifest).toBeDefined();
    expect(manifest!.nodeFiles.get('BasicBlock')?.rows ?? 0).toBe(base.basicBlocks);
    let manifestEdgeRows = 0;
    for (const [, meta] of manifest!.relsByPair) manifestEdgeRows += meta.rows;
    expect(manifestEdgeRows).toBe(base.pdgEdges);
  });

  it('falls back to in-memory emit when streaming is on but no storage path exists', async () => {
    // `streamPdgEmit: true` with NO parse cache → `parsedFileStorePath` is
    // undefined, so phase.ts cannot place the streamed CSV dir and falls back to
    // the in-memory whole-graph emit (the `else` branch that warns). The PDG
    // layer must still land in the graph and NO manifest is produced.
    const fellBack = await runPipelineFromRepo(freshRepo(VUE_TS_FIXTURE), () => {}, {
      pdg: true,
      streamPdgEmit: true,
      // intentionally no parseCache → no storagePath
    });
    const counts = pdgCounts(fellBack);
    expect(counts.basicBlocks).toBeGreaterThan(0); // emitted in-memory, not streamed
    expect(counts.pdgEdges).toBeGreaterThan(0);
    expect(fellBack.pdgEmitManifest).toBeUndefined(); // no streaming happened
  });
});
