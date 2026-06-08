/**
 * Mode C Verifier — LSP read-only foundation, WI-#6.
 *
 * Reads a stratified sample of heuristic CALLS edges, asks an LSP
 * server for the `textDocument/definition` at each call site, maps
 * the response to a graph nodeId, and compares the result to the
 * heuristic target. Produces a deterministic per-tier and overall
 * precision / recall / false-confident-rate report.
 *
 * Design references:
 *   docs/designs/159-lsp-readonly-foundation.md
 *     - § Components   → "mode-c-verifier.ts" (P1)
 *     - § Flows        → #sd-verify-mode-c
 *     - § KeyDecisions → KD-8 (CALLS-first, stratified by tier)
 *     - § Invariants   → 1 (no graph writes), 3 (refuse over guess),
 *                        7 (deterministic report)
 *
 * Algorithm (mirrors the WI spec step-by-step):
 *
 *   1. Run the workspace-readiness probe. If `ready:false`, return an
 *      "LSP unavailable" report with `lspUnavailable: true` and the
 *      probe's `reason` (no LSP requests are made).
 *   2. Otherwise read all CALLS edges from the graph (read-only
 *      Cypher MATCH). Derive a tier for each edge from its `reason`
 *      field (the schema stores `reason`, not `tier` — see
 *      `reasonToTier`).
 *   3. Stratified sampling (KD-8): over-sample `same-file`
 *      (the highest-signal tier). A seeded PRNG (mulberry32)
 *      shuffles each tier's edges deterministically; we take the
 *      first `cap[tier]` of each. The total is bounded by
 *      `sampleSize`; any over-allocation is logged.
 *   4. For each sampled edge:
 *      - Call `client.request('textDocument/definition', loc, timeout)`.
 *      - Map the LSP response (or `[]`/null) via `mapLocationToNodeId`.
 *      - Classify the verdict:
 *          | LSP-maps  | heuristic-target | classification  |
 *          |-----------|------------------|-----------------|
 *          | NO_NODE   | any              | refused         |
 *          | AMBIGUOUS | any              | refused         |
 *          | node X    | null             | recall-gain     |
 *          | node X    | node X           | match           |
 *          | node X    | node Y (≠ X)     | false-confident |
 *          | node X    | missing-id edge  | recall-miss     |
 *      - Refused NEVER counts as a match (Invariant 3).
 *   5. Tally per-tier + overall metrics. Report shape is stable
 *      across runs given the same seed and graph (Invariant 7).
 *
 * Read-only (Invariant 1):
 *   The verifier's only DB surface is `executeParameterized` with a
 *   read-only MATCH…RETURN. It never imports a write API. A runtime
 *   self-check test asserts this holds.
 *
 * Determinism (Invariant 7):
 *   mulberry32 with the caller-supplied seed (default
 *   `"deterministic-seed-42"`) drives every random pick. The order
 *   in which tiers are sampled and the order in which edges are
 *   shuffled within a tier is also deterministic.
 */

import type { LspClient } from './lsp-client.js';
import type { MapperResult } from './location-mapper.js';
import type { ResolutionTier } from '../resolution-context.js';
import { executeParameterized } from '../../../mcp/core/lbug-adapter.js';

// ─── Public types ──────────────────────────────────────────────────────

/** Re-export the canonical tier type for verifier consumers. */
export type Tier = ResolutionTier;

/** Re-export the canonical mapper verdict shape for verifier consumers. */
export type { MapperResult };

/**
 * Per-tier metric counters. Invariant 7 (determinism) guarantees
 * that two runs of `runModeCVerify` with the same seed + repo +
 * server produce byte-identical reports. The numbers sum as:
 *
 *   matches + falseConfident + recallMisses + refusals + recallGains === n
 *
 * where the first four are mutually exclusive per edge, and a
 * `recallGains` edge is one where the heuristic was null/unknown
 * but LSP resolved.
 */
