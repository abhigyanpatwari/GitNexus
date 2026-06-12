/**
 * scripts/flow-fate.ts — WI-4 (#170 delta + flow-fate analysis)
 *
 * Quantifies PR #170's index-shape delta and explains the 266→167
 * flow drop with a decomposed, evidence-based verdict.
 *
 * Two pieces of contract (per docs/designs/159-mode-c-measurement.md
 * §Contracts and docs/plans/159-mode-c-measurement.md §WI-4):
 *
 *  1. `classifyFlowFates(before, after): FateReport` — PURE.
 *     Match key is `(entryPointId, terminalId)` (NEVER label —
 *     label is display-only and heuristic). Fates are one of
 *     `stable` | `label-changed` | `removed` | `added`. Emits
 *     `entryPointCandidatesBefore/After` (entry-point score > 0
 *     count) and `entryPointsFound` (delta) for the entry-point
 *     hypothesis verdict. The classifier is the testable unit; the
 *     orchestration around it is the CLI entry.
 *
 *  2. CLI `main()` — orchestrates the delta: emits
 *     `{FateReport, delta, sample, verdict}` JSON; writes a
 *     deterministic filename `<out>/<before-basename>-vs-<after-basename>-flow-fate.json`;
 *     missing `--before` dir → non-zero exit, no partial output
 *     (per WI-4 invariant + KD-6 / halt contract).
 *
 * Read-only contract (KD-8 / I-2): this module MUST NOT statically
 * reach for `initLbug`, `executeQuery`, `addNode`, or
 * `addRelationship`. The unit test `no-write-invariant` block in
 * `flow-fate.test.ts` pins this (mirrors the WI-1b/1c pattern).
 *
 * No `--json` / `--seed` flags on the production `verify` CLI
 * (KD-1) — programmatic invocation only.
 */

// ─── Public types ──────────────────────────────────────────────────────

/** The pre-#170 baseline SHA enforced by I-7. The campaign's
 *  `--before` clone MUST be checked out at this commit (or an
 *  operator-overridden SHA via `--expected-before-sha`); a
 *  mismatch aborts with `FlowFateHaltError` exit 4 before any
 *  artifact is written. The constant lives in source so the
 *  default SHA is greppable + testable. */
export const EXPECTED_BEFORE_SHA = '438600e182c2078f571b209670b5bf4dfb544a7c';

/** Minimal Process-node shape consumed by the pure classifier.
 *  Only the fields the fates taxonomy needs: the `id`, the
 *  `label` (for label-changed detection), and the match key
 *  `(entryPointId, terminalId)`. Mirrors the `ProcessNode`
 *  interface in `src/core/ingestion/process-processor.ts:42-52`. */
export interface ProcessNode {
  id: string;
  label: string;
  /** Entry-point node id — the FIRST node in the trace. */
  entryPointId: string;
  /** Terminal node id — the LAST node in the trace. */
  terminalId: string;
  /** Optional: a marker for "is this a candidate entry point
   *  (score > 0)?" — fed by the CLI side (the CLI runs a separate
   *  `MATCH (n:Function|Method)`-style query to derive it). The
   *  pure classifier only USES it to emit the
   *  `entryPointCandidatesBefore/After` counts. When absent, the
   *  classifier treats it as `false`. */
  isEntryPointCandidate?: boolean;
}

/** The match key per KD-6: `(entryPointId, terminalId)`. */
export type FlowKey = `${string}::${string}`;

/** A fate assigned to a single process. */
export type FlowFate = 'stable' | 'label-changed' | 'removed' | 'added';

/** One row of the per-flow fate table. */
export interface FlowFateRow {
  /** The match key `(entryPointId, terminalId)`. */
  key: FlowKey;
  fate: FlowFate;
  /** The `id` in the `before` index (when present). */
  beforeId?: string;
  /** The `id` in the `after` index (when present). */
  afterId?: string;
  /** Label in `before` (when present). */
  beforeLabel?: string;
  /** Label in `after` (when present). */
  afterLabel?: string;
}

/** The full classification result.
 *  `key` is `(entryPointId, terminalId)` (KD-6).
 *  `fates` maps the key to its assigned fate. */
export interface FateReport {
  /** Counts per fate (4 entries, all >= 0). */
  counts: Record<FlowFate, number>;
  /** Per-key fate rows — the full per-flow table (NOT the
   *  truncated 10-flow sample; the CLI renders the sample
   *  separately). */
  rows: FlowFateRow[];
  /** Number of `before` processes whose `isEntryPointCandidate`
   *  is truthy. Emitted even when the classifier is invoked with
   *  arrays that omit the flag (in that case it falls back to
   *  `0` and the verdict annotates "no candidate info
   *  available"). */
  entryPointCandidatesBefore: number;
  /** Same for `after`. */
  entryPointCandidatesAfter: number;
  /** When set, captures the cypher-dispatch error from the
   *  `deriveEntryPointCandidateIds` query on the `before` or
   *  `after` side. Distinct from `entryPointCandidatesBefore
   *  === 0`: a `0` count with no `entryPointQueryError` is a
   *  legitimate "no candidates" answer (legacy index); a `0`
   *  count WITH this field set is a cypher-dispatch failure
   *  (the classifier received an empty candidate set because
   *  the query threw, not because the table is empty). The
   *  verdict annotation distinguishes the two so the operator
   *  does not misread "counts below are not comparable". Set
   *  in `loadProcessNodes` from `error.message` (coerced to
   *  string for non-Error throws). Undefined on the happy
   *  path. */
  entryPointQueryError?: string;
  /** `after - before`. Positive means MORE candidates after #170,
   *  negative means FEWER (the post-#170 index found fewer
   *  entry-point-eligible functions). */
  entryPointsFound: number;
  /** The list of keys present in BOTH sides with different labels
   *  — kept as a separate array for the CLI's 10-flow sample
   *  rendering (the CLI may sample from `labelChanged` for the
   *  "label delta" line). */
  labelChangedKeys: FlowKey[];
  /** Total keys in `before`, total in `after`, and the
   *  intersection count. Useful for the entry-point hypothesis
   *  verdict (KD-6: decomposed, never single-cause). */
  totals: {
    before: number;
    after: number;
    intersection: number;
  };
}

// ─── Pure classifier ───────────────────────────────────────────────────

