// Pure, side-effect-free verdict classifier for the FTS evict→reload RSS bench
// (fts-evict-reload-rss.mjs). Extracted so it can be unit-tested WITHOUT importing
// the native LadybugDB addon or running the bench — this module has zero imports
// and zero module-scope side effects. Do not add imports or top-level statements.
//
// The discriminant between a real leak and allocator warmup is SLOPE DECELERATION,
// not total delta. A true per-reload leak (stranded FTS arena) rises ~linearly:
// the second-half slope stays ≈ the first-half slope. Allocator working-set warmup
// rises then flattens: the second-half slope decays to a fraction of the first.
//
// Thresholds:
//   EPSILON (~0.1 MB/cycle) — below this the tail is effectively flat (no leak).
//   SUSTAIN_FLOOR (0.5 MB/cycle) — the base noise floor.
//   The floor SCALES with the working-set growth (peak − baseline), NOT the pre-DB
//     `baseline` RSS: baseline is interpreter/addon overhead (and is LARGER in
//     --via-pool mode), so a baseline-keyed floor would inflate and HIDE leaks. A
//     bigger fixture has a bigger arena and bigger per-cycle noise, so the floor
//     rises with the working set: floor = SUSTAIN_FLOOR · max(1, (peak−baseline)/REF).

export const EPSILON_MB_PER_CYCLE = 0.1;
export const SUSTAIN_FLOOR = 0.5;
// Reference working-set (MB) at which the floor equals SUSTAIN_FLOOR; the floor
// scales up linearly for larger arenas. ~200 MB ≈ a small FTS fixture's footprint.
export const FLOOR_REF_WORKINGSET_MB = 200;

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function slopeMbPerCycle(series) {
  // Least-squares slope of rss vs cycle index.
  const n = series.length;
  if (n < 2) return 0;
  const xs = series.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (series[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Classify an RSS-per-cycle series into PLATEAU / CLIMB / INCONCLUSIVE.
 * Pure: no I/O, no globals. `baseline` is the pre-DB RSS; `peak` defaults to the
 * series max. Returns the label plus the diagnostics the bench prints.
 */
export function classifyVerdict(series, baseline, peak = Math.max(...series)) {
  const cycles = series.length;
  const half = Math.max(1, Math.floor(cycles / 2));
  const firstHalfSlope = slopeMbPerCycle(series.slice(0, half));
  const secondHalfSlope = slopeMbPerCycle(series.slice(-half));
  const decelRatio = secondHalfSlope / Math.max(firstHalfSlope, 1e-9);

  // Step discontinuity: a single cycle-to-cycle jump far larger than the typical
  // per-cycle delta — a one-time allocator/arena reservation (then flat), not a
  // per-reload leak, but a noisy run we won't claim a clean result on.
  const deltas = series.slice(1).map((v, i) => v - series[i]);
  const absDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
  const medAbsDelta = absDeltas.length ? absDeltas[Math.floor(absDeltas.length / 2)] : 0;
  const maxJump = deltas.length ? Math.max(...deltas) : 0;
  const stepDiscontinuity = maxJump > Math.max(30, 5 * Math.max(medAbsDelta, 1));

  // Working-set-scaled floor (see header). Guard against a negative working set.
  const workingSet = Math.max(0, peak - baseline);
  const floor = SUSTAIN_FLOOR * Math.max(1, workingSet / FLOOR_REF_WORKINGSET_MB);

  const SUSTAINED = 0.6; // decelRatio at/above which the tail is "not decaying"
  let verdict;
  if (stepDiscontinuity) {
    verdict = 'INCONCLUSIVE';
  } else if (secondHalfSlope < EPSILON_MB_PER_CYCLE) {
    // Effectively flat — no leak, regardless of decelRatio (a flat-from-start run
    // has decelRatio ≈ 1 but is still PLATEAU). This gate is what keeps a true
    // negative from being over-corrected into INCONCLUSIVE.
    verdict = 'PLATEAU';
  } else if (secondHalfSlope >= floor) {
    // Tail is still substantial: sustained → real leak; decelerating → unresolved.
    verdict = decelRatio >= SUSTAINED ? 'CLIMB' : 'INCONCLUSIVE';
  } else if (decelRatio < SUSTAINED) {
    // Below the floor AND decelerating — warmup converged toward flat → PLATEAU.
    verdict = 'PLATEAU';
  } else {
    // Below the floor but SUSTAINED — a slow steady creep RSS can't distinguish
    // from noise at this scale. The honest label is "not resolved", NEVER a clean
    // PLATEAU ("no leak"). This is the headline tri-review fix.
    verdict = 'INCONCLUSIVE';
  }

  return {
    verdict,
    firstHalfSlope,
    secondHalfSlope,
    decelRatio,
    floor,
    stepDiscontinuity,
    maxJump,
    peak,
  };
}