export interface VerifyMetrics {
  /** matches / (matches + falseConfident) — 0 if denom is 0. */
  precision: number;
  /** matches / (matches + falseConfident + recallMisses) — 0 if denom is 0. */
  recall: number;
  /** falseConfident / n — undefined if n is 0. */
  falseConfidentRate: number;
  /** Heuristic & LSP agreed on the same target. */
  matches: number;
  /** Heuristic target ≠ LSP target (LSP answered confidently). */
  falseConfident: number;
  /** Heuristic was null/unknown AND LSP also could not resolve. */
  recallMisses: number;
  /** LSP returned NO_NODE or AMBIGUOUS. NEVER a match. */
  refusals: number;
  /** Heuristic was null/unknown but LSP DID resolve — heuristic missed. */
  recallGains: number;
  /** Total sampled edges in this tier. */
  n: number;
}

/** The shape the verifier returns. Per-tier + overall counters. */
export interface VerifyReport {
  perTier: Record<Tier, VerifyMetrics>;
  overall: VerifyMetrics;
  sampleSize: number;
  serverVersion: string | null;
  /** True iff the readiness probe returned `ready:false`. */
  lspUnavailable?: boolean;
  /** Probe reason on unavailability; never present when probe is ready. */
  reason?: string;
  /** Sampled cap (number actually attempted) — diagnostic. */
  sampledCap?: number;
}

/**
 * Dependency bag the verifier consumes. Every member has a sensible
 * production default; callers (typically unit tests) inject custom
 * implementations for determinism.
 */
