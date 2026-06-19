/**
 * Pure scorer + annotation canonicalizer for the impact-PDG accuracy harness
 * (U7). NO substrate here — no `runPipelineFromRepo`, no `LocalBackend`, no DB,
 * no child-process `analyze`. Everything in this module is a pure function over
 * plain symbol-set inputs, so the metric-math unit test
 * (`test/unit/impact-pdg-metric-math.test.ts`) can import and assert the
 * arithmetic deterministically, staying OUT of the flaky full-pipeline lane
 * (Arch-review Issue 5). `measure.mjs` imports these for the live loop.
 *
 * ── CIS / AIS framing (KTD9 — Arnold–Bohner) ───────────────────────────────
 * CIS = Computed Impact Set: what a mode REPORTS as impacted.
 * AIS = Actual Impact Set: the curated ground-truth set truly affected.
 *   precision = |AIS∩CIS| / |CIS|   (over-approximation cost; ∅ CIS ⇒ undefined)
 *   recall    = |AIS∩CIS| / |AIS|   (under-approximation; ∅ AIS ⇒ undefined)
 *   F1        = harmonic mean        (undefined if either is undefined)
 *   FPIS = CIS − AIS  (false positives — noise)
 *   FNIS = AIS − CIS  (false negatives — the DANGEROUS miss for a safety tool)
 *
 * ── Granularity: the two engines measure DIFFERENT scopes (U7 rework) ───────
 * The two `impact` engines answer different questions at different granularities,
 * so they are scored against different ground truths:
 *
 *  - **PDG mode** (`impact({mode:'pdg', line:N})`) is scored at intra-procedural
 *    STATEMENT granularity. The statement-anchored slice returns
 *    `affectedStatements: {line,filePath,text}[]` — the dependent statements of
 *    the criterion line N. CIS_pdg is the set of those LINE keys
 *    (`<filePath>:<line>`, via `pdgLineCis`); AIS is the `intra_AIS` line set
 *    (via `intraLineAis`). This is the unit at which PDG is precise.
 *  - **Call-graph mode** is scored at inter-procedural SYMBOL granularity. CIS is
 *    the reported symbols (`<symbol>@<filePath>`, via `symbolKey`); AIS is the
 *    `inter_AIS` symbol set (via `aisByScope`). This is the unit at which the
 *    call-graph blast radius is meaningful.
 *
 * Neither native row is a strict refinement of the other: the PDG native
 * metric resolves dependent statements WITHIN a function, while call-graph
 * resolves cross-function symbol reach. The unified axes report checks whether
 * mode:'pdg' carries both outputs without blending their granularities.
 *
 * `partitionCisByScope`/`aisByScope` (symbol-level) remain for the call-graph
 * path; `pdgLineCis`/`intraLineAis` (line-level) drive the PDG path.
 */

/** Order-independent symbol key. Collapses statement lines onto their symbol. */
export function symbolKey(symbol, filePath) {
  return `${symbol}@${filePath}`;
}

/**
 * Statement-LINE key for the PDG path (U7 rework). PDG mode is now scored at
 * intra-procedural STATEMENT granularity: the `impact({mode:'pdg', line})` slice
 * returns `affectedStatements: {line, filePath, text}[]`, and the intra ground
 * truth is the per-line `intra_AIS`. A line key is `<filePath>:<line>` —
 * order-independent and statement-granular (NOT collapsed onto the owning
 * symbol the way `symbolKey` is). This is the unit at which PDG is precise.
 */
export function lineKey(filePath, line) {
  return `${filePath}:${line}`;
}

/**
 * Unified-impact key spaces keep the two granularities explicit. A tagged key
 * is never compared across axes: `statement:src/a.ts:10` and
 * `symbol:handler@src/a.ts` are different measurement units by design.
 */
export function unifiedLineKey(filePath, line) {
  return `statement:${lineKey(filePath, line)}`;
}

export function unifiedSymbolKey(symbol, filePath) {
  return `symbol:${symbolKey(symbol, filePath)}`;
}

/**
 * CIS_pdg = the set of affected-statement LINE keys from an impact pdg result.
 *
 * `scope` (FU-A) ∈ `undefined | 'intra' | 'inter'`:
 *   - `undefined` → the all-union over the full slice (back-compat; the
 *     metric-math unit test and the U2 mutation-oracle rely on this form).
 *   - `'intra'` / `'inter'` → keep only statements carrying that `scope` tag, so
 *     U1's cross-function reach stops landing on the intra-line axis as FPIS.
 */
