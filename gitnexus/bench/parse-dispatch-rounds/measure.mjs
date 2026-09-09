/**
 * Build-free bench for parse-cache pack layout and dispatch-round cadence.
 *
 * WHY THIS EXISTS. `WorkerPool.dispatch` is a barrier: it resolves only once
 * every job it created has committed. Packs are keyed `(language,
 * sha256(path) % 128)`, so the byte budget almost never binds and most packs
 * land far below the pool size — this repo produced 1285 packs where the
 * budget alone needed 16, and 549 held a single file. Dispatching one pack at
 * a time therefore left most workers idle for every round-trip. #3194 fixed
 * fan-out WITHIN a pack; #3196 batched packs into bounded rounds and took a
 * cold analyze from 110.3s to 70.5s (221 dispatches -> 15).
 *
 * Nothing guarded that. Round boundaries are deliberately invisible to the
 * graph — batching that changed output would be a bug — so no test can see the
 * regression, and it would come back as a silent 1.5x on every cold analyze.
 * Two earlier attempts to pin this as a unit test failed for exactly that
 * reason: one scraped a logger line the progress stream does not carry, the
 * other asserted graph content that is identical either way.
 *
 * FOUR ARMS, and only the last is a timing arm:
 *
 * - `rounds` — EXACT. The regression signal. A fixed corpus and budget must
 *   produce a fixed number of rounds. Per-pack dispatch coming back sends this
 *   to `packs`; a broken close condition sends it to 1.
 *
 * - `cjk_rounds` vs `ascii_rounds` — EXACT. The round budget bounds what the
 *   MAIN THREAD HOLDS, so it must count UTF-8 bytes. `String.length` returns
 *   UTF-16 code units: a CJK character is one unit but three UTF-8 bytes, so
 *   reverting the unit would let a CJK-heavy repo hold ~3x its nominal budget
 *   before draining — the #2649 heap-failure shape. The two corpora are
 *   identical in UTF-16 length and differ only in encoded size, so under
 *   `String.length` they would close the SAME number of rounds. Only a UTF-8
 *   count separates them.
 *
 * - `packs` / `single_file_packs` — EXACT, and they are the FLOOR. `rounds`
 *   only asserts something while the corpus over-splits (774 packs where the
 *   byte budget alone needs 5). Shrink the corpus past that and `rounds` still
 *   reads 5 and still passes, gating a property the corpus no longer has.
 *   bench/import-target learned this when four heap arms read 0 B and passed.
 *
 * - `pack_scaling_ratio` — the only timing arm, and a RATIO not a millisecond
 *   ceiling. (t_4n/t_n)/4 divides the machine out; ~1.0 is linear. A fixed ms
 *   budget on a shared runner is a coin flip, and this repo has the scar:
 *   bench/callable-value-flow's gate failed twice at 2.07 and 1.975 against a
 *   1.9 budget with correct code, on a sub-11ms measurement. Catches
 *   `packParseCacheChunks` going superlinear; not tight enough to police drift.
 *
 * Usage:
 *   node --import tsx bench/parse-dispatch-rounds/measure.mjs           # report
 *   node --import tsx bench/parse-dispatch-rounds/measure.mjs --check   # CI gate
 */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { packParseCacheChunks } from '../../src/storage/parse-cache.js';
import { createRoundBudget } from '../../src/core/ingestion/pipeline-phases/parse-round-budget.js';

const baselines = JSON.parse(
  new URL('./baselines.json', import.meta.url).pathname
    ? readFileSync(new URL('./baselines.json', import.meta.url), 'utf8')
    : '{}',
);

/** Matches DEFAULT_CHUNK_BYTE_BUDGET / the round budget's default in parse-impl.ts. */
const BUDGET = 2 * 1024 * 1024;

/**
 * A repo shaped like a real one: many languages, so `(language, bucket)`
 * packing over-splits well past what the byte budget alone would need. Sizes
 * are deliberately uneven — a uniform corpus hides an off-by-one in the fold.
 */
