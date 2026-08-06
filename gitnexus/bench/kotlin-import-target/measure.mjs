/**
 * Build-free identity + scaling bench for `resolveKotlinImportTarget`, the
 * Kotlin import resolver.
 *
 * Before this bench's companion change the resolver walked the ENTIRE
 * `allFilePaths` Set on every import. Its four tiers — exact/suffix,
 * directory child, package fan-out, progressive prefix strip — each ran
 * `for (const raw of allFilePaths)` with a `replace(/\\/g, '/')` and several
 * string comparisons per entry, and they are tried in cascade, so one
 * unresolved import cost two to four full passes. Resolution was therefore
 * O(imports x files). Once a repository reaches tens of thousands of Kotlin
 * files that is on the order of 10^10 string operations on one thread:
 * `analyze` sits at exactly 1.00 core with a flat heap and emits nothing for
 * hours, because every allocation is a short-lived string and nothing
 * accumulates to hint at progress.
 *
 * This is the same shape #1918 fixed for Python and #2788 for C++, and it
 * returns the same way: someone adds a tier, reaches for `allFilePaths`, and
 * writes a loop. Neither existing gate can catch it here —
 * `bench/python-scope/import-target-fingerprint.mjs` drives the Python
 * resolver only, and `bench/scope-capture/measure.mjs` fingerprints
 * `emit<Lang>ScopeCaptures`, a different function that never calls import
 * resolution. Hence this bench, in an always-on CI step.
 *
 * TWO ARMS, and they fail for opposite reasons:
 *
 *   - `fingerprint` — a sha256 over every `fromFile | targetRaw -> result`
 *     triple the correctness corpus resolves (an exhaustive branch matrix plus
 *     a deterministic fuzz). This is a CORRECTNESS gate. Drift means Kotlin
 *     imports started resolving a DIFFERENT file set, i.e. CALLS/IMPORTS edges
 *     moved in every Kotlin repository. It is deterministic: a re-run never
 *     changes it, and it must never be re-baselined to make CI green. This
 *     value is the one the pre-index implementation produced — see
 *     `_provenance` in baselines.json.
 *
 *   - `scaling_ratio` — `(t_large/t_small)/(LARGE/SMALL)` over a synthetic
 *     Kotlin monorepo at two scales, timing the index build TOGETHER with
 *     resolving every import. ~1.0 is linear; a reintroduced per-import scan
 *     measures ~4 at this scale gap. This is a TIMING gate: re-run it on an
 *     idle machine before investigating.
 *
 * Three properties of the corpora are load-bearing and must not be
 * "simplified" away:
 *
 *   1. **The correctness corpus fuzzes each file set in BOTH iteration
 *      orders.** Every tie-break in this resolver is expressed only through
 *      Set-iteration order — "first suffix match wins", and the two stem maps
 *      keeping the FIRST path inserted per key. A single-order corpus scores an
 *      implementation that keeps the LAST match identically.
 *   2. **The correctness corpus contains repeated directory names where the
 *      first occurrence is not the parent** (`data/src/main/kotlin/com/example/
 *      data/Repo.kt`). The pre-index scan tested `startsWith` and then used
 *      `indexOf`, so it only ever considered the FIRST `/dir/`; that file is
 *      therefore NOT a child of `data`. The index reproduces it deliberately.
 *      Without these shapes the fingerprint cannot tell the preserved rule from
 *      the intuitive one.
 *   3. **~40% of the scaling corpus's imports are unresolvable.** The old cost
 *      was worst when nothing matched, because only then did all four tiers
 *      run. A corpus where every import hits tier 1 exits after one pass and
 *      scores a per-import scan far closer to linear.
 *
 * Run:
 *   node --import tsx bench/kotlin-import-target/measure.mjs            # report
 *   node --import tsx bench/kotlin-import-target/measure.mjs --check    # CI gate
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKotlinImportTarget } from '../../src/core/ingestion/languages/kotlin/import-target.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 400;
const LARGE = 1600;
/** Imports per file. Keeps the import count proportional to the file count, so
 *  a per-import workspace scan shows up as a quadratic ratio rather than being
 *  amortized away by a fixed import budget. Sized so the SMALL arm measures in
 *  the tens of ms: at ~2 ms timer granularity and JIT warm-up, not scaling, set
 *  the ratio — the same artifact bench/cpp-qualified-ns documents. */