/**
 * Classify flow fates between two Process-node snapshots. Pure
 * with respect to its inputs — the same `(before, after)` pair
 * always yields the same `FateReport` (referential transparency;
 * the function has no side effects and no time/randomness).
 *
 * Match key is `(entryPointId, terminalId)` per KD-6 — labels
 * are display-only and heuristic, so two flows with the same
 * entry/terminal but different labels are `label-changed`, not
 * `removed` + `added`. Two flows with different entry/terminal
 * keys but the same label are independent: one is `removed`, the
 * other is `added` (the label is not the match key).
 *
 * Duplicate keys within `before` or `after` are kept as separate
 * rows (the `rows` array preserves the input order). The
 * `counts` is the *number of keys assigned to each fate*, where
 * a key present in BOTH sides counts once (as `stable` or
 * `label-changed`); a key present in only ONE side counts once
 * (as `added` or `removed`). This matches the contract in the
 * design doc.
 *
 * Empty input cases:
 *  - both empty → all-zero report, no crash.
 *  - empty `before`, non-empty `after` → all `after` keys are
 *    `added`.
 *  - non-empty `before`, empty `after` → all `before` keys are
 *    `removed`.
 *
 * @param before Process nodes from the `before` index.
 * @param after  Process nodes from the `after` index.
 */
export function classifyFlowFates(
  before: ProcessNode[],
  after: ProcessNode[],
): FateReport {
  // ── 1) Build per-side match-key maps (preserves first-occurrence
  //    order for the row table). For duplicate keys we keep the
  //    FIRST occurrence's `id` / `label` in the row; subsequent
  //    duplicates with the same key collapse onto the same row
  //    (they share the same fate). This is consistent with the
  //    design intent: the match key is the identity, not the
  //    process `id`. ──────────────────────────────────────────────
  const beforeMap = new Map<FlowKey, { id: string; label: string; isEntryPointCandidate?: boolean }>();
  const afterMap = new Map<FlowKey, { id: string; label: string; isEntryPointCandidate?: boolean }>();
  const beforeCandidateCount = countEntryPointCandidates(before);
  const afterCandidateCount = countEntryPointCandidates(after);

  for (const p of before) {
    const key = toFlowKey(p.entryPointId, p.terminalId);
    if (!beforeMap.has(key)) {
      beforeMap.set(key, {
        id: p.id,
        label: p.label,
        isEntryPointCandidate: p.isEntryPointCandidate,
      });
    }
  }
  for (const p of after) {
    const key = toFlowKey(p.entryPointId, p.terminalId);
    if (!afterMap.has(key)) {
      afterMap.set(key, {
        id: p.id,
        label: p.label,
        isEntryPointCandidate: p.isEntryPointCandidate,
      });
    }
  }

  // ── 2) Walk every observed key (union of both sides) and assign
  //    a fate. Order: insertion order of the union (we build it
  //    by iterating `before` first, then any `after` keys not
  //    already seen). The `rows` array preserves the union order
  //    for stable rendering. ─────────────────────────────────────
  const seen = new Set<FlowKey>();
  const rows: FlowFateRow[] = [];
  const counts: Record<FlowFate, number> = {
    stable: 0,
    'label-changed': 0,
    removed: 0,
    added: 0,
  };
  const labelChangedKeys: FlowKey[] = [];

  for (const p of before) {
    const key = toFlowKey(p.entryPointId, p.terminalId);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = beforeMap.get(key)!;
    const a = afterMap.get(key);
    if (a) {
      // Present in both → compare labels.
      if (b.label === a.label) {
        rows.push({
          key,
          fate: 'stable',
          beforeId: b.id,
          afterId: a.id,
          beforeLabel: b.label,
          afterLabel: a.label,
        });
        counts.stable++;
      } else {
        rows.push({
          key,
          fate: 'label-changed',
          beforeId: b.id,
          afterId: a.id,
          beforeLabel: b.label,
          afterLabel: a.label,
        });
        counts['label-changed']++;
        labelChangedKeys.push(key);
      }
    } else {
      // before-only → removed.
      rows.push({
        key,
        fate: 'removed',
        beforeId: b.id,
        beforeLabel: b.label,
      });
      counts.removed++;
    }
  }

  for (const p of after) {
    const key = toFlowKey(p.entryPointId, p.terminalId);
    if (seen.has(key)) continue;
    seen.add(key);
    const a = afterMap.get(key)!;
    rows.push({
      key,
      fate: 'added',
      afterId: a.id,
      afterLabel: a.label,
    });
    counts.added++;
  }

  // ── 3) Totals + intersection (for the verdict's input). ────────
  let intersection = 0;
  for (const key of beforeMap.keys()) {
    if (afterMap.has(key)) intersection++;
  }

  return {
    counts,
    rows,
    entryPointCandidatesBefore: beforeCandidateCount,
    entryPointCandidatesAfter: afterCandidateCount,
    entryPointsFound: afterCandidateCount - beforeCandidateCount,
    labelChangedKeys,
    totals: {
      before: beforeMap.size,
      after: afterMap.size,
      intersection,
    },
  };
}

/** Build the match key `(entryPointId, terminalId)` per KD-6.
 *  Uses `::` as the separator; both halves are validated to be
 *  non-empty strings. The design doc does not pin a separator
 *  format, but `::` is unambiguous (not used in the production
 *  id format `proc_<idx>_<name>`) and is the standard
 *  `KeyValue`-style separator in the codebase. */
export function toFlowKey(entryPointId: string, terminalId: string): FlowKey {
  if (typeof entryPointId !== 'string' || entryPointId.length === 0) {
    throw new TypeError('toFlowKey: entryPointId must be a non-empty string');
  }
  if (typeof terminalId !== 'string' || terminalId.length === 0) {
    throw new TypeError('toFlowKey: terminalId must be a non-empty string');
  }
  return `${entryPointId}::${terminalId}` as FlowKey;
}

/** Count the number of processes whose `isEntryPointCandidate` is
 *  truthy. When ALL inputs omit the flag (legacy), the count is
 *  `0` (the verdict annotates this as "no candidate info"). */
function countEntryPointCandidates(arr: ProcessNode[]): number {
  let n = 0;
  for (const p of arr) {
    if (p.isEntryPointCandidate) n++;
  }
  return n;
}

// ─── Verdict (decomposed, never single-cause) ─────────────────────────

/** Evidence lines for the entry-point hypothesis verdict. The
 *  verdict is decomposed across the three known drivers per KD-6:
 *  (a) `calculateEntryPointScore` candidate shift, (b) the
 *  `maxProcesses*2` trace cap (`process-processor.ts:108`), (c)
 *  endpoint dedup (`deduplicateByEndpoints`). We never collapse
 *  the three into a single "the flow count dropped by N because
 *  of X" — we always publish the per-driver evidence so the
 *  reader can judge. */