function mixedCorpus(scale = 1) {
  const langs = [
    ['ts', 900],
    ['py', 400],
    ['java', 260],
    ['go', 240],
    ['rb', 120],
    ['rs', 180],
    ['php', 90],
    ['cs', 140],
  ];
  const files = [];
  for (const [ext, count] of langs) {
    for (let i = 0; i < count * scale; i++) {
      files.push({
        path: `src/${ext}/mod${i}.${ext}`,
        // 400B - 8KB, varying by index so packs are not uniform.
        size: 400 + ((i * 977) % 7700),
        language: ext,
      });
    }
  }
  return files;
}

/** Feed chunks through the real accumulator and count the rounds it closes. */
function roundsFor(chunks, contentsByPath, budgetBytes) {
  const budget = createRoundBudget(budgetBytes);
  let rounds = 0;
  for (const chunk of chunks) {
    if (budget.addChunk(chunk.map((p) => contentsByPath.get(p)))) rounds++;
  }
  // The tail drain closes a partially-filled round when anything is left.
  if (budget.bufferedBytes > 0) rounds++;
  return rounds;
}

/**
 * Two corpora with IDENTICAL UTF-16 length and different UTF-8 size. Under
 * `String.length` both close the same number of rounds; under UTF-8 the CJK
 * one closes strictly more.
 */
