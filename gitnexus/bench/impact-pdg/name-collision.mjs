/**
 * Realized name-collision probe for the PDG-impact statement-precise bridge.
 *
 * The bridge labels a callgraph-reached callee "proven" (callgraph-bridge) iff its
 * LEAF NAME appears in the changed line's dependence-slice block callees
 * (`pdgBridgeEvidenceForImpact`, pdg-impact.ts). Because the match is by name, two
 * distinct reached symbols that share a leaf name (e.g. two `get`s) are BOTH proven
 * whenever that name is in the slice — but the slice's call site(s) resolve to a
 * specific subset, so the extras are over-attribution (false-proven). This is the
 * documented "conservative SUPERSET" caveat (pdg-impact.ts:1352).
 *
 * This probe QUANTIFIES that over-attribution on real code, to decide whether a
 * sound resolved-symbol-id bridge is worth building.
 *
 * Key property that makes an index-only measurement rigorous: a collision
 * false-positive is ALWAYS a name-ambiguous proven label. To be proven a symbol
 * must first be reached, so every same-name over-attribution surfaces as >=2
 * DISTINCT proven symbol-ids sharing one leaf name. Counting those is therefore
 * COMPLETE for collision-FP. It is an UPPER BOUND (a slice could legitimately call
 * two same-named callees on different lines, in which case both proven labels are
 * correct), so the realized FP is in [0, ambiguous]. A near-zero result is a
 * decisive no-go; a material result motivates the exact line-join confirmation
 * (which needs a re-run that captures per-call-site resolved ids — the persisted
 * CALLS edge has no call-site line, BasicBlock.callees is a deduped leaf-name set).
 *
 * Focus is DEPTH 1: name-matching only fires at the first hop; deeper proven labels
 * are inherited from their depth-1 ancestor (betterBridgeEvidence), a different
 * (transitive) imprecision, not name collision.
 *
 * ── U8: realized id-vs-name diff (the R5 proof, exact-slice) ─────────────────
 * After U5/U6 the live bridge matches RESOLVED callee symbol-ids: on an index that
 * carries `BasicBlock.calleeIds`, `pdgInterprocedural.statementPreciseByDepth` is
 * the SOUND id-proven set. The `ambiguityRate` above then collapses to ~0 (ids
 * discriminate same-named callees) — itself proof the collision is gone. To
 * MEASURE what the id bridge changed versus the old name bridge on the SAME real
 * slices, this probe also recomputes, per function, the NAME-proven set the
 * leaf-name predicate WOULD prove on the EXACT seed∪reachable slice (not a
 * function-level proxy — the impact result exposes `seedBlocks`/`reachableBlocks`,
 * so we query those exact blocks' `callees` and replicate the bridge's
 * `sliceCalleeNames.has(name)` fallback), and diffs the two reached-item sets:
 *   - fpEliminated = name-proven ∖ id-proven  (collision FALSE-POSITIVES removed:
 *     labels the name match would prove that the id match drops)
 *   - fnRecovered  = id-proven ∖ name-proven  (import-alias FALSE-NEGATIVES
 *     recovered: labels the id match proves that the name match would miss)
 * Both sets are keyed by reached-item id (resolved symbol-id), falling back to
 * `name@filePath` for the rare id-less reached item. The scoring is factored into
 * the dependency-free pure `scoreIdVsName`/`summarizeIdVsName` (asserted by
 * test/unit/impact-pdg-id-vs-name-metrics.test.ts), exactly like
 * `summarizeBlastRadius` in blast-radius.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, parseMarkdownRows } from './blast-radius.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// `CALLEES_TRUNCATED_SENTINEL` (cfg/emit.ts) — a slice block that hit the
// per-statement site cap marks its callee set INCOMPLETE; the bridge keeps such
// reach callgraph-equal (callee-unknown) rather than under-proving.
const CALLEES_TRUNCATED_SENTINEL = '*';

function round(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function readOption(argv, name, fallback = undefined) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function fmt(value, digits = 2) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

/**
 * Proven (callgraph-bridge) items at a given depth from a `statementPreciseByDepth`
 * record. Items carry { id, name, ... }; the projection already dropped
 * unproven-bridge, so every item here is a proven label.
 */