export function pdgLineCis(affectedStatements, scope) {
  const out = new Set();
  for (const s of affectedStatements ?? []) {
    if (scope !== undefined && s?.scope !== scope) continue;
    if (s && typeof s.line === 'number' && typeof s.filePath === 'string') {
      out.add(lineKey(s.filePath, s.line));
    }
  }
  return out;
}

/** AIS_intra = the set of `intra_AIS` LINE keys (statement-granular ground truth). */
export function intraLineAis(gt) {
  const out = new Set();
  for (const e of gt.intra_AIS ?? []) {
    if (e && typeof e.line === 'number' && typeof e.filePath === 'string') {
      out.add(lineKey(e.filePath, e.line));
    }
  }
  return out;
}

/** Unified AIS = two explicit axes, never one blended line+symbol set. */
export function unifiedAis(gt) {
  const intraLine = new Set();
  for (const e of gt.intra_AIS ?? []) {
    if (e && typeof e.line === 'number' && typeof e.filePath === 'string') {
      intraLine.add(unifiedLineKey(e.filePath, e.line));
    }
  }

  const interSymbol = new Set();
  for (const e of gt.inter_AIS ?? []) {
    if (e && typeof e.symbol === 'string' && typeof e.filePath === 'string') {
      interSymbol.add(unifiedSymbolKey(e.symbol, e.filePath));
    }
  }

  return { intraLine, interSymbol };
}

/** Canonicalize an iterable of {symbol,filePath} (or pre-made keys) → a Set. */
export function toKeySet(entries) {
  const out = new Set();
  for (const e of entries) {
    if (typeof e === 'string') out.add(e);
    else out.add(symbolKey(e.symbol, e.filePath));
  }
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n++;
  return n;
}

/** a − b as a sorted array of keys. */
export function difference(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}

/**
 * Core CIS-vs-AIS scorer. `cis` / `ais` are Sets of canonical symbol keys.
 *
 * Empty-denominator semantics are EXPLICIT (not silently 0 or 1):
 *  - |CIS|=0 ⇒ precision = null (no predictions to be right/wrong about).
 *  - |AIS|=0 ⇒ recall    = null (nothing to find — this scope has no truth).
 *  - F1 = null whenever precision or recall is null OR both are 0.
 * A null metric is REPORTED as `n/a`, never averaged in as 0 — collapsing it to
 * 0 would punish a mode for a scope that simply has no ground truth (the
 * apples-to-oranges trap, R1).
 */
export function score(cis, ais) {
  const tp = intersectionSize(cis, ais);
  const precision = cis.size === 0 ? null : tp / cis.size;
  const recall = ais.size === 0 ? null : tp / ais.size;
  let f1 = null;
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1 = (2 * precision * recall) / (precision + recall);
  }
  return {
    tp,
    cisSize: cis.size,
    aisSize: ais.size,
    precision,
    recall,
    f1,
    fpis: difference(cis, ais), // CIS − AIS (noise / over-approx)
    fnis: difference(ais, cis), // AIS − CIS (missed / under-approx)
    fpisCount: cis.size - tp,
    fnisCount: ais.size - tp,
    // |CIS|/|AIS| size ratio (>1 over-approximates, <1 under). null if |AIS|=0.
    cisAisRatio: ais.size === 0 ? null : cis.size / ais.size,
  };
}

/**
 * Cross-mode comparison of two CIS sets against a shared AIS (KTD9 set-diffs).
 * Jaccard(callgraph_CIS, pdg_CIS) + directional set-diffs, each split into
 * `true` (∩AIS — a real find the other mode missed) vs `noise` (−AIS — a false
 * positive the other mode avoided).
 */
export function compareModes(callgraphCis, pdgCis, ais) {
  const union = new Set([...callgraphCis, ...pdgCis]);
  const inter = intersectionSize(callgraphCis, pdgCis);
  const jaccard = union.size === 0 ? null : inter / union.size;

  const pdgOnly = difference(pdgCis, callgraphCis);
  const callgraphOnly = difference(callgraphCis, pdgCis);
  const splitByAis = (keys) => {
    const trueFinds = keys.filter((k) => ais.has(k)).sort();
    const noise = keys.filter((k) => !ais.has(k)).sort();
    return { all: keys, true: trueFinds, noise };
  };
  return {
    jaccard,
    intersectionSize: inter,
    unionSize: union.size,
    pdgOnly: splitByAis(pdgOnly),
    callgraphOnly: splitByAis(callgraphOnly),
  };
}

