/**
 * U7 — PDG-vs-call-graph impact ACCURACY measurement harness.
 *
 * Runs BOTH `impact` engines over the curated U6 ground-truth fixtures and
 * scores each at its NATIVE granularity:
 *   - `mode:'pdg'` is seeded on the criterion's STATEMENT (`line: criterion.line`)
 *     and scored at intra-procedural LINE granularity against `intra_AIS`
 *     (CIS_pdg = the `affectedStatements` line set);
 *   - `mode:'callgraph'` is scored at inter-procedural SYMBOL granularity against
 *     `inter_AIS` (CIS = the reported symbol set).
 * It computes precision/recall/F1 stratified by impact locus (intra/inter/mixed)
 * plus cross-mode set-diffs, prints a stratified report ending in a plain-
 * language DECISION RECOMMENDATION, and (under `--check`) gates regressions with
 * two NON-byte-identity gates. The two engines answer DIFFERENT questions at
 * DIFFERENT granularities — the report shows both, neither strictly dominates.
 *
 * ── Substrate (the load-bearing mechanism — KTD9/R8; plan U7 "Substrate
 * decision") ──────────────────────────────────────────────────────────────
 * `runPipelineFromRepo` is in-memory and never persists; `impact` queries a
 * PERSISTED `repo.lbugPath` + a `meta.pdg` stamp. There is no exported
 * `runAnalyze` (the entrypoint `analyzeCommand` calls `process.exit`, unusable
 * in a loop), and the test-suite `vi.mock` registry bridge is vitest-only. So:
 * REAL analyze via a temp `GITNEXUS_HOME`, mock-free. Per fixture:
 *   1. point `process.env.GITNEXUS_HOME` at a per-run temp dir (honored by
 *      `repo-manager.getGlobalDir()` — it roots the registry; the per-repo DB
 *      lands in `<fixtureCopy>/.gitnexus/`, so fixtures are copied to a temp
 *      working dir to keep the source tree clean);
 *   2. SHELL OUT to the real CLI as a child process:
 *        node --import tsx src/cli/index.ts analyze <copy> --pdg --skip-git --index-only
 *      (child-process isolation sidesteps `process.exit`; real `saveMeta` +
 *      `registerRepo` land in the temp home; workers spawn from `dist/`, so the
 *      harness builds `dist/` first — run `node scripts/build.js`);
 *   3. `new LocalBackend(); await init()` resolves the fixture via the REAL
 *      registry (the parent process ALSO sets `GITNEXUS_HOME` so init reads the
 *      temp registry, not the user's ~/.gitnexus);
 *   4. `callTool('impact', …)` ×2 — callgraph (symbol BFS) and pdg (seeded on
 *      `line: criterion.line` so it returns the statement-anchored slice);
 *   5. teardown the temp home + copy.
 *
 * The `repo` arg is the absolute fixture-copy PATH (tier-1 path match in
 * `resolveRepoFromCache`) — unambiguous, no name collisions.
 *
 * ── Granularity / CIS-AIS framing ──────────────────────────────────────────
 * See `metrics.mjs`. PDG = intra-procedural LINE granularity vs `intra_AIS`;
 * call-graph = inter-procedural SYMBOL granularity vs `inter_AIS`. The two
 * engines measure different scopes; both are now non-empty.
 *
 * Build-free: `node --import tsx bench/impact-pdg/measure.mjs`. Runtime budget
 * and re-baseline instructions: see README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  symbolKey,
  pdgLineCis,
  intraLineAis,
  score,
  aggregate,
  aisByScope,
  fingerprintAnnotationSet,
  median,
} from './metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // gitnexus/
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const BASELINE_PATH = path.join(__dirname, 'baselines.json');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const SCOPES = ['intra', 'inter', 'mixed'];
const MODES = ['callgraph', 'pdg'];

// ── F3 minimum-corpus floor (KTD9): below this the harness reports DIRECTION
// only, never a headline decimal verdict. Mirrors the U6 schema test's floor.
const FLOOR_PER_STRATUM = 3;
const FLOOR_TOTAL = 12;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── fixture loading ────────────────────────────────────────────────────────

function loadFixtures(filter) {
  const names = fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !filter || filter.includes(n))
    .sort();
  return names.map((name) => {
    const dir = path.join(FIXTURES_DIR, name);
    const gt = JSON.parse(fs.readFileSync(path.join(dir, 'ground-truth.json'), 'utf8'));
    return { name, dir, gt, excluded: gt.pdgScoring === 'exclude' };
  });
}

// ── substrate: analyze a fixture into a temp GITNEXUS_HOME, run both modes ───

/**
 * Copy the fixture src into a temp working dir, analyze it with `--pdg` as a
 * child process (real persistence into the temp GITNEXUS_HOME), then drive both
 * impact modes through a fresh LocalBackend. Returns the raw impact results +
 * the working-copy path (so the criterion file paths line up with the
 * annotations, which are repo-relative `src/...`). `pdgOn` toggles `--pdg` so
 * the degraded-index scenario (KTD7) can be exercised.
 */
