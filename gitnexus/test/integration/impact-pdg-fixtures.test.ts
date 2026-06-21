import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// U6 — schema-validation + smoke test for the curated impact-PDG accuracy
// fixtures (bench/impact-pdg/fixtures). Two guards:
//
//  1. SCHEMA VALIDATION — every ground-truth.json is well-formed: required keys
//     present, a valid `locus`, intra/inter AIS non-overlapping where
//     applicable, and the corpus meets the KTD9/F3 minimum floor (>= 3 cases
//     per locus stratum, >= 12 measurable).
//
//  2. SMOKE — each fixture analyzes cleanly under {pdg:true} and produces CDG +
//     REACHING_DEF edges, AND the criterion function SPECIFICALLY produces both
//     (located via the criterion `marker`). A criterion whose function emits
//     ZERO PDG edges has unmeasurable ground truth — the smoke test catches it.
//     The one intentional no-body case (pdgScoring:"exclude") is the sole
//     exemption: its criterion must produce ZERO PDG edges (the KTD6 case).
//
// We annotate from SOURCE SEMANTICS only (KTD9 annotation-circularity guard) —
// this test does NOT derive ground truth from the traversal; it only confirms
// the fixtures are measurable substrate. Reconciling AIS against the live
// traversal is U7's job, not U6's.

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'bench', 'impact-pdg', 'fixtures');

const VALID_LOCI = new Set(['intra', 'inter', 'mixed', 'n/a']);
const VALID_DIRECTIONS = new Set(['downstream', 'upstream']);
const VALID_PROVENANCE = new Set(['manual', 'mutation']);

interface AisEntry {
  symbol: string;
  filePath: string;
  line?: number;
  note?: string;
}
type PdgEdgeKind = 'REACHING_DEF' | 'CDG';
interface Criterion {
  name: string;
  filePath: string;
  direction: string;
  /**
   * The 1-based source line of the statement being changed — the seed of the
   * statement-anchored PDG slice (`impact({mode:'pdg', line})`, U7 rework). Set
   * from SOURCE SEMANTICS (the def/criterion whose change propagates to the
   * intra_AIS lines), validated against the live traversal in the harness's
   * Step 0. Required for every measurable case; omitted on excluded no-body
   * cases (which carry no statement to seed).
   */
  line?: number;
  marker?: string;
  /**
   * The PDG edge kinds the criterion function is EXPECTED to produce. A pure
   * straight-line data-flow criterion legitimately produces only REACHING_DEF
   * (no branches -> no control dependence); a branching/guard criterion
   * produces both. The smoke test asserts exactly these are non-zero on the
   * criterion, so a pure-dataflow archetype is not forced to carry an
   * artificial branch. Omitted on excluded no-body cases.
   */
  pdgEdgeKinds?: PdgEdgeKind[];
}
interface GroundTruth {
  schemaVersion: number;
  criterion: Criterion;
  locus: string;
  pdgScoring?: string;
  provenance: string;
  analyzerVersion: string;
  intra_AIS: AisEntry[];
  inter_AIS: AisEntry[];
  rationale: string;
}

interface FixtureCase {
  name: string;
  dir: string;
  gt: GroundTruth;
  excluded: boolean;
}

function loadFixtures(): FixtureCase[] {
  const entries = fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return entries.map((name) => {
    const dir = path.join(FIXTURES_DIR, name);
    const gtPath = path.join(dir, 'ground-truth.json');
    const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8')) as GroundTruth;
    return { name, dir, gt, excluded: gt.pdgScoring === 'exclude' };
  });
}

const FIXTURES = loadFixtures();

function isAisEntry(e: unknown): e is AisEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.symbol !== 'string' || o.symbol.length === 0) return false;
  if (typeof o.filePath !== 'string' || o.filePath.length === 0) return false;
  if (o.line !== undefined && (typeof o.line !== 'number' || !Number.isInteger(o.line))) {
    return false;
  }
  return true;
}

/** Stable key for an AIS entry so intra/inter overlap is set-comparable. */
function aisKey(e: AisEntry): string {
  return `${e.symbol}@${e.filePath}#${e.line ?? '-'}`;
}

const tmpDirs: string[] = [];
function freshRepo(srcDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-fx-'));
  fs.cpSync(srcDir, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

interface Counts {
  basicBlocks: number;
  reachingDefs: number;
  cdg: number;
}
function counts(result: PipelineResult): Counts {
  let basicBlocks = 0;
  result.graph.forEachNode((n) => {
    if (n.label === 'BasicBlock') basicBlocks++;
  });
  let reachingDefs = 0;
  let cdg = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === 'REACHING_DEF') reachingDefs++;
    if (rel.type === 'CDG') cdg++;
  }
  return { basicBlocks, reachingDefs, cdg };
}

