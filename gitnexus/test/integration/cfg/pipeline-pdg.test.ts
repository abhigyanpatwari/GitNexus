import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { decodeTaintPath } from '../../../src/core/ingestion/taint/path-codec.js';
import { fixtureTaintTotals } from '../../helpers/taint-fixture.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

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

  // #2227 tri-review-2 R3: the regression guard the stale-parse-cache emptiness
  // needed. The bridge unit tests used SYNTHETIC capture maps, so the real
  // worker→capture→position-join→BasicBlock.calleeIds path was never exercised
  // end-to-end and a stale-cache emptiness shipped undetected. This asserts a
  // REAL --pdg run populates calleeIds for the fixture's in-repo call sites
  // (read from the in-memory graph; the join runs main-thread in scope-resolution).
  it('with --pdg on: populates BasicBlock.calleeIds from the real pipeline (R3)', async () => {
    const result = await runPipelineFromRepo(freshRepo(), () => {}, { pdg: true });
    const nonEmptyCalleeIds: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'BasicBlock') return;
      const v = n.properties.calleeIds;
      if (typeof v === 'string' && v.length > 0) nonEmptyCalleeIds.push(v);
    });
    // The fixture has in-repo calls whose resolved ids join into calleeIds; a real
    // --pdg run must populate at least one (synthetic-map unit tests cannot catch
    // a join/capture/cache regression that empties this column).
    expect(nonEmptyCalleeIds.length).toBeGreaterThan(0);
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

// ── C-family worker-mode PDG (#2195 U7) ─────────────────────────────────────
//
// The same both-sinks proof as the TS block above, run through the REAL worker
// pipeline for each of C, C++, C#, Java, Go. Each language gets its own tiny
// repo (one hazard fixture with real branching AND a non-terminating
// loop/`select`) and we assert, under `--pdg`:
//   - BasicBlock + CFG > 0 (the worker built a per-function CFG and emit wired it)
//   - REACHING_DEF > 0 (the def/use harvest populates the data-dependence layer)
//   - CDG > 0 AND ≥1 CDG edge is sourced INSIDE the non-terminating-loop
//     function itself (`hazard`, below) — not merely an aggregate satisfied by
//     any branching function in the fixture. This is the load-bearing claim:
//     the post-dom/CDG pass was NOT skipped for the function whose loop traps
//     EXIT, i.e. EXIT stays reverse-reachable end-to-end through the worker even
//     with the non-terminating loop/`select`. (#2197 U3 — the prior whole-
//     fixture `cdg > 0` aggregate did not isolate the hazard function.)
// and without `--pdg` (both the default run and an explicit `pdg:false` run):
//   - BasicBlock + CFG + REACHING_DEF + CDG == 0
//   - the non-PDG graph is byte-identical between the two flag-off runs and
//     matches a committed digest snapshot (the per-language byte-identical-off
//     golden parity gate — R3; the cross-repo gate is pipeline-graph-golden).
//
// ⚠ Requires a FRESH `dist/parse-worker.js` — CFGs are built in the worker from
// `dist/`. A stale bundle silently zeros CFG output. `pretest:integration` (and
// the U7 verification recipe) run `node scripts/build.js` first.

const C_FAMILY_FIXTURES = path.join(__dirname, 'fixtures');

// `hazard`: a substring of a BasicBlock's `text` that appears ONLY inside the
// fixture's non-terminating-loop function (`for(;;)` / `while(true)` / `for{}`).
// It locates that function's block anchor so the CDG assertion can prove the
// function specifically is CDG-bearing (see `cdgSourcedInHazardFunction`). C#
// has no such loop (its `Retry` goto-cycle is conditional and terminates), so
// it has no `hazard` and keeps the whole-fixture aggregate only.
const C_FAMILY: ReadonlyArray<{ lang: string; fixture: string; hazard?: string }> = [
  { lang: 'C', fixture: 'c-hazards.c', hazard: 'handle_request' }, // server_forever: for(;;)
  { lang: 'C++', fixture: 'cpp-hazards.cpp', hazard: 'poll(' }, // run_forever: while(true)
  { lang: 'C#', fixture: 'csharp-hazards.cs' }, // no non-terminating loop in the fixture
  { lang: 'Java', fixture: 'java-hazards.java', hazard: 'ready(' }, // serve: while(true)
  { lang: 'Go', fixture: 'go-hazards.go', hazard: 'handle(v)' }, // forInfinite: for{}
];