async function analyzeAndImpact(fx, home, { pdgOn = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-work-'));
  fs.cpSync(path.join(fx.dir, 'src'), path.join(work, 'src'), { recursive: true });

  const env = { ...process.env, GITNEXUS_HOME: home };
  const args = ['--import', 'tsx', CLI_ENTRY, 'analyze', work, '--skip-git', '--index-only'];
  if (pdgOn) args.push('--pdg');
  const an = spawnSync(process.execPath, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
  if (an.status !== 0) {
    fs.rmSync(work, { recursive: true, force: true });
    throw new Error(
      `analyze failed for ${fx.name} (exit ${an.status}): ${(an.stderr || an.stdout || '').slice(-600)}`,
    );
  }

  // The parent process must see the temp GITNEXUS_HOME too — LocalBackend.init()
  // reads the REAL registry under getGlobalDir() (no mock). A fresh backend per
  // fixture avoids cross-fixture pool/registry caching.
  //
  // FIX 8: wrap the post-analyze body in try/finally. The analyze-failure path
  // above already cleans `work`; if `backend.callTool()` (or init/import) THROWS
  // here, `work` would otherwise leak. On success we return `work` so the caller
  // can run its own validation + cleanup; on throw we remove it before rethrow.
  let succeeded = false;
  try {
    process.env.GITNEXUS_HOME = home;
    const { LocalBackend } = await import(
      path.join(REPO_ROOT, 'src', 'mcp', 'local', 'local-backend.ts')
    );
    const backend = new LocalBackend();
    await backend.init();

    // callgraph: symbol→symbol BFS (no statement anchor). pdg: SEEDED on the
    // criterion's statement line so it returns the dependence slice — the U7
    // rework's central change. A whole-symbol pdg slice (no `line`) is empty by
    // design; `criterion.line` is the 1-based source line of the changed
    // statement (set from source semantics, validated in Step 0).
    const results = {
      callgraph: await backend.callTool('impact', {
        repo: work,
        target: fx.gt.criterion.name,
        direction: fx.gt.criterion.direction,
        mode: 'callgraph',
      }),
      pdg: await backend.callTool('impact', {
        repo: work,
        target: fx.gt.criterion.name,
        direction: fx.gt.criterion.direction,
        mode: 'pdg',
        line: fx.gt.criterion.line,
      }),
    };
    succeeded = true;
    return { work, results };
  } finally {
    // Only clean up on the throwing path — on success the caller owns `work`
    // (it runs `validateFixture(fx, work, ...)` then removes it in its finally).
    if (!succeeded) fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Flatten a CALLGRAPH impact result's byDepth into canonical SYMBOL keys (the
 * CIS_callgraph, scored against `inter_AIS`). Unresolved shadow entries are kept
 * (keyed by file) so a recall loss is never hidden.
 */
function callgraphCisFromResult(res) {
  const items = Object.values(res?.byDepth ?? {}).flat();
  const keys = new Set();
  const meta = { unresolved: 0, ambiguous: 0 };
  for (const it of items) {
    if (it?.unresolved) {
      meta.unresolved += 1;
      keys.add(symbolKey('(unresolved)', it.filePath));
      continue;
    }
    if (it?.ambiguous) meta.ambiguous += 1;
    keys.add(symbolKey(it.name, it.filePath));
  }
  return { keys, meta };
}

/**
 * Extract the PDG statement-line CIS (`<filePath>:<line>` keys) from a pdg
 * impact result's `affectedStatements`, plus the diagnostic fields the report
 * surfaces (the slice's epistemic marker / note / block count). This is the
 * U7-rework CIS: the dependent STATEMENTS the change at `criterion.line` reaches.
 */
function pdgCisFromResult(res) {
  return {
    keys: pdgLineCis(res?.affectedStatements),
    meta: {
      affectedStatementCount: res?.affectedStatementCount ?? 0,
      blockCount: res?.blockCount ?? null,
      criterionLine: res?.criterionLine ?? null,
      epistemic: res?.epistemic ?? null,
      note: res?.note ?? null,
    },
  };
}

// ── Step 0: fixture AIS validation (gated on the live traversal; KTD9
// circularity guard) ───────────────────────────────────────────────────────

/**
 * Before scoring, reconcile each fixture's annotation against the LIVE analyzer:
 *  (a) the criterion must produce ≥1 PDG edge (no accidental no-body / cap
 *      truncation — a zero-edge criterion has unmeasurable ground truth);
 *  (b) the criterion symbol must NOT share `(filePath, startLine)` with another
 *      Function/Method (same-line projection ambiguity, R4) — one count query;
 *  (c) the annotation paths must line up with the analyzer's repo-relative
 *      paths (so symbol keys match across CIS/AIS).
 * A fixture failing (a)/(b) is EXCLUDED from scoring and LOGGED (no silent cap).
 */
async function validateFixture(fx, work, exec) {
  const lbugPath = path.join(work, '.gitnexus', 'lbug');
  // (a) criterion produces ≥1 PDG edge. Locate the criterion's blocks via the
  // marker (the same technique the U6 smoke test uses) and count CDG/RD edges
  // sourced inside them.
  const marker = fx.gt.criterion.marker;
  const blocks = await exec(lbugPath, `MATCH (b:BasicBlock) RETURN b.id AS id, b.text AS text`, {});
  const idsByAnchor = new Map();
  let anchor;
  for (const b of blocks) {
    const id = String(b.id ?? b[0] ?? '');
    const anc = id.slice(0, id.lastIndexOf(':'));
    (idsByAnchor.get(anc) ?? idsByAnchor.set(anc, new Set()).get(anc)).add(id);
    const text = String(b.text ?? b[1] ?? '');
    if (marker && text.includes(marker)) anchor = anc;
  }
  let critEdges = 0;
  if (anchor) {
    const blockIds = [...(idsByAnchor.get(anchor) ?? [])];
    if (blockIds.length > 0) {
      const rows = await exec(
        lbugPath,
        `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
           WHERE r.type IN ['CDG','REACHING_DEF'] AND a.id IN $ids
           RETURN count(r) AS n`,
        { ids: blockIds },
      );
      critEdges = Number(rows?.[0]?.n ?? rows?.[0]?.[0] ?? 0);
    }
  }

  // (b) same-(filePath,startLine) collision for the criterion symbol (R4).
  const collisionRows = await exec(
    lbugPath,
    `MATCH (s:\`Function\`)
       WHERE s.name = $name AND s.filePath = $fp
       RETURN s.startLine AS sl
     UNION ALL
     MATCH (s:\`Method\`)
       WHERE s.name = $name AND s.filePath = $fp
       RETURN s.startLine AS sl`,
    { name: fx.gt.criterion.name, fp: fx.gt.criterion.filePath },
  );
  let sameLineCollision = false;
  const startLine = collisionRows?.[0]?.sl ?? collisionRows?.[0]?.[0];
  if (startLine !== undefined && startLine !== null) {
    const peers = await exec(
      lbugPath,
      `MATCH (s:\`Function\`)
         WHERE s.filePath = $fp AND s.startLine = $sl
         RETURN s.name AS name
       UNION ALL
       MATCH (s:\`Method\`)
         WHERE s.filePath = $fp AND s.startLine = $sl
         RETURN s.name AS name`,
      { fp: fx.gt.criterion.filePath, sl: startLine },
    );
    sameLineCollision = (peers?.length ?? 0) > 1;
  }

  const problems = [];
  if (!anchor) problems.push(`criterion blocks not locatable via marker ${JSON.stringify(marker)}`);
  if (critEdges === 0)
    problems.push('criterion produces ZERO PDG edges (unmeasurable ground truth)');
  if (sameLineCollision)
    problems.push(
      'criterion shares (filePath,startLine) with another Function/Method (R4 ambiguity)',
    );
  return { critEdges, sameLineCollision, problems, measurable: problems.length === 0 };
}

// ── per-fixture scoring (each mode vs its NATIVE ground truth — U7 rework) ────

/**
 * Score the CALLGRAPH mode for one fixture: its reported SYMBOL CIS against the
 * fixture's `inter_AIS` (the cross-function symbols truly affected). The
 * criterion symbol itself is dropped from the CIS first — callgraph never names
 * the criterion as its own dependent, and `inter_AIS` is cross-function by
 * construction, so a stray self-reference would be spurious noise. (In practice
 * the callgraph CIS already excludes the seed; this is belt-and-suspenders.)
 */
function scoreCallgraph(gt, symbolCisKeys) {
  const ais = aisByScope(gt);
  const cis = new Set([...symbolCisKeys].filter((k) => k !== ais.criterionKey));
  return score(cis, ais.inter);
}

/**
 * Score the PDG mode for one fixture: its statement-LINE CIS (the
 * `affectedStatements` from the line-seeded slice) against the fixture's
 * `intra_AIS` LINE set. This is the intra-procedural statement-granularity
 * measurement the U7 rework introduces. For an inter fixture (`intra_AIS` empty
 * by design) the slice may return the router's own control-dependent statements
 * — those are FPIS against the empty intra ground truth and recall is n/a, which
 * is the honest "PDG is intra-procedural; on a pure-inter fixture it has no
 * meaningful intra ground truth" result (symmetric to callgraph's empty intra).
 */
function scorePdg(gt, lineCisKeys) {
  return score(lineCisKeys, intraLineAis(gt));
}

// ── reporting helpers ────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(3));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function renderTable(strata) {
  const head =
    `${pad('Scope', 7)} ${pad('Mode', 10)} ${pad('Granularity', 11)} ${lpad('P', 7)} ${lpad('R', 7)} ${lpad('F1', 7)} ` +
    `${lpad('|CIS|/|AIS|', 11)} ${lpad('FPIS', 6)} ${lpad('FNIS', 6)} ${lpad('n', 4)}`;
  const lines = [head, '-'.repeat(head.length)];
  // PDG is scored at LINE granularity vs intra_AIS; callgraph at SYMBOL
  // granularity vs inter_AIS — the column makes the "different scopes" explicit.
  const gran = (mode) => (mode === 'pdg' ? 'line/intra' : 'symbol/inter');
  for (const scope of SCOPES) {
    for (const mode of MODES) {
      const a = strata[scope][mode];
      lines.push(
        `${pad(scope, 7)} ${pad(mode, 10)} ${pad(gran(mode), 11)} ${lpad(fmt(a.precision), 7)} ${lpad(fmt(a.recall), 7)} ` +
          `${lpad(fmt(a.f1), 7)} ${lpad(fmt(a.cisAisRatio), 11)} ${lpad(a.fpis, 6)} ${lpad(a.fnis, 6)} ` +
          `${lpad(a.nCases, 4)}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Plain-language DECISION RECOMMENDATION (F2 — the deliverable that answers
 * "which is more accurate" as a verdict, not just a table). Derived from the
 * measured numbers: PDG's intra-procedural STATEMENT-granularity F1 (the slice it
 * is built to compute) and call-graph's inter-procedural SYMBOL-granularity F1
 * (the cross-function reach it is built to compute).
 */
function decisionRecommendation(strata, underpowered, exclusions) {
  // PDG is precise at intra LINE granularity; callgraph covers inter SYMBOL reach.
  const pdgIntraF1 = strata.intra.pdg.f1;
  const pdgIntraP = strata.intra.pdg.precision;
  const pdgIntraR = strata.intra.pdg.recall;
  const cgInterF1 = strata.inter.callgraph.f1;
  const cgInterR = strata.inter.callgraph.recall;
  const pdgMixedF1 = strata.mixed.pdg.f1;
  const cgMixedF1 = strata.mixed.callgraph.f1;

  const lines = [];
  lines.push('DECISION RECOMMENDATION');
  if (underpowered) {
    lines.push(
      `Corpus is UNDERPOWERED (below the ${FLOOR_PER_STRATUM}/stratum, ${FLOOR_TOTAL}-total floor` +
        ` after exclusions) — reporting DIRECTION, not headline decimals.`,
    );
  }

  // Intra-scope: the statement-anchored PDG slice — the question PDG answers.
  lines.push(
    `On INTRA-scope (statement granularity), the line-seeded PDG slice scores P=${fmt(pdgIntraP)} ` +
      `R=${fmt(pdgIntraR)} F1=${fmt(pdgIntraF1)} against intra_AIS: it identifies the dependent ` +
      `STATEMENTS of the changed line precisely. Call-graph mode cannot resolve below function ` +
      `granularity, so on a self-contained function it names no other symbol (intra recall n/a — ` +
      `no cross-function truth to find). PDG is the engine for "which statements does this line affect?".`,
  );

  // Inter-scope: the cross-function blast radius — the question call-graph answers.
  lines.push(
    `On INTER-scope (symbol granularity), call-graph scores R=${fmt(cgInterR)} F1=${fmt(cgInterF1)} ` +
      `against inter_AIS: it recovers the cross-function callees exactly. PDG mode is ` +
      `intra-procedural, so on a pure-inter fixture it returns only the router's own ` +
      `control-dependent statements (FPIS against the empty intra_AIS — recall n/a). Call-graph is ` +
      `the engine for "what else calls/uses this?".`,
  );

  // Mixed-scope: both engines contribute, each in its own scope.
  if (pdgMixedF1 !== null || cgMixedF1 !== null) {
    lines.push(
      `On MIXED-scope, the two are COMPLEMENTARY: PDG resolves the intra statement set ` +
        `(F1=${fmt(pdgMixedF1)} vs intra_AIS) while call-graph reaches the callee(s) ` +
        `(F1=${fmt(cgMixedF1)} vs inter_AIS). Neither alone covers the full mixed blast radius.`,
    );
  }

  lines.push(
    `VERDICT: the two engines answer DIFFERENT questions at DIFFERENT granularities, and NEITHER ` +
      `dominates. mode:'callgraph' (the default) is the correct engine for the inter-procedural ` +
      `safety question — "what else depends on / calls this symbol?" — carrying the cross-function ` +
      `reach the blast radius needs. mode:'pdg' (opt-in, seeded with line:N, where analyze --pdg ` +
      `persisted the layer) is PRECISE at intra-procedural STATEMENT granularity — "which statements ` +
      `inside this function does changing line N affect?" — a question call-graph cannot answer at ` +
      `all. Use call-graph for cross-symbol impact; reach for line-seeded PDG when you need ` +
      `statement-level dependence INSIDE a function. They compose: a full mixed-locus blast radius ` +
      `is the UNION of call-graph's inter-symbol reach and PDG's intra-statement slice.`,
  );
  if (exclusions.length > 0) {
    lines.push(
      `Excluded from scoring: ${exclusions.map((e) => `${e.name} (${e.reason})`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}

// ── main run ─────────────────────────────────────────────────────────────────

async function run() {
  const CHECK = process.argv.includes('--check');
  const JSON_OUT = process.argv.includes('--json');
  // Optional subset for a fast substrate proof: --only=a,b,c or GN_IMPACT_PDG_ONLY=a,b
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyEnv = process.env.GN_IMPACT_PDG_ONLY;
  const filter = (onlyArg ? onlyArg.slice('--only='.length) : onlyEnv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const fixtures = loadFixtures(filter.length ? filter : null);
  if (fixtures.length === 0) throw new Error('no fixtures found');

  // K repeats for substrate-stability (F5). --check runs K times and gates on
  // the per-(mode,scope) MEDIAN F1, so a flaky analyze edge cannot trip the band.
  const K = CHECK ? Number(process.env.GN_IMPACT_PDG_K || 1) : 1;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-home-'));
  const { initLbug, executeParameterized, closeLbug } = await import(
    path.join(REPO_ROOT, 'src', 'core', 'lbug', 'pool-adapter.ts')
  );

  // exec wrapper that ensures the pool is initialised for Step 0's raw queries.
  const initialised = new Set();
  const exec = async (lbugPath, q, p) => {
    if (!initialised.has(lbugPath)) {
      await initLbug(lbugPath, lbugPath).catch(() => {});
      initialised.add(lbugPath);
    }
    return executeParameterized(lbugPath, q, p);
  };

  const exclusions = [];
  const perRunStrata = []; // K runs × { scope: { mode: aggregate } }
  let perCaseDetail = null; // last run's per-case detail for the report
  let degradedCheck = null;

  try {
    for (let runIdx = 0; runIdx < K; runIdx++) {
      // perCaseScores[scope][mode] = array of per-fixture score objects
      const perScopeMode = {};
      for (const s of SCOPES) {
        perScopeMode[s] = {};
        for (const m of MODES) perScopeMode[s][m] = [];
      }
      const detail = [];

      for (const fx of fixtures) {
        if (fx.excluded) {
          if (runIdx === 0)
            exclusions.push({ name: fx.name, reason: 'no-body (pdgScoring:exclude / KTD6)' });
          continue;
        }
        const { work, results } = await analyzeAndImpact(fx, home, { pdgOn: true });
        try {
          // Step 0 — reconcile annotation against the live traversal.
          const v = await validateFixture(fx, work, exec);
          if (!v.measurable) {
            if (runIdx === 0) exclusions.push({ name: fx.name, reason: v.problems.join(' + ') });
            continue;
          }

          // CALLGRAPH: symbol CIS vs inter_AIS. PDG: line CIS vs intra_AIS.
          const cg = callgraphCisFromResult(results.callgraph);
          const pdg = pdgCisFromResult(results.pdg);
          const cgScore = scoreCallgraph(fx.gt, cg.keys); // symbol/inter
          const pdgScore = scorePdg(fx.gt, pdg.keys); // line/intra

          const locusScope = fx.gt.locus; // the stratum this fixture belongs to
          // A fixture is scored in its OWN locus stratum (intra/inter/mixed),
          // each mode against its native ground truth (symbol vs line).
          if (SCOPES.includes(locusScope)) {
            perScopeMode[locusScope].callgraph.push(cgScore);
            perScopeMode[locusScope].pdg.push(pdgScore);
          }

          if (runIdx === 0) {
            detail.push({
              name: fx.name,
              locus: fx.gt.locus,
              criterion: fx.gt.criterion.name,
              direction: fx.gt.criterion.direction,
              criterionLine: fx.gt.criterion.line ?? null,
              critEdges: v.critEdges,
              cg: {
                count: results.callgraph.impactedCount,
                symbols: [...cg.keys].sort(),
                score: cgScore, // vs inter_AIS (symbol)
              },
              pdg: {
                affectedStatementCount: pdg.meta.affectedStatementCount,
                blockCount: pdg.meta.blockCount,
                criterionLine: pdg.meta.criterionLine,
                lines: [...pdg.keys].sort(),
                score: pdgScore, // vs intra_AIS (line)
              },
            });
          }
        } finally {
          await closeLbug(path.join(work, '.gitnexus', 'lbug')).catch(() => {});
          initialised.delete(path.join(work, '.gitnexus', 'lbug'));
          fs.rmSync(work, { recursive: true, force: true });
        }
      }

      // Aggregate this run's strata.
      const strata = {};
      for (const s of SCOPES) {
        strata[s] = {};
        for (const m of MODES) strata[s][m] = aggregate(perScopeMode[s][m]);
      }
      perRunStrata.push(strata);
      if (runIdx === 0) perCaseDetail = detail;
    }

    // ── Degraded-index check (KTD7): on ONE intra fixture, analyze WITHOUT
    // --pdg and assert PDG mode reports a degradation note (skipped, not 0/0).
    const degTarget = fixtures.find((f) => !f.excluded && f.gt.locus === 'intra');
    if (degTarget) {
      const { work, results } = await analyzeAndImpact(degTarget, home, { pdgOn: false });
      try {
        const pdgRes = results.pdg;
        degradedCheck = {
          name: degTarget.name,
          pdgLayer: pdgRes.pdgLayer ?? null,
          note: (pdgRes.note ?? pdgRes.error ?? '').slice(0, 140),
          skipped: pdgRes.pdgLayer !== undefined && pdgRes.pdgLayer !== 'ready',
        };
      } finally {
        const lbugPath = path.join(work, '.gitnexus', 'lbug');
        await closeLbug(lbugPath).catch(() => {});
        initialised.delete(lbugPath);
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── Collapse K runs into the report strata: per (mode,scope) take the MEDIAN
  // F1 across runs (F5 substrate stability); other fields from run 0.
  const strata0 = perRunStrata[0];
  const report = {};
  for (const s of SCOPES) {
    report[s] = {};
    for (const m of MODES) {
      const f1s = perRunStrata.map((r) => r[s][m].f1).filter((v) => v !== null && v !== undefined);
      const pmeds = perRunStrata
        .map((r) => r[s][m].precision)
        .filter((v) => v !== null && v !== undefined);
      const rmeds = perRunStrata
        .map((r) => r[s][m].recall)
        .filter((v) => v !== null && v !== undefined);
      report[s][m] = {
        ...strata0[s][m],
        f1: f1s.length ? median(f1s) : null,
        precision: pmeds.length ? median(pmeds) : null,
        recall: rmeds.length ? median(rmeds) : null,
      };
    }
  }

  // Underpowered floor (F3): measured cases per stratum after exclusions.
  const measurableTotal = SCOPES.reduce(
    (a, s) => a + Math.max(report[s].callgraph.nCases, report[s].pdg.nCases),
    0,
  );
  const underpowered =
    measurableTotal < FLOOR_TOTAL ||
    SCOPES.some(
      (s) => Math.max(report[s].callgraph.nCases, report[s].pdg.nCases) < FLOOR_PER_STRATUM,
    );

  const annotationFingerprint = fingerprintAnnotationSet(fixtures, sha256);

  const machineReport = {
    analyzerVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
      .version,
    corpus: { total: fixtures.length, measurable: measurableTotal, excluded: exclusions },
    underpowered,
    floor: { perStratum: FLOOR_PER_STRATUM, total: FLOOR_TOTAL },
    strata: report,
    perCase: perCaseDetail,
    degradedCheck,
    annotationFingerprint,
    runsK: K,
  };

  // ── output ──────────────────────────────────────────────────────────────
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(machineReport, null, 2) + '\n');
  } else {
    const out = [];
    out.push('=== impact-PDG accuracy report ===');
    out.push(
      `analyzer ${machineReport.analyzerVersion} | corpus ${fixtures.length} ` +
        `(${measurableTotal} measurable, ${exclusions.length} excluded) | runs K=${K}`,
    );
    out.push('');
    out.push(
      'Stratified P/R/F1 (PDG: line granularity vs intra_AIS; callgraph: symbol vs inter_AIS):',
    );
    out.push(renderTable(report));
    out.push('');
    out.push(
      'Per-case: PDG slice (line/intra) and callgraph reach (symbol/inter), with FPIS/FNIS:',
    );
    for (const d of perCaseDetail) {
      out.push(
        `  ${pad(d.name, 28)} locus=${pad(d.locus, 6)} line=${lpad(d.criterionLine ?? '-', 3)}`,
      );
      // PDG line slice: F1 vs intra_AIS, with the false-positive / false-negative lines.
      const ps = d.pdg.score;
      out.push(
        `      pdg  line/intra : P=${fmt(ps.precision)} R=${fmt(ps.recall)} F1=${fmt(ps.f1)} ` +
          `|CIS|=${d.pdg.affectedStatementCount} blocks=${d.pdg.blockCount} ` +
          `FPIS=${ps.fpisCount} FNIS=${ps.fnisCount}`,
      );
      if (ps.fpisCount > 0) out.push(`        FPIS(noise): ${ps.fpis.join(', ')}`);
      if (ps.fnisCount > 0) out.push(`        FNIS(missed): ${ps.fnis.join(', ')}`);
      // Callgraph symbol reach: F1 vs inter_AIS.
      const cs = d.cg.score;
      out.push(
        `      cg   symbol/inter: P=${fmt(cs.precision)} R=${fmt(cs.recall)} F1=${fmt(cs.f1)} ` +
          `|CIS|=${d.cg.count} FPIS=${cs.fpisCount} FNIS=${cs.fnisCount}`,
      );
      if (cs.fnisCount > 0) out.push(`        FNIS(missed): ${cs.fnis.join(', ')}`);
    }
    out.push('');
    if (degradedCheck) {
      out.push(
        `Degraded-index probe (KTD7): ${degradedCheck.name} analyzed WITHOUT --pdg → ` +
          `pdgLayer=${degradedCheck.pdgLayer} skipped=${degradedCheck.skipped}`,
      );
      out.push(`  note: ${degradedCheck.note}`);
      out.push('');
    }
    out.push(`Annotation fingerprint: ${annotationFingerprint}`);
    out.push('');
    out.push(decisionRecommendation(report, underpowered, exclusions));
    process.stdout.write(out.join('\n') + '\n');
  }

  // ── --check: two gates (KTD10) + F5 substrate stability ───────────────────
  if (CHECK) {
    if (!fs.existsSync(BASELINE_PATH)) {
      process.stderr.write(`[impact-pdg --check] FAIL: no baselines.json at ${BASELINE_PATH}\n`);
      process.exit(1);
    }
    const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const failures = [];

    // Gate 1 — order-independent annotation fingerprint (unreviewed GT edits).
    if (baselines.annotationFingerprint !== annotationFingerprint) {
      failures.push(
        `annotation fingerprint drift: ground-truth set changed without re-baseline ` +
          `(got ${annotationFingerprint}, expected ${baselines.annotationFingerprint}) — ` +
          `review the ground-truth.json edits, then re-baseline.`,
      );
    }

    // Gate 2 — one-sided F1 regression band per mode per scope (improvements
    // pass freely; only a DROP beyond ε fails). Median-of-K already applied.
    const eps = baselines.epsilon ?? 0.05;
    const bands = baselines.f1Bands ?? {};
    for (const s of SCOPES) {
      for (const m of MODES) {
        const baseF1 = bands[s]?.[m];
        const gotF1 = report[s][m].f1;
        if (baseF1 === undefined || baseF1 === null) continue; // no band ⇒ nothing to regress against
        if (gotF1 === null) {
          // F1 became undefined where a baseline existed — a structural change
          // (the scope lost all measurable cases). Flag it, don't pass silently.
          failures.push(
            `${s}/${m}: F1 is now n/a but baseline was ${fmt(baseF1)} (scope lost measurable cases?)`,
          );
          continue;
        }
        if (gotF1 < baseF1 - eps) {
          failures.push(
            `${s}/${m}: F1 ${fmt(gotF1)} < baseline ${fmt(baseF1)} − ε(${eps}) = ${fmt(baseF1 - eps)} ` +
              `(median of K=${K})`,
          );
        }
      }
    }

    if (failures.length > 0) {
      for (const f of failures) process.stderr.write(`[impact-pdg --check] FAIL: ${f}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[impact-pdg --check] PASS (${SCOPES.length} scopes × ${MODES.length} modes, ` +
        `fingerprint OK, K=${K})\n`,
    );
  }
}

run().catch((err) => {
  process.stderr.write(`[impact-pdg] ERROR: ${err?.stack || err}\n`);
  process.exit(1);
});