export interface VerdictEvidence {
  /** Net change in flow count. */
  flowDelta: number;
  /** Net change in entry-point candidate count (positive = more
   *  candidates after, negative = fewer). */
  candidateDelta: number;
  /** Number of flows that existed in BOTH sides (intersection). */
  intersection: number;
  /** Number of flows removed (before-only). */
  removed: number;
  /** Number of flows added (after-only). */
  added: number;
  /** Per-driver evidence (decomposed — never single-cause). */
  drivers: {
    /** (a) Candidate shift: how many entry-point candidates
     *  disappeared from `before` to `after` (i.e.
     *  `entryPointCandidatesBefore - entryPointCandidatesAfter`,
     *  clamped to non-negative). The flow drop can be partly
     *  attributed to fewer candidate entry points feeding the
     *  `findEntryPoints` → `traceFromEntryPoint` pipeline. */
    candidateShift: number;
    /** (b) `maxProcesses*2` trace cap: a per-run ceiling on the
     *  number of traces the process-processor emits. We surface
     *  the cap value (default 75 → 150 traces cap) and a
     *  boolean indicating whether the `before` side or `after`
     *  side was the binding constraint. (Without runtime
     *  instrumentation we cannot tell which side clipped; we
     *  publish the cap and let the operator decide.) */
    traceCap: { cap: number; bindingSide: 'before' | 'after' | 'unknown' };
    /** (c) Endpoint dedup: number of distinct `(entryPointId,
     *  terminalId)` pairs in `before` (i.e. the count of unique
     *  endpoints). The dedup is a pure transform of the trace
     *  list, so a drop here signals the trace list itself
     *  shrunk. */
    endpointDedup: { beforeEndpoints: number; afterEndpoints: number };
  };
  /** Final verdict line (multi-cause, evidence-cited). */
  verdict: string;
}

/** Compute the decomposed verdict from a `FateReport` and the
 *  raw `before`/`after` arrays. The verdict is multi-cause; we
 *  never single-cause. Pure: same inputs → same output. */
export function computeVerdict(
  before: ProcessNode[],
  after: ProcessNode[],
  report: FateReport,
  maxProcessesCap = 75,
): VerdictEvidence {
  const cap = maxProcessesCap * 2; // mirrors process-processor.ts:108
  const beforeCount = before.length;
  const afterCount = after.length;
  const flowDelta = afterCount - beforeCount;
  const candidateDelta = report.entryPointsFound;
  const candidateShift = Math.max(0, -candidateDelta); // collapse to "missing" count
  const intersection = report.totals.intersection;
  // Endpoint dedup: number of unique keys per side (the
  // dedup function's input is the trace list; we approximate
  // by counting unique keys, which is a monotonic proxy).
  const beforeEndpoints = report.totals.before;
  const afterEndpoints = report.totals.after;
  // Trace cap binding side: the side whose raw trace count is
  // closest to (or at) the cap. We don't have the raw trace
  // count, so we report 'unknown' and let the operator read
  // the numbers.
  let bindingSide: 'before' | 'after' | 'unknown' = 'unknown';
  if (beforeCount > cap && afterCount <= cap) bindingSide = 'before';
  else if (afterCount > cap && beforeCount <= cap) bindingSide = 'after';
  else if (beforeCount > cap && afterCount > cap) {
    bindingSide = beforeCount > afterCount ? 'before' : 'after';
  }

  const verdictParts: string[] = [];
  if (flowDelta < 0) {
    verdictParts.push(
      `flow count dropped by ${-flowDelta} (${beforeCount} → ${afterCount})`,
    );
  } else if (flowDelta > 0) {
    verdictParts.push(
      `flow count grew by ${flowDelta} (${beforeCount} → ${afterCount})`,
    );
  } else {
    verdictParts.push(`flow count unchanged (${beforeCount})`);
  }
  verdictParts.push(
    `intersection ${intersection}`,
    `removed ${report.counts.removed}`,
    `added ${report.counts.added}`,
  );
  if (report.entryPointQueryError) {
    // The candidate query threw on at least one side. The
    // counts below are still emitted (the loader falls back
    // to an empty candidate set on dispatch failure), but the
    // operator should not compare them as if they were
    // legitimate "no candidates" results. Surface the message
    // so the verdict is self-explaining.
    verdictParts.push(
      `  (entry-point query failed: ${report.entryPointQueryError} — counts below are not comparable)`,
    );
  }
  if (candidateDelta !== 0) {
    verdictParts.push(
      `candidate shift: ${candidateDelta > 0 ? '+' : ''}${candidateDelta}` +
        ` (entry-point eligible functions: ${report.entryPointCandidatesBefore} → ${report.entryPointCandidatesAfter})`,
    );
  }
  verdictParts.push(
    `trace cap = ${cap} (maxProcesses=${maxProcessesCap} × 2)`,
    `endpoint dedup: ${beforeEndpoints} → ${afterEndpoints}`,
  );
  const verdict =
    `Decomposed verdict — ${verdictParts.join('; ')}. ` +
    `No single-cause attribution: the drop (or growth) is jointly driven by ` +
    `(a) entry-point candidate shift, (b) the maxProcesses*2 trace cap, ` +
    `and (c) endpoint dedup. Each driver is evidence-cited above per KD-6.`;

  return {
    flowDelta,
    candidateDelta,
    intersection,
    removed: report.counts.removed,
    added: report.counts.added,
    drivers: {
      candidateShift,
      traceCap: { cap, bindingSide },
      endpointDedup: { beforeEndpoints, afterEndpoints },
    },
    verdict,
  };
}

// ─── #170 delta table (orchestration) ──────────────────────────────────

/** A row in the #170 delta table. The table compares meta stats
 *  between two commits (e.g. `438600e` vs `b83ddb1`). */
export interface DeltaRow {
  metric: string;
  before: number | string | null;
  after: number | string | null;
  delta: number | string | null;
  unit?: string;
}

/** The full delta table result (one row per metric). */
export interface DeltaTable {
  rows: DeltaRow[];
  /** SHA of the `before` commit (or a synthetic identifier like
   *  `438600e`). */
  beforeSha: string;
  /** SHA of the `after` commit. */
  afterSha: string;
  /** Wall-time for the `before` analyze (ms). `null` if the
   *  caller did not measure (e.g. pre-existing scratch index). */
  beforeAnalyzeWallMs: number | null;
  /** Wall-time for the `after` analyze (ms). `null` when the
   *  index was pre-existing. */
  afterAnalyzeWallMs: number | null;
}

/** Build the delta table from the two `RepoMeta` snapshots. The
 *  metrics are the six the WI contract requires:
 *  nodes/edges/clusters/flows/DB-size/wall-time. Pure. */