// ── Remaining-language worker-mode PDG (#2195 capstone) ─────────────────────
//
// The same both-sinks worker proof, run for the eight languages whose CFG
// visitors completed the PDG-language rollout AFTER the C-family: the dynamic
// languages (Python, PHP, Ruby), the systems/app languages (Rust, Swift,
// Kotlin, Dart), AND Vue (whose provider reuses the TypeScript CfgVisitor — the
// .vue file routes through the worker's Vue→TypeScript grammar mapping and the
// SFC <script setup> extractor). Each fixture carries real branching AND a
// non-terminating loop (`while True:` / `loop {}` / `while (true)`), and we
// assert CDG > 0 AND that ≥1 CDG edge is sourced INSIDE that non-terminating-
// loop function (`hazard`) — proving EXIT stays reverse-reachable end-to-end
// through the worker for the silent-zero hazard function specifically, not just
// in aggregate (#2197 U3). The right extension per language routes the worker to
// the correct provider/grammar (Swift/Kotlin/Dart grammars are vendored).
//
// COBOL is the deliberate non-goal of #2195 (no installed grammar; exotic
// PERFORM / GO-TO control flow). Its provider has no `cfgVisitor`, so the worker
// emits no cfgSideChannel — that gate is asserted in `worker-roundtrip.test.ts`.
const REMAINING_LANGS: ReadonlyArray<{
  lang: string;
  fixture: string;
  hazard?: string;
  // Vendored/optional grammar: gate on isLanguageAvailable so CI on a platform
  // lacking the prebuilt grammar skips rather than fails (#2197 U4).
  vendored?: boolean;
}> = [
  { lang: 'Python', fixture: 'python-hazards.py', hazard: 'should_stop' }, // while_true_loop
  { lang: 'PHP', fixture: 'php-hazards.php', hazard: 'tick(' }, // infiniteLoop: while(true)
  { lang: 'Ruby', fixture: 'ruby-hazards.rb', hazard: 'handle()' }, // infinite_loop: while true
  { lang: 'Rust', fixture: 'rust-hazards.rs', hazard: 'tick(' }, // loop_forever: loop {}
  { lang: 'Swift', fixture: 'swift-hazards.swift', hazard: 'poll(', vendored: true }, // eventLoop: while true
  { lang: 'Kotlin', fixture: 'kotlin-hazards.kt', hazard: 'step(', vendored: true }, // spin: while(true)
  { lang: 'Dart', fixture: 'dart-hazards.dart', hazard: 'work(', vendored: true }, // spin: while(true)
  { lang: 'Vue', fixture: 'vue-hazards.vue', hazard: 'shouldStop' }, // eventLoop: while(true)
];

const cFamilyTmpDirs: string[] = [];
function freshLangRepo(fixture: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdg-lang-'));
  fs.copyFileSync(path.join(C_FAMILY_FIXTURES, fixture), path.join(dir, fixture));
  cFamilyTmpDirs.push(dir);
  return dir;
}

// Force worker-pool parsing even for a single small file: the CFG is built IN
// the worker, so the proof is only meaningful on the worker path.
const WORKER_PDG = {
  pdg: true,
  workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
  workerPoolSize: 2,
} as const;
const WORKER_OFF = {
  workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
  workerPoolSize: 2,
} as const;

/**
 * Deterministic, path/id-independent digest of the non-PDG graph: sorted
 * label→count and relType→count maps + a sha256 over symbolic edge triples
 * (label:name keyed, not opaque ids). Mirrors `pipeline-graph-golden`'s
 * technique so the snapshot is stable across id-format refactors and only
 * trips on a real semantic change to the C-family graph.
 */