/**
 * BasicBlock id template (cf. emit.ts):
 *   `BasicBlock:<filePath>:<fnStartLine>:<fnStartCol>:<blockIndex>`
 * (filePath may itself contain `:` on some platforms). All blocks of one
 * function share the anchor = id minus the trailing `:<blockIndex>`.
 */
function functionAnchorOf(blockId: string): string {
  return blockId.slice(0, blockId.lastIndexOf(':'));
}

/**
 * Locate the criterion function's block anchor via its `marker` (a substring
 * unique to the function body, present in one of its blocks' `text`), then
 * count CDG / REACHING_DEF edges SOURCED inside that function. Mirrors the
 * `cdgSourcedInHazardFunction` technique in pipeline-pdg.test.ts: attributing
 * edges to a specific function, not the whole-fixture aggregate.
 */
function criterionEdgeCounts(
  result: PipelineResult,
  marker: string,
): { cdg: number; reachingDefs: number; found: boolean } {
  let anchor: string | undefined;
  const idsByAnchor = new Map<string, Set<string>>();
  result.graph.forEachNode((n) => {
    if (n.label !== 'BasicBlock') return;
    const a = functionAnchorOf(n.id);
    (idsByAnchor.get(a) ?? idsByAnchor.set(a, new Set()).get(a)!).add(n.id);
    const text = (n.properties as { text?: string }).text ?? '';
    if (text.includes(marker)) anchor = a;
  });
  if (anchor === undefined) return { cdg: 0, reachingDefs: 0, found: false };
  const blockIds = idsByAnchor.get(anchor) ?? new Set<string>();
  let cdg = 0;
  let reachingDefs = 0;
  for (const rel of result.graph.iterRelationships()) {
    if (!blockIds.has(rel.sourceId)) continue;
    if (rel.type === 'CDG') cdg++;
    if (rel.type === 'REACHING_DEF') reachingDefs++;
  }
  return { cdg, reachingDefs, found: true };
}

