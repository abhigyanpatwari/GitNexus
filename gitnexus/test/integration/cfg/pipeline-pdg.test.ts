import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';
import { fixtureTaintTotals } from '../../helpers/taint-fixture.js';

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
  tainted: number;
  sanitizes: number;
  cdg: number;
} {
  let basicBlocks = 0;
  result.graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') basicBlocks++;
  });
  let cfgEdges = 0;
  let reachingDefs = 0;
  let tainted = 0;
  let sanitizes = 0;
  let cdg = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'CFG') cfgEdges++;
    if (rel.type === 'REACHING_DEF') reachingDefs++;
    if (rel.type === 'TAINTED') tainted++;
    if (rel.type === 'SANITIZES') sanitizes++;
    if (rel.type === 'CDG') cdg++;
  }
  return { basicBlocks, cfgEdges, reachingDefs, tainted, sanitizes, cdg };
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

  // M3 (#2083 U4/U7): the taint layer rides the same gate. The fixture's
  // vuln.ts carries one vulnerable flow (req.body → child_process.exec) and
  // one sanitized variant (encodeURIComponent before res.send); taint-cases.ts
  // adds the U7 acceptance battery (direct, multi-hop, conditional-sanitizer,
  // loop-carried, through-call).
  it('with --pdg on: emits TAINTED + SANITIZES edges with decodable hop reasons', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const blockIds = new Set<string>();
    result.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') blockIds.add(n.id);
    });
    const { tainted, sanitizes, reachingDefs } = counts(result);
    expect(tainted).toBeGreaterThan(0);
    expect(sanitizes).toBeGreaterThanOrEqual(1);

    // AE2 (AC2) — sparse persistence. The load-bearing O(findings) gate is
    // EXACT equality: one TAINTED row per pure-path finding and one SANITIZES
    // row per kill over the same fixture, computed through the shared harness
    // so the worker pipeline and the snapshot suite cannot drift apart. Any
    // REACHING_DEF-style row multiplication (per-fact, per-block-pair, …)
    // breaks the equality immediately.
    const expected = fixtureTaintTotals(FIXTURE);
    expect(expected.findings).toBeGreaterThan(0);
    expect(tainted).toBe(expected.findings);
    expect(sanitizes).toBe(expected.kills);
    // Ratio sanity vs the dense RD projection on the SAME run. The fixture is
    // deliberately finding-DENSE (nearly every function is a vulnerable
    // acceptance case), so the honest measured ratio here is ~22% (8 taint
    // rows vs 37 RD rows) — the < 0.5 bound still catches any per-fact
    // explosion (which would multiply taint rows past RD); the representative
    // ≪-RD posture on realistic density is gated by the bench taint scenario's
    // absolute boundedness/byte ceilings (bench/cfg).
    expect(tainted + sanitizes).toBeLessThan(reachingDefs * 0.5);
    let sawVulnFlow = false;
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'TAINTED' && rel.type !== 'SANITIZES') continue;
      // Both endpoints are persisted BasicBlock nodes (the shared id template).
      expect(blockIds.has(rel.sourceId)).toBe(true);
      expect(blockIds.has(rel.targetId)).toBe(true);
      if (rel.type === 'TAINTED') {
        // The reason is the versioned hop encoding — decodable by the SHARED
        // codec (U6's explain imports the same module), variables carried.
        const decoded = decodeTaintPath(rel.reason);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.hops.length).toBeGreaterThan(0);
          for (const hop of decoded.hops) {
            expect(hop.variable.length).toBeGreaterThan(0);
            expect(hop.line).toBeGreaterThan(0);
          }
          if (decoded.hops.some((h) => h.variable === 'cmd')) sawVulnFlow = true;
        }
      } else {
        // SANITIZES carries the killed binding's plain name: `value` from
        // vuln.ts sendEncoded, `text` from taint-cases.ts conditionalSanitizer.
        expect(['value', 'text']).toContain(rel.reason);
      }
    }
    expect(sawVulnFlow).toBe(true); // the req.body → exec flow, via `cmd`
  }, 60000);

  // M5 (#2085 U6): control dependence rides the same `--pdg` gate. AC3 — the
  // CDG edges make "under what condition does block X run?" answerable: each
  // edge's source is the controlling branch block and its `reason` is the
  // 'T'|'F' sense. (The dedicated `pdg_query` MCP tool is #2086; here the raw
  // graph carries the answer.)
  it('with --pdg on: emits CDG edges (controller→dependent, T/F label) — AC3 answerability', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const { cdg } = counts(result);
    expect(cdg).toBeGreaterThan(0);

    const blockIds = new Set<string>();
    result.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') blockIds.add(n.id);
    });

    // "What controls block X?" — index CDG edges by dependent block. Every CDG
    // edge connects two persisted BasicBlocks and carries a T/F label.
    const controllersOf = new Map<string, { controller: string; label: string }[]>();
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'CDG') continue;
      expect(blockIds.has(rel.sourceId)).toBe(true);
      expect(blockIds.has(rel.targetId)).toBe(true);
      expect(['T', 'F']).toContain(rel.reason);
      const list = controllersOf.get(rel.targetId) ?? [];
      list.push({ controller: rel.sourceId, label: rel.reason });
      controllersOf.set(rel.targetId, list);
    }
    // At least one block has its controlling branch + condition recoverable —
    // the query "under what condition does this block run?" is answerable.
    expect(controllersOf.size).toBeGreaterThan(0);
    for (const [, controls] of controllersOf) {
      expect(controls.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('with --pdg off (default): emits zero BasicBlock nodes and zero CFG/CDG edges', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {});
    const { basicBlocks, cfgEdges, reachingDefs, tainted, sanitizes, cdg } = counts(result);
    expect(basicBlocks).toBe(0);
    expect(cfgEdges).toBe(0);
    expect(reachingDefs).toBe(0);
    expect(tainted).toBe(0);
    expect(sanitizes).toBe(0);
    expect(cdg).toBe(0);
  }, 60000);
});
