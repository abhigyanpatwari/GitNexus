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
 * A ratio cannot see a constant factor and a file-count ratio cannot see a
 * depth cost, so `--check` also asserts a DEPTH ratio (file count fixed, paths
 * ~3x deeper) and an absolute ceiling on the small arm. A full workspace scan
 * reintroduced on 1-in-32 imports scores 1.490 — inside the scaling budget —
 * while running 2.8x slower; the ceiling is what catches that shape.
 *
 * One honest limit: at a very small import count the index loses. Building it
 * is one workspace pass, so a single import into a 100k-file workspace costs
 * ~0.8 s against ~0 for a scan that returns on its first hit. It inverts at
 * roughly 15 imports, and in the polyglot case that motivates the worry —
 * 100k files, 5% Kotlin, a couple of imports — the index already wins, because
 * the build skips non-`.kt` entries as cheaply as the scan did.
 *
 * Five properties of the corpora are load-bearing and must not be
 * "simplified" away:
 *
 *   1. **The correctness corpus fuzzes each file set in BOTH iteration
 *      orders.** Every tie-break in this resolver is expressed only through
 *      Set-iteration order — "first suffix match wins", and the two stem maps
 *      keeping the FIRST path inserted per key. A single-order corpus scores an
 *      implementation that keeps the LAST match identically.
 *   2. **The correctness corpus contains repeated directory names at BOTH the
 *      leading and the mid-path position** (`data/src/main/kotlin/com/example/
 *      data/Repo.kt` and `top/data/mid/data/Repo.kt`). Until #2881 the resolver
 *      required a file's package directory to be the FIRST occurrence of that
 *      name in its own path, so neither file was a child of `data`; both are
 *      now, and that is what the fingerprint pins. Two positions, not one,
 *      because the old rule was two guards and a half fix that drops only the
 *      leading-position one still leaves the mid-path shape broken — see
 *      `_gate_controls` in baselines.json. Without these shapes the fingerprint
 *      cannot tell the current rule from either predecessor.
 *   3. **~40% of the scaling corpus's imports are unresolvable.** The old cost
 *      was worst when nothing matched, because only then did all four tiers
 *      run. A corpus where every import hits tier 1 exits after one pass and
 *      scores a per-import scan far closer to linear.
 *   4. **The hashed record includes the FILE SET, not just the query and the
 *      result.** Otherwise a corpus edit that swaps the workspace under a case
 *      while leaving its result string alone is invisible: dropping the
 *      competing file from the "exact beats an earlier suffix" case, or
 *      emptying the repeated-directory negative case, each leaves `cases`,
 *      `non_null` and the fingerprint byte-identical and the gate green.
 *   5. **Path depth and package size are spanned, not pinned.** Both loops this
 *      change added are driven by depth — one `suffixByStem` entry per '/' in a
 *      stem, one `dirChildren` pass per component of `dir` — and the fan-out
 *      tier returns a bucket whose length is the package size. While the corpus
 *      capped depth at 8 components and packages at 16 files, three plausible
 *      follow-up guards (cap suffix depth at 7, skip the `dirChildren` suffix
 *      loop above depth 8, cap a bucket at 17) all passed `--check` with a
 *      byte-identical fingerprint — while on a standard Gradle layout the depth
 *      skip resolved EVERY package import to null and the bucket cap truncated
 *      fan-out by 58%. Import ARITY, by contrast, was never blind: a tier-4 cap
 *      at 4 dotted segments already failed the gate, because the branch matrix
 *      carries 6- and 8-segment cases.
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
/** Depth arm: same file count either side, ~3x the path depth on one side. */
const DEPTH_FILES = 800;
const DEPTH_PAD = 16;
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
    // The FILE SET is part of the hashed record, not just the query and the
    // result — see header property 4.
    lines.push(`${order}\t${list.join('|')}\t${fromFile}\t${targetRaw}\t${rendered}`);
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
// Header property 2: repeated directory name — a child of the repeated package
// since #2881, at the leading position here and mid-path below.
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