function graphDigest(result: PipelineResult): {
  symbols: number;
  relationships: number;
  byType: Record<string, number>;
  byRelType: Record<string, number>;
  edgeDigest: string;
} {
  const byType: Record<string, number> = {};
  const byRelType: Record<string, number> = {};
  const nodeKey = new Map<string, string>();
  result.graph.forEachNode((n) => {
    byType[n.label] = (byType[n.label] ?? 0) + 1;
    const props = n.properties as Record<string, unknown>;
    const fp = (props.filePath as string | undefined) ?? '';
    const nm = (props.name as string | undefined) ?? '';
    nodeKey.set(n.id, `${n.label}:${nm}@${fp}`);
  });
  const triples: string[] = [];
  for (const rel of result.graph.iterRelationships()) {
    byRelType[rel.type] = (byRelType[rel.type] ?? 0) + 1;
    const src = nodeKey.get(rel.sourceId) ?? `?:${rel.sourceId}`;
    const dst = nodeKey.get(rel.targetId) ?? `?:${rel.targetId}`;
    triples.push(`${rel.type}|${src}|${dst}`);
  }
  triples.sort();
  const sortObj = (o: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
  };
  return {
    symbols: result.graph.nodeCount,
    relationships: result.graph.relationshipCount,
    byType: sortObj(byType),
    byRelType: sortObj(byRelType),
    edgeDigest: crypto.createHash('sha256').update(triples.join('\n')).digest('hex'),
  };
}

/**
 * Parse a BasicBlock node id into its function anchor (#2197 U3). emit.ts
 * templates the id as `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIndex>`
 * (filePath may itself contain `:` on some platforms) — so the anchor is every
 * segment except the trailing block index, and the function anchor is the id
 * with its final `:<blockIndex>` segment stripped. All blocks of one function
 * share that anchor; block indices restart at 0 per function.
 */
function functionAnchorOf(blockId: string): string {
  return blockId.slice(0, blockId.lastIndexOf(':'));
}

/**
 * Whether ≥1 CDG edge is sourced inside the fixture's non-terminating-loop
 * function — the load-bearing #2197 U3 claim. Locates that function via
 * `hazardMarker` (a substring of a block `text` unique to the hazard function),
 * derives its block anchor, collects every BasicBlock id under that anchor, and
 * checks whether any CDG edge's source block is one of them. Unlike the whole-
 * fixture `cdg > 0` aggregate (satisfied by ANY branching function), this proves
 * the post-dom/CDG pass actually ran for the function whose loop traps EXIT.
 */
function cdgSourcedInHazardFunction(result: PipelineResult, hazardMarker: string): boolean {
  // Find the hazard function's anchor from the block whose text carries the
  // marker, and (separately) every block id grouped by anchor.
  let hazardAnchor: string | undefined;
  const idsByAnchor = new Map<string, Set<string>>();
  result.graph.forEachNode((n) => {
    if (n.label !== 'BasicBlock') return;
    const anchor = functionAnchorOf(n.id);
    (idsByAnchor.get(anchor) ?? idsByAnchor.set(anchor, new Set()).get(anchor)!).add(n.id);
    const text = (n.properties as { text?: string }).text ?? '';
    if (text.includes(hazardMarker)) hazardAnchor = anchor;
  });
  if (hazardAnchor === undefined) return false; // marker not found → fail the assertion
  const hazardBlockIds = idsByAnchor.get(hazardAnchor) ?? new Set<string>();
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'CDG' && hazardBlockIds.has(rel.sourceId)) return true;
  }
  return false;
}