const IMPORTS_PER_FILE = 32;
const WARMUP = 2;
const REPS = 7;

// ---------------------------------------------------------------------------
// Correctness arm
// ---------------------------------------------------------------------------

const lines = [];
let nonNull = 0;

function resolve(files, targetRaw, fromFile) {
  return resolveKotlinImportTarget(
    { kind: 'named', localName: 'X', importedName: 'X', targetRaw },
    { fromFile, allFilePaths: new Set(files) },
  );
}

/** Record one case in BOTH file-set iteration orders — see header property 1. */
function record(files, targetRaw, fromFile = 'App.kt') {
  for (const [order, list] of [
    ['fwd', files],
    ['rev', [...files].reverse()],
  ]) {
    const r = resolve(list, targetRaw, fromFile);
    if (r !== null) nonNull++;
    const rendered = r === null ? 'NULL' : Array.isArray(r) ? `[${r.join(',')}]` : r;
    lines.push(`${order}\t${fromFile}\t${targetRaw}\t${rendered}`);
  }
}

// ---- 1. Exhaustive branch matrix ------------------------------------------

// Tier 1, exact.
record(['util/User.kt', 'util/Repo.kt'], 'util.User');
// Tier 1, suffix (import is not workspace-rooted).
record(['src/main/kotlin/util/User.kt'], 'util.User');
// Exact anywhere beats a suffix found earlier.
record(['deep/util/User.kt', 'util/User.kt'], 'util.User');
// No exact match: first suffix in iteration order wins.
record(['a/util/User.kt', 'b/util/User.kt'], 'util.User');
// .kt / .kts sharing a stem.
record(['dup/Thing.kt', 'dup/Thing.kts'], 'dup.Thing');
// Multi-segment suffix query.
record(['src/main/com/example/User.kt'], 'com.example.User');
record(['a/b/com/example/User.kt', 'com/example/User.kt'], 'com.example.User');
// Tier 2: stripped path matches a file (class-or-object holding the member).
record(['util/OneArg.kt'], 'util.OneArg.writeAudit');
record(['src/main/kotlin/util/OneArg.kt'], 'util.OneArg.writeAudit');
// Tier 3: package fan-out to every direct child, in order.
record(['models/User.kt', 'models/Repo.kt', 'models/sub/Deep.kt'], 'models.getRepo');
record(['models/User.kt', 'models/sub/Deep.kt', 'models/Repo.kt'], 'models.getRepo');
// Fan-out where the package directory is reached by suffix, not at the root.
record(['app/src/main/kotlin/models/User.kt', 'app/src/main/kotlin/models/Repo.kt'], 'models.get');
// Tier 4: progressive prefix strip, one and several skip levels.
record(['x/y/z/Deep.kt'], 'com.example.z.Deep');
record(['z/Deep.kt'], 'a.b.c.d.z.Deep');
record(['q/Deep.kt'], 'a.b.c.d.e.f.q.Deep');
// Tier 4 reaching the fan-out tier after stripping.
record(['pkg/A.kt', 'pkg/B.kt'], 'com.example.pkg.someFunction');
// Backslash normalization.
record(['win\\pkg\\A.kt'], 'win.pkg.A');
record(['win\\pkg\\A.kt', 'win\\pkg\\B.kt'], 'win.pkg.someFunction');
// Non-Kotlin files never resolve.
record(['pkg/A.java', 'pkg/A.md', 'pkg/A.kt.txt'], 'pkg.A');
// Kotlin file alongside non-Kotlin noise of the same stem.
record(['pkg/A.java', 'pkg/A.kt'], 'pkg.A');
// Header property 2: repeated directory name, first occurrence is not the parent.
record(['data/src/main/kotlin/com/example/data/Repo.kt'], 'data.something');
record(['data/src/main/kotlin/com/example/data/Repo.kt'], 'data.Repo');
record(['a/c/b/c/File.kt'], 'c.X');
record(['c/b/c/File.kt'], 'c.X');
// Doubly nested same-name directory, both below the root.
record(['top/data/mid/data/Repo.kt'], 'data.something');
// A path starting with the directory name is not its child unless direct.
record(['data/sub/Repo.kt'], 'data.something');
record(['data/Repo.kt'], 'data.something');
// Repo-root file has no package directory.
record(['Root.kt'], 'Root');
record(['Root.kt', 'pkg/Root.kt'], 'Root');
// Wildcard: `.*` is stripped and lands on the single-file tier, not fan-out.
record(['models/User.kt', 'models/Repo.kt'], 'models.*');
record(['models/Repo.kt', 'models/User.kt'], 'models.*');
record(['util/User.kt'], 'util.User.*');
// Unknown target.
record(['pkg/A.kt'], 'nowhere.Thing');
// Single-segment target with no directory anywhere.
record(['pkg/A.kt'], 'A');
// Empty-ish and degenerate targets.
record(['pkg/A.kt'], '*');
record(['pkg/A.kt'], 'pkg.');
// fromFile variation must not change the outcome (this resolver ignores it) —
// pinned so a future change that starts consulting it is visible here.
record(['util/User.kt'], 'util.User', 'deep/nested/Caller.kt');

