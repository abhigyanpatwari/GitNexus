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
 *   2. SHELL OUT to the real CLI as a child process (see `cliChildArgs`):
 *        node dist/cli/index.js analyze <copy> --pdg --skip-git --index-only
 *      preferring the BUILT `dist/` CLI when present — plain JS, no tsx, and the
 *      parse workers it spawns also load from `dist/`. The mutation workflow
 *      builds `dist/` first (`node scripts/build.js`); `node --import tsx
 *      src/cli/index.ts` is NOT used because Node >=22.18 native type-stripping
 *      breaks the `.js`->`.ts` entry resolution (ERR_MODULE_NOT_FOUND on
 *      `lazy-action.js`). Build-free runs fall back to tsx's own CLI over src.
 *      (Child-process isolation sidesteps `process.exit`; real `saveMeta` +
 *      `registerRepo` land in the temp home);
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
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  symbolKey,
  pdgLineCis,
  intraLineAis,
  score,
  aggregate,
  aisByScope,
  unifiedAis,
  callgraphUnifiedCis,
  pdgUnifiedCis,
  composeUnifiedCis,
  scoreUnifiedAxes,
  aggregateUnifiedScores,
  fingerprintAnnotationSet,
  mutationRecall,
  circularityDiff,
  isEquivalentMutant,
  fingerprintMutationSet,
  median,
} from './metrics.mjs';
// U2 dynamic-oracle substrate: regex-mutate the criterion line, Babel-instrument
// the original TS AST, run original + mutants on type-driven inputs via tsx
// dynamic-import, value-diff into a behavioral (dynamic forward slice) AIS. Gated
// behind --mutation. `deriveBehavioralAis` / `writeMutationSidecar` (and their heavy
// @babel/* deps) are LAZY dynamic-imported inside run()'s --mutation branch, NOT
// statically here: a top-level import pulls Babel into this module's graph, and a
// test that imports measure.mjs for its pure helpers (impact-pdg-id-bridge-gate.test.ts)
// then crashes the vitest worker under full-suite memory pressure (the documented
// static-heavy-import-crashes-module-load pattern). The default report never loads it.
// U9 resolved-id soundness axis: reuse the U8 PURE bridge-predicate replica
// (`bridgeProvenSets`) and the id-vs-name set diff (`scoreIdVsName`) so the gate
// computes the NAME-match counterfactual the exact same way the realized-FP
// harness does — one source of truth for "what name-match would prove".
import { bridgeProvenSets, scoreIdVsName, reachedItemKey } from './name-collision.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // gitnexus/
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const BASELINE_PATH = path.join(__dirname, 'baselines.json');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
// Shipped CLI entry (package.json `bin`). PREFERRED for the child analyze: it's
// plain compiled JS, so the analyze process — AND the parse workers it spawns,
// which resolve relative to the running entry — load from `dist/` with no tsx in
// the loop. The build-free path below stays as a fallback.
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
// Build-free fallback: tsx's OWN cli entry (resolved from this package), NOT
// `node --import tsx <entry>.ts`. On Node >=22.18 native TypeScript type-
// stripping is enabled by default and intercepts the `.ts` entry before tsx's
// `--import` resolve hook applies; native stripping does NOT remap `./foo.js`
// specifiers to `foo.ts` (tsx does), so `node --import tsx src/cli/index.ts`
// crashes resolving `./lazy-action.js` (ERR_MODULE_NOT_FOUND) on newer Node.
// The tsx CLI takes over module loading and is version-agnostic across the
// declared engines range (node >=22.0, where `--no-experimental-strip-types`
// is not a universally-recognized flag). Workers still spawn from src via tsx on
// this path, so it is only robust on the older Node devs run locally.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/**
 * Build the argv that runs the real CLI as a child of `process.execPath`.
 * Prefers the built `dist/` CLI (production-faithful, no tsx, dist workers) when
 * present — this is what the mutation workflow uses (it builds dist first). Falls
 * back to the tsx CLI over src for build-free local runs. Returns the args AFTER
 * the node binary, i.e. ready for `spawnSync(process.execPath, [...args])`.
 */
function cliChildArgs(rest) {
  return fs.existsSync(DIST_CLI) ? [DIST_CLI, ...rest] : [TSX_CLI, CLI_ENTRY, ...rest];
}

const SCOPES = ['intra', 'inter', 'mixed'];
const MODES = ['callgraph', 'pdg'];
const UNIFIED_MODES = ['callgraph', 'pdg', 'composed-current'];

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
  const args = cliChildArgs(['analyze', work, '--skip-git', '--index-only']);
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
  const inter = callgraphCisFromResult({
    byDepth: res?.interproceduralByDepth ?? res?.pdgInterprocedural?.byDepth ?? {},
  });
  return {
    lineKeys: pdgLineCis(res?.affectedStatements),
    // FU-A: the intra-line axis is scored against intra-tagged statements only,
    // so U1's cross-function (inter) reach is no longer counted as intra FPIS.
    // The full `lineKeys` stays for diagnostics; inter reach lives on the
    // separate symbol axis (`symbolKeys` / `interproceduralByDepth`).
    intraLineKeys: pdgLineCis(res?.affectedStatements, 'intra'),
    symbolKeys: inter.keys,
    meta: {
      affectedStatementCount: res?.affectedStatementCount ?? 0,
      blockCount: res?.blockCount ?? null,
      criterionLine: res?.criterionLine ?? null,
      epistemic: res?.epistemic ?? null,
      note: res?.note ?? null,
      interprocedural: res?.pdgInterprocedural ?? null,
    },
  };
}