export function buildDeltaTable(
  beforeMeta: { stats?: { nodes?: number; edges?: number; communities?: number; processes?: number; files?: number } } | null,
  afterMeta: { stats?: { nodes?: number; edges?: number; communities?: number; processes?: number; files?: number } } | null,
  beforeDbSize: number | null,
  afterDbSize: number | null,
  beforeWallMs: number | null,
  afterWallMs: number | null,
  beforeSha: string,
  afterSha: string,
): DeltaTable {
  const statNum = (
    m: { stats?: { nodes?: number; edges?: number; communities?: number; processes?: number; files?: number } } | null,
    k: 'nodes' | 'edges' | 'communities' | 'processes' | 'files',
  ): number | null => (m?.stats?.[k] !== undefined ? (m!.stats![k] as number) : null);

  const numDelta = (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) return null;
    return b - a;
  };

  const rows: DeltaRow[] = [
    {
      metric: 'files',
      before: statNum(beforeMeta, 'files'),
      after: statNum(afterMeta, 'files'),
      delta: numDelta(statNum(beforeMeta, 'files'), statNum(afterMeta, 'files')),
    },
    {
      metric: 'nodes',
      before: statNum(beforeMeta, 'nodes'),
      after: statNum(afterMeta, 'nodes'),
      delta: numDelta(statNum(beforeMeta, 'nodes'), statNum(afterMeta, 'nodes')),
    },
    {
      metric: 'edges',
      before: statNum(beforeMeta, 'edges'),
      after: statNum(afterMeta, 'edges'),
      delta: numDelta(statNum(beforeMeta, 'edges'), statNum(afterMeta, 'edges')),
    },
    {
      metric: 'clusters',
      before: statNum(beforeMeta, 'communities'),
      after: statNum(afterMeta, 'communities'),
      delta: numDelta(statNum(beforeMeta, 'communities'), statNum(afterMeta, 'communities')),
    },
    {
      metric: 'flows',
      before: statNum(beforeMeta, 'processes'),
      after: statNum(afterMeta, 'processes'),
      delta: numDelta(statNum(beforeMeta, 'processes'), statNum(afterMeta, 'processes')),
    },
    {
      metric: 'db-size',
      before: beforeDbSize,
      after: afterDbSize,
      delta: numDelta(beforeDbSize, afterDbSize),
      unit: 'bytes',
    },
    {
      metric: 'analyze-wall-time',
      before: beforeWallMs,
      after: afterWallMs,
      delta: numDelta(beforeWallMs, afterWallMs),
      unit: 'ms',
    },
  ];

  return { rows, beforeSha, afterSha, beforeAnalyzeWallMs: beforeWallMs, afterAnalyzeWallMs: afterWallMs };
}

/** Render the delta table as a markdown block. Pure. */
export function renderDeltaTable(t: DeltaTable): string {
  const lines: string[] = [];
  lines.push('| metric | before | after | delta | unit |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const r of t.rows) {
    const fmt = (v: number | string | null): string => {
      if (v === null || v === undefined) return '-';
      if (typeof v === 'number') return v.toLocaleString('en-US');
      return v;
    };
    lines.push(`| ${r.metric} | ${fmt(r.before)} | ${fmt(r.after)} | ${fmt(r.delta)} | ${r.unit ?? ''} |`);
  }
  return lines.join('\n');
}

// ─── 10-flow sample + CLI artifact shape ──────────────────────────────

/** Pick N flow-fate rows for the CLI's 10-flow sample render.
 *  The sample is stratified: stable, label-changed, removed, added
 *  in a 4-2-2-2 ratio by default (8 rows for 10 total; rounded to
 *  4-2-2-2 for `n=10`). For `n=0` we return []. For other N we
 *  take all available rows of each fate up to its quota, then
 *  fill from the most populous fate. */
export function sampleFlowFates(
  report: FateReport,
  n = 10,
): { stable: number; 'label-changed': number; removed: number; added: number } {
  if (n <= 0) return { stable: 0, 'label-changed': 0, removed: 0, added: 0 };
  // Stratified allocation: round-robin to keep the sample balanced.
  // We allocate one to each fate per round until we hit n.
  const fates: FlowFate[] = ['stable', 'label-changed', 'removed', 'added'];
  const out: Record<FlowFate, number> = { stable: 0, 'label-changed': 0, removed: 0, added: 0 };
  let remaining = n;
  let round = 0;
  while (remaining > 0) {
    let anyTaken = false;
    for (const f of fates) {
      if (remaining === 0) break;
      if (out[f] < report.counts[f]) {
        out[f]++;
        remaining--;
        anyTaken = true;
      }
    }
    if (!anyTaken) break; // all fates saturated
    round++;
    if (round > n * 4) break; // safety: prevent infinite loop on degenerate inputs
  }
  return out;
}

/** Take a stratified sample of `n` rows from a `FateReport` per
 *  `sampleFlowFates`. The order within each fate bucket is the
 *  insertion order in `report.rows`. */
export function takeFateSample(report: FateReport, n = 10): FlowFateRow[] {
  const alloc = sampleFlowFates(report, n);
  const want: Record<FlowFate, number> = { ...alloc };
  const out: FlowFateRow[] = [];
  for (const row of report.rows) {
    if (want[row.fate] > 0) {
      out.push(row);
      want[row.fate]--;
    }
  }
  return out;
}

/** Render the 10-flow sample as a markdown table. Pure. */
export function renderSampleTable(sample: FlowFateRow[]): string {
  const lines: string[] = [];
  lines.push('| fate | entryPointId | terminalId | beforeLabel | afterLabel |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of sample) {
    const [entryId, terminalId] = r.key.split('::');
    const bl = r.beforeLabel ?? '-';
    const al = r.afterLabel ?? '-';
    lines.push(`| ${r.fate} | ${entryId} | ${terminalId} | ${bl} | ${al} |`);
  }
  return lines.join('\n');
}

// ─── CLI orchestration: read Process nodes via executeParameterized ───

/** Default cypher query: returns one row per Process node. The
 *  shape mirrors the production `Process` table
 *  (`src/core/lbug/schema.ts:212-223`). The `isEntryPointCandidate`
 *  flag is derived by the CLI side via a separate query
 *  (`deriveEntryPointCandidates`) because the production table
 *  does not persist the flag — the entry-point score is a
 *  computation, not a column. */
export const DEFAULT_PROCESS_QUERY = [
  'MATCH (p:Process)',
  'RETURN',
  '  p.id          AS id,',
  '  p.label       AS label,',
  '  p.entryPointId AS entryPointId,',
  '  p.terminalId  AS terminalId',
].join('\n');

/** Entry-point-candidate derivation query. The production
 *  `calculateEntryPointScore` (`src/core/ingestion/entry-point-
 *  scoring.ts:292-352`) is a continuous function whose output is
 *  consumed at ingest time to choose the `Process.entryPointId`;
 *  the score itself is NOT persisted. The best proxy available
 *  in the schema is the *set of distinct entry-point ids used
 *  across all processes* — the verifier chose each of these as
 *  the trace's first node, so each id is by construction an
 *  "entry-point candidate" the campaign cares about. The query
 *  is relationship-agnostic (no `WHERE` on edge type) and
 *  repo-scoped via the `repoId` projection filter at the call
 *  site.
 *
 *  Counted row: one row per distinct `entryPointId`. The CLI
 *  populates `ProcessNode.isEntryPointCandidate` for processes
 *  whose `entryPointId` is in the candidate set, and the pure
 *  classifier then counts `true` flags on each side to emit
 *  `entryPointCandidatesBefore/After`. When the query returns
 *  zero rows, the verdict annotates "no candidate info available"
 *  (legacy index without `Process` nodes). */