/**
 * Aggregate per-case scores for ONE (mode, scope) into a corpus row. Averaging
 * follows KTD9 "per change, averaged over the corpus": a case with a null metric
 * (e.g. |CIS|=0 precision) is EXCLUDED from that metric's mean (counted in
 * `nMetric`), never folded in as 0. The macro-average is over the cases that
 * actually have the metric defined; `nCases` records the stratum size for the
 * underpowered-corpus floor (F3).
 */
export function aggregate(perCaseScores) {
  const avg = (sel) => {
    const xs = perCaseScores.map(sel).filter((v) => v !== null && v !== undefined);
    if (xs.length === 0) return { mean: null, n: 0 };
    return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
  };
  const p = avg((s) => s.precision);
  const r = avg((s) => s.recall);
  const f = avg((s) => s.f1);
  const ratio = avg((s) => s.cisAisRatio);
  return {
    nCases: perCaseScores.length,
    precision: p.mean,
    nPrecision: p.n,
    recall: r.mean,
    nRecall: r.n,
    f1: f.mean,
    nF1: f.n,
    cisAisRatio: ratio.mean,
    // Summed FPIS/FNIS counts over the stratum (totals, not means) — the
    // absolute over/under-approximation volume.
    fpis: perCaseScores.reduce((a, s) => a + (s.fpisCount ?? 0), 0),
    fnis: perCaseScores.reduce((a, s) => a + (s.fnisCount ?? 0), 0),
  };
}

/**
 * Partition a mode's reported CIS keys into per-scope sub-CIS, given the
 * criterion's own symbol key. INTRA = the criterion symbol itself (the only
 * symbol whose blocks/edges are intra-procedural); INTER = every OTHER reported
 * symbol (callees / cross-function reach). `unresolved` shadow entries (id null,
 * surfaced under a file) are kept in INTER — they are non-criterion reach the
 * mode could not attribute to a named symbol, and dropping them would hide a
 * recall fact (R9). MIXED scope unions both.
 */
export function partitionCisByScope(cisKeys, criterionKey) {
  const intra = new Set();
  const inter = new Set();
  for (const k of cisKeys) {
    if (k === criterionKey) intra.add(k);
    else inter.add(k);
  }
  return { intra, inter, mixed: new Set([...intra, ...inter]) };
}

/**
 * Build the scope-appropriate AIS key sets from a ground-truth record.
 *  - intra: the criterion symbol itself (intra_AIS lines collapse onto it). A
 *    case with a non-empty intra_AIS contributes {criterion}; an empty intra_AIS
 *    contributes ∅ (no intra truth → recall n/a, not 0).
 *  - inter: the distinct callee symbols named in inter_AIS.
 *  - mixed: the union.
 * Keys are `<symbol>@<filePath>` with paths normalised to the criterion's path
 * style (the fixture annotations and the analyzer both use repo-relative
 * `src/...` paths, so no rewrite is needed — asserted by Step 0).
 */
export function aisByScope(gt) {
  const critKey = symbolKey(gt.criterion.name, gt.criterion.filePath);
  const intra = new Set();
  if (Array.isArray(gt.intra_AIS) && gt.intra_AIS.length > 0) intra.add(critKey);
  const inter = toKeySet(
    (gt.inter_AIS ?? []).map((e) => ({ symbol: e.symbol, filePath: e.filePath })),
  );
  return { criterionKey: critKey, intra, inter, mixed: new Set([...intra, ...inter]) };
}

const tagSymbolKeys = (keys) => new Set([...keys].map((k) => `symbol:${k}`));
const tagLineKeys = (keys) => new Set([...keys].map((k) => `statement:${k}`));

/**
 * Current callgraph unified CIS: inter-symbol axis only. The seed/criterion
 * symbol is filtered because `inter_AIS` is cross-function by construction.
 */
export function callgraphUnifiedCis(gt, symbolCisKeys) {
  const { criterionKey } = aisByScope(gt);
  const inter = new Set([...symbolCisKeys].filter((k) => k !== criterionKey));
  return { intraLine: new Set(), interSymbol: tagSymbolKeys(inter) };
}

/**
 * Unified PDG CIS: statement axis from affectedStatements plus, once runtime
 * mode:'pdg' composes interprocedural reach, symbol axis from byDepth. The
 * criterion symbol is filtered because inter_AIS is cross-function by
 * construction. Passing only lineCisKeys preserves the old intra-only shape for
 * focused metric tests.
 */
export function pdgUnifiedCis(lineCisKeys, symbolCisKeys = new Set(), gt = null) {
  const { criterionKey } = gt ? aisByScope(gt) : { criterionKey: null };
  const inter = criterionKey
    ? new Set([...symbolCisKeys].filter((k) => k !== criterionKey))
    : new Set(symbolCisKeys);
  return { intraLine: tagLineKeys(lineCisKeys), interSymbol: tagSymbolKeys(inter) };
}