function provenItemsAtDepth(byDepth, depth) {
  const items = byDepth?.[depth] ?? byDepth?.[String(depth)] ?? [];
  return Array.isArray(items) ? items : [];
}

/** Full depth-1 inter-procedural reach (proven + unproven) — the direct callees. */
function provGetReachedD1(pdg) {
  const byDepth = pdg?.interproceduralByDepth ?? pdg?.pdgInterprocedural?.byDepth ?? {};
  return provenItemsAtDepth(byDepth, 1);
}

/**
 * Group proven items by leaf name, counting DISTINCT symbol ids per name. A name
 * mapping to >=2 distinct ids is an ambiguous (non-discriminating) proven group:
 * the name-match proved all of them, but the slice resolves to a subset.
 */
function nameCollisionStats(provenItems) {
  const idsByName = new Map();
  for (const it of provenItems) {
    if (!it || typeof it !== 'object') continue;
    const name = typeof it.name === 'string' ? it.name : '';
    if (!name) continue;
    const id =
      typeof it.id === 'string' && it.id
        ? it.id
        : `${name}@${typeof it.filePath === 'string' ? it.filePath : '?'}`;
    let set = idsByName.get(name);
    if (!set) {
      set = new Set();
      idsByName.set(name, set);
    }
    set.add(id);
  }
  let provenLabels = 0;
  let ambiguousLabels = 0; // proven labels whose name is shared by >=2 distinct ids
  let excessLabels = 0; //   sum(count - 1) over ambiguous names = central FP estimate
  const ambiguousNames = [];
  for (const [name, ids] of idsByName) {
    const c = ids.size;
    provenLabels += c;
    if (c >= 2) {
      ambiguousLabels += c;
      excessLabels += c - 1;
      ambiguousNames.push({ name, count: c });
    }
  }
  ambiguousNames.sort((a, b) => b.count - a.count);
  return { provenLabels, ambiguousLabels, excessLabels, ambiguousNames };
}

export function summarize(cases) {
  const withProven = cases.filter((c) => c.provenLabels > 0);
  const sum = (sel) => cases.reduce((a, c) => a + sel(c), 0);
  const totalProven = sum((c) => c.provenLabels);
  const totalAmbiguous = sum((c) => c.ambiguousLabels);
  const totalExcess = sum((c) => c.excessLabels);
  const totalReachedD1 = sum((c) => c.reachedD1);
  const totalDivergent = sum((c) => c.divergentReached);
  return {
    n: cases.length,
    functionsWithProvenLabels: withProven.length,
    functionsWithAmbiguity: cases.filter((c) => c.ambiguousLabels > 0).length,
    totalProvenLabels: totalProven,
    totalAmbiguousLabels: totalAmbiguous,
    totalExcessLabels: totalExcess,
    // Upper bound on collision-FP as a fraction of all proven labels.
    ambiguityRate: totalProven > 0 ? round(totalAmbiguous / totalProven) : null,
    // Central FP estimate (assumes ~1 distinct resolved symbol per slice leaf name).
    excessRate: totalProven > 0 ? round(totalExcess / totalProven) : null,
    medianProvenPerFn: median(withProven.map((c) => c.provenLabels)),
    // FN / aliasing axis: depth-1 reached callees whose resolved name is in NO
    // block leaf of the owning function (alias/rename/dynamic) — the surface where
    // a truly-on-slice callee can never be name-proven.
    totalReachedD1,
    totalDivergentReached: totalDivergent,
    divergenceRate: totalReachedD1 > 0 ? round(totalDivergent / totalReachedD1) : null,
    functionsWithDivergence: cases.filter((c) => c.divergentReached > 0).length,
  };
}