// ---- 1b. Depth and package size, the two axes the loops scale on ----------
//
// Header property 5. The index writes one `suffixByStem` entry per '/' in a
// stem and walks `dir` once per component, so DEPTH is what those two loops
// cost, and `dirChildren` bucket length is what the fan-out tier returns. A
// corpus that pins either as a constant cannot see a guard on it: capping
// suffix-key depth at 7, skipping the `dirChildren` suffix loop above depth 8,
// or capping a bucket at 17 entries all left the fingerprint, `cases` and
// `non_null` byte-identical before these cases existed — while, on a standard
// Gradle layout, the depth skip resolved EVERY package import to null and the
// bucket cap silently truncated fan-out by 58%.
const DEEP = 'core/data/src/main/kotlin/com/example/core/data/repository';
// 11 components — ordinary for Android/Gradle source, which runs 9-12.
record([`${DEEP}/UserRepository.kt`], 'com.example.core.data.repository.UserRepository');
record([`${DEEP}/UserRepository.kt`], 'repository.UserRepository');
record([`${DEEP}/UserRepository.kt`], 'core.data.repository.UserRepository');
record([`${DEEP}/UserRepository.kt`, `${DEEP}/PostRepository.kt`], 'repository.findAll');
record([`${DEEP}/UserRepository.kt`, `${DEEP}/PostRepository.kt`], 'core.data.repository.findAll');
// Deeper still, and with the repeated-name shape at depth.
const DEEPER = 'feature/home/src/main/kotlin/com/example/feature/home/data/local/dao';
record([`${DEEPER}/UserDao.kt`], 'dao.UserDao');
record([`${DEEPER}/UserDao.kt`, `${DEEPER}/PostDao.kt`], 'dao.insertAll');
record([`${DEEPER}/UserDao.kt`], 'home.data.local.dao.UserDao');
// Suffix keys deeper than 7 components. Depth in the FILE is not enough on its
// own: a cap on how many component-suffixes a stem contributes stays invisible
// unless something QUERIES one of the deep keys, and every Gradle-shaped import
// above is 6 segments or fewer. These reach the top of the stem.
record(
  [`${DEEP}/UserRepository.kt`],
  'src.main.kotlin.com.example.core.data.repository.UserRepository',
);
record(
  [`${DEEP}/UserRepository.kt`],
  'data.src.main.kotlin.com.example.core.data.repository.UserRepository',
);
record([`${DEEPER}/UserDao.kt`], 'src.main.kotlin.com.example.feature.home.data.local.dao.UserDao');
record(
  [`${DEEPER}/UserDao.kt`],
  'home.src.main.kotlin.com.example.feature.home.data.local.dao.UserDao',
);
record(
  [`${DEEP}/UserRepository.kt`, `${DEEP}/PostRepository.kt`],
  'src.main.kotlin.com.example.core.data.repository.findAll',
);

// A package larger than any plausible bucket cap. 40 files in one package is
// ordinary; a silent sibling cap is exactly what #2732 shipped on the JVM side.
const BIG_PACKAGE = Array.from({ length: 40 }, (_, i) => `${DEEP}/Item${i}.kt`);
record(BIG_PACKAGE, 'repository.someTopLevelFun');
record(BIG_PACKAGE, 'com.example.core.data.repository.someTopLevelFun');
record([...BIG_PACKAGE, `${DEEP}/sub/Nested.kt`], 'repository.someTopLevelFun');

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
  // Depth beyond the Gradle norm, so the fuzz spans the axis too rather than
  // leaving it to the hand-written cases above.
  'core/data/src/main/kotlin/com/example/core/data/repository',
  'feature/home/src/main/kotlin/com/example/feature/home/data/local/dao',
  'a/b/c/d/e/f/g/h/i/j/k/l',
];
// Segment alphabet overlaps the DIRS entries on purpose: a random dotted target
// only exercises a deep suffix key if its segments can actually align with a
// deep path.
const SEGS = [
  'User',
  'Repo',
  'Util',
  'Service',
  'Model',
  'data',
  'core',
  'api',
  'store',
  'sub',
  'src',
  'main',
  'kotlin',
  'com',
  'example',
  'repository',
  'dao',
];
const EXTS = ['.kt', '.kt', '.kt', '.kts', '.java', '.md'];