function encodingCorpora() {
  // 1 UTF-16 unit / 3 UTF-8 bytes each, vs 1 unit / 1 byte each.
  const cjkLine = '説'.repeat(240);
  const asciiLine = 'a'.repeat(240);
  const count = 260;
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/enc/mod${i}.ts`,
    size: 240,
    language: 'ts',
  }));
  const chunks = packParseCacheChunks(files, BUDGET);
  const cjk = new Map(files.map((f) => [f.path, cjkLine]));
  const ascii = new Map(files.map((f) => [f.path, asciiLine]));
  // A budget small enough that both corpora close several rounds.
  const encBudget = 24 * 1024;
  return {
    utf16Length: cjkLine.length === asciiLine.length,
    cjkRounds: roundsFor(chunks, cjk, encBudget),
    asciiRounds: roundsFor(chunks, ascii, encBudget),
  };
}

/**
 * Min-of-N estimator. `fastest` rather than a mean because the minimum is the
 * least contaminated sample on a shared runner — the same choice, and the same
 * reason, as bench/import-target's `fastest()`.
 */
function fastest(fn, reps) {
  fn(); // warm
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const REPS = 15;

const corpus = mixedCorpus();
const corpus4x = mixedCorpus(4);

const packs = packParseCacheChunks(corpus, BUDGET);
// A RATIO, not a millisecond ceiling. Wall-clock is runner-speed-dependent and
// a fixed ms budget on a shared runner is a coin flip — this file's sibling
// benches record exactly that failure. (t_4n / t_n) / 4 divides the machine
// out: ~1.0 is linear, and packParseCacheChunks going superlinear (it sorts
// within each bucket) shows up here regardless of how fast the box is.
const smallMs = fastest(() => packParseCacheChunks(corpus, BUDGET), REPS);
const largeMs = fastest(() => packParseCacheChunks(corpus4x, BUDGET), REPS);
const packScaling = largeMs / smallMs / 4;

const contents = new Map(corpus.map((f) => [f.path, 'x'.repeat(f.size)]));
const rounds = roundsFor(packs, contents, BUDGET);

const enc = encodingCorpora();

/**
 * Order-independent hash of the pack layout: which files share a pack, and in
 * what order within it. Catches a packing change that leaves the counts intact
 * but moves files between packs — which would silently change every cache key.
 */
const layoutFingerprint = createHash('sha256')
  .update(
    packs
      .map((chunk) => chunk.join(','))
      .sort()
      .join('\n'),
  )
  .digest('hex');

const singleFilePacks = packs.filter((c) => c.length === 1).length;
const totalBytes = corpus.reduce((sum, f) => sum + f.size, 0);
const budgetFloor = Math.ceil(totalBytes / BUDGET);

console.log(`files                  : ${corpus.length}`);
console.log(
  `packs                  : ${packs.length}  (expect ${baselines.packs}; byte budget alone needs ${budgetFloor})`,
);
console.log(`rounds                 : ${rounds}  (expect ${baselines.rounds})`);
console.log(`single_file_packs      : ${singleFilePacks}  (expect ${baselines.single_file_packs})`);
console.log(`cjk_rounds             : ${enc.cjkRounds}  (UTF-8 bytes)`);
console.log(`ascii_rounds           : ${enc.asciiRounds}  (same UTF-16 length)`);
console.log(`layout_fingerprint     : ${layoutFingerprint.slice(0, 16)}`);
console.log(
  `pack_scaling_ratio     : ${packScaling.toFixed(3)}  (budget <= ${baselines.pack_scaling_budget}; ~1.0 is linear)`,
);
console.log(
  `reps                   : ${REPS}   small ${smallMs.toFixed(2)}ms / 4x ${largeMs.toFixed(2)}ms`,
);

if (process.argv.includes('--check')) {
  let failed = false;

  if (layoutFingerprint !== baselines.layout_fingerprint) {
    failed = true;
    console.error(
      `\nFAIL layout_fingerprint: ${layoutFingerprint}\n` +
        `  expected ${baselines.layout_fingerprint}\n` +
        `  Pack membership moved. Every parse-cache key is derived from a pack's\n` +
        `  file set, so this invalidates every cached chunk for every user. If the\n` +
        `  change is intended, it needs a SCHEMA_BUMP in src/storage/parse-cache.ts\n` +
        `  alongside a new fingerprint here — never re-baseline it alone.`,
    );
  }

  if (rounds !== baselines.rounds) {
    failed = true;
    console.error(
      `\nFAIL rounds: ${rounds}, expected exactly ${baselines.rounds}.\n` +
        `  HIGHER (toward packs=${packs.length}) means rounds stopped batching and\n` +
        `  dispatch went back to one barrier per cache pack — the #3196 regression,\n` +
        `  worth ~1.5x on a cold analyze with no visible symptom.\n` +
        `  LOWER (toward 1) means the close condition stopped firing, so an open\n` +
        `  round retains the whole repo until the tail drain (#2649 heap shape).\n` +
        `  Check createRoundBudget in pipeline-phases/parse-round-budget.ts.`,
    );
  }

  if (!enc.utf16Length) {
    failed = true;
    console.error(
      `\nFAIL encoding arm is broken: its two corpora no longer share a UTF-16 length.`,
    );
  } else if (enc.cjkRounds <= enc.asciiRounds) {
    failed = true;
    console.error(
      `\nFAIL cjk_rounds ${enc.cjkRounds} <= ascii_rounds ${enc.asciiRounds}.\n` +
        `  These corpora have identical UTF-16 length and differ only in encoded\n` +
        `  size, so equal round counts mean the budget is counting String.length\n` +
        `  again instead of Buffer.byteLength. A CJK-heavy repo would then hold\n` +
        `  ~3x its nominal budget on the main thread before draining.\n` +
        `  See roundFileBytes in pipeline-phases/parse-round-budget.ts.`,
    );
  }

  // SHAPE — the floor. Without it every arm below is a ceiling over nothing:
  // shrink the corpus until packing stops over-splitting and `rounds` still
  // reads 5 and still passes, asserting a property the corpus no longer has.
  if (packs.length !== baselines.packs || singleFilePacks !== baselines.single_file_packs) {
    failed = true;
    console.error(
      `\nFAIL shape: packs ${packs.length} (expected ${baselines.packs}), ` +
        `single_file_packs ${singleFilePacks} (expected ${baselines.single_file_packs}).\n` +
        `  The corpus must stay one that OVER-SPLITS — ${packs.length} packs where the\n` +
        `  byte budget alone needs ${budgetFloor}. That gap is the entire reason rounds\n` +
        `  exist, so if it closes, the rounds arm below asserts nothing.`,
    );
  }

  if (packScaling > baselines.pack_scaling_budget) {
    failed = true;
    console.error(
      `\nFAIL pack_scaling_ratio: ${packScaling.toFixed(3)} exceeds ` +
        `${baselines.pack_scaling_budget} (~1.0 is linear).\n` +
        `  packParseCacheChunks grew superlinearly in file count — it sorts within\n` +
        `  each bucket, so a global sort or a nested scan lands here.\n` +
        `  This is the ONLY timing arm in this file: re-run on an idle machine\n` +
        `  before investigating, and check \`reps\` in the report first.`,
    );
  }

  if (failed) process.exit(1);
  console.log('\nOK — within budget.');
}