/** Evaluation-only composed baseline: callgraph inter-symbol + PDG intra-line. */
export function composeUnifiedCis(...parts) {
  const intraLine = new Set();
  const interSymbol = new Set();
  for (const part of parts) {
    for (const k of part.intraLine ?? []) intraLine.add(k);
    for (const k of part.interSymbol ?? []) interSymbol.add(k);
  }
  return { intraLine, interSymbol };
}

/** Score one engine/candidate against unified AIS without blending axes. */
export function scoreUnifiedAxes(cis, ais) {
  return {
    intraLine: score(cis.intraLine ?? new Set(), ais.intraLine ?? new Set()),
    interSymbol: score(cis.interSymbol ?? new Set(), ais.interSymbol ?? new Set()),
  };
}

export function aggregateUnifiedScores(perCaseScores) {
  const intraLine = aggregate(perCaseScores.map((s) => s.intraLine));
  const interSymbol = aggregate(perCaseScores.map((s) => s.interSymbol));
  const definedRecalls = [intraLine.recall, interSymbol.recall].filter(
    (v) => v !== null && v !== undefined,
  );
  return {
    intraLine,
    interSymbol,
    minRecall: definedRecalls.length ? Math.min(...definedRecalls) : null,
    fpis: (intraLine.fpis ?? 0) + (interSymbol.fpis ?? 0),
    fnis: (intraLine.fnis ?? 0) + (interSymbol.fnis ?? 0),
  };
}

/**
 * Order-independent annotation-set fingerprint (KTD10). Mirrors the
 * bench/cfg/measure.mjs canonicalization TECHNIQUE (sort every collection,
 * stringify deterministically, hash) — but is annotation-set-shaped and written
 * here, NOT a literal import of `canonicalizeCfg`. Any unreviewed edit to a
 * ground-truth.json (criterion, AIS membership, locus, direction, edge kinds)
 * changes the digest, tripping a `--check` gate distinct from the F1 band.
 *
 * `hash` is injected (node:crypto in the harness; a stub in the unit test) so
 * this module pulls no node-only deps that would complicate the test import.
 */
export function canonicalizeAnnotationSet(fixtures) {
  const canonAis = (entries) =>
    (entries ?? [])
      .map((e) => `${e.symbol}|${e.filePath}|${e.line ?? '-'}`)
      .sort()
      .join(';');
  // U9 resolved-id soundness block (optional): the expected id-proven set, the
  // name-match over-attribution set, and the eliminated collision id(s). It is
  // part of the ground truth — an unreviewed edit changes the gate, so it MUST
  // trip the fingerprint. Sorted so the digest is order-independent; absent on
  // fixtures without an `idBridge` block (canonicalized as `-`).
  const canonIdBridge = (b) => {
    const sorted = (xs) => [...(xs ?? [])].sort().join(',');
    return b
      ? `${b.seedLine ?? '-'}|${sorted(b.idProven)}|${sorted(b.nameWouldProve)}|${sorted(b.fpEliminated)}`
      : '-';
  };
  const lines = fixtures
    .map((fx) => {
      const c = fx.gt.criterion;
      const kinds = Array.isArray(c.pdgEdgeKinds) ? [...c.pdgEdgeKinds].sort().join(',') : '-';
      // `line` is the criterion's 1-based statement anchor (U7 — the seed of the
      // statement-anchored PDG slice). It is part of the ground truth: changing
      // which statement the slice seeds on changes the measured PDG impact set,
      // so an unreviewed `criterion.line` edit MUST trip the fingerprint gate.
      return [
        `case=${fx.name}`,
        `schema=${fx.gt.schemaVersion}`,
        `crit=${c.name}|${c.filePath}|${c.direction}|${c.line ?? '-'}|${c.marker ?? '-'}|${kinds}`,
        `locus=${fx.gt.locus}`,
        `pdgScoring=${fx.gt.pdgScoring ?? '-'}`,
        `provenance=${fx.gt.provenance}`,
        `intra=${canonAis(fx.gt.intra_AIS)}`,
        `inter=${canonAis(fx.gt.inter_AIS)}`,
        `idBridge=${canonIdBridge(fx.gt.idBridge)}`,
      ].join('\n');
    })
    .sort()
    .join('\n====\n');
  return lines;
}