describe('U7 — C-family worker-mode --pdg pipeline', () => {
  afterAll(() => {
    for (const d of cFamilyTmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const { lang, fixture, hazard } of C_FAMILY) {
    it(`${lang}: --pdg on emits BasicBlock + CFG + REACHING_DEF + CDG (> 0) via the worker`, async () => {
      const result = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, WORKER_PDG);
      // The CFG is built in the worker — a stale dist silently zeros this.
      expect(result.usedWorkerPool).toBe(true);
      const { basicBlocks, cfgEdges, reachingDefs, cdg } = counts(result);
      expect(basicBlocks, `${lang} BasicBlock count`).toBeGreaterThan(0);
      expect(cfgEdges, `${lang} CFG edge count`).toBeGreaterThan(0);
      // def/use harvest populated the data-dependence layer.
      expect(reachingDefs, `${lang} REACHING_DEF count`).toBeGreaterThan(0);
      // CDG > 0 proves the post-dom/CDG pass ran for SOME function in the fixture.
      expect(cdg, `${lang} CDG count`).toBeGreaterThan(0);
      // The load-bearing claim (#2197 U3): ≥1 CDG edge is sourced INSIDE the
      // non-terminating-loop function itself — so the post-dom/CDG pass was NOT
      // skipped for the function whose loop traps EXIT, i.e. EXIT stays
      // reverse-reachable end-to-end through the worker even with that loop. The
      // whole-fixture aggregate above would pass on any branching function; this
      // pins it to the hazard. (C# has no such loop → no `hazard` → aggregate only.)
      if (hazard !== undefined) {
        expect(
          cdgSourcedInHazardFunction(result, hazard),
          `${lang} CDG edge sourced inside the non-terminating-loop function (marker ${JSON.stringify(hazard)})`,
        ).toBe(true);
      }

      // Both CFG and CDG endpoints are persisted BasicBlocks; CDG carries a T/F.
      const blockIds = new Set<string>();
      result.graph.forEachNode((n) => {
        if (n.label === 'BasicBlock') blockIds.add(n.id);
      });
      for (const rel of result.graph.iterRelationships()) {
        if (rel.type === 'CFG' || rel.type === 'REACHING_DEF' || rel.type === 'CDG') {
          expect(blockIds.has(rel.sourceId), `${lang} ${rel.type} source is a BasicBlock`).toBe(
            true,
          );
          expect(blockIds.has(rel.targetId), `${lang} ${rel.type} target is a BasicBlock`).toBe(
            true,
          );
        }
        if (rel.type === 'CDG') expect(['T', 'F']).toContain(rel.reason);
      }
    }, 60000);

    it(`${lang}: --pdg off is byte-identical (zero PDG nodes/edges, stable golden digest)`, async () => {
      // Default (no pdg flag) and explicit pdg:false must produce the IDENTICAL
      // graph — the R3 parity property — and neither carries any PDG layer.
      const defaultRun = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, WORKER_OFF);
      const offRun = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, {
        ...WORKER_OFF,
        pdg: false,
      });

      for (const r of [defaultRun, offRun]) {
        const { basicBlocks, cfgEdges, reachingDefs, tainted, sanitizes, cdg } = counts(r);
        expect(basicBlocks).toBe(0);
        expect(cfgEdges).toBe(0);
        expect(reachingDefs).toBe(0);
        expect(tainted).toBe(0);
        expect(sanitizes).toBe(0);
        expect(cdg).toBe(0);
      }

      const defaultDigest = graphDigest(defaultRun);
      const offDigest = graphDigest(offRun);
      // pdg:false ≡ pdg-absent — the dominant existing-user path is untouched.
      expect(offDigest).toEqual(defaultDigest);
      // None of the PDG node/rel types leak into the flag-off graph.
      for (const t of ['BasicBlock'] as const) expect(defaultDigest.byType[t]).toBeUndefined();
      for (const t of ['CFG', 'REACHING_DEF', 'CDG', 'TAINTED', 'SANITIZES'] as const)
        expect(defaultDigest.byRelType[t]).toBeUndefined();
      // Committed golden: the flag-off graph is pinned by snapshot so a future
      // refactor that silently rewires the C-family graph trips this gate.
      expect(defaultDigest).toMatchSnapshot();
    }, 90000);
  }
});

