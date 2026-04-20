/**
 * Shadow-mode parity harness — dual-run observability for the RFC #909
 * registry rollout (RFC §6.3; Ring 2 PKG #923).
 *
 * ## What it does
 *
 *   - Exposes `record({ language, callsite, legacy, newResult })` for
 *     every call site where the caller has BOTH a legacy-DAG resolution
 *     and a new `Registry.lookup` resolution.
 *   - Computes a `ShadowDiff` per record via shared `diffResolutions`
 *     (#918) and accumulates them in a per-language bucket.
 *   - At the end of a run, aggregates into a `ShadowParityReport` via
 *     shared `aggregateDiffs` (#918) — per-language parity %,
 *     evidence-kind breakdown of divergences, grand-total overall row.
 *   - Optionally persists the report as JSON under
 *     `.gitnexus/shadow-parity/` so the static dashboard at
 *     `gitnexus/shadow-parity-dashboard/` can render it offline.
 *
 * ## What it does NOT do
 *
 *   - **Invoke either resolution path itself.** The caller must run
 *     legacy + `Registry.lookup` and pass results in. The harness is a
 *     side-car, not a dispatcher — this keeps call-processor integration
 *     surgical when it lands (tracked as a follow-up; the shared model
 *     doesn't dual-invoke on its own).
 *   - **Flip anything.** `REGISTRY_PRIMARY_<LANG>` lives in
 *     `registry-primary-flag.ts` (#924); the harness records the
 *     caller-supplied "which side is primary" bit for each record so the
 *     dashboard can label rows, but it does not consult the flag itself.
 *
 * ## Activation
 *
 * `GITNEXUS_SHADOW_MODE=1` (or `'true'`, `'yes'`, case-insensitive,
 * trimmed) enables the harness. When disabled, `record()` is a cheap
 * no-op: no accumulation, no allocation beyond the harness object
 * itself. Callers can always construct a harness and hand it through;
 * the "off" overhead is near-zero.
 *
 * ## Persistence shape
 *
 * When `persist()` is called, the harness writes TWO files:
 *
 *   - `<outputDir>/<runId>.json` — the timestamped snapshot (immutable)
 *   - `<outputDir>/latest.json`  — a pointer that the dashboard reads
 *
 * Both files contain the same `PersistedShadowReport` payload:
 *
 *   {
 *     schemaVersion: 1,
 *     runId: "<iso-8601>-<rand>",
 *     generatedAt: "<iso-8601>",
 *     primaryByLanguage: { [lang]: "legacy" | "registry" },
 *     report: <ShadowParityReport>
 *   }
 *
 * Schema-version-gated so future format changes don't silently confuse
 * older dashboards. The dashboard renders `report.perLanguage` rows and
 * annotates each with `primaryByLanguage[lang]`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  aggregateDiffs,
  diffResolutions,
  type Resolution,
  type ShadowCallsite,
  type ShadowDiff,
  type ShadowParityReport,
  type SupportedLanguages,
} from 'gitnexus-shared';

// ─── Public API ────────────────────────────────────────────────────────────

/** Which side of the dual-run is considered authoritative for this language. */
export type PrimarySide = 'legacy' | 'registry';

/** One record per call site the caller dual-runs. */
export interface ShadowRecordInput {
  readonly language: SupportedLanguages;
  readonly callsite: ShadowCallsite;
  readonly legacy: readonly Resolution[];
  readonly newResult: readonly Resolution[];
  /**
   * Which side drove the actual runtime answer for this record. Lets the
   * dashboard distinguish "registry-primary, legacy is shadow" from the
   * default "legacy-primary, registry is shadow" without re-reading
   * `REGISTRY_PRIMARY_<LANG>` env vars at render time.
   */
  readonly primary: PrimarySide;
}

/** Persisted JSON shape. Schema-versioned for future migrations. */
export interface PersistedShadowReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly primaryByLanguage: Readonly<Partial<Record<SupportedLanguages, PrimarySide>>>;
  readonly report: ShadowParityReport;
}