describe('U6 — impact-PDG fixture ground-truth schema', () => {
  it('discovers the curated fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const fx of FIXTURES) {
    describe(fx.name, () => {
      const { gt } = fx;

      it('has all required top-level keys', () => {
        expect(typeof gt.schemaVersion).toBe('number');
        expect(gt.criterion).toBeTypeOf('object');
        expect(VALID_LOCI.has(gt.locus)).toBe(true);
        expect(VALID_PROVENANCE.has(gt.provenance)).toBe(true);
        // v1 is manual-annotation-primary (KTD9 — mutation deferred).
        expect(gt.provenance).toBe('manual');
        expect(typeof gt.analyzerVersion).toBe('string');
        expect(gt.analyzerVersion.length).toBeGreaterThan(0);
        expect(Array.isArray(gt.intra_AIS)).toBe(true);
        expect(Array.isArray(gt.inter_AIS)).toBe(true);
        expect(typeof gt.rationale).toBe('string');
        // Rationale is what makes manual annotation defensible — non-trivial.
        expect(gt.rationale.length).toBeGreaterThan(40);
      });

      it('has a well-formed criterion', () => {
        const c = gt.criterion;
        expect(typeof c.name).toBe('string');
        expect(c.name.length).toBeGreaterThan(0);
        expect(typeof c.filePath).toBe('string');
        expect(c.filePath.startsWith('src/')).toBe(true);
        expect(VALID_DIRECTIONS.has(c.direction)).toBe(true);
        // The criterion source file actually exists.
        expect(fs.existsSync(path.join(fx.dir, c.filePath))).toBe(true);
        // Measurable cases carry a marker; excluded no-body cases need none.
        if (!fx.excluded) {
          expect(typeof c.marker, `${fx.name} needs a criterion.marker`).toBe('string');
          expect(c.marker!.length).toBeGreaterThan(0);
          // The marker must appear in the criterion file's source.
          const src = fs.readFileSync(path.join(fx.dir, c.filePath), 'utf8');
          expect(src.includes(c.marker!), `marker ${JSON.stringify(c.marker)} in source`).toBe(
            true,
          );
          // Measurable cases carry a 1-based statement anchor (criterion.line) —
          // the seed of the PDG slice (U7 rework). It must be a positive integer
          // pointing at an actual source line of the criterion file.
          expect(typeof c.line, `${fx.name} needs a 1-based criterion.line`).toBe('number');
          expect(Number.isInteger(c.line!) && c.line! >= 1, `${fx.name} criterion.line >= 1`).toBe(
            true,
          );
          const lineCount = src.split('\n').length;
          expect(c.line! <= lineCount, `${fx.name} criterion.line within file`).toBe(true);
          // Measurable cases declare which PDG edge kinds the criterion produces.
          expect(Array.isArray(c.pdgEdgeKinds), `${fx.name} needs criterion.pdgEdgeKinds`).toBe(
            true,
          );
          expect(c.pdgEdgeKinds!.length).toBeGreaterThan(0);
          for (const k of c.pdgEdgeKinds!) {
            expect(['REACHING_DEF', 'CDG'], `valid pdgEdgeKind ${k}`).toContain(k);
          }
        }
      });

      it('has well-formed, valid AIS entries', () => {
        for (const e of gt.intra_AIS) {
          expect(isAisEntry(e), `intra_AIS entry ${JSON.stringify(e)}`).toBe(true);
        }
        for (const e of gt.inter_AIS) {
          expect(isAisEntry(e), `inter_AIS entry ${JSON.stringify(e)}`).toBe(true);
        }
      });

      it('has non-overlapping intra/inter AIS', () => {
        const intraKeys = new Set(gt.intra_AIS.map(aisKey));
        for (const e of gt.inter_AIS) {
          expect(intraKeys.has(aisKey(e)), `inter entry ${aisKey(e)} overlaps intra`).toBe(false);
        }
      });

      it('matches its locus to its AIS shape', () => {
        if (fx.excluded) {
          // Excluded strata: the KTD6 no-body case (locus n/a) AND the resolved-id
          // soundness-gate fixture (locus inter) both carry empty AIS — their scoring
          // lives on the dedicated id-bridge axis in measure.mjs, not the F1 strata bands,
          // so neither intra_AIS nor inter_AIS is the measured quantity.
          expect(gt.intra_AIS.length).toBe(0);
          expect(gt.inter_AIS.length).toBe(0);
        } else if (gt.locus === 'inter') {
          // Inter cases: PDG intra-AIS is empty by design; the impact is cross-function.
          expect(gt.intra_AIS.length).toBe(0);
          expect(gt.inter_AIS.length).toBeGreaterThan(0);
        } else if (gt.locus === 'intra') {
          // Intra cases: the truly-affected set is within the function.
          expect(gt.intra_AIS.length).toBeGreaterThan(0);
          expect(gt.inter_AIS.length).toBe(0);
        } else {
          // Mixed cases: both loci carry genuine impact. (n/a never reaches here — a
          // no-body fixture is always pdgScoring:"exclude" and handled above.)
          expect(gt.intra_AIS.length).toBeGreaterThan(0);
          expect(gt.inter_AIS.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('meets the KTD9/F3 minimum corpus floor (>=3 per locus stratum, >=12 measurable)', () => {
    const byLocus = new Map<string, number>();
    let measurable = 0;
    for (const fx of FIXTURES) {
      if (fx.excluded) continue;
      measurable++;
      byLocus.set(fx.gt.locus, (byLocus.get(fx.gt.locus) ?? 0) + 1);
    }
    expect(measurable).toBeGreaterThanOrEqual(12);
    for (const locus of ['intra', 'inter', 'mixed']) {
      expect(byLocus.get(locus) ?? 0, `>=3 cases for locus ${locus}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('exercises BOTH PDG edge kinds across the corpus', () => {
    const declared = new Set<string>();
    for (const fx of FIXTURES) {
      if (fx.excluded) continue;
      for (const k of fx.gt.criterion.pdgEdgeKinds ?? []) declared.add(k);
    }
    expect(declared.has('REACHING_DEF')).toBe(true);
    expect(declared.has('CDG')).toBe(true);
  });

  it('TRIPWIRE: no *.test.ts exists anywhere under bench/impact-pdg/ (cannot inflate npm test)', () => {
    // The bench harness (measure.mjs, metrics.mjs, mutation-oracle.mjs) is run
    // manually, never by `npm test`. The U2 dynamic-oracle generates instrumented
    // mutants in os.tmpdir(), never inside the repo. This tripwire guarantees a
    // future probe can never silently drop a `*.test.ts` under bench/impact-pdg/
    // and have it picked up by the default vitest glob — which would inflate the
    // suite with a flaky full-pipeline lane the harness is designed to stay out of.
    const benchRoot = path.join(__dirname, '..', '..', 'bench', 'impact-pdg');
    const collect = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
        const full = path.join(dir, ent.name);
        return ent.isDirectory() ? collect(full) : ent.name.endsWith('.test.ts') ? [full] : [];
      });
    const offenders = collect(benchRoot);
    expect(
      offenders,
      `unexpected *.test.ts under bench/impact-pdg/: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('has exactly one no-body case (the KTD6 case) and it is excluded', () => {
    // The no-body KTD6 case is identified by locus 'n/a' (no CFG body). It is a STRICT
    // subset of pdgScoring:"exclude" — the resolved-id soundness-gate fixture is also
    // excluded but DOES have a body (locus 'inter'), so we count no-body cases, not all
    // excluded cases.
    const noBody = FIXTURES.filter((fx) => fx.gt.locus === 'n/a');
    expect(noBody.length).toBe(1);
    expect(noBody[0].excluded).toBe(true);
  });
});

describe('U6 — impact-PDG fixtures analyze under {pdg:true} with measurable criteria', () => {
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const fx of FIXTURES) {
    if (fx.gt.locus === 'n/a') {
      // The intentional no-body case (KTD6): no function bodies, so its criterion must
      // produce ZERO PDG edges — a confident zero is the whole point of the exclusion.
      it(`${fx.name}: no-body criterion produces ZERO PDG edges (KTD6 exclusion)`, async () => {
        const result = await runPipelineFromRepo(freshRepo(fx.dir), () => {}, { pdg: true });
        // The fixture has no function bodies at all, so the whole-repo PDG layer
        // is empty too — but the load-bearing claim is the criterion symbol.
        const { basicBlocks } = counts(result);
        expect(basicBlocks, `${fx.name} no-body fixture should emit no BasicBlocks`).toBe(0);
      }, 60000);
      continue;
    }

    if (fx.excluded) {
      // A resolved-id soundness-gate fixture (e.g. intra-overloaded-callee): excluded from
      // the F1 strata bands and scored on the dedicated id-bridge axis in measure.mjs, but it
      // DOES have function bodies, so it emits a real PDG layer. Assert it analyzes cleanly and
      // produces that layer; the F1 criterion-edge checks below intentionally do not apply.
      it(`${fx.name}: analyzes under --pdg with a PDG layer (id-bridge soundness gate)`, async () => {
        const result = await runPipelineFromRepo(freshRepo(fx.dir), () => {}, { pdg: true });
        const total = counts(result);
        expect(total.basicBlocks, `${fx.name} BasicBlock count`).toBeGreaterThan(0);
        expect(total.reachingDefs, `${fx.name} REACHING_DEF count`).toBeGreaterThan(0);
      }, 60000);
      continue;
    }

    it(`${fx.name}: analyzes under --pdg; criterion produces its declared PDG edges`, async () => {
      const result = await runPipelineFromRepo(freshRepo(fx.dir), () => {}, { pdg: true });

      // The fixture as a whole produces a PDG layer (BasicBlocks + RD edges).
      // CDG is not asserted fixture-wide: a pure straight-line data-flow
      // fixture legitimately has zero control dependence.
      const total = counts(result);
      expect(total.basicBlocks, `${fx.name} BasicBlock count`).toBeGreaterThan(0);
      expect(total.reachingDefs, `${fx.name} fixture REACHING_DEF count`).toBeGreaterThan(0);

      // The CRITERION function specifically — located by its marker — must
      // produce EXACTLY the edge kinds its ground truth declares, and at least
      // one PDG edge overall. A zero-edge criterion has unmeasurable ground
      // truth; this is the load-bearing smoke gate (no accidental no-body).
      const marker = fx.gt.criterion.marker!;
      const crit = criterionEdgeCounts(result, marker);
      expect(
        crit.found,
        `${fx.name} criterion blocks located via marker ${JSON.stringify(marker)}`,
      ).toBe(true);
      expect(
        crit.cdg + crit.reachingDefs,
        `${fx.name} criterion '${fx.gt.criterion.name}' produces >=1 PDG edge (unmeasurable if 0)`,
      ).toBeGreaterThan(0);
      const kinds = fx.gt.criterion.pdgEdgeKinds ?? [];
      if (kinds.includes('REACHING_DEF')) {
        expect(
          crit.reachingDefs,
          `${fx.name} criterion declares REACHING_DEF but produced none`,
        ).toBeGreaterThan(0);
      }
      if (kinds.includes('CDG')) {
        expect(crit.cdg, `${fx.name} criterion declares CDG but produced none`).toBeGreaterThan(0);
      }
    }, 60000);
  }
});