describe('U7 — remaining languages worker-mode --pdg pipeline (#2195 capstone)', () => {
  afterAll(() => {
    for (const d of cFamilyTmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const { lang, fixture, hazard, vendored } of REMAINING_LANGS) {
    // Vendored grammars (Swift/Kotlin/Dart) may lack a prebuild on the CI
    // platform — skip rather than fail when the grammar can't load (#2197 U4).
    const testFn =
      !vendored || isLanguageAvailable(SupportedLanguages[lang as keyof typeof SupportedLanguages])
        ? it
        : it.skip;
    testFn(
      `${lang}: --pdg on emits BasicBlock + CFG + REACHING_DEF + CDG (> 0) via the worker`,
      async () => {
        const result = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, WORKER_PDG);
        // The CFG is built in the worker — a stale dist silently zeros this.
        expect(result.usedWorkerPool, `${lang} used the worker pool`).toBe(true);
        const { basicBlocks, cfgEdges, reachingDefs, cdg } = counts(result);
        expect(basicBlocks, `${lang} BasicBlock count`).toBeGreaterThan(0);
        expect(cfgEdges, `${lang} CFG edge count`).toBeGreaterThan(0);
        // def/use harvest populated the data-dependence layer.
        expect(reachingDefs, `${lang} REACHING_DEF count`).toBeGreaterThan(0);
        // CDG > 0 proves the post-dom/CDG pass ran for SOME function in the fixture.
        expect(cdg, `${lang} CDG count`).toBeGreaterThan(0);
        // The load-bearing claim (#2197 U3): ≥1 CDG edge is sourced INSIDE the
        // non-terminating-loop function itself — so the post-dom/CDG pass was NOT
        // skipped for the function whose loop traps EXIT, i.e. EXIT stays
        // reverse-reachable end-to-end through the worker even with that loop. The
        // whole-fixture aggregate above would pass on any branching function; this
        // pins it to the hazard.
        if (hazard !== undefined) {
          expect(
            cdgSourcedInHazardFunction(result, hazard),
            `${lang} CDG edge sourced inside the non-terminating-loop function (marker ${JSON.stringify(hazard)})`,
          ).toBe(true);
        }

        // Both CFG and CDG endpoints are persisted BasicBlocks; CDG carries a T/F.
        const blockIds = new Set<string>();
        result.graph.forEachNode((n) => {
          if (n.label === 'BasicBlock') blockIds.add(n.id);
        });
        for (const rel of result.graph.iterRelationships()) {
          if (rel.type === 'CFG' || rel.type === 'REACHING_DEF' || rel.type === 'CDG') {
            expect(blockIds.has(rel.sourceId), `${lang} ${rel.type} source is a BasicBlock`).toBe(
              true,
            );
            expect(blockIds.has(rel.targetId), `${lang} ${rel.type} target is a BasicBlock`).toBe(
              true,
            );
          }
          if (rel.type === 'CDG') expect(['T', 'F']).toContain(rel.reason);
        }
      },
      60000,
    );

    testFn(
      `${lang}: --pdg off emits zero PDG nodes/edges (the R3 flag-off gate)`,
      async () => {
        // Default (no pdg flag) and explicit pdg:false must both produce a graph
        // with NO PDG layer — the existing-user path stays untouched.
        const defaultRun = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, WORKER_OFF);
        const offRun = await runPipelineFromRepo(freshLangRepo(fixture), () => {}, {
          ...WORKER_OFF,
          pdg: false,
        });

        for (const r of [defaultRun, offRun]) {
          const { basicBlocks, cfgEdges, reachingDefs, tainted, sanitizes, cdg } = counts(r);
          expect(basicBlocks).toBe(0);
          expect(cfgEdges).toBe(0);
          expect(reachingDefs).toBe(0);
          expect(tainted).toBe(0);
          expect(sanitizes).toBe(0);
          expect(cdg).toBe(0);
        }

        // pdg:false ≡ pdg-absent — the symbolic graph digest is identical.
        expect(graphDigest(offRun)).toEqual(graphDigest(defaultRun));
      },
      90000,
    );
  }
});