export interface RunModeCVerifyOpts {
  repoId: string;
  /** Used for `textDocument/definition` requests. */
  client: LspClient;
  /** Maps an LSP Location to a graph nodeId. Default: real `mapLocationToNodeId`. */
  mapLocationToNodeId: (loc: any, repoId: string) => Promise<MapperResult>;
  /** Read-only Cypher dispatch. Default: `executeParameterized`. */
  executeParameterized: (
    repoId: string,
    cypher: string,
    params: Record<string, any>,
  ) => Promise<any[]>;
  /** The probe — `probeWorkspaceReadiness` by default. */
  probe: (client: LspClient) => Promise<{ ready: boolean; reason?: string }>;
  /**
   * Server version, captured upstream. Forwarded into the report so
   * consumers can correlate the metrics with a specific binary.
   * Optional: null when unknown.
   */
  serverVersion?: string | null;
  /** Total target sample size (capped by available edges). Default: 200. */
  sampleSize?: number;
  /** Seeded PRNG seed. Default: 'deterministic-seed-42'. */
  seed?: string;
  /** Hard cap on the number of LSP requests (bounds DB/LSP time). Default: sampleSize. */
  hardCap?: number;
  /** Per-request timeout in ms. Default: 5000. */
  requestTimeoutMs?: number;
  /** Optional sink for diagnostic logs (e.g. the "cap reached" warning). */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

// ─── Defaults ──────────────────────────────────────────────────────────

/** Default total sample size (per KD-8). */
export const DEFAULT_SAMPLE_SIZE = 200;

/** Default deterministic seed. */
export const DEFAULT_SEED = 'deterministic-seed-42';

/** Default per-request timeout for `textDocument/definition`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Per-tier sampling weights (KD-8). Same-file is the
 * highest-signal tier (heuristic should be near-certain there) and
 * is over-sampled. Global and external are under-sampled because
 * they produce the most noise. The weights are normalized at
 * sampling time so the total does not exceed `sampleSize`.
 */
const TIER_WEIGHTS: Record<Tier, number> = {
  'same-file': 3.0,
  'import-scoped': 2.0,
  global: 1.0,
  external: 0.5,
};

/** The set of tier names we report against. */
const ALL_TIERS: Tier[] = ['same-file', 'import-scoped', 'global', 'external'];

/** The set of `reason` values produced by the analyzer (call-processor.ts:733). */
const REASON_SAME_FILE = 'same-file';
const REASON_IMPORT_RESOLVED = 'import-resolved';
const REASON_FUZZY_GLOBAL = 'fuzzy-global';

/** Empty-metrics factory — used for the "no data" branch. */
function emptyMetrics(): VerifyMetrics {
  return {
    precision: 0,
    recall: 0,
    falseConfidentRate: 0,
    matches: 0,
    falseConfident: 0,
    recallMisses: 0,
    refusals: 0,
    recallGains: 0,
    n: 0,
  };
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Run Mode C verification: compare a seeded sample of heuristic
 * CALLS edges to LSP-resolved definitions, and produce a
 * deterministic precision/recall/false-confident report.
 *
 * The function is **read-only** (Invariant 1): it never imports a
 * write API, never opens a transaction, never modifies the graph.
 *
 * @param opts See `RunModeCVerifyOpts` for the full surface.
 */
export async function runModeCVerify(opts: RunModeCVerifyOpts): Promise<VerifyReport> {
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const seed = opts.seed ?? DEFAULT_SEED;
  const hardCap = opts.hardCap ?? sampleSize;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // ── 1) Readiness gate (Invariant 4) ─────────────────────────────────
  // The probe is the sole gate. A `ready:false` verdict means we
  // must not even try to use LSP — every downstream comparison
  // would be against an unbuilt workspace. The probe itself
  // already enforces this (it issues a canary request); the
  // verifier just propagates its verdict.
  const probeResult = await opts.probe(opts.client);
  if (!probeResult.ready) {
    return {
      perTier: emptyPerTier(),
      overall: emptyMetrics(),
      sampleSize: 0,
      serverVersion: opts.serverVersion ?? null,
      lspUnavailable: true,
      reason: probeResult.reason,
    };
  }

  // ── 2) Read CALLS edges (read-only) ────────────────────────────────
  // The Cypher is fixed (no user input). We project every column
  // we need to reconstruct the call-site Location AND the
  // heuristic target's nodeId. `tier` is NOT in the schema — we
  // derive it from `reason` in `reasonToTier()`.
  const cypher = [
    'MATCH (a)-[r:CodeRelation {type: $relType}]->(b)',
    'WHERE a.filePath IS NOT NULL AND b.filePath IS NOT NULL',
    '  AND a.startLine IS NOT NULL',
    'RETURN a.filePath AS sourceFile,',
    '       a.startLine AS sourceLine,',
    '       a.name AS sourceName,',
    '       a.id AS sourceId,',
    '       b.filePath AS targetFile,',
    '       b.startLine AS targetStartLine,',
    '       b.endLine AS targetEndLine,',
    '       b.name AS targetName,',
    '       b.id AS targetId,',
    '       r.confidence AS confidence,',
    '       r.reason AS reason',
    'ORDER BY a.startLine ASC, a.id ASC, b.id ASC',
  ].join(' ');
  const rows = await opts.executeParameterized(opts.repoId, cypher, {
    relType: 'CALLS',
  });

  // ── 3) Project + bucket by tier ────────────────────────────────────
  // The seedable PRNG instance — every random call (sampling,
  // shuffling) goes through it. This is the keystone of
  // determinism (Invariant 7).
  const rng = mulberry32(hashSeed(seed));
  const buckets: Record<Tier, CallEdge[]> = {
    'same-file': [],
    'import-scoped': [],
    global: [],
    external: [],
  };
  for (const row of rows ?? []) {
    const edge = projectEdge(row);
    if (!edge) continue;
    buckets[edge.tier].push(edge);
  }

  // ── 4) Stratified sampling (KD-8) ──────────────────────────────────
  // We compute each tier's allocated share of `sampleSize` by
  // weight, then take min(share, popCount). Tiers with
  // `popCount === 0` get 0. The grand total is bounded by
  // `hardCap`. When a tier's allocation would exceed the
  // available edges, we log the cap (EdgeCase 9).
  const totalWeight = ALL_TIERS.reduce((s, t) => s + TIER_WEIGHTS[t], 0);
  const allocated: Record<Tier, number> = {
    'same-file': 0,
    'import-scoped': 0,
    global: 0,
    external: 0,
  };
  for (const t of ALL_TIERS) {
    const share = Math.floor((sampleSize * TIER_WEIGHTS[t]) / totalWeight);
    allocated[t] = Math.min(buckets[t].length, share);
  }

  // Deterministic intra-tier shuffle, then slice. The shuffle
  // uses the seeded PRNG so the same (seed, bucket) → same order
  // → same report (Invariant 7).
  const sampled: Record<Tier, CallEdge[]> = {
    'same-file': [],
    'import-scoped': [],
    global: [],
    external: [],
  };
  for (const t of ALL_TIERS) {
    const arr = buckets[t].slice();
    shuffleInPlace(arr, rng);
    sampled[t] = arr.slice(0, allocated[t]);
  }
  const sampledTotal = ALL_TIERS.reduce((s, t) => s + sampled[t].length, 0);

  // EdgeCase 9: log the cap. The total CAN exceed sampleSize
  // when individual tiers have more edges than their share — but
  // we always slice to `allocated[t] = min(popCount, share)`, so
  // the total is bounded by `min(sampleSize, sum(popCount))`. The
  // "cap" warning fires when a tier's population equals or
  // exceeds its allocation, i.e. that tier ran out of slack. This
  // is the diagnostic we want operators to see.
  for (const t of ALL_TIERS) {
    if (buckets[t].length > 0 && allocated[t] < buckets[t].length) {
      const share = Math.floor((sampleSize * TIER_WEIGHTS[t]) / totalWeight);
      if (allocated[t] === share && share < buckets[t].length) {
        // Genuine cap (allocation hit, not over-allocation).
        opts.logger?.warn(
          `[mode-c] tier=${t} cap reached: sampled ${allocated[t]} of ${buckets[t].length} (share=${share})`,
        );
      }
    }
  }

  // Hard-cap guard: never exceed `hardCap` LSP requests. This
  // bounds total wall-clock even if `sampleSize` is large.
  let sampledCap = sampledTotal;
  if (sampledTotal > hardCap) {
    // Truncate by walking tiers in priority order
    // (same-file → import-scoped → global → external).
    let remaining = hardCap;
    for (const t of ALL_TIERS) {
      const take = Math.min(sampled[t].length, remaining);
      sampled[t] = sampled[t].slice(0, take);
      remaining -= take;
      if (remaining === 0) break;
    }
    sampledCap = ALL_TIERS.reduce((s, t) => s + sampled[t].length, 0);
  }

  // ── 5) Per-edge classification ─────────────────────────────────────
  // The request loop. For each sampled edge we (a) ask LSP for
  // the definition at the call-site, (b) map the response to a
  // nodeId, (c) classify the verdict. Refusals NEVER count as
  // matches (Invariant 3).
  const perTierCounters: Record<Tier, VerifyMetrics> = {
    'same-file': emptyMetrics(),
    'import-scoped': emptyMetrics(),
    global: emptyMetrics(),
    external: emptyMetrics(),
  };
  for (const t of ALL_TIERS) {
    for (const edge of sampled[t]) {
      const cls = await classifyEdge(edge, opts, requestTimeoutMs);
      perTierCounters[t][cls] += 1;
      perTierCounters[t].n += 1;
    }
  }

  // ── 6) Tally overall + compute metrics ─────────────────────────────
  const overall = emptyMetrics();
  for (const t of ALL_TIERS) {
    const c = perTierCounters[t];
    overall.matches += c.matches;
    overall.falseConfident += c.falseConfident;
    overall.recallMisses += c.recallMisses;
    overall.refusals += c.refusals;
    overall.recallGains += c.recallGains;
    overall.n += c.n;
  }
  finalizeMetrics(overall);
  for (const t of ALL_TIERS) {
    finalizeMetrics(perTierCounters[t]);
  }

  return {
    perTier: perTierCounters,
    overall,
    sampleSize: sampledCap,
    serverVersion: opts.serverVersion ?? null,
    sampledCap,
  };
}

// ─── Edge shape + tier derivation ──────────────────────────────────────

/**
 * The internal edge shape. We project DB rows into this once,
 * then operate on a stable type. The `heuristicTarget` is the
 * raw `targetId` (may be empty for edges where the analyzer
 * could not resolve a target — those count as "heuristic null").
 */
interface CallEdge {
  /** Source node id (for diagnostics). */
  sourceId: string;
  /** Heuristic target node id — empty string means "heuristic missed". */
  heuristicTarget: string;
  /** File the call was made from. */
  sourceFile: string;
  /** 0-indexed line of the call. */
  sourceLine: number;
  /** Derived tier for stratified sampling. */
  tier: Tier;
}

/**
 * Coerce a DB row into a `CallEdge`. Defensive — every field is
 * type-checked. Returns `null` on a malformed row (the row is
 * dropped; this never throws into the report).
 */
function projectEdge(row: any): CallEdge | null {
  if (!row || typeof row !== 'object') return null;
  const sourceFile = typeof row.sourceFile === 'string' ? row.sourceFile : '';
  const sourceId = typeof row.sourceId === 'string' ? row.sourceId : '';
  const targetId = typeof row.targetId === 'string' ? row.targetId : '';
  const reason = typeof row.reason === 'string' ? row.reason : '';
  if (!sourceFile) return null;
  // sourceLine: 0-indexed integer. Anything else means a
  // partially-indexed edge we cannot ask LSP about — drop it.
  const sourceLine = typeof row.sourceLine === 'number' ? row.sourceLine : NaN;
  if (!Number.isFinite(sourceLine) || sourceLine < 0) return null;
  return {
    sourceId,
    heuristicTarget: targetId,
    sourceFile,
    sourceLine,
    tier: reasonToTier(reason),
  };
}

/**
 * Map the analyzer's `reason` value to a `Tier`. The schema does
 * NOT store `tier` directly — the analyzer writes one of three
 * canonical reasons (see call-processor.ts:733) and we map those
 * onto the four-tier taxonomy.
 *
 *   reason 'same-file'        → 'same-file'
 *   reason 'import-resolved'  → 'import-scoped'
 *   reason 'fuzzy-global'     → 'global'
 *   reason '' or unknown      → 'global' (defensive default)
 *
 * Cross-repo / external edges are out of scope for this cycle —
 * they never appear in CALLS rows in the current schema, but the
 * `external` tier is reserved for future cycles and is included
 * in the per-tier report so the shape is stable.
 */
function reasonToTier(reason: string): Tier {
  if (reason === REASON_SAME_FILE) return 'same-file';
  if (reason === REASON_IMPORT_RESOLVED) return 'import-scoped';
  if (reason === REASON_FUZZY_GLOBAL) return 'global';
  // Defensive: empty / unknown reasons get bucketed as 'global'.
  // This is the safest default — it does not artificially inflate
  // the same-file or import-scoped metrics, and the report
  // surfaces the (n=0) empty buckets anyway.
  return 'global';
}

// ─── Per-edge classification ───────────────────────────────────────────

/**
 * Classify a single edge by comparing the heuristic target to
 * the LSP-resolved target. The function owns its own request
 * lifecycle; it never throws into the caller (LSP request
 * failures map to `refused`).
 *
 * Decision table:
 *
 *   | heuristic \ LSP | node X           | NO_NODE     | AMBIGUOUS  |
 *   |-----------------|------------------|-------------|------------|
 *   | null/empty      | recall-gain      | recall-miss | refused    |
 *   | node X (match)  | match            | refused     | refused    |
 *   | node Y (≠ X)    | false-confident  | refused     | refused    |
 *
 * Notes:
 *   - A refusal (NO_NODE / AMBIGUOUS) is NEVER a match. Even
 *     when the heuristic was also "null", a refusal is still a
 *     refusal — we don't double-count it as a recall-miss
 *     (Invariant 3: refuse over guess).
 *   - "heuristic null" means `heuristicTarget === ''` (the
 *     analyzer wrote a CALLS edge but could not resolve a
 *     target). The confidence column is ignored — the schema
 *     stores it, but the analyzer's "no target" signal is
 *     `targetId === ''`, not `confidence === 0`.
 */
type EdgeClass =
  | 'matches'
  | 'falseConfident'
  | 'recallMisses'
  | 'refusals'
  | 'recallGains';

async function classifyEdge(
  edge: CallEdge,
  opts: RunModeCVerifyOpts,
  timeoutMs: number,
): Promise<EdgeClass> {
  // ── Ask LSP for the definition at the call-site ──────────────────
  // We use the file URI form (with `file://` prefix) because the
  // location-mapper strips it via the same normalizer the indexer
  // used; the call-site line is 0-indexed (Invariant 5).
  const uri = `file://${edge.sourceFile}`;
  const params = {
    textDocument: { uri },
    position: { line: edge.sourceLine, character: 0 },
  };
  let locations: any = null;
  try {
    locations = await opts.client.request<any>('textDocument/definition', params, timeoutMs);
  } catch {
    // Defensive: a future LspClient bug that lets a throw
    // escape. Treat as refused (we don't crash the verifier).
    return 'refusals';
  }
  if (locations === null) {
    // LSP returned null (timeout / crash). Per the spec:
    //   "LSP maps to `null` and heuristic target is `null` → recall-miss"
    //   (any other heuristic) → refused.
    return edge.heuristicTarget === '' ? 'recallMisses' : 'refusals';
  }
  if (!Array.isArray(locations) || locations.length === 0) {
    // Empty array = LSP answered "no definition here". Treat
    // identically to `null` (per the spec the "LSP maps to
    // null" branch covers both).
    return edge.heuristicTarget === '' ? 'recallMisses' : 'refusals';
  }

  // The LSP server may return multiple locations (overload set,
  // multi-class inheritance, etc.). For Mode C we treat
  // multi-location responses as AMBIGUOUS at the LSP layer and
  // map only the FIRST to a nodeId — but we only count the
  // edge as `match` / `false-confident` when the LSP verdict
  // is single, single-resolves, and agrees with the heuristic.
  // Multiple locations → refused (the verifier cannot tell
  // which the heuristic "meant"). This is the LSP-side
  // analog of the mapper's "refuse over guess".
  let mapperResult: MapperResult;
  if (locations.length > 1) {
    // Multi-location from LSP is rare; treat as a refusal at
    // the LSP layer (NOT a false-confident) — we cannot
    // honestly attribute the heuristic edge to any single
    // target.
    return 'refusals';
  } else {
    mapperResult = await opts.mapLocationToNodeId(locations[0], opts.repoId);
  }

  // ── Map the verdict ────────────────────────────────────────────────
  const lspNode = mapperResult.kind === 'node' ? mapperResult.nodeId : null;
  const heuristicNull = edge.heuristicTarget === '';

  if (mapperResult.kind === 'NO_NODE' || mapperResult.kind === 'AMBIGUOUS') {
    // Refused. NEVER a match.
    if (heuristicNull) {
      // The heuristic also missed (or refused) — but the spec
      // says refusals NEVER double as recall-misses. A
      // recall-miss is "heuristic was null and LSP also
      // resolved to null" — but here LSP *refused*, not
      // resolved. So: refused.
      return 'refusals';
    }
    return 'refusals';
  }
  // mapperResult.kind === 'node'
  if (heuristicNull) {
    // Heuristic missed, LSP found it. This is a recall-gain —
    // the count of edges the heuristic would have under-
    // emitted had the index been LSP-augmented.
    return 'recallGains';
  }
  if (lspNode === edge.heuristicTarget) {
    return 'matches';
  }
  return 'falseConfident';
}

// ─── Metric math ───────────────────────────────────────────────────────

/**
 * Compute derived metrics (precision / recall / falseConfidentRate)
 * in place. `n === 0` is the explicit "no data" branch: the rates
 * are 0 (NOT NaN) so the report JSON is well-formed.
 *
 *   precision = matches / (matches + falseConfident)   [0 if denom 0]
 *   recall    = matches / (matches + falseConfident
 *                          + recallMisses)             [0 if denom 0]
 *   falseConfidentRate = falseConfident / n            [0 if n 0]
 */
function finalizeMetrics(m: VerifyMetrics): void {
  const preciseDenom = m.matches + m.falseConfident;
  m.precision = preciseDenom > 0 ? m.matches / preciseDenom : 0;
  const recallDenom = m.matches + m.falseConfident + m.recallMisses;
  m.recall = recallDenom > 0 ? m.matches / recallDenom : 0;
  m.falseConfidentRate = m.n > 0 ? m.falseConfident / m.n : 0;
}

/** Build an empty per-tier record with stable key order. */
function emptyPerTier(): Record<Tier, VerifyMetrics> {
  return {
    'same-file': emptyMetrics(),
    'import-scoped': emptyMetrics(),
    global: emptyMetrics(),
    external: emptyMetrics(),
  };
}

// ─── Seeded PRNG (mulberry32) — Invariant 7 ────────────────────────────

/**
 * Hash a string seed into a 32-bit integer. FNV-1a — fast, well-
 * distributed enough for sampling. Any deterministic hash works
 * here; we just need the same seed string → same integer every
 * time the function is called.
 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // Force into uint32 range.
  return h >>> 0;
}

/**
 * mulberry32 — small, fast, seedable PRNG with 2^32 period. Good
 * enough for sampling; we don't need cryptographic strength.
 *
 * Reference: https://en.wikipedia.org/wiki/Pseudorandom_number_generator
 */
function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle, in place, deterministic from the supplied
 * PRNG. The shuffle visits every position (O(n)); for the
 * sampling use case we only need the first `cap` positions, so a
 * partial Fisher–Yates would be O(cap) — but the bookkeeping
 * isn't worth the complexity for n in the low thousands, and a
 * full shuffle is the most defensible "I really am sampling from
 * the whole tier" stance for the report contract.
 */
function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// ─── Default `probe` factory (mirrors the WI-#5 contract) ─────────────

/**
 * The default probe implementation. Mirrors the contract from
 * `workspace-readiness-probe.ts` (WI-#5): the probe issues a
 * single canary `textDocument/definition` request against a known
 * sample. The verifier exposes this as a factory so callers can
 * pin a different sample or skip the call entirely.
 */
export function defaultProbe(
  client: LspClient,
  sample: { textDocument: { uri: string }; position: { line: number; character: number } },
  timeoutMs: number,
): Promise<{ ready: boolean; reason?: string }> {
  return (async () => {
    if (client.getState() !== 'ready') {
      return { ready: false, reason: 'LSP client not started' };
    }
    let result: any;
    try {
      result = await client.request('textDocument/definition', sample, timeoutMs);
    } catch {
      return { ready: false, reason: 'LSP request threw' };
    }
    if (result === null) {
      return { ready: false, reason: 'LSP request timed out or returned null' };
    }
    if (Array.isArray(result) && result.length === 0) {
      return { ready: false, reason: 'LSP returned no definitions for the canary sample' };
    }
    return { ready: true };
  })();
}

// ─── Read-only invariant self-check (Invariant 1) ─────────────────────

/**
 * Runtime self-check: assert that this module imports no write
 * API. The check is exposed as an exported function so a unit
 * test can call it (the imports list is captured at module load
 * time, when static `import` declarations have already been
 * resolved).
 *
 * What "write API" means here, concretely:
 *   - `executeQuery` (the write-mode cypher dispatch in lbug-adapter).
 *   - `addNode` / `addRelationship` (the higher-level write helpers).
 *   - `initLbug` / `initLbugWithDb` (DB lifecycle — not a "write"
 *     in the sense of mutation, but it touches the DB schema and
 *     MUST NOT be reached from the verifier).
 *   - `CYPHER_WRITE_RE` is OK as a string constant — the verifier
 *     imports it implicitly only if a future refactor pulls it
 *     in; we forbid the whole lbug-adapter write surface.
 *
 * The check is intentionally string-based (regex over the
 * module's source) because TS imports are resolved at runtime —
 * by the time the test runs, the imports are gone. The source-
 * text check pins the static surface.
 */
export function assertNoGraphWriteImports(sourceText: string): {
  ok: boolean;
  violations: string[];
} {
  // The forbidden tokens. We match imports + call sites of
  // the write APIs. The regex form `/\bname\s*\(/` matches a
  // call site; `/\bimport\b[^\n]*\bname\b/` matches an import.
  // We allow `executeParameterized` (the only read API the
  // verifier is allowed to use).
  //
  // NOTE: the regex strings themselves are excluded from the
  // source-text match by `stripSelf` below. Otherwise the
  // pattern `/\bDROP ... TABLE\b/i` would match its own source
  // text, producing a false positive on the very file that
  // defines the check.
  const FORBIDDEN = [
    /\bexecuteQuery\s*\(/,
    /\bimport\b[^\n]*\bexecuteQuery\b/,
    /\baddNode\s*\(/,
    /\baddRelationship\s*\(/,
    /\bimport\b[^\n]*\baddNode\b/,
    /\bimport\b[^\n]*\baddRelationship\b/,
    /\binitLbug\b\s*\(/,
    /\binitLbugWithDb\b\s*\(/,
    /\bDROP\s+(?:NODE\s+)?TABLE\b/i,
  ];
  const violations: string[] = [];
  // Strip the body of THIS function from the source text so the
  // regex patterns themselves don't trigger themselves. We
  // find the `assertNoGraphWriteImports` function body and
  // remove it from the input.
  const stripped = stripFunctionBody(sourceText, 'assertNoGraphWriteImports');
  for (const re of FORBIDDEN) {
    const m = stripped.match(re);
    if (m) violations.push(m[0]);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Return a copy of `src` with the body of the named exported
 * function replaced by an empty string. Used by
 * `assertNoGraphWriteImports` to keep the regex patterns from
 * matching themselves.
 *
 * Implementation: locate the `export function NAME` /
 * `function NAME` line, then walk braces until the matching
 * close brace. The slice is replaced with `/* … stripped … *​/`
 * which cannot match any of the forbidden regexes.
 */
function stripFunctionBody(src: string, name: string): string {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) return src;
  // Find the opening brace of the body.
  const openBrace = src.indexOf('{', m.index);
  if (openBrace < 0) return src;
  // Walk braces.
  let depth = 1;
  let i = openBrace + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return src.slice(0, openBrace) + '{} /* …stripped… */' + src.slice(i);
}

// ─── Re-exports for tests / advanced callers ───────────────────────────

/** Internal helpers exposed for the unit test suite. */
export const __test__ = {
  reasonToTier,
  projectEdge,
  hashSeed,
  mulberry32,
  shuffleInPlace,
  finalizeMetrics,
  emptyMetrics,
  emptyPerTier,
  classifyEdge,
  TIER_WEIGHTS,
  ALL_TIERS,
  REASON_SAME_FILE,
  REASON_IMPORT_RESOLVED,
  REASON_FUZZY_GLOBAL,
};