export const ENTRY_POINT_CANDIDATE_QUERY = [
  'MATCH (p:Process)',
  'WHERE p.entryPointId IS NOT NULL',
  'RETURN DISTINCT p.entryPointId AS entryPointId',
].join('\n');

/** Derive the set of entry-point candidate ids for one repo.
 *  Pure with respect to `runCypher` (the only side effect is
 *  the cypher call). Returns a `Set<string>` of distinct
 *  `entryPointId` values. An empty result is a legitimate
 *  "no candidates" answer (legacy index) — the caller decides
 *  whether to treat empty as a halt. */
export async function deriveEntryPointCandidateIds(
  repoId: string,
  runCypher: (repoId: string, cypher: string, params: Record<string, any>) => Promise<any[]>,
): Promise<Set<string>> {
  const rows = await runCypher(repoId, ENTRY_POINT_CANDIDATE_QUERY, {});
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && typeof r.entryPointId === 'string' && r.entryPointId.length > 0) {
      out.add(r.entryPointId);
    }
  }
  return out;
}

/** Mark each process node with `isEntryPointCandidate: true` when
 *  its `entryPointId` is in the candidate set. Pure with respect
 *  to the inputs — the same (nodes, candidates) pair always
 *  yields the same output array. */
export function annotateWithEntryPointCandidates(
  nodes: ProcessNode[],
  candidates: Set<string>,
): ProcessNode[] {
  return nodes.map((p) => ({
    ...p,
    isEntryPointCandidate: candidates.has(p.entryPointId),
  }));
}

/** Project a `Process` cypher row into a `ProcessNode`. Defensive
 *  against missing columns (returns `null` for the row when the
 *  shape is invalid; the caller filters nulls out). */
export function rowToProcessNode(row: any): ProcessNode | null {
  if (!row || typeof row !== 'object') return null;
  const id = row.id;
  const label = row.label;
  const entryPointId = row.entryPointId;
  const terminalId = row.terminalId;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof label !== 'string') return null;
  if (typeof entryPointId !== 'string' || entryPointId.length === 0) return null;
  if (typeof terminalId !== 'string' || terminalId.length === 0) return null;
  return { id, label, entryPointId, terminalId };
}

/** Filter an array of `ProcessNode` objects: drop those with
 *  invalid match keys (the production `toFlowKey` would throw on
 *  empty strings; this helper does the same check non-throwing). */
export function filterValidProcessNodes(arr: ProcessNode[]): ProcessNode[] {
  return arr.filter(
    (p) =>
      typeof p?.id === 'string' &&
      p.id.length > 0 &&
      typeof p?.label === 'string' &&
      typeof p?.entryPointId === 'string' &&
      p.entryPointId.length > 0 &&
      typeof p?.terminalId === 'string' &&
      p.terminalId.length > 0,
  );
}

// ─── CLI entry — flag parsing ─────────────────────────────────────────

/** Parsed CLI args for `flow-fate`. */
export interface ParsedFlowFateArgs {
  /** Path to the `before` repo (must exist; abort otherwise). */
  beforePath: string;
  /** Path to the `after` repo (defaults to cwd). */
  afterPath: string;
  /** Output directory for the artifact (defaults to
   *  `./.gitnexus-flow-fate-out`). */
  outDir: string;
  /** Sample size for the 10-flow rendering (defaults to 10). */
  sampleSize: number;
  /** Operator-overridden pre-#170 baseline SHA. When unset,
   *  the harness uses `EXPECTED_BEFORE_SHA`. A mismatch between
   *  the resolved value and `--before`'s `meta.json:lastCommit`
   *  aborts with `FlowFateHaltError` exit 4. */
  expectedBeforeSha: string;
  /** `--help` sentinel. */
  help?: boolean;
}

/** Sentinel returned for `--help` / `-h`. */
export const HELP_FLOW_FATE_ARGS: ParsedFlowFateArgs = Object.freeze({
  beforePath: '',
  afterPath: '',
  outDir: './.gitnexus-flow-fate-out',
  sampleSize: 10,
  expectedBeforeSha: EXPECTED_BEFORE_SHA,
  help: true,
}) as ParsedFlowFateArgs;

/** Parse `process.argv`-shaped arrays. Pure. Unknown / malformed
 *  input throws `TypeError` with a stable message. */
export function parseFlowFateArgs(args: string[]): ParsedFlowFateArgs {
  const out: ParsedFlowFateArgs = {
    beforePath: '',
    afterPath: '',
    outDir: './.gitnexus-flow-fate-out',
    sampleSize: 10,
    expectedBeforeSha: EXPECTED_BEFORE_SHA,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      const v = args[++i];
      if (typeof v !== 'string' || v.length === 0) {
        throw new TypeError(`flag '${a}' requires a value`);
      }
      return v;
    };
    switch (a) {
      case '--before':
        out.beforePath = next();
        break;
      case '--after':
        out.afterPath = next();
        break;
      case '--out':
        out.outDir = next();
        break;
      case '--sample':
        {
          const v = next();
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0) {
            throw new TypeError(`--sample: expected non-negative integer, got '${v}'`);
          }
          out.sampleSize = n;
        }
        break;
      case '--expected-before-sha':
        out.expectedBeforeSha = next();
        break;
      case '-h':
      case '--help':
        return HELP_FLOW_FATE_ARGS;
      default:
        throw new TypeError(`unknown flag: '${a}'`);
    }
  }
  if (out.beforePath.length === 0) {
    throw new TypeError("--before <path> is required");
  }
  if (out.afterPath.length === 0) {
    out.afterPath = '.';
  }
  return out;
}

/** Print CLI usage to stdout. */
export function renderFlowFateHelp(): string {
  return [
    'usage: tsx scripts/flow-fate.ts [options]',
    '',
    'Options:',
    '  --before <DIR>  path to the pre-#170 repo clone (REQUIRED)',
    '  --after <DIR>   path to the post-#170 repo (default: cwd)',
    '  --out <DIR>     output directory (default: ./.gitnexus-flow-fate-out)',
    '  --sample <N>    number of flow rows to sample (default: 10)',
    '  --expected-before-sha <SHA>  override the pre-#170 baseline SHA',
    '                 (default: 438600e). The --before clone\'s',
    '                 meta.json:lastCommit MUST match this SHA;',
    '                 mismatch → exit 4, no artifact.',
    '  -h, --help      show this help',
    '',
    'Emits a FateReport + #170 delta table + decomposed entry-point',
    'hypothesis verdict to <out>/<before-basename>-vs-<after-basename>-flow-fate.json.',
    'Missing --before directory → non-zero exit, no partial output (per WI-4 halt contract).',
  ].join('\n');
}