/**
 * PURE replica of the bridge's depth-1 evidence predicate
 * (`pdgBridgeEvidenceForImpact`, pdg-impact.ts) over the SAME inputs, returning
 * the two counterfactual proven sets for ONE function's slice:
 *   - `nameProven` = what the LEAF-NAME bridge would prove,
 *   - `idProven`   = what the RESOLVED-ID bridge proves.
 *
 * The predicate (mirrored exactly so the whole-symbol / sentinel fallbacks cancel
 * on both sides and ONLY the discriminating divergence survives the diff):
 *   1. sliceCalleeNames empty            → prove ALL (whole-symbol fallback)
 *   2. sentinel ('*') in sliceCalleeNames → prove ALL (callee-unknown, capped)
 *   3a. id path  (ids present): prove iff item.id   ∈ sliceCalleeIds
 *   3b. name path (no ids):     prove iff item.name ∈ sliceCalleeNames
 * The name-counterfactual ALWAYS uses 3b at step 3 (what name-match would decide);
 * the id set uses 3a when ids are present, else 3b (graceful degrade — identical
 * to the name set on a pre-v3 index, so the diff is then structurally empty).
 *
 * `discriminating` flags the only regime where the two can differ (names present,
 * no sentinel, ids present); non-discriminating slices fall back identically and
 * contribute 0 to fpEliminated/fnRecovered by construction.
 *
 * Pure: no DB / analyze / Date / random — deterministic over plain inputs.
 */
export function bridgeProvenSets(reachedItems, sliceCalleeNames, sliceCalleeIds) {
  const names =
    sliceCalleeNames instanceof Set ? sliceCalleeNames : new Set(sliceCalleeNames ?? []);
  const ids = sliceCalleeIds instanceof Set ? sliceCalleeIds : new Set(sliceCalleeIds ?? []);
  const items = Array.isArray(reachedItems) ? reachedItems : [];
  const wholeSymbol = names.size === 0;
  const truncated = names.has(CALLEES_TRUNCATED_SENTINEL);
  const idsPresent = ids.size > 0;
  const discriminating = !wholeSymbol && !truncated && idsPresent;

  // Step 1/2: whole-symbol or sentinel ⇒ both bridges prove ALL reached items.
  // Otherwise apply the step-3 membership predicate.
  const fallbackProvesAll = wholeSymbol || truncated;
  const provenBy = (member) => (fallbackProvesAll ? [...items] : items.filter(member));

  const nameProven = provenBy((it) => typeof it?.name === 'string' && names.has(it.name));
  const idProven = provenBy((it) =>
    discriminating
      ? typeof it?.id === 'string' && ids.has(it.id)
      : typeof it?.name === 'string' && names.has(it.name),
  );
  return { nameProven, idProven, discriminating, wholeSymbol, truncated };
}

/**
 * Stable identity key for a reached/proven item. The resolved symbol id is the
 * sound key (an alias/collision shares the leaf NAME but NEVER the id); fall back
 * to `name@filePath` only for the rare id-less reached item (dynamic/unresolved),
 * mirroring `symbolSetFromByDepth` in blast-radius.mjs.
 */
export function reachedItemKey(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.id === 'string' && item.id.length > 0) return item.id;
  const name = typeof item.name === 'string' ? item.name : '(unknown)';
  const filePath = typeof item.filePath === 'string' ? item.filePath : '(unknown)';
  return `${name}@${filePath}`;
}

/** A de-duplicated key set over reached items (drops empty/unkeyable items). */
function keySetOf(items) {
  const out = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const key = reachedItemKey(it);
    if (key) out.add(key);
  }
  return out;
}

/**
 * PURE scorer (R5): diff the NAME-proven and ID-proven statement-precise sets for
 * ONE function's slice. No DB / analyze / Date / random — deterministic over plain
 * reached-item arrays so the unit test can assert the arithmetic.
 *
 *   - `fpEliminated` = |name-proven ∖ id-proven| — collision false-positives the
 *     id bridge removed (the name predicate would prove these; the id predicate
 *     drops them because their resolved id is not on the exact slice).
 *   - `fnRecovered`  = |id-proven ∖ name-proven| — import-alias false-negatives the
 *     id bridge recovered (the id predicate proves these via the resolved id even
 *     though their leaf name is absent from the slice's `callees`).
 *
 * Identical sets ⇒ both counts 0. Keys are sorted so the output is order-stable
 * regardless of input ordering (determinism).
 */