export interface ShadowHarness {
  /** `true` iff `GITNEXUS_SHADOW_MODE` is truthy. When `false`, `record()` is a no-op. */
  readonly enabled: boolean;
  /** Accumulate a dual-run observation. No-op when `enabled === false`. */
  record(input: ShadowRecordInput): void;
  /** Number of records accumulated so far. Useful for diagnostics / tests. */
  size(): number;
  /**
   * Aggregate the accumulated records into a `ShadowParityReport`
   * without persisting. Returns a deterministic snapshot each call;
   * idempotent with respect to `record()` ordering.
   */
  snapshot(now?: Date): ShadowParityReport;
  /**
   * Write the aggregated snapshot to JSON. Resolves to the path of the
   * per-run file. Also writes/overwrites `latest.json` alongside.
   *
   * Creates `outputDir` if it doesn't exist.
   */
  persist(outputDir: string, now?: Date): Promise<string>;
  /** Reset the accumulator. Preserves `enabled`. */
  clear(): void;
}

/**
 * Construct a harness. Reads `GITNEXUS_SHADOW_MODE` at construction time
 * (not per-`record()` call) so repeated no-op records don't re-check the
 * env var in the hot path.
 */
export function createShadowHarness(): ShadowHarness {
  const enabled = parseShadowModeEnv(process.env['GITNEXUS_SHADOW_MODE']);

  interface Accumulated {
    readonly language: SupportedLanguages;
    readonly diff: ShadowDiff;
  }
  const records: Accumulated[] = [];
  const primaryByLanguage: Partial<Record<SupportedLanguages, PrimarySide>> = {};

  const recordImpl = (input: ShadowRecordInput): void => {
    if (!enabled) return;
    const diff = diffResolutions(input.callsite, input.legacy, input.newResult);
    records.push({ language: input.language, diff });
    // Primary per-language is resolved by last-write. In practice a run
    // is single-threaded with respect to flag readings, so this is
    // deterministic; a language's primary cannot change mid-run.
    primaryByLanguage[input.language] = input.primary;
  };

  const snapshotImpl = (now: Date = new Date()): ShadowParityReport => {
    return aggregateDiffs(records, now);
  };

  const persistImpl = async (outputDir: string, now: Date = new Date()): Promise<string> => {
    await fs.mkdir(outputDir, { recursive: true });
    const report = snapshotImpl(now);
    const runId = makeRunId(now);
    const payload: PersistedShadowReport = {
      schemaVersion: 1,
      runId,
      generatedAt: now.toISOString(),
      primaryByLanguage,
      report,
    };
    const json = JSON.stringify(payload, null, 2);
    const perRunPath = path.join(outputDir, `${runId}.json`);
    const latestPath = path.join(outputDir, 'latest.json');
    await fs.writeFile(perRunPath, json, 'utf8');
    await fs.writeFile(latestPath, json, 'utf8');
    return perRunPath;
  };

  const clearImpl = (): void => {
    records.length = 0;
    for (const key of Object.keys(primaryByLanguage)) {
      delete primaryByLanguage[key as SupportedLanguages];
    }
  };

  return {
    enabled,
    record: recordImpl,
    size: () => records.length,
    snapshot: snapshotImpl,
    persist: persistImpl,
    clear: clearImpl,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Env-var parser for `GITNEXUS_SHADOW_MODE`. Accepts the same truthy
 * conventions as `REGISTRY_PRIMARY_<LANG>` from #924: `'true'` / `'1'` /
 * `'yes'`, case-insensitive, whitespace-trimmed. Anything else — including
 * `undefined`, `''`, `'false'`, `'off'`, typos — is false.
 */
function parseShadowModeEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Deterministic run id derived from the timestamp plus 4 random bytes
 * of entropy. The timestamp comes first so files sort chronologically;
 * the entropy suffix prevents collisions when multiple runs share a
 * clock-second. Shape: `YYYYMMDD-HHMMSS-xxxxxxxx`.
 */
function makeRunId(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  const h = now.getUTCHours().toString().padStart(2, '0');
  const min = now.getUTCMinutes().toString().padStart(2, '0');
  const s = now.getUTCSeconds().toString().padStart(2, '0');
  const entropy = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${y}${m}${d}-${h}${min}${s}-${entropy}`;
}