/**
 * Callee NAME set + resolved-ID set for an EXACT dependence slice (seed ∪
 * reachable blocks), read off the persisted `BasicBlock.callees` / `.calleeIds`
 * via the raw pool `exec` — exactly the two sets the bridge unions over the slice
 * in `local-backend.ts`. Mirrors `sliceCalleeSetsOf` in name-collision.mjs but
 * runs through `exec` (the harness already holds the pool open for Step 0), so
 * the name counterfactual is computed from the SAME persisted data the live
 * bridge proved against. On a pre-v3 index the `calleeIds` column is absent →
 * the id query throws → ids stay empty (graceful degrade).
 */
async function sliceCalleeSetsOf(lbugPath, blockIds, exec) {
  const names = new Set();
  const ids = new Set();
  if (!Array.isArray(blockIds) || blockIds.length === 0) return { names, ids };
  const nameRows = await exec(
    lbugPath,
    `MATCH (b:BasicBlock) WHERE b.id IN $ids RETURN b.callees AS callees`,
    { ids: blockIds },
  );
  for (const r of nameRows) {
    for (const n of String(r.callees ?? r[0] ?? '').split(' ')) if (n) names.add(n);
  }
  const idRows = await exec(
    lbugPath,
    `MATCH (b:BasicBlock) WHERE b.id IN $ids RETURN b.calleeIds AS calleeIds`,
    { ids: blockIds },
  ).catch(() => []);
  for (const r of idRows) {
    for (const i of String(r.calleeIds ?? r[0] ?? '').split(' ')) if (i && i !== '*') ids.add(i);
  }
  return { names, ids };
}

/**
 * U9 axis — run the resolved-id soundness gate on ONE fixture that carries an
 * `idBridge` ground-truth block. Seeds `impact(mode:'pdg', line: idBridge.seedLine)`,
 * extracts the id-proven statement-precise set, computes the leaf-NAME match
 * counterfactual over the SAME reached depth-1 callees + the SAME exact slice
 * (via the U8 `bridgeProvenSets`), and evaluates both against ground truth with
 * the pure `evaluateIdBridge`. Returns the gate verdict + the realized numbers
 * the report/README record (id-proven == 1 correct id; name-match == 2 = the
 * over-attribution baseline).
 */