/** SHA-256 the canonical string with an injected hashing function. */
export function fingerprintAnnotationSet(fixtures, sha256Hex) {
  return sha256Hex(canonicalizeAnnotationSet(fixtures));
}

// ── U2: mutation/dynamic-oracle PURE scorers (dependency-free, unit-testable) ─
//
// `behavioralAis` (B) is the dynamic forward slice the oracle PROVED by value-diff;
// `slice` is the SAME live static PDG slice the F1 metric scores (pdgLineCis of
// `affectedStatements`); `manualAis` (M) is the manual `intra_AIS` line set. All
// three are plain string Sets of `<filePath>:<line>` keys. These functions are
// pure math over those sets, so `test/unit/impact-pdg-metric-math.test.ts` asserts
// them deterministically (no DB / analyze / Babel / random).

/**
 * mutation_recall = |B ∩ slice| / |B|. A recall < 1.0 means B ∖ slice is a
 * statement the dynamic oracle PROVED depends on the criterion that the static
 * slice MISSED — a real recall hole (or a known U1 ascent gap). |B|=0 ⇒ recall
 * is `null` (the oracle proved nothing to find — equivalent mutants only, or an
 * oracle-excluded fixture), never 0. `missing` = B ∖ slice (the dangerous miss),
 * `extra` = slice ∖ B (sound static over-approximation; reported, NOT gated).
 */
export function mutationRecall(behavioralAis, slice) {
  const B = behavioralAis instanceof Set ? behavioralAis : new Set(behavioralAis);
  const S = slice instanceof Set ? slice : new Set(slice);
  const tp = intersectionSize(B, S);
  const recall = B.size === 0 ? null : tp / B.size;
  return {
    recall,
    bSize: B.size,
    sliceSize: S.size,
    intersection: tp,
    missing: difference(B, S), // B ∖ slice — recall hole (sorted)
    extra: difference(S, B), // slice ∖ B — sound over-approximation (informational)
  };
}

/**
 * Circularity cross-check: B ∖ M. A NON-EMPTY result means the manual annotation
 * MISSED a real dependence the dynamic oracle proved — the headline independent
 * evidence U2 exists to produce. Reported as a WARN with the specific lines; it
 * is NOT a failure (the corpus documents annotation incompleteness as threat #1).
 * `confirmed` = B ∩ M (the manual lines the oracle independently re-derived).
 */
export function circularityDiff(behavioralAis, manualAis) {
  const B = behavioralAis instanceof Set ? behavioralAis : new Set(behavioralAis);
  const M = manualAis instanceof Set ? manualAis : new Set(manualAis);
  return {
    beyondManual: difference(B, M), // B ∖ M — manual missed these (WARN)
    confirmed: [...B].filter((k) => M.has(k)).sort(), // B ∩ M
    manualOnly: difference(M, B), // M ∖ B — manual claimed, oracle did not prove
  };
}

/**
 * A mutant is EQUIVALENT iff its behavioral AIS is empty (it changed no observed
 * value at any non-criterion line on any input). Equivalent mutants are discarded
 * from the union (they carry no dependence signal). Accepts the oracle's per-mutant
 * `{ diffLines }` record or a bare line array/Set.
 */
export function isEquivalentMutant(behavioralAis) {
  const lines = Array.isArray(behavioralAis?.diffLines) ? behavioralAis.diffLines : behavioralAis;
  const set = lines instanceof Set ? lines : new Set(lines ?? []);
  return set.size === 0;
}

/**
 * Order-independent canonical string over the mutation-oracle output set (one
 * entry per fixture: criterion key + sorted behavioral AIS + sorted non-equivalent
 * mutant ops). Mirrors the annotation-fingerprint TECHNIQUE so a CHANGE in what the
 * oracle proves is detectable. `hash` is injected (node:crypto in the harness; a
 * stub in the unit test) so this module pulls no node-only deps.
 */
export function canonicalizeMutationSet(perFixture) {
  return perFixture
    .map((f) => {
      const ais = [...(f.behavioralAis ?? [])].sort().join(',');
      const ops = [...(f.mutants ?? [])]
        .filter((m) => !isEquivalentMutant(m))
        .map((m) => m.op)
        .sort()
        .join(',');
      return [`case=${f.name}`, `crit=${f.criterionKey ?? '-'}`, `ais=${ais}`, `ops=${ops}`].join(
        '\n',
      );
    })
    .sort()
    .join('\n====\n');
}

export function fingerprintMutationSet(perFixture, sha256Hex) {
  return sha256Hex(canonicalizeMutationSet(perFixture));
}

/** median of a numeric array (substrate-stability gate, F5). */
export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