export function scoreIdVsName(nameProvenItems, idProvenItems) {
  const nameKeys = keySetOf(nameProvenItems);
  const idKeys = keySetOf(idProvenItems);
  const fpEliminatedKeys = [...nameKeys].filter((k) => !idKeys.has(k)).sort();
  const fnRecoveredKeys = [...idKeys].filter((k) => !nameKeys.has(k)).sort();
  return {
    nameProven: nameKeys.size,
    idProven: idKeys.size,
    fpEliminated: fpEliminatedKeys.length,
    fnRecovered: fnRecoveredKeys.length,
    fpEliminatedKeys,
    fnRecoveredKeys,
  };
}

/**
 * PURE aggregation over per-function `scoreIdVsName` outputs (the U8 headline).
 * Dependency-free for the deterministic unit test, mirroring `summarizeBlastRadius`.
 */
export function summarizeIdVsName(cases) {
  const sum = (sel) => cases.reduce((a, c) => a + sel(c), 0);
  const totalNameProven = sum((c) => c.nameProven ?? 0);
  const totalIdProven = sum((c) => c.idProven ?? 0);
  const totalFpEliminated = sum((c) => c.fpEliminated ?? 0);
  const totalFnRecovered = sum((c) => c.fnRecovered ?? 0);
  return {
    n: cases.length,
    totalNameProven,
    totalIdProven,
    totalFpEliminated,
    totalFnRecovered,
    functionsWithFpEliminated: cases.filter((c) => (c.fpEliminated ?? 0) > 0).length,
    functionsWithFnRecovered: cases.filter((c) => (c.fnRecovered ?? 0) > 0).length,
    functionsWithDiscriminatingSlice: cases.filter((c) => c.discriminatingSlice === true).length,
    // Fraction of name-proven labels the id bridge proved were over-attribution.
    fpEliminatedRate: totalNameProven > 0 ? round(totalFpEliminated / totalNameProven) : null,
    // Fraction of id-proven labels the name bridge would have missed (alias FN).
    fnRecoveredRate: totalIdProven > 0 ? round(totalFnRecovered / totalIdProven) : null,
  };
}

async function cypherRows(backend, repo, query) {
  const res = await backend.callTool('cypher', { repo, query });
  return parseMarkdownRows(res?.markdown);
}

/**
 * Callee NAME set AND resolved-ID set for the EXACT dependence slice (seed ∪
 * reachable blocks the impact result exposes) — exactly the `sliceCalleeNames` /
 * `sliceCalleeIds` the bridge unions over the slice (`local-backend.ts`). The
 * sentinel `'*'` (a capped block) is PRESERVED in the name set so the replica
 * predicate can take the callee-unknown fallback. This is the EXACT slice, NOT a
 * function-level proxy. Block ids carry no quotes, so the `IN [...]` literal is
 * safe (same convention as the candidate queries above). On a pre-v3 index the
 * `calleeIds` column is absent → the query errors → ids degrade to empty (the
 * bridge then name-matches, and the id-vs-name diff is structurally 0).
 */
async function sliceCalleeSetsOf(backend, repo, sliceBlockIds) {
  const names = new Set();
  const ids = new Set();
  if (!Array.isArray(sliceBlockIds) || sliceBlockIds.length === 0) return { names, ids };
  const idList = sliceBlockIds.map((id) => `'${id}'`).join(', ');
  const nameRows = await cypherRows(
    backend,
    repo,
    `MATCH (b:BasicBlock) WHERE b.id IN [${idList}] RETURN b.callees AS callees`,
  );
  for (const r of nameRows) {
    for (const n of String(r.callees ?? '').split(' ')) if (n) names.add(n);
  }
  try {
    const idRows = await cypherRows(
      backend,
      repo,
      `MATCH (b:BasicBlock) WHERE b.id IN [${idList}] RETURN b.calleeIds AS calleeIds`,
    );
    for (const r of idRows) {
      for (const i of String(r.calleeIds ?? '').split(' '))
        if (i && i !== CALLEES_TRUNCATED_SENTINEL) ids.add(i);
    }
  } catch {
    // pre-v3 index: no `calleeIds` column — leave ids empty (graceful degrade).
  }
  return { names, ids };
}