async function idBridgeAxisFor(fx, work, results, exec) {
  const lbugPath = path.join(work, '.gitnexus', 'lbug');
  const pdg = results.pdg;
  const idProven = idProvenIdsFromResult(pdg);

  // Name counterfactual: same depth-1 reached callees, same exact slice sets.
  const reachedD1 =
    pdg?.pdgInterprocedural?.byDepth?.[1] ?? pdg?.pdgInterprocedural?.byDepth?.['1'] ?? [];
  const exactSlice = [
    ...(Array.isArray(pdg?.seedBlocks) ? pdg.seedBlocks : []),
    ...(Array.isArray(pdg?.reachableBlocks) ? pdg.reachableBlocks : []),
  ];
  const { names, ids } = await sliceCalleeSetsOf(lbugPath, exactSlice, exec);
  const proven = bridgeProvenSets(reachedD1, names, ids);
  const nameWouldProve = proven.nameProven.map(reachedItemKey).filter(Boolean);
  const idVsName = scoreIdVsName(proven.nameProven, proven.idProven);

  const verdict = evaluateIdBridge(idProven, nameWouldProve, fx.gt.idBridge);
  return {
    name: fx.name,
    seedLine: fx.gt.idBridge?.seedLine ?? null,
    discriminating: proven.discriminating === true,
    ...verdict,
    idProvenCount: verdict.idProven.length,
    nameProvenCount: verdict.nameProven.length,
    fpEliminatedCount: idVsName.fpEliminated,
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

// ── U9: resolved-symbol-id soundness axis (plan 2026-06-18-001 U9; R1, R5) ────

/**
 * Flatten the proven (statement-precise) reach of a `pdg` impact result into a
 * sorted, de-duplicated id list. `pdgInterprocedural.statementPreciseByDepth`
 * already holds ONLY the `callgraph-bridge` (id-proven) items across depths —
 * the `unproven-bridge` callees (reached but NOT on the dependence slice) are
 * dropped by `projectStatementPreciseByDepth`. So this is exactly the set the
 * RESOLVED-ID bridge proves. Items without an `id` fall back to `reachedItemKey`
 * (mirroring the U8 harness) so a dynamic/unresolved callee is never silently
 * dropped from the gate.
 */
export function idProvenIdsFromResult(res) {
  const byDepth = res?.pdgInterprocedural?.statementPreciseByDepth ?? {};
  const out = new Set();
  for (const items of Object.values(byDepth)) {
    for (const it of Array.isArray(items) ? items : []) out.add(reachedItemKey(it));
  }
  return [...out].filter(Boolean).sort();
}

/**
 * PURE gate scorer for the resolved-id soundness fixture (no DB / analyze / Date /
 * random — the deterministic unit test asserts this arithmetic directly).
 *
 * Inputs are three plain id lists derived from ONE `pdg` impact result on the
 * fixture's seed line:
 *   - `idProven`     — what the resolved-id bridge proved (statement-precise set);
 *   - `nameWouldProve` — what the leaf-NAME bridge would prove over the SAME
 *     reached items + the SAME slice (the over-attribution counterfactual);
 *   - `expected`     — the ground-truth `idBridge` block.
 *
 * The gate PASSES iff the id-proven set equals `expected.idProven` EXACTLY and
 * the name counterfactual strictly over-attributes (proves a superset that
 * includes every `expected.fpEliminated` id). `over` is the realized
 * over-attribution count the README records (= |name ∖ id|). Returns
 * `{ ok, problems, idProven, nameProven, fpEliminated, over }`.
 */
export function evaluateIdBridge(idProven, nameWouldProve, expected) {
  const idSet = [...new Set(idProven)].sort();
  const nameSet = [...new Set(nameWouldProve)].sort();
  const expId = [...new Set(expected?.idProven ?? [])].sort();
  const expFp = [...new Set(expected?.fpEliminated ?? [])].sort();
  const idKeys = new Set(idSet);
  const over = nameSet.filter((k) => !idKeys.has(k)).sort();

  const problems = [];
  const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  problems.push(
    ...(sameSet(idSet, expId)
      ? []
      : [`id-proven set ${JSON.stringify(idSet)} != ground-truth ${JSON.stringify(expId)}`]),
  );
  // The whole point: the NAME match must over-attribute (prove the collision
  // callee the id match correctly drops). A name set that did NOT over-attribute
  // would mean the fixture lost its discriminating power — fail loudly.
  problems.push(
    ...(over.length > 0
      ? []
      : ['name-match did NOT over-attribute — the fixture lost its discriminating power']),
  );
  const missingFp = expFp.filter((k) => !over.includes(k));
  problems.push(
    ...(missingFp.length === 0
      ? []
      : [
          `name-match did not over-attribute the expected collision id(s) ${JSON.stringify(missingFp)}`,
        ]),
  );

  return {
    ok: problems.length === 0,
    problems,
    idProven: idSet,
    nameProven: nameSet,
    fpEliminated: over,
    over: over.length,
  };
}

// ── U2 mutation-oracle reporting + recall-hole classification ────────────────

/**
 * Classify a single B∖slice recall-hole line into one honest bucket so a reader is
 * not misled (R2). These are NOT all "noise" — only the last is a genuine slicer
 * bug, but two of the others are REAL, DOCUMENTED limitations the oracle exists to
 * surface (not dismiss):
 *   (a) known-U1-no-ascent-gap — the missed line is the criterion function's
 *       continuation AFTER a call: it depends on a callee RETURN/out-param/throw
 *       effect the intra slice cannot ascend into without CALL_SUMMARY. A REAL,
 *       DOCUMENTED U1 limitation (genuinely affected, genuinely missed).
 *   (b) block-granularity-limit — the missed line genuinely depends on the
 *       criterion but is an INTERIOR statement of a coalesced straight-line CFG
 *       BasicBlock whose representative line already appears in the slice. The
 *       slice is sound at BLOCK granularity but cannot pinpoint interior statements
 *       at STATEMENT granularity. This is the PR's declared #1 validity threat
 *       (annotation-circularity / block reconciliation), here INDEPENDENTLY
 *       QUANTIFIED — a real limitation, not measurement noise.
 *   (c) oracle-direction-scope — an UPSTREAM-annotated fixture: the forward value-
 *       diff oracle runs in its native DOWNSTREAM sense (R1), so it cannot validate
 *       the reverse slice. A scope limit of the ORACLE, not a slicer property.
 *   (d) novel-recall-hole — anything else: a dependence the static slice missed
 *       that is NOT explained by (a)/(b)/(c). The strongest "real bug" signal;
 *       when unsure we fall back HERE (flag, never silently dismiss).
 * Heuristic, line-based, conservative.
 */
function classifyRecallHole(missLine, check) {
  const manual = new Set(check.manualAis ?? []);
  const file = missLine.slice(0, missLine.lastIndexOf(':'));
  const missNum = Number(missLine.slice(missLine.lastIndexOf(':') + 1));
  const critNum = check.criterionLine ?? null;
  const sliceNums = (check.sliceLines ?? [])
    .filter((k) => k.slice(0, k.lastIndexOf(':')) === file)
    .map((k) => Number(k.slice(k.lastIndexOf(':') + 1)))
    .filter((n) => Number.isFinite(n));

  // (c — oracle scope limit, upstream-direction): on an UPSTREAM fixture the oracle
  // runs in its native DOWNSTREAM sense (R1), so any B∖slice line is a forward-oracle
  // vs reverse-slice direction mismatch — the ORACLE cannot validate this fixture,
  // it is NOT a slicer recall bug.
  if (check.direction === 'upstream') {
    return {
      bucket: 'oracle-direction-scope',
      line: missLine,
      reason: 'upstream fixture: forward oracle cannot validate the reverse slice',
    };
  }

  // (b — real block-granularity limitation): the missed line sits BETWEEN a
  // block-start that IS in the slice (or the criterion line) and the NEXT slice
  // line — i.e. inside a coalesced CFG BasicBlock whose start line already appears
  // in the slice. The CFG merges consecutive straight-line statements into one
  // block, so an interior line can never surface as a DISTINCT slice statement even
  // though it genuinely depends on the criterion. The dynamic oracle observes it at
  // statement granularity, so this is the documented block-granularity limitation
  // (the #1 validity threat), independently quantified — NOT measurement noise.
  // Coalescing is a phenomenon of consecutive STRAIGHT-LINE statements inside one
  // function (the intra stratum); on inter/mixed fixtures a "between two slice
  // lines" miss is more likely a cross-function caller-continuation gap (U1), so
  // restrict this classification to the intra stratum.
  const blockStarts = [...sliceNums, ...(critNum !== null ? [critNum] : [])].sort((a, b) => a - b);
  const startBelow = blockStarts.filter((n) => n < missNum).sort((a, b) => b - a)[0];
  const startOrSliceAtOrAbove = blockStarts.filter((n) => n >= missNum).sort((a, b) => a - b)[0];
  const shadowedByCoalescedBlock =
    check.locus === 'intra' &&
    startBelow !== undefined &&
    // missLine is strictly inside [startBelow+1, nextStart-1] and the slice/criterion
    // already represents that block at startBelow.
    (startOrSliceAtOrAbove === undefined || startOrSliceAtOrAbove > missNum);
  if (shadowedByCoalescedBlock) {
    return {
      bucket: 'block-granularity-limit',
      line: missLine,
      reason:
        'interior of a coalesced straight-line block (sound at block granularity, under-reports at statement granularity)',
    };
  }

  // (a — known U1 no-ascent gap): on an inter/mixed fixture, a missed dependent line
  // the slice did not reach is the classic caller-continuation-after-call gap (a
  // return-value / out-param / throw effect not ascended without CALL_SUMMARY).
  if (check.locus === 'inter' || check.locus === 'mixed') {
    return {
      bucket: 'known-U1-no-ascent-gap',
      line: missLine,
      reason: 'caller continuation depends on callee effect',
    };
  }

  // (d — novel hole): a genuine intra dependence the static slice missed that none
  // of the documented buckets explains. A miss that is ALSO a manual intra_AIS line
  // is the strongest signal, but ANY unexplained intra-downstream miss is flagged
  // here rather than dismissed — honesty over a clean gate.
  const reason = manual.has(missLine)
    ? 'manual intra_AIS line not in slice'
    : 'intra dependence missed, unexplained by U1/block/direction';
  return { bucket: 'novel-recall-hole', line: missLine, reason };
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

function renderUnifiedTable(unified) {
  const head =
    `${pad('Mode', 17)} ${pad('Axis', 13)} ${lpad('P', 7)} ${lpad('R', 7)} ${lpad('F1', 7)} ` +
    `${lpad('|CIS|/|AIS|', 11)} ${lpad('FPIS', 6)} ${lpad('FNIS', 6)} ${lpad('n', 4)}`;
  const lines = [head, '-'.repeat(head.length)];
  const axes = [
    ['intraLine', 'line/intra'],
    ['interSymbol', 'symbol/inter'],
  ];
  for (const mode of UNIFIED_MODES) {
    for (const [axis, label] of axes) {
      const a = unified[mode][axis];
      lines.push(
        `${pad(mode, 17)} ${pad(label, 13)} ${lpad(fmt(a.precision), 7)} ${lpad(fmt(a.recall), 7)} ` +
          `${lpad(fmt(a.f1), 7)} ${lpad(fmt(a.cisAisRatio), 11)} ${lpad(a.fpis, 6)} ${lpad(a.fnis, 6)} ` +
          `${lpad(a.nCases, 4)}`,
      );
    }
  }
  lines.push('');
  lines.push('Unified verdict guard: compare axes separately; do not blend line and symbol F1.');
  for (const mode of UNIFIED_MODES) {
    lines.push(
      `  ${mode}: min defined recall=${fmt(unified[mode].minRecall)} FPIS=${unified[mode].fpis} FNIS=${unified[mode].fnis}`,
    );
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
function decisionRecommendation(strata, unified, underpowered, exclusions) {
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
      `against inter_AIS: it recovers the cross-function callees exactly. Unified PDG mode now ` +
      `attaches the same inter-symbol reach in interproceduralByDepth/byDepth while keeping statement reach in ` +
      `affectedStatements, so the symbol axis can be compared directly against callgraph.`,
  );

  // Mixed-scope: both engines contribute, each in its own scope.
  if (pdgMixedF1 !== null || cgMixedF1 !== null) {
    lines.push(
      `On MIXED-scope, the two are COMPLEMENTARY: PDG resolves the intra statement set ` +
        `(F1=${fmt(pdgMixedF1)} vs intra_AIS) while call-graph reaches the callee(s) ` +
        `(F1=${fmt(cgMixedF1)} vs inter_AIS). Neither alone covers the full mixed blast radius.`,
    );
  }

  if (unified) {
    lines.push(
      `Unified-axis check: current callgraph leaves the intra-line axis empty. Unified PDG now ` +
        `covers both axes, while composed-current remains the control baseline that combines the ` +
        `standalone callgraph symbol reach with PDG statement reach. composed-current reaches min ` +
        `defined recall=${fmt(unified['composed-current'].minRecall)} with ` +
        `FPIS=${unified['composed-current'].fpis} and FNIS=${unified['composed-current'].fnis}; ` +
        `pdg should match that recall before any default-switch discussion.`,
    );
  }

  lines.push(
    `VERDICT: keep option-driven comparison, but mode:'pdg' is now the unified PDG-facing ` +
      `answer: statement-level affectedStatements come from the persisted CDG/REACHING_DEF slice, ` +
      `and inter-procedural symbol reach is carried in interproceduralByDepth/byDepth. mode:'callgraph' remains the ` +
      `default/comparator for the established symbol-only traversal. The accuracy decision should be ` +
      `made from the unified axes: pdg must preserve statement recall while matching the composed ` +
      `inter-symbol baseline and bounding FPIS.`,
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
  // U2 dynamic-oracle (opt-in, BENCH-ADDITIVE). --mutation runs the value-diff
  // forward-slice oracle and prints per-fixture recall + circularity rows;
  // --mutation-strict would later flip Gate 4 to a hard exit (report-only now).
  const MUTATION = process.argv.includes('--mutation');
  const MUTATION_STRICT = process.argv.includes('--mutation-strict');
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
  const perRunUnified = []; // K runs × { mode: { intraLine, interSymbol } }
  let perCaseDetail = null; // last run's per-case detail for the report
  let degradedCheck = null;
  const idBridgeChecks = []; // U9 resolved-id soundness axis (one per idBridge fixture)
  const mutationChecks = []; // U2 dynamic-oracle rows (one per measurable fixture, --mutation only)

  try {
    for (let runIdx = 0; runIdx < K; runIdx++) {
      // perCaseScores[scope][mode] = array of per-fixture score objects
      const perScopeMode = {};
      for (const s of SCOPES) {
        perScopeMode[s] = {};
        for (const m of MODES) perScopeMode[s][m] = [];
      }
      const detail = [];
      const perUnifiedMode = {};
      for (const m of UNIFIED_MODES) perUnifiedMode[m] = [];

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
          const pdgScore = scorePdg(fx.gt, pdg.intraLineKeys); // line/intra (FU-A: intra-tagged only)

          const unifiedTruth = unifiedAis(fx.gt);
          const cgUnified = callgraphUnifiedCis(fx.gt, cg.keys);
          const pdgUnified = pdgUnifiedCis(pdg.intraLineKeys, pdg.symbolKeys, fx.gt);
          const composedUnified = composeUnifiedCis(cgUnified, pdgUnified);
          const unifiedScores = {
            callgraph: scoreUnifiedAxes(cgUnified, unifiedTruth),
            pdg: scoreUnifiedAxes(pdgUnified, unifiedTruth),
            'composed-current': scoreUnifiedAxes(composedUnified, unifiedTruth),
          };
          for (const m of UNIFIED_MODES) perUnifiedMode[m].push(unifiedScores[m]);

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
                lines: [...pdg.lineKeys].sort(),
                symbols: [...pdg.symbolKeys].sort(),
                score: pdgScore, // vs intra_AIS (line)
              },
              unified: unifiedScores,
            });
          }
        } finally {
          await closeLbug(path.join(work, '.gitnexus', 'lbug')).catch(() => {});
          initialised.delete(path.join(work, '.gitnexus', 'lbug'));
          fs.rmSync(work, { recursive: true, force: true });
        }
      }

      // Aggregate this run's native strata and unified two-axis comparison.
      const strata = {};
      for (const s of SCOPES) {
        strata[s] = {};
        for (const m of MODES) strata[s][m] = aggregate(perScopeMode[s][m]);
      }
      const unified = {};
      for (const m of UNIFIED_MODES) unified[m] = aggregateUnifiedScores(perUnifiedMode[m]);
      perRunStrata.push(strata);
      perRunUnified.push(unified);
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

    // ── U9 resolved-id soundness axis (R1, R5): for each fixture carrying an
    // `idBridge` ground-truth block, prove that the resolved-ID bridge labels
    // EXACTLY the right callee statement-precise while the leaf-NAME bridge would
    // over-attribute the same-named collision callee. analyzeAndImpact already
    // seeds `results.pdg` on `criterion.line` (== idBridge.seedLine), so the
    // statement-precise set is the id-proven set for the seed line directly.
    for (const fx of fixtures.filter((f) => f.gt.idBridge)) {
      const { work, results } = await analyzeAndImpact(fx, home, { pdgOn: true });
      try {
        idBridgeChecks.push(await idBridgeAxisFor(fx, work, results, exec));
      } finally {
        const lbugPath = path.join(work, '.gitnexus', 'lbug');
        await closeLbug(lbugPath).catch(() => {});
        initialised.delete(lbugPath);
        fs.rmSync(work, { recursive: true, force: true });
      }
    }

    // ── U2 dynamic-oracle mutation pass (opt-in --mutation; BENCH-ADDITIVE) ──
    // For each fixture: re-analyze into the SAME temp working copy, take the SAME
    // live static PDG slice the F1 metric scores, derive the behavioral (dynamic
    // forward) AIS by value-diff over line-scoped mutants on the criterion line,
    // then score mutation_recall vs the slice and the circularity diff vs the
    // manual intra_AIS. Runs ONCE (not K times) — the oracle is deterministic and
    // the value-diff is the load-bearing signal, not substrate-noise-prone like F1.
    if (MUTATION) {
      // LAZY-load the oracle (+ its heavy @babel/* deps) only when --mutation is
      // actually requested — see the import-block note above for why this must NOT
      // be a static top-level import.
      const { deriveBehavioralAis, writeMutationSidecar } = await import('./mutation-oracle.mjs');
      for (const fx of fixtures) {
        // nobody-interface-excluded has NO body → no statement to seed/mutate →
        // oracle-excluded (not a silent skip; printed in the row).
        const noBody = fx.gt.locus === 'n/a' || !fx.gt.criterion.line;
        // R1: the two direction:'upstream' fixtures are a forward-oracle mismatch.
        // Run the oracle in its native downstream sense + the circularity cross-
        // check, but DO NOT apply the recall gate to them (oracle-direction-excluded).
        const upstream = fx.gt.criterion.direction === 'upstream';
        // intra-overloaded-callee (pdgScoring:exclude, has a body) is corroboration
        // for the id-discrimination axis, NOT an AIS recall case.
        const idCorroboration = fx.gt.pdgScoring === 'exclude' && !noBody;

        if (noBody) {
          mutationChecks.push({
            name: fx.name,
            locus: fx.gt.locus,
            direction: fx.gt.criterion.direction,
            criterionKey: null,
            behavioralAis: [],
            sliceLines: [],
            manualAis: [],
            recall: null,
            recallGated: false,
            scopeNote: 'oracle-excluded: no body (no statement to mutate)',
            mutants: [],
            circularity: { beyondManual: [], confirmed: [], manualOnly: [] },
            skipped: 'no-body',
          });
          continue;
        }

        const { work, results } = await analyzeAndImpact(fx, home, { pdgOn: true });
        try {
          // The SAME live static slice the F1 metric scores.
          const slice = pdgLineCis(results.pdg?.affectedStatements);
          const manualAis = intraLineAis(fx.gt);
          const derived = await deriveBehavioralAis(fx, work);
          writeMutationSidecar(fx, derived);

          const B = new Set(derived.behavioralAis);
          const rec = mutationRecall(B, slice);
          const circ = circularityDiff(B, manualAis);
          // The recall gate applies to DOWNSTREAM, non-corroboration fixtures only.
          const recallGated = !upstream && !idCorroboration;
          const scopeNote = idCorroboration
            ? 'id-discrimination corroboration (excluded from recall gate)'
            : upstream
              ? 'oracle-direction-excluded: upstream fixture (forward-oracle native downstream)'
              : null;

          mutationChecks.push({
            name: fx.name,
            locus: fx.gt.locus,
            direction: fx.gt.criterion.direction,
            criterionKey: derived.criterionKey,
            criterionLine: derived.criterionLine,
            behavioralAis: derived.behavioralAis,
            sliceLines: [...slice].sort(),
            manualAis: [...manualAis].sort(),
            recall: rec.recall,
            recallGated,
            intersection: rec.intersection,
            bSize: rec.bSize,
            sliceSize: rec.sliceSize,
            missing: rec.missing, // B ∖ slice — recall hole
            extra: rec.extra, // slice ∖ B — sound over-approx (informational)
            circularity: circ,
            scopeNote,
            paramTypes: derived.paramTypes,
            inputs: derived.inputs,
            mutants: derived.mutants,
            skipped: derived.skipped,
          });
        } finally {
          const lbugPath = path.join(work, '.gitnexus', 'lbug');
          await closeLbug(lbugPath).catch(() => {});
          initialised.delete(lbugPath);
          fs.rmSync(work, { recursive: true, force: true });
        }
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

  const unified0 = perRunUnified[0];
  const unifiedReport = {};
  for (const mode of UNIFIED_MODES) {
    unifiedReport[mode] = { ...unified0[mode] };
    for (const axis of ['intraLine', 'interSymbol']) {
      const f1s = perRunUnified
        .map((r) => r[mode][axis].f1)
        .filter((v) => v !== null && v !== undefined);
      const pmeds = perRunUnified
        .map((r) => r[mode][axis].precision)
        .filter((v) => v !== null && v !== undefined);
      const rmeds = perRunUnified
        .map((r) => r[mode][axis].recall)
        .filter((v) => v !== null && v !== undefined);
      unifiedReport[mode][axis] = {
        ...unified0[mode][axis],
        f1: f1s.length ? median(f1s) : null,
        precision: pmeds.length ? median(pmeds) : null,
        recall: rmeds.length ? median(rmeds) : null,
      };
    }
    const minRecalls = perRunUnified
      .map((r) => r[mode].minRecall)
      .filter((v) => v !== null && v !== undefined);
    unifiedReport[mode].minRecall = minRecalls.length ? median(minRecalls) : null;
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
    unified: unifiedReport,
    perCase: perCaseDetail,
    degradedCheck,
    idBridgeChecks,
    mutation: MUTATION
      ? {
          fingerprint: fingerprintMutationSet(mutationChecks, sha256),
          checks: mutationChecks,
        }
      : null,
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
    out.push('Unified impact axes (additive; native table above is unchanged):');
    out.push(renderUnifiedTable(unifiedReport));
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
    if (idBridgeChecks.length > 0) {
      out.push('Resolved-id soundness axis (U9 — R1/R5): id-match proves the right callee,');
      out.push('name-match over-attributes the same-leaf-name collision callee:');
      for (const c of idBridgeChecks) {
        out.push(
          `  ${pad(c.name, 28)} seed=${lpad(c.seedLine ?? '-', 3)} ` +
            `id-proven=${c.idProvenCount} name-would-prove=${c.nameProvenCount} ` +
            `(over-attribution=${c.over}) ${c.ok ? 'PASS' : 'FAIL'}`,
        );
        out.push(`      id-proven : ${c.idProven.join(', ') || '(none)'}`);
        out.push(`      eliminated: ${c.fpEliminated.join(', ') || '(none)'}`);
        out.push(...(c.problems.length > 0 ? [`      problems  : ${c.problems.join('; ')}`] : []));
      }
      out.push('');
    }
    if (MUTATION) {
      out.push(
        'U2 dynamic-oracle (value-diff forward slice; Agrawal-Horgan/Tip/Voas): mutation_recall =',
      );
      out.push(
        '|B ∩ slice|/|B| (B = dynamic AIS the oracle PROVED). circularity = B ∖ manual_intra_AIS',
      );
      out.push(
        '(non-empty ⇒ the manual annotation MISSED a real dependence — independent evidence):',
      );
      const head =
        `  ${pad('Case', 28)} ${pad('locus', 6)} ${pad('dir', 10)} ${lpad('|B|', 4)} ` +
        `${lpad('|slice|', 8)} ${lpad('recall', 7)} ${lpad('gated', 6)} ${lpad('circ', 5)}`;
      out.push(head);
      out.push('  ' + '-'.repeat(head.length - 2));
      for (const c of mutationChecks) {
        out.push(
          `  ${pad(c.name, 28)} ${pad(c.locus, 6)} ${pad(c.direction, 10)} ${lpad(c.bSize ?? 0, 4)} ` +
            `${lpad(c.sliceSize ?? 0, 8)} ${lpad(fmt(c.recall), 7)} ${lpad(c.recallGated ? 'yes' : 'no', 6)} ` +
            `${lpad((c.circularity?.beyondManual ?? []).length, 5)}`,
        );
        out.push(...(c.scopeNote ? [`        scope: ${c.scopeNote}`] : []));
        out.push(...(c.skipped ? [`        oracle-skipped: ${c.skipped}`] : []));
        out.push(
          ...((c.missing ?? []).length > 0
            ? [`        B∖slice (recall hole): ${c.missing.join(', ')}`]
            : []),
        );
        // B∖manual is only a circularity SIGNAL on intra fixtures (whose intra_AIS
        // claims completeness). On inter/mixed fixtures intra_AIS deliberately omits
        // cross-function lines, so B∖manual there is EXPECTED (callee-body lines),
        // not an annotation miss — labelled accordingly so it is not misread.
        const circMeaningful = c.locus === 'intra';
        out.push(
          ...((c.circularity?.beyondManual ?? []).length > 0
            ? [
                `        B∖manual (${circMeaningful ? 'WARN — intra annotation missed' : 'expected: cross-function, intra_AIS empty-by-design'}): ${c.circularity.beyondManual.join(', ')}`,
              ]
            : []),
        );
      }
      out.push('');
      // Classify EVERY recall<1.0 (R2) so a reader is not misled.
      const holes = [];
      for (const c of mutationChecks) {
        for (const miss of c.missing ?? [])
          holes.push({ ...classifyRecallHole(miss, c), case: c.name });
      }
      out.push('Recall-hole classification (R2 — every B∖slice line):');
      if (holes.length === 0) {
        out.push('  (none — every gated fixture has mutation_recall == 1.0)');
      } else {
        for (const h of holes) out.push(`  [${h.bucket}] ${h.case}: ${h.line} — ${h.reason}`);
      }
      // Corpus circularity headline — meaningful ONLY on intra fixtures (whose
      // intra_AIS claims completeness). A non-empty B∖manual there would be the
      // headline independent evidence that the hand annotation is incomplete.
      const intraCirc = mutationChecks.filter(
        (c) => c.locus === 'intra' && (c.circularity?.beyondManual ?? []).length > 0,
      );
      out.push(
        intraCirc.length > 0
          ? `CIRCULARITY: on ${intraCirc.length} intra fixture(s) the oracle proved a dependence the ` +
              `manual intra_AIS missed: ${intraCirc.map((c) => `${c.name} [${c.circularity.beyondManual.join(', ')}]`).join('; ')}. ` +
              `Classify each (block-granularity reconciliation vs genuine annotation gap) before acting.`
          : 'CIRCULARITY: clean on the intra stratum — the dynamic oracle proved no INTRA dependence the ' +
              'manual intra_AIS missed (inter/mixed B∖manual is expected cross-function reach, not a miss).',
      );
      out.push(`Mutation fingerprint: ${fingerprintMutationSet(mutationChecks, sha256)}`);
      out.push('');
    }
    out.push(`Annotation fingerprint: ${annotationFingerprint}`);
    out.push('');
    out.push(decisionRecommendation(report, unifiedReport, underpowered, exclusions));
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

    // Gate 3 — resolved-id soundness axis (U9, R1/R5): every fixture carrying an
    // `idBridge` block must PASS its gate (id-proven == the single correct id AND
    // the name match strictly over-attributes the eliminated collision id). The
    // expected sets live in the ground-truth `idBridge` block (covered by Gate 1's
    // fingerprint), so this gate has no separate baseline number to drift.
    const idBridgeFixtureCount = fixtures.filter((f) => f.gt.idBridge).length;
    for (const c of idBridgeChecks) {
      failures.push(
        ...(c.ok ? [] : [`id-bridge ${c.name} (seed ${c.seedLine}): ${c.problems.join('; ')}`]),
      );
    }
    // A declared idBridge fixture that produced NO check (analyze/seed dropout)
    // must fail loudly — never let the soundness gate silently vanish.
    failures.push(
      ...(idBridgeChecks.length === idBridgeFixtureCount
        ? []
        : [
            `id-bridge axis ran ${idBridgeChecks.length} of ${idBridgeFixtureCount} declared ` +
              `idBridge fixtures (a fixture dropped out of the gate)`,
          ]),
    );

    // Gate 4 — U2 mutation recall (REPORT-ONLY this landing; --mutation only).
    // mutation_recall < 1.0 on a GATED (downstream, non-corroboration) fixture
    // means the dynamic oracle proved a dependence the static slice missed. We
    // PRINT the gate line + the numbers but DO NOT process.exit(1) yet — flipping
    // to a hard gate later is a one-flag change (--mutation-strict already wired).
    if (MUTATION) {
      const gatedHoles = mutationChecks.filter(
        (c) => c.recallGated && c.recall !== null && c.recall < 1,
      );
      const gatedCount = mutationChecks.filter((c) => c.recallGated).length;
      // A future hard gate should fire only on NOVEL holes. The documented,
      // expected buckets are excluded: known-U1-no-ascent-gap (return/effect ascent
      // U1 lacks), block-granularity-limit (interior of a coalesced block — the
      // slice is sound at block granularity), and oracle-direction-scope (upstream
      // fixture the forward oracle cannot validate). Compute the novel subset via
      // the same classifier the report uses.
      const novelHoles = [];
      for (const c of gatedHoles) {
        for (const miss of c.missing ?? []) {
          const cls = classifyRecallHole(miss, c);
          if (cls.bucket === 'novel-recall-hole') novelHoles.push(`${c.name}:${miss}`);
        }
      }
      const allRecall1 =
        gatedHoles.length === 0
          ? 'all gated recall==1.0'
          : gatedHoles
              .map((c) => `${c.name} recall=${fmt(c.recall)} (B∖slice: ${c.missing.join(', ')})`)
              .join('; ');
      process.stderr.write(
        `[impact-pdg --check] Gate 4 (mutation recall, REPORT-ONLY): ` +
          `${gatedCount} gated fixture(s), ${gatedHoles.length} below 1.0 ` +
          `(${novelHoles.length} NOVEL after classification) — ${allRecall1}\n`,
      );
      // --mutation-strict opt-in: flip the report-only gate to a hard failure on
      // NOVEL holes only (one-flag change to make this the live gate later).
      failures.push(
        ...(MUTATION_STRICT && novelHoles.length > 0
          ? [`mutation recall: NOVEL hole(s) (--mutation-strict): ${novelHoles.join(', ')}`]
          : []),
      );
    }

    if (failures.length > 0) {
      for (const f of failures) process.stderr.write(`[impact-pdg --check] FAIL: ${f}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[impact-pdg --check] PASS (${SCOPES.length} scopes × ${MODES.length} modes, ` +
        `fingerprint OK, ${idBridgeChecks.length} id-bridge fixture(s) sound, K=${K})\n`,
    );
  }
}

// Only execute the harness when invoked as the CLI entrypoint — NOT when this
// module is imported (e.g. impact-pdg-id-bridge-gate.test.ts imports the exported
// pure helpers). Importing must be side-effect-free: an unguarded run() kicks off
// the full real-analyze report in the background, which under the full vitest
// suite leaks an unhandled error that Vitest attributes to the importing file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    process.stderr.write(`[impact-pdg] ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