// ---- 2. Deterministic fuzz -------------------------------------------------

/** xorshift32 — seeded, so the corpus is identical on every machine. */
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

const DIRS = [
  '',
  'app',
  'core',
  'data',
  'feature/home',
  'lib/data',
  'src/main/kotlin',
  'src/main/kotlin/com/example',
  'module/src/main/kotlin/com/example/data',
  'data/src/main/kotlin/com/example/data',
  'top/data/mid/data',
  'win\\pkg',
];
const SEGS = ['User', 'Repo', 'Util', 'Service', 'Model', 'data', 'core', 'api', 'store', 'sub'];
const EXTS = ['.kt', '.kt', '.kt', '.kts', '.java', '.md'];

function randPath() {
  const dir = pick(DIRS);
  const base = pick(SEGS);
  const file = `${base}${pick(EXTS)}`;
  if (dir === '') return file;
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`;
}
function randDotted() {
  const n = 1 + Math.floor(rnd() * 4);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(SEGS));
  return rnd() < 0.12 ? `${parts.join('.')}.*` : parts.join('.');
}

for (let repo = 0; repo < 400; repo++) {
  const fileCount = 3 + Math.floor(rnd() * 14);
  const files = [];
  for (let i = 0; i < fileCount; i++) files.push(randPath());
  const fromFile = randPath();
  for (let imp = 0; imp < 25; imp++) record(files, randDotted(), fromFile);
}

const correctnessFingerprint = crypto
  .createHash('sha256')
  .update([...lines].sort().join('\n'))
  .digest('hex');

// ---------------------------------------------------------------------------
// Scaling arm
// ---------------------------------------------------------------------------

/** A synthetic Kotlin monorepo: Gradle-module roots over a shared package
 *  namespace, at the path depth real Kotlin source has (the index stores one
 *  suffix entry per '/' in a stem, so depth is a cost driver and a flat corpus
 *  would understate the build). */
function buildCorpus(fileCount) {
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const mod = i % 16;
    files.push(`lib${mod}/src/main/kotlin/com/example/mod${mod}/Class${i}.kt`);
  }
  return files;
}

/** Import targets for the corpus, ~40% of them unresolvable — see header
 *  property 3: only a miss drives all four tiers, which is where the
 *  per-import scan was worst. */
function buildImports(fileCount) {
  const imports = [];
  for (let i = 0; i < fileCount * IMPORTS_PER_FILE; i++) {
    const kind = i % 5;
    const mod = i % 16;
    if (kind === 0)
      imports.push(`com.example.mod${mod}.Class${i % fileCount}`); // tier 1 hit
    else if (kind === 1)
      imports.push(`com.example.mod${mod}.someFunction`); // fan-out
    else if (kind === 2)
      imports.push(`mod${mod}.Class${i % fileCount}`); // suffix
    else imports.push(`org.absent.pkg${mod}.Missing${i}`); // full cascade, no hit
  }
  return imports;
}

function fastest(values) {
  return Math.min(...values);
}

/**
 * Time one full pass: the index build PLUS resolving every import. The build is
 * the work the per-import scan was traded for, so hiding it would let an index
 * that is itself quadratic pass. Each pass gets its own Set object, because the
 * index is memoized on Set identity and a shared Set would build once and make
 * every later pass free. The Sets are constructed OUTSIDE the timer so their
 * own O(files) cost never lands in the measurement.
 */
function timeResolution(files, imports) {
  const sets = [];
  for (let i = 0; i < WARMUP + REPS; i++) sets.push(new Set(files));
  const fromFile = files[0];

  for (let w = 0; w < WARMUP; w++) {
    for (const t of imports) {
      resolveKotlinImportTarget(
        { kind: 'named', localName: 'X', importedName: 'X', targetRaw: t },
        { fromFile, allFilePaths: sets[w] },
      );
    }
  }
  const samples = [];
  for (let r = 0; r < REPS; r++) {
    const set = sets[WARMUP + r];
    const t0 = performance.now();
    for (const t of imports) {
      resolveKotlinImportTarget(
        { kind: 'named', localName: 'X', importedName: 'X', targetRaw: t },
        { fromFile, allFilePaths: set },
      );
    }
    samples.push(performance.now() - t0);
  }
  return fastest(samples);
}

const scales = {};
for (const [name, fileCount] of [
  ['small', SMALL],
  ['large', LARGE],
]) {
  const files = buildCorpus(fileCount);
  const imports = buildImports(fileCount);
  scales[name] = {
    files: fileCount,
    imports: imports.length,
    ms: Number(timeResolution(files, imports).toFixed(3)),
  };
}

const scalingRatio = scales.large.ms / scales.small.ms / (LARGE / SMALL);

const report = {
  small: scales.small,
  large: scales.large,
  scaling_ratio: Number(scalingRatio.toFixed(3)),
  // Reported, not asserted: a corpus edit that collapses the resolved surface
  // still produces a "valid" fingerprint over far less, so these make the
  // shrink visible in the diff.
  cases: lines.length,
  non_null: nonNull,
  fingerprint: correctnessFingerprint,
};

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];
if (report.fingerprint !== baseline.fingerprint) {
  failures.push(
    `fingerprint drift: ${report.fingerprint} != ${baseline.fingerprint} — Kotlin import ` +
      `resolution returned a DIFFERENT file set. That is a behaviour change, not a perf one: ` +
      `IMPORTS/CALLS edges move in every Kotlin repository. Explain it, never re-baseline to ` +
      `make CI green.`,
  );
}
if (report.cases !== baseline.cases) {
  failures.push(
    `case count ${report.cases} != ${baseline.cases} — the corpus itself changed, so the ` +
      `fingerprint above is computed over a different surface and proves nothing about the ` +
      `resolver. Re-baseline both fields together, deliberately.`,
  );
}
if (report.scaling_ratio > baseline.scaling_budget) {
  failures.push(
    `scaling ${report.scaling_ratio} > budget ${baseline.scaling_budget} — per-import cost grows ` +
      `with workspace size again, i.e. a tier went back to walking allFilePaths. Timing arm: ` +
      `re-run on an idle machine before investigating (see _scaling_note in baselines.json); the ` +
      `fingerprint arm is deterministic and never warrants a re-run.`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[kotlin-import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[kotlin-import-target --check] PASS');