function randPath() {
  const dir = pick(DIRS);
  const base = pick(SEGS);
  const file = `${base}${pick(EXTS)}`;
  if (dir === '') return file;
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`;
}
function randDotted() {
  // Up to 9 segments, not 4: import arity is the one axis the branch matrix
  // already spanned, but the fuzz should cover it too now that the corpus
  // carries paths deep enough for a long target to align with one.
  const n = 1 + Math.floor(rnd() * 9);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(SEGS));
  return rnd() < 0.12 ? `${parts.join('.')}.*` : parts.join('.');
}

// File counts run to 45, not 16: a package that never exceeds 16 direct
// children cannot distinguish an uncapped `dirChildren` bucket from one capped
// at 17 (header property 5).
for (let repo = 0; repo < 400; repo++) {
  const fileCount = 3 + Math.floor(rnd() * 43);
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
 *  suffix entry per '/' in a stem and walks `dir` once per component, so depth
 *  is a cost driver and a flat corpus would understate the build).
 *
 *  `padDepth` inserts filler segments so the depth arm below can hold the file
 *  count fixed and vary only depth — the scaling ratio is scale-invariant in
 *  FILE COUNT and would otherwise never see a depth-driven cost regression. */
function buildCorpus(fileCount, padDepth = 0) {
  const pad = Array.from({ length: padDepth }, (_, d) => `p${d}`).join('/');
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const mod = i % 16;
    const root = pad === '' ? `lib${mod}` : `lib${mod}/${pad}`;
    files.push(`${root}/src/main/kotlin/com/example/mod${mod}/Class${i}.kt`);
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

// Depth arm: file count fixed, depth roughly tripled. `scaling_ratio` divides
// out the file count, so it is scale-INVARIANT and structurally cannot see a
// cost that grows with path depth instead — and both loops this PR added are
// depth loops. Same corpus size, same imports, only the paths get longer.
const depthFiles = buildCorpus(DEPTH_FILES, 0);
const depthFilesPadded = buildCorpus(DEPTH_FILES, DEPTH_PAD);
const depthImports = buildImports(DEPTH_FILES);
const shallowMs = timeResolution(depthFiles, depthImports);
const deepMs = timeResolution(depthFilesPadded, depthImports);
const depthRatio = deepMs / shallowMs;

const report = {
  small: scales.small,
  large: scales.large,
  scaling_ratio: Number(scalingRatio.toFixed(3)),
  depth: {
    files: DEPTH_FILES,
    shallow_components: 8,
    deep_components: 8 + DEPTH_PAD,
    shallow_ms: Number(shallowMs.toFixed(3)),
    deep_ms: Number(deepMs.toFixed(3)),
  },
  depth_ratio: Number(depthRatio.toFixed(3)),
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
for (const field of ['cases', 'non_null']) {
  if (report[field] !== baseline[field]) {
    failures.push(
      `${field} ${report[field]} != ${baseline[field]} — the corpus itself changed, so the ` +
        `fingerprint above is computed over a different surface and proves nothing about the ` +
        `resolver. Re-baseline every corpus field together, deliberately.`,
    );
  }
}
if (report.scaling_ratio > baseline.scaling_budget) {
  failures.push(
    `scaling ${report.scaling_ratio} > budget ${baseline.scaling_budget} — per-import cost grows ` +
      `with workspace size again, i.e. a tier went back to walking allFilePaths. Timing arm: ` +
      `re-run on an idle machine before investigating (see _scaling_note in baselines.json); the ` +
      `fingerprint arm is deterministic and never warrants a re-run.`,
  );
}
if (report.depth_ratio > baseline.depth_budget) {
  failures.push(
    `depth ratio ${report.depth_ratio} > budget ${baseline.depth_budget} — cost now grows with ` +
      `PATH DEPTH at a fixed file count. scaling_ratio divides the file count out and cannot ` +
      `see this. Timing arm: re-run on an idle machine first.`,
  );
}
if (report.small.ms > baseline.small_ms_ceiling) {
  failures.push(
    `small arm ${report.small.ms} ms > ceiling ${baseline.small_ms_ceiling} ms — scaling_ratio is ` +
      `a RATIO, so a constant-factor regression that grows both arms equally passes it (a full ` +
      `scan reintroduced on 1-in-32 imports measured 1.490, inside the budget, while running ` +
      `2.8x slower). This ceiling is what catches that. Timing arm: re-run on an idle machine.`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[kotlin-import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[kotlin-import-target --check] PASS');