// ─── CLI entry — main() ────────────────────────────────────────────────

/** Dependencies for `main`. Every I/O + side effect is injected;
 *  the default wiring reaches into the production seams
 *  (`executeParameterized`, `loadMeta`, `getStoragePaths`). */
export interface FlowFateMainDeps {
  argv?: string[];
  cwd?: string;
  /** Filesystem seam. */
  fs?: FlowFateFs;
  /** Exit seam. */
  exit?: (code: number) => void;
  /** Stderr writer. */
  stderr?: (s: string) => void;
  /** Stdout writer. */
  stdout?: (s: string) => void;
  /** Repo-stat seam (`.gitnexus/lbug` size lookup). */
  stat?: StatFn;
  /** `loadMeta` seam. */
  loadMeta?: LoadMetaFn;
  /** `getStoragePaths` seam. */
  getStoragePaths?: GetStoragePathsFn;
  /** `runCypher` seam (defaults to `executeParameterized`). */
  runCypher?: RunCypherFn;
  /** `sha` seam (default: `git rev-parse HEAD`). */
  sha?: ShaFn;
  /** repoId derivation seam. Default: lowercased basename. */
  deriveRepoId?: (repoPath: string) => string;
  /** Optional `analyze` runner — used when `--before` points to a
   *  repo without an existing `.gitnexus` index. The default is
   *  a no-op that surfaces an error to the caller. */
  analyze?: (repoPath: string) => Promise<{ wallMs: number }>;
  /** Pure classifier seam. Default: `classifyFlowFates`. */
  classify?: (before: ProcessNode[], after: ProcessNode[]) => FateReport;
  /** Process-row → ProcessNode projection seam. Default:
   *  `rowToProcessNode`. */
  rowToProcessNode?: (row: any) => ProcessNode | null;
  /** `analyze` wall-time for the `before` side. `null` when the
   *  index was pre-existing. */
  beforeAnalyzeWallMs?: number | null;
  /** Same for the `after` side. */
  afterAnalyzeWallMs?: number | null;
  /** Expected pre-#170 baseline SHA for the `--before` side.
   *  The `loadProcessNodes` call for `--before` aborts with
   *  `FlowFateHaltError` exit 4 when `meta.lastCommit !==
   *  expectedBeforeSha`. The `--after` side is NOT pinned (the
   *  "after" commit is operator-controlled, e.g. `HEAD`).
   *  Default: `EXPECTED_BEFORE_SHA`. */
  expectedBeforeSha?: string;
  /** Side selector — `'before'` asserts the SHA, `'after'`
   *  skips the assertion. `loadProcessNodes` takes this via the
   *  call site (the `main()` loop) so the helper stays pure
   *  with respect to a single side. */
  side?: 'before' | 'after';
}

export interface FlowFateFs {
  access(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export type StatFn = (repoPath: string) => Promise<number | null>;
export type LoadMetaFn = (storagePath: string) => Promise<RepoMeta | null>;
export type GetStoragePathsFn = (repoPath: string) => {
  storagePath: string;
  lbugPath: string;
  metaPath: string;
};
export type RunCypherFn = (
  repoId: string,
  cypher: string,
  params: Record<string, any>,
) => Promise<any[]>;
export type ShaFn = (repoPath: string) => Promise<string>;

export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
  schemaVersion?: number;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
}

/** Per the WI-4 contract: missing `--before` dir → non-zero exit,
 *  no partial output. The check is `fs.access(beforePath)`; any
 *  rejection (ENOENT or permission denied) is fatal. */
export class FlowFateHaltError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'FlowFateHaltError';
  }
}

// ─── Default wiring (dynamic imports to keep the no-write sweep clean)

let _runCypherCache: RunCypherFn | null = null;
let _loadMetaCache: LoadMetaFn | null = null;
let _getStoragePathsCache: GetStoragePathsFn | null = null;
let _execCache: ((cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>) | null = null;

async function defaultRunCypher(): Promise<RunCypherFn> {
  if (_runCypherCache) return _runCypherCache;
  const mod: any = await import('../dist/mcp/core/lbug-adapter.js');
  _runCypherCache = mod.executeParameterized as RunCypherFn;
  return _runCypherCache;
}

async function defaultLoadMeta(): Promise<LoadMetaFn> {
  if (_loadMetaCache) return _loadMetaCache;
  const mod: any = await import('../dist/storage/repo-manager.js');
  _loadMetaCache = mod.loadMeta as LoadMetaFn;
  _getStoragePathsCache = mod.getStoragePaths as GetStoragePathsFn;
  return _loadMetaCache;
}

async function defaultGetStoragePaths(): Promise<GetStoragePathsFn> {
  if (_getStoragePathsCache) return _getStoragePathsCache;
  await defaultLoadMeta();
  return _getStoragePathsCache!;
}

async function defaultExec(): Promise<NonNullable<FlowFateMainDeps['analyze']> extends never ? never : (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>> {
  if (_execCache) return _execCache as any;
  const { execFile } = await import('node:child_process');
  _execCache = (cmd, args, cwd) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { cwd, maxBuffer: 64 * 1024 * 1024 },
        (err: any, stdout: string, stderr: string) => {
          if (err) {
            const code = typeof err?.code === 'number' ? err.code : 1;
            resolve({ stdout: stdout ?? '', stderr: stderr ?? err.message ?? '', code });
            return;
          }
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        },
      );
    });
  return _execCache as any;
}

// ─── Per-side process-node loader ────────────────────────────────────

/** Load the `Process` nodes from one repo via the injected
 *  `runCypher` seam. Returns the list and the `repoId` (for
 *  diagnostics). Throws when the repo is not indexed (no
 *  `.gitnexus/meta.json`). */