async function run() {
  const argv = process.argv.slice(2);
  const repo = readOption(argv, 'repo', 'GitNexus');
  const sample = Math.max(1, Number(readOption(argv, 'sample', '120')));
  const minBlocks = Math.max(2, Number(readOption(argv, 'min-blocks', '6')));
  const src = readOption(argv, 'src', 'gitnexus/src/');
  const depth = Math.max(1, Number(readOption(argv, 'depth', '3')));
  const limit = Math.max(1, Number(readOption(argv, 'limit', '200')));
  const json = hasFlag(argv, 'json');

  const { LocalBackend } = await import(
    path.join(REPO_ROOT, 'src', 'mcp', 'local', 'local-backend.ts')
  );
  const backend = new LocalBackend();
  const initialized = await backend.init();
  if (!initialized)
    throw new Error('no indexed repositories found; run gitnexus analyze --pdg first');

  try {
    const candidateQuery = (label) =>
      `MATCH (f:${label}) WHERE f.filePath STARTS WITH '${src}' AND f.endLine > f.startLine + 18 ` +
      `RETURN f.name AS name, f.filePath AS filePath, f.startLine AS startLine, ` +
      `f.endLine AS endLine, '${label}' AS kind`;
    let candidates = [
      ...(await cypherRows(backend, repo, candidateQuery('Function'))),
      ...(await cypherRows(backend, repo, candidateQuery('Method'))),
    ].filter((c) => c.name && /^[A-Za-z_$][\w$]*$/.test(c.name));
    const stride = Math.max(1, Math.floor(candidates.length / (sample * 3)));
    candidates = candidates.filter((_, i) => i % stride === 0);

    const cases = [];
    let degraded = 0;
    for (const c of candidates) {
      if (cases.length >= sample) break;
      const lo = Number(c.startLine);
      const hi = Number(c.endLine);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;

      const blockRows = await cypherRows(
        backend,
        repo,
        `MATCH (b:BasicBlock) WHERE b.filePath = '${c.filePath}' AND b.startLine >= ${lo} ` +
          `AND b.startLine <= ${hi + 1} RETURN b.id AS id, b.startLine AS startLine, ` +
          `b.callees AS callees ORDER BY b.startLine`,
      );
      const fnLine1b = String(lo + 1);
      const own = blockRows.filter((r) => {
        const parts = r.id.split(':');
        return parts[parts.length - 3] === fnLine1b;
      });
      // Union of all leaf call names across the function's own blocks — the
      // complete set name-matching could ever prove. A reached direct callee whose
      // resolved (definition) name is NOT in here can NEVER be name-proven: it is
      // called via an alias/rename, dynamically, or as a filtered member-read —
      // the false-negative (import-alias) surface.
      const blockLeafUnion = new Set();
      for (const r of own) {
        for (const n of String(r.callees ?? '').split(' '))
          if (n && n !== '*') blockLeafUnion.add(n);
      }
      const bodyBlocks = own.length;
      if (bodyBlocks < minBlocks) continue;
      const startLines = own
        .map((r) => Number(r.startLine))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const anchor = startLines[Math.max(1, Math.floor(bodyBlocks / 3))];
      if (!Number.isFinite(anchor)) continue;

      const pdg = await backend.callTool('impact', {
        repo,
        target: c.name,
        file_path: c.filePath,
        kind: c.kind,
        direction: 'downstream',
        maxDepth: depth,
        limit,
        includeTests: true,
        mode: 'pdg',
        line: anchor,
      });
      if (pdg?.error) continue;
      if (pdg?.pdgLayer && pdg.pdgLayer !== 'ready') {
        degraded++;
        continue;
      }
      if (pdg?.epistemic === 'pdg-no-block-at-line') continue;

      const spByDepth = pdg?.pdgInterprocedural?.statementPreciseByDepth ?? {};
      const d1 = nameCollisionStats(provenItemsAtDepth(spByDepth, 1));
      // All-depth (depth-1 firing + inherited deeper) for context only.
      const allProven = Object.keys(spByDepth).flatMap((d) =>
        provenItemsAtDepth(spByDepth, Number(d)),
      );
      const all = nameCollisionStats(allProven);

      // FN / aliasing axis: depth-1 reached direct callees (proven + unproven)
      // whose resolved name is absent from EVERY block leaf of the function — so
      // name-matching can never prove them even if they are on the slice.
      const reachedD1 = provGetReachedD1(pdg);
      let reachedD1Names = 0;
      let divergentReached = 0;
      const seenReached = new Set();
      for (const it of reachedD1) {
        const nm = it && typeof it.name === 'string' ? it.name : '';
        const id = it && typeof it.id === 'string' ? it.id : `${nm}@?`;
        if (!nm || seenReached.has(id)) continue;
        seenReached.add(id);
        reachedD1Names += 1;
        if (!blockLeafUnion.has(nm)) divergentReached += 1;
      }

      // ── U8 realized id-vs-name diff on the EXACT slice ──────────────────────
      // Both proven sets are computed by the SAME bridge predicate replica
      // (`bridgeProvenSets`) over the depth-1 reached callees and the EXACT
      // seed∪reachable slice's `callees`/`calleeIds` — so the whole-symbol and
      // sentinel fallbacks (which prove ALL reached items identically on both
      // sides) cancel, and only the discriminating divergence survives:
      //   fpEliminated = name-proven ∖ id-proven  (collision FP removed),
      //   fnRecovered  = id-proven ∖ name-proven  (import-alias FN recovered).
      // On a pre-v3 index `calleeIds` is absent → the id set == the name set →
      // both diffs are structurally 0 (the honest degraded reading).
      const exactSlice = [
        ...(Array.isArray(pdg?.seedBlocks) ? pdg.seedBlocks : []),
        ...(Array.isArray(pdg?.reachableBlocks) ? pdg.reachableBlocks : []),
      ];
      const { names: sliceCalleeNames, ids: sliceCalleeIds } = await sliceCalleeSetsOf(
        backend,
        repo,
        exactSlice,
      );
      const proven = bridgeProvenSets(reachedD1, sliceCalleeNames, sliceCalleeIds);
      const idVsName = scoreIdVsName(proven.nameProven, proven.idProven);

      cases.push({
        name: c.name,
        kind: c.kind,
        file: c.filePath,
        anchor,
        sliceBlocks: pdg?.affectedStatementCount ?? 0,
        statementPrecision:
          typeof pdg?.pdgInterprocedural?.statementPrecision === 'number'
            ? round(pdg.pdgInterprocedural.statementPrecision)
            : null,
        // headline = depth 1 (where name-matching actually fires)
        provenLabels: d1.provenLabels,
        ambiguousLabels: d1.ambiguousLabels,
        excessLabels: d1.excessLabels,
        topAmbiguous: d1.ambiguousNames.slice(0, 4),
        allDepthProven: all.provenLabels,
        allDepthAmbiguous: all.ambiguousLabels,
        reachedD1: reachedD1Names,
        divergentReached,
        // U8 exact-slice id-vs-name diff
        nameProven: idVsName.nameProven,
        idProven: idVsName.idProven,
        fpEliminated: idVsName.fpEliminated,
        fnRecovered: idVsName.fnRecovered,
        fpEliminatedKeys: idVsName.fpEliminatedKeys,
        fnRecoveredKeys: idVsName.fnRecoveredKeys,
        // True only when names present, no sentinel, and ids present — the regime
        // where the id and name bridges can diverge (else both whole-symbol/name
        // fall back identically). Lets the summary confirm the diff is concentrated
        // on discriminating slices, not a fallback artifact.
        discriminatingSlice: proven.discriminating,
      });
    }

    const summary = summarize(cases);
    const idVsNameSummary = summarizeIdVsName(cases);
    const report = {
      repo,
      direction: 'downstream',
      sample: cases.length,
      minBlocks,
      degradedSkipped: degraded,
      generatedAt: new Date().toISOString(),
      note:
        'Realized name-collision probe (depth 1). ambiguousLabels = proven labels whose ' +
        'leaf name is shared by >=2 distinct reached symbol-ids — an UPPER BOUND on ' +
        'collision false-positives (complete: every collision-FP is such a label). ' +
        'excessLabels = sum(count-1) per ambiguous name = central FP estimate. U8 ' +
        'idVsName diffs the EXACT-slice name-proven vs id-proven sets: fpEliminated = ' +
        'realized collision FP the id bridge removes; fnRecovered = realized alias FN it ' +
        'recovers. On a v3+ (calleeIds) index ambiguityRate should collapse to ~0.',
      summary,
      idVsName: idVsNameSummary,
      cases,
    };

    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    const s = summary;
    const lines = [];
    lines.push('=== impact-PDG realized name-collision probe (depth 1) ===');
    lines.push(`repo ${repo} | downstream | functions ${cases.length} | minBlocks ${minBlocks}`);
    lines.push('');
    lines.push(
      `Proven labels: ${s.totalProvenLabels} across ${s.functionsWithProvenLabels} functions ` +
        `(median ${s.medianProvenPerFn}/fn).`,
    );
    lines.push(
      `Name-ambiguous proven labels (UPPER BOUND on collision-FP): ${s.totalAmbiguousLabels} ` +
        `(${fmt((s.ambiguityRate ?? 0) * 100, 1)}% of proven), in ${s.functionsWithAmbiguity}/` +
        `${cases.length} functions.`,
    );
    lines.push(
      `Excess proven labels (central FP estimate, sum(count-1)): ${s.totalExcessLabels} ` +
        `(${fmt((s.excessRate ?? 0) * 100, 1)}% of proven).`,
    );
    lines.push(
      `FN / aliasing surface: ${s.totalDivergentReached}/${s.totalReachedD1} depth-1 reached ` +
        `callees (${fmt((s.divergenceRate ?? 0) * 100, 1)}%) have a resolved name absent from ` +
        `every block leaf (alias/rename/dynamic), in ${s.functionsWithDivergence}/${cases.length} ` +
        `functions — name-matching can never prove these.`,
    );
    lines.push('');
    const v = idVsNameSummary;
    lines.push('--- U8 realized id-vs-name diff (exact seed∪reachable slice) ---');
    lines.push(
      `Name-proven labels: ${v.totalNameProven} | id-proven labels: ${v.totalIdProven} ` +
        `(across ${v.n} functions; ${v.functionsWithDiscriminatingSlice} have a discriminating ` +
        `slice where the two bridges can diverge).`,
    );
    lines.push(
      `fpEliminated (collision FP the id bridge REMOVES, name∖id): ${v.totalFpEliminated} ` +
        `(${fmt((v.fpEliminatedRate ?? 0) * 100, 1)}% of name-proven), in ` +
        `${v.functionsWithFpEliminated}/${cases.length} functions.`,
    );
    lines.push(
      `fnRecovered (alias FN the id bridge RECOVERS, id∖name): ${v.totalFnRecovered} ` +
        `(${fmt((v.fnRecoveredRate ?? 0) * 100, 1)}% of id-proven), in ` +
        `${v.functionsWithFnRecovered}/${cases.length} functions.`,
    );
    lines.push('');
    lines.push(
      'Interpretation: ambiguityRate is the fraction of statement-precise proven labels the ' +
        'NAME match cannot disambiguate (>=2 reached callees share the leaf name). On a v3+ ' +
        'index it collapses to ~0 because the id bridge already discriminates same-named ' +
        'callees — that ~0 is itself proof. fpEliminated is the REALIZED collision FP the id ' +
        'bridge proved away on these exact slices; fnRecovered is the realized import-alias FN ' +
        'it recovered. On a pre-v3 index (no calleeIds) both are 0 (id set == name set).',
    );
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await backend.dispose().catch(() => {});
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`[impact-pdg-name-collision] ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