export async function loadProcessNodes(
  repoPath: string,
  deps: FlowFateMainDeps,
): Promise<{ nodes: ProcessNode[]; repoId: string; dbSizeBytes: number | null; meta: RepoMeta | null; sha: string; entryPointQueryError?: string }> {
  const runCypher = deps.runCypher ?? (await defaultRunCypher());
  const loadMeta = deps.loadMeta ?? (await defaultLoadMeta());
  const getStoragePaths = deps.getStoragePaths ?? (await defaultGetStoragePaths());
  const stat = deps.stat;
  const sha = deps.sha;
  const deriveRepoId = deps.deriveRepoId ?? defaultDeriveRepoId;

  const paths = getStoragePaths(repoPath);
  const meta = await loadMeta(paths.storagePath);
  if (!meta) {
    throw new FlowFateHaltError(
      2,
      `error: repo '${repoPath}' has no .gitnexus/meta.json — run 'analyze' first`,
    );
  }
  // I-7 SHA enforcement: when this side is `'before'`, the loaded
  // meta's `lastCommit` MUST match the expected pre-#170 baseline
  // SHA. A mismatch means the operator pointed `--before` at the
  // wrong commit (a campaign operator can otherwise silently
  // produce a verdict against the wrong baseline). The
  // `expectedBeforeSha` is operator-overridable via
  // `--expected-before-sha`; the `'after'` side is NEVER pinned
  // (the after commit is operator-controlled, e.g. `HEAD`).
  if (deps.side === 'before') {
    const expected = deps.expectedBeforeSha ?? EXPECTED_BEFORE_SHA;
    if (meta.lastCommit !== expected) {
      throw new FlowFateHaltError(
        4,
        `error: --before '${repoPath}' meta.json:lastCommit is '${meta.lastCommit}' ` +
          `but expected '${expected}'. Pass --expected-before-sha <sha> to override, ` +
          `or check out the documented pre-#170 baseline. Halt contract: ` +
          `mismatched --before SHA → exit 4, no artifact, no partial output.`,
      );
    }
  }
  const repoId = deriveRepoId(repoPath);
  let dbSizeBytes: number | null = null;
  if (stat) {
    dbSizeBytes = await stat(repoPath);
  }
  let headSha: string = meta.lastCommit ?? '';
  if (sha) {
    try {
      headSha = await sha(repoPath);
    } catch {
      /* fall back to meta.lastCommit */
    }
  }

  let rows: any[];
  try {
    rows = await runCypher(repoId, DEFAULT_PROCESS_QUERY, {});
  } catch (e: any) {
    // A legacy index without `Process` rows (or no `Process`
    // table at all) returns [] on a successful query, or throws
    // here. We surface a halt so the operator can re-analyze.
    throw new FlowFateHaltError(
      3,
      `error: failed to load Process nodes from '${repoPath}': ${e?.message ?? String(e)}`,
    );
  }
  const rowToNode = deps.rowToProcessNode ?? rowToProcessNode;
  const rawNodes = filterValidProcessNodes(
    (Array.isArray(rows) ? rows : []).map(rowToNode).filter((x): x is ProcessNode => x !== null),
  );
  // KD-6: entry-point candidates are derived via a SEPARATE cypher
  // query (the production `Process` table does not persist the
  // entry-point score). When the candidate set is non-empty, each
  // process node is annotated with `isEntryPointCandidate` so the
  // pure classifier can emit `entryPointCandidatesBefore/After`.
  // When the query returns an empty set (legacy index without
  // `Process` rows), nodes are returned un-annotated and the
  // verdict annotates "no candidate info available" — the count
  // is `0` but it is a legitimate answer, not a contract
  // violation.
  let nodes: ProcessNode[];
  let entryPointQueryError: string | undefined;
  try {
    const candidates = await deriveEntryPointCandidateIds(repoId, runCypher);
    nodes = annotateWithEntryPointCandidates(rawNodes, candidates);
  } catch (error) {
    // A cypher dispatch error on the candidate query should not
    // abort the whole flow-fate run — the per-side `MATCH
    // (p:Process)` query has already succeeded, so we have the
    // raw nodes. Annotate with an empty set and let the classifier
    // emit `entryPointCandidatesBefore/After: 0` (the verdict
    // will annotate the absence). Capture the error message
    // (coerced to string for non-Error throws) on the result so
    // the verdict can distinguish "cypher dispatch failed" from
    // "legitimate empty result" downstream.
    nodes = rawNodes;
    entryPointQueryError =
      typeof error === 'string'
        ? error
        : (error as Error)?.message ?? String(error);
  }
  return { nodes, repoId, dbSizeBytes, meta, sha: headSha, entryPointQueryError };
}

/** Default `repoId` derivation: lowercased basename of the
 *  resolved path. Mirrors `LocalBackend.repoId` and the
 *  `deriveRepoId` helper in `measure-mode-c.ts`. */
export function defaultDeriveRepoId(repoPath: string): string {
  // Pure: we deliberately use string operations to avoid the
  // node:path dynamic import in the unit test path.
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const lower = base.toLowerCase();
  return lower.length > 0 ? lower : 'repo';
}

// ─── Atomic write helpers ─────────────────────────────────────────────

/** Atomic write: write to `<path>.tmp`, then rename. */
export async function flowFateAtomicWrite(
  path: string,
  content: string,
  fsImpl?: FlowFateFs,
): Promise<void> {
  const fs = fsImpl ?? (await import('node:fs/promises'));
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, path);
}

/** Derive a deterministic, path-safe filename for the artifact.
 *  `<before-basename>-vs-<after-basename>-flow-fate.json`. */
export function flowFateArtifactFilename(
  beforePath: string,
  afterPath: string,
): string {
  const safe = (s: string): string =>
    s.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '-') ?? 'repo';
  return `${safe(beforePath)}-vs-${safe(afterPath)}-flow-fate.json`;
}

// ─── Top-level CLI entry ──────────────────────────────────────────────

/**
 * Top-level CLI entry. Reachable from
 * `tsx scripts/flow-fate.ts …` and from the unit test suite
 * (with injected `deps`).
 *
 * Halt contract (per docs/plans/159-mode-c-measurement.md WI-4):
 *  - `--before` dir absent → `process.exit(2)`, no artifact.
 *  - `--after` dir absent → `process.exit(2)`, no artifact.
 *  - `runCypher` rejects mid-run → surfaced to stderr, exit 3,
 *    no partial output.
 *  - `--before` repo not indexed (no `meta.json`) → exit 2,
 *    no artifact.
 *  - parse error → exit 1, no artifact.
 *
 * Determinism: the artifact filename is
 * `<before-basename>-vs-<after-basename>-flow-fate.json` (stable
 * across reruns of the same pair).
 */
export async function main(deps: FlowFateMainDeps = {}): Promise<void> {
  const argv = deps.argv ?? (typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv.slice(2) : []);
  const fs = deps.fs ?? (await import('node:fs/promises'));
  const exit = deps.exit ?? ((code: number) => {
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(code);
    }
  });
  const stderr = deps.stderr ?? ((s: string) => {
    if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
  });
  const stdout = deps.stdout ?? ((s: string) => {
    if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
  });

  // 1) Parse flags.
  let parsed: ParsedFlowFateArgs;
  try {
    parsed = parseFlowFateArgs(argv);
  } catch (e: any) {
    stderr(`error: ${e?.message ?? String(e)}\n\n${renderFlowFateHelp()}\n`);
    exit(1);
    return;
  }
  if ((parsed as any).help) {
    stdout(renderFlowFateHelp() + '\n');
    return;
  }

  // 2) Pre-measure gate: both `--before` and `--after` must be
  //    resolvable on disk. Missing → exit 2, no artifact.
  try {
    await fs.access(parsed.beforePath);
  } catch (e: any) {
    stderr(
      `error: --before directory not found: '${parsed.beforePath}'` +
        ` (${e?.message ?? String(e)})\n` +
        `No partial output will be written. Halt contract: missing --before → exit 2.\n`,
    );
    exit(2);
    return;
  }
  try {
    await fs.access(parsed.afterPath);
  } catch (e: any) {
    stderr(
      `error: --after directory not found: '${parsed.afterPath}'` +
        ` (${e?.message ?? String(e)})\n` +
        `No partial output will be written.\n`,
    );
    exit(2);
    return;
  }

  // 3) Make sure the output directory exists BEFORE any artifact
  //    is written. A failure here is fatal — no partial output.
  try {
    await fs.mkdir(parsed.outDir, { recursive: true });
  } catch (e: any) {
    stderr(
      `error: cannot create output directory '${parsed.outDir}': ${e?.message ?? String(e)}\n`,
    );
    exit(1);
    return;
  }

  // 4) Per-side loader + classifier + delta table. The `side`
  //    selector on the deps tells `loadProcessNodes` whether to
  //    enforce the pre-#170 baseline SHA (I-7). `expectedBeforeSha`
  //    defaults to `EXPECTED_BEFORE_SHA`; the operator can override
  //    via `--expected-before-sha`.
  let before: Awaited<ReturnType<typeof loadProcessNodes>>;
  let after: Awaited<ReturnType<typeof loadProcessNodes>>;
  try {
    before = await loadProcessNodes(parsed.beforePath, {
      ...deps,
      side: 'before',
      expectedBeforeSha: parsed.expectedBeforeSha,
    });
  } catch (e: any) {
    if (e instanceof FlowFateHaltError) {
      stderr(`${e.message}\n`);
      exit(e.code);
      return;
    }
    stderr(
      `error: failed to load Process nodes from --before '${parsed.beforePath}': ` +
        `${e?.message ?? String(e)}\n`,
    );
    exit(3);
    return;
  }
  try {
    after = await loadProcessNodes(parsed.afterPath, {
      ...deps,
      side: 'after',
    });
  } catch (e: any) {
    if (e instanceof FlowFateHaltError) {
      stderr(`${e.message}\n`);
      exit(e.code);
      return;
    }
    stderr(
      `error: failed to load Process nodes from --after '${parsed.afterPath}': ` +
        `${e?.message ?? String(e)}\n`,
    );
    exit(3);
    return;
  }

  const classify = deps.classify ?? classifyFlowFates;
  const report = classify(before.nodes, after.nodes);
  // Propagate the per-side candidate-query error to the report
  // so `computeVerdict` can emit the
  // "(entry-point query failed: … — counts below are not
  // comparable)" annotation. Prefer the `before` error when
  // both sides report one (the `before` side is the campaign
  // baseline and the more likely place an operator is
  // debugging).
  if (before.entryPointQueryError || after.entryPointQueryError) {
    (report as FateReport).entryPointQueryError =
      before.entryPointQueryError ?? after.entryPointQueryError;
  }
  const verdict = computeVerdict(before.nodes, after.nodes, report);

  const deltaTable = buildDeltaTable(
    before.meta,
    after.meta,
    before.dbSizeBytes,
    after.dbSizeBytes,
    deps.beforeAnalyzeWallMs ?? null,
    deps.afterAnalyzeWallMs ?? null,
    before.sha,
    after.sha,
  );

  const sample = takeFateSample(report, parsed.sampleSize);
  const sampleMd = renderSampleTable(sample);
  const deltaMd = renderDeltaTable(deltaTable);

  // 5) Build the artifact object.
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(), // deterministic for byte-identity
    before: {
      path: parsed.beforePath,
      sha: before.sha,
      repoId: before.repoId,
      dbSizeBytes: before.dbSizeBytes,
      meta: before.meta,
      processCount: before.nodes.length,
    },
    after: {
      path: parsed.afterPath,
      sha: after.sha,
      repoId: after.repoId,
      dbSizeBytes: after.dbSizeBytes,
      meta: after.meta,
      processCount: after.nodes.length,
    },
    delta: deltaTable,
    fates: report,
    sample: sampleMd,
    deltaMarkdown: deltaMd,
    verdict,
  };

  // 6) Write the artifact atomically. A failure here is fatal —
  //    we'd rather abort than publish partial results.
  const filename = flowFateArtifactFilename(parsed.beforePath, parsed.afterPath);
  const fullPath = `${parsed.outDir.replace(/\/+$/, '')}/${filename}`;
  try {
    await flowFateAtomicWrite(fullPath, JSON.stringify(artifact, null, 2), fs as any);
  } catch (e: any) {
    stderr(
      `error: failed to write artifact ${fullPath}: ${e?.message ?? String(e)}\n`,
    );
    exit(1);
    return;
  }
  // Emit a short summary on stdout (not stderr) so the operator
  // can `> log.txt` and grep.
  stdout(
    [
      `flow-fate: ${parsed.beforePath} (${before.sha}) vs ${parsed.afterPath} (${after.sha})`,
      `  before flows: ${before.nodes.length}  after flows: ${after.nodes.length}  delta: ${after.nodes.length - before.nodes.length}`,
      `  fates: stable=${report.counts.stable} label-changed=${report.counts['label-changed']} removed=${report.counts.removed} added=${report.counts.added}`,
      `  entry-point candidates: ${report.entryPointCandidatesBefore} → ${report.entryPointCandidatesAfter} (delta ${report.entryPointsFound})`,
      `  artifact: ${fullPath}`,
      '',
    ].join('\n'),
  );
}

// ─── Re-exports for tests ─────────────────────────────────────────────

/** Internal helpers exposed for the unit test suite. */
export const __test__ = {
  toFlowKey,
  countEntryPointCandidates,
  sampleFlowFates,
  takeFateSample,
  buildDeltaTable,
  renderDeltaTable,
  renderSampleTable,
  rowToProcessNode,
  filterValidProcessNodes,
  parseFlowFateArgs,
  renderFlowFateHelp,
  flowFateArtifactFilename,
  defaultDeriveRepoId,
};

// ─── Script entry ──────────────────────────────────────────────────────

/** Auto-run when this module is the entry (`tsx scripts/flow-fate.ts …`).
 *  Mirrors the `runAsScript` guard in `measure-mode-c.ts`: we
 *  compare `import.meta.url` to `process.argv[1]` (both resolved
 *  to absolute paths) so importing the module from tests does
 *  NOT trigger the CLI. */
async function runAsScript(): Promise<void> {
  try {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const url: string = import.meta.url;
    const here = path.resolve(fileURLToPath(url));
    if (!process.argv[1]) return;
    const entry = path.resolve(process.argv[1]);
    if (entry !== here) return;
    await main();
  } catch (e: any) {
    process.stderr.write(`[flow-fate] fatal: ${e?.stack ?? e}\n`);
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(1);
    }
  }
}

void runAsScript();
