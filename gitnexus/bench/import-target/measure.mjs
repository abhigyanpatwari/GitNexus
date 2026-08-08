/**
 * Build-free scaling + identity bench for the Go, C#, Dart, Ruby (#2877, #2878,
 * #2879, #2880) and Kotlin (#2872) import-target resolvers, over ONE shared
 * corpus so the five are directly comparable.
 *
 * Kotlin also has `bench/kotlin-import-target/`, and this does not replace it:
 * that bench fingerprints both file-set iteration orders and probes the
 * four-tier cascade shape by shape, which this corpus does not. What Kotlin
 * gains here is a second corpus and the arms below that its own bench predates.
 *
 * Before this PR each of the other four answered its lookups with a full
 * `allFilePaths` scan per import, so import resolution cost O(imports × files):
 *
 *   - Go: `findRootPackageFiles` / `findAllFilesInPkgDir`, the latter once per
 *     path segment on the GOPATH fallback — several full scans per import;
 *   - C#: the no-csproj leg took the raw Set past the memoized index the csproj
 *     leg was already using — up to eight passes for a four-segment `using`;
 *   - Dart: one full scan per candidate path, and for an external package both
 *     candidates miss, so both always ran to completion;
 *   - Ruby: a complete `buildSuffixIndex` rebuilt and discarded per `require`.
 *
 * Two properties of the corpus are load-bearing and must not be "simplified":
 *
 *  1. **Most imports are unresolvable.** In real source the majority of imports
 *     name the stdlib or a third-party package, and those run every leg of the
 *     cascade to completion before returning null — the fast paths never fire.
 *     A corpus of mostly-resolving imports measures the wrong half of the
 *     function and would score a reintroduced scan as linear.
 *  2. **Import count scales WITH file count.** The regression is quadratic in
 *     `imports × files`; holding imports fixed while files grow would halve the
 *     exponent and let a per-import scan pass the budget.
 *
 * Reports per language and scale:
 *   - `ms`: fastest of REPS full passes, INCLUDING the one-time index build —
 *     hiding the build would let an index that is itself quadratic pass;
 *   - `scaling_ratio` `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear, ~4.x
 *     quadratic at this scale gap;
 *   - `depth_ratio` `t_deep/t_small` at a FIXED file count with ~6x the path
 *     components. `scaling_ratio` divides the file count out, so it is
 *     scale-invariant and structurally cannot see a cost that grows with path
 *     DEPTH instead — and `buildSuffixIndex` (C#, Ruby) and Kotlin's
 *     `suffixByStem` each emit one entry per component. Go and Dart, whose
 *     indexes are depth-free, sit at ~0.9; the others sit legitimately above
 *     1.0, which is why the budget is per language;
 *   - `collide_scaling_ratio`, the same measurement on a corpus whose
 *     directories SHARE their last segment and whose files share basenames —
 *     see the `collide` section below;
 *   - `heap` (C# and Ruby): retained bytes of the shared `WorkspaceFileIndex`
 *     — see the `heap` section below;
 *   - a sha256 over every distinct `fromFile | target → result`, as the
 *     correctness gate. The tie-break-level proof that this PR's index
 *     reproduces the scans lives in
 *     `test/unit/scope-resolution/import-target-index-parity.test.ts`, which
 *     diffs against verbatim copies of the pre-change implementations; this
 *     fingerprint is the forward guard that keeps the output pinned from here.
 *     Every scale's fingerprint is asserted, not just `large`'s: the arms
 *     differ only in layout and padding, so a per-scale-only defect (a resolver
 *     bug that corrupts deep paths, or a corpus edit that quietly deletes the
 *     depth padding) moves no asserted count and would otherwise print PASS.
 *
 * `--check` adds arms that no ratio can carry:
 *   - the corpus SHAPE (files, imports, resolved, distinct outcomes, per scale),
 *     so a future edit cannot quietly shrink the corpus below the sizes that
 *     make the timing arms meaningful and still print PASS. The `deep` and
 *     `collide` arms must also resolve exactly what `small` resolves — padding
 *     and re-layout were supposed to change path depth and directory naming and
 *     nothing else;
 *   - `deep.fingerprint !== small.fingerprint` and
 *     `collide.fingerprint !== small.fingerprint`, so those two arms' EFFECT is
 *     pinned rather than only their output. Both are count-neutral by
 *     construction, so neutering either one (`DEEP_PAD = 0`, a `collideDir`
 *     that forwards to `uniqueDir`) leaves every asserted number untouched;
 *     comparing the arms to `small` is the only thing that notices;
 *   - `small_ms_ceiling` and `collide_ms_ceiling`, ABSOLUTE bounds, because a
 *     constant-factor regression that grows both scale arms equally passes
 *     every ratio.
 *
 * SCOPE OF THE "independent of corpus size" CLAIM — the `collide` arm.
 * `small`/`large`/`deep` mint one directory name per index (`src/pkg7`,
 * `src/Ns7`, `lib/feature7`) and one basename per file, so every index bucket
 * in them holds exactly ONE entry: measured, max last-segment bucket = 1 and
 * max matching directories = 1 for go and csharp at both 400 and 1600 files,
 * max basename bucket = 1 for dart and ruby. Bucket cardinality is the only
 * non-constant term the new indexes have, so those arms certify the headline
 * claim on the one shape where that term cannot appear. `collide` is the same
 * workload — identical file, import and resolved counts — laid out the way
 * these languages are actually written: `svcN/internal/`, `SrcN/Models/`, a
 * `mod0.dart`/`mod0.rb` in every package. Measured on that shape the per-import
 * cost is NOT corpus-size-independent for the three resolvers that scan a
 * bucket:
 *
 *   - go and csharp walk `PackageDirIndex.dirsByLastSegment[seg]`, which now
 *     holds every directory;
 *   - dart walks its basename bucket, which now holds every same-named file;
 *   - ruby and kotlin answer from keyed maps and are collision-IMMUNE, so their
 *     collide budgets are the linear ones — that immunity is the assertion.
 *
 * This is a scope-of-claim limit, not a regression: on the MISS path with a
 * shared leaf name the bucket grows with the file count BY CONSTRUCTION, and
 * the indexed code is still faster there than the pre-change full scan. The arm
 * exists so the real shape is measured and pinned, and so nobody reads the 1.8
 * budget as covering it. Narrowing it would mean a reversed-path prefix-range
 * structure, which trades against the O(files × depth) memory
 * `package-dir-index.ts` cites #2649 to avoid — a design change, not a tune.
 *
 * MEMORY — the `heap` arm. C# and Ruby both resolve through the shared
 * `WorkspaceFileIndex`, and `buildSuffixIndex` under it emits three maps at
 * O(files × depth): exactly the profile `package-dir-index.ts` cites #2649 to
 * avoid for itself. C# is the reason this is gated rather than noted: at BASE
 * `getWorkspaceFileIndex` was reached only from the csproj branch and the
 * no-csproj leg scanned the Set and retained nothing, whereas it is now called
 * unconditionally. Every other arm here is time or count, and no ratio can see
 * a footprint. Measured in ABSOLUTE bytes, not only as a ratio: the finding is
 * about the footprint itself, and a ratio alone hides a large constant.
 *
 * KNOWN BLIND SPOT, measured: a full workspace scan reintroduced on 1-in-32
 * imports passes every arm here (dart scored 1.458 scaling, 1.736 ms). The gate
 * that NARROWS it is not a timing gate — the parity test above counts
 * iterations of the file-set Set and reads 14 instead of 1 for that same
 * mutation. It does not CLOSE it: the counter watches the Set, while the
 * resolvers hold materialized arrays of the same file list
 * (`WorkspaceFileIndex.normalized`/`.all`, Dart's basename buckets,
 * `PackageDirIndex.filesByDir`), and a 1-in-32 scan over one of THOSE passes
 * both the parity test and `--check`. Chasing it by tightening these ceilings
 * toward the noise floor would only buy flaky CI; see `_blind_spot` in
 * baselines.json.
 *
 * Run:
 *   node --expose-gc --import tsx bench/import-target/measure.mjs           # report
 *   node --expose-gc --import tsx bench/import-target/measure.mjs --check   # CI gate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveGoImportTarget } from '../../src/core/ingestion/languages/go/import-target.ts';
import { resolveDartImportTarget } from '../../src/core/ingestion/languages/dart/import-target.ts';
import { resolveRubyImportTarget } from '../../src/core/ingestion/languages/ruby/import-target.ts';
import { resolveCsharpImportTarget } from '../../src/core/ingestion/languages/csharp/import-target.ts';
import { resolveKotlinImportTarget } from '../../src/core/ingestion/languages/kotlin/import-target.ts';
import { getWorkspaceFileIndex } from '../../src/core/ingestion/import-resolvers/workspace-file-index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 400;
const LARGE = 1600;
const IMPORTS_PER_FILE = 8;
/** Extra directory components prepended in the `deep` arm — see `depth_ratio`. */
const DEEP_PAD = 16;
/** `fastest()` below is a min-of-N estimator, so N is the noise knob: raising it
 *  lowers and stabilises the minimum. `depth_ratio` divides two sub-3 ms
 *  measurements, and Dart's are sub-1 ms, so it is by far the noisiest number
 *  here and it sets N for the whole file. Measured over 22 `--check` runs on an
 *  idle box: at N=5 it tripped its own budget ~1 run in 20, at N=7 Dart still
 *  swung 3.0x peak-to-peak and tripped once. N=15 matches `bench/cfg`,
 *  `bench/schema-pairs` and `bench/callable-value-flow`; the distributions it
 *  produces are recorded in `_arms_note`. */
const REPS = 15;
const WARMUP = 2;

/** Heap arm (C#, Ruby). Far more files than the timing arms because the finding
 *  is an ABSOLUTE footprint at repository scale, and 1600 files would report a
 *  fraction of a MiB — a number no ceiling could usefully bound. `HEAP_PAD`
 *  keeps the paths at a plausible monorepo depth: `buildSuffixIndex` is
 *  O(files × depth), so a flat corpus would understate it by ~4x. */
const HEAP_SMALL = 8000;
const HEAP_LARGE = 32000;
const HEAP_PAD = 8;
/** Languages whose resolvers retain the shared `WorkspaceFileIndex`. */
const HEAP_LANGS = ['csharp', 'ruby'];

/** Needs `node --expose-gc` to force collection for a clean delta; without it
 *  the heap metric is reported as null and its `--check` gate would be skipped,
 *  which is why `--check` refuses to run without the flag (see below). */
const GC = typeof global.gc === 'function' ? () => (global.gc(), global.gc()) : null;

/** Deterministic 32-bit avalanche (murmur3 finalizer) — no `Math.random()`, so
 *  the corpus and therefore the fingerprint are byte-reproducible. */
function mix(n) {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const GO_MODULE = { modulePath: 'example.com/mod' };
const EXTENSION = { go: '.go', csharp: '.cs', dart: '.dart', ruby: '.rb', kotlin: '.kt' };

/**
 * UNIQUE-LEAF layout: one directory name per index, so no two directories share
 * a last segment and no two files share a basename. Every index bucket holds
 * exactly one entry. A nested same-name directory in one repo slice is the
 * shape whose handling the first-`indexOf` tie-break decides (see
 * package-dir-index.ts), and the shape Kotlin's `dirChildren` resolves the same
 * way.
 */
function uniqueDir(lang, d) {
  if (lang === 'go') return d % 7 === 0 ? `src/pkg${d}/internal/pkg${d}` : `src/pkg${d}`;
  if (lang === 'csharp') return d % 7 === 0 ? `src/Ns${d}/Sub/Ns${d}` : `src/Ns${d}`;
  if (lang === 'dart') return d % 3 === 0 ? `lib/feature${d}` : `pkg/feature${d}`;
  if (lang === 'kotlin') {
    return d % 7 === 0
      ? `mod${d}/src/main/kotlin/com/example/pkg${d}/inner/pkg${d}`
      : `mod${d}/src/main/kotlin/com/example/pkg${d}`;
  }
  return `lib/mod${d}`;
}

/**
 * SHARED-LEAF layout: every directory ends in the SAME segment, so one bucket
 * holds all of them. The `d % 7` slice keeps the nested same-name directory of
 * the unique layout, and Go additionally replicates one package (`internal/
 * shared`) across services — the monorepo shape `filesDirectlyInPkgDir`'s merge
 * exists for, and the only arm in this bench that reaches `dirCount > 1`.
 *
 * Each language's local import spelling is chosen so this arm resolves exactly
 * as many imports as `small` does (asserted): same workload, different layout.
 */
function collideDir(lang, d) {
  if (lang === 'go') {
    if (d % 7 === 0) return `svc${d}/internal/sub/internal`;
    return d % 5 === 1 ? `svc${d}/internal/shared` : `svc${d}/internal`;
  }
  if (lang === 'csharp') return d % 7 === 0 ? `Src${d}/Models/Inner/Models` : `Src${d}/Models`;
  if (lang === 'dart') return `pkg${d}/lib/src`;
  if (lang === 'kotlin') {
    return d % 7 === 0
      ? `mod${d}/src/main/kotlin/com/example/models/inner/models`
      : `mod${d}/src/main/kotlin/com/example/models`;
  }
  return `svc${d}/lib/models`;
}

/**
 * The file paths of one synthetic repository. `dirs` grows with the file count
 * so directory fan-out is realistic at both scales rather than collapsing onto
 * a handful of buckets.
 *
 * `pad` prepends that many extra directory components to every path. Every
 * language's in-repo target resolves through a path SUFFIX (Go's module leg
 * against the package dir, C#'s progressive strip, Dart's `lib/<rel>`, Ruby's
 * suffix match, Kotlin's `suffixByStem`), so the padding changes path depth
 * without changing what resolves — which is what makes the `deep` arm a clean
 * depth measurement rather than a different corpus.
 *
 * Split out from `buildRepo` so the heap arm can build 32k paths without also
 * minting 256k import tuples it would never resolve.
 */
function buildFiles(lang, fileCount, pad, shape) {
  const dirs = Math.max(4, Math.floor(fileCount / 8));
  const files = [];
  const ext = EXTENSION[lang];
  const prefix = pad === 0 ? '' : Array.from({ length: pad }, (_, n) => `d${n}`).join('/') + '/';
  for (let i = 0; i < fileCount; i++) {
    const d = i % dirs;
    const dir = shape === 'collide' ? collideDir(lang, d) : uniqueDir(lang, d);
    // In the collide shape Dart and Ruby carry a REPEATED basename — the term
    // their indexes bucket on. `i / dirs` is unique within a directory (8 files
    // land in each) and identical across directories, which is exactly the
    // `models.dart` / `models.rb`-in-every-package convention. Go, C# and
    // Kotlin bucket on the directory instead, so their stems stay unique.
    const collideStem = lang === 'dart' || lang === 'ruby';
    const stem =
      shape === 'collide' && collideStem
        ? `mod${Math.floor(i / dirs)}`
        : lang === 'csharp' || lang === 'kotlin'
          ? `File${i}`
          : `file${i}`;
    // Go's package leg must exclude `_test.go`; keep a real share of them.
    // Kotlin resolves `.kt` and `.kts` through the same stem maps; keep both.
    const suffix =
      lang === 'go' && i % 6 === 0 ? '_test.go' : lang === 'kotlin' && i % 11 === 0 ? '.kts' : ext;
    files.push(`${prefix}${dir}/${stem}${suffix}`);
  }
  return files;
}

/**
 * One synthetic repository per language: the file set plus the import list each
 * file issues.
 */
function buildRepo(lang, fileCount, pad = 0, shape = 'unique') {
  const dirs = Math.max(4, Math.floor(fileCount / 8));
  const files = buildFiles(lang, fileCount, pad, shape);
  const collide = shape === 'collide';

  const imports = [];
  for (let i = 0; i < fileCount; i++) {
    const from = files[i];
    for (let k = 0; k < IMPORTS_PER_FILE; k++) {
      const r = mix(i * 65599 + k);
      // ~3 in 8 imports resolve in-repo; the rest are external and run the
      // whole cascade to completion (corpus property 1).
      const local = r % 8 < 3;
      const d = r % dirs;
      const j = r % fileCount;
      let target;
      if (lang === 'go') {
        target = local
          ? collide
            ? // The replicated package is addressed by the path it shares, so
              // the module leg matches every service at once (`dirCount > 1`).
              d % 5 === 1 && d % 7 !== 0
              ? `${GO_MODULE.modulePath}/internal/shared`
              : `${GO_MODULE.modulePath}/svc${d}/internal`
            : `${GO_MODULE.modulePath}/src/pkg${d}`
          : (r >>> 3) % 2 === 0
            ? ['fmt', 'os', 'net/http', 'encoding/json'][(r >>> 4) % 4]
            : collide
              ? // Ends in the shared segment, so the GOPATH fallback walks the
                // whole bucket three times and still returns null: the MISS
                // path this arm exists to measure.
                `github.com/org/repo${(r >>> 4) % 97}/internal`
              : `github.com/org/repo${(r >>> 4) % 97}/pkg/util`;
      } else if (lang === 'csharp') {
        target = local
          ? collide
            ? // `Vendor` has no directory anywhere, mirroring the unique arm's
              // nested-same-name slice, which also resolves to nothing.
              d % 7 === 0
              ? `App.Src${d}.Vendor`
              : `App.Src${d}.Models`
            : `App.Ns${d}`
          : (r >>> 3) % 2 === 0
            ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 4) % 3]
            : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
      } else if (lang === 'dart') {
        target = local
          ? collide
            ? `package:app/pkg${j % dirs}/lib/src/mod${Math.floor(j / dirs)}.dart`
            : `package:app/feature${d}/file${j}.dart`
          : (r >>> 3) % 3 === 0
            ? ['dart:core', 'dart:async', 'dart:io'][(r >>> 4) % 3]
            : collide
              ? // A repeated basename under a directory nothing carries: both
                // candidates walk the whole basename bucket and miss.
                `package:ext${(r >>> 4) % 97}/other/mod${(r >>> 4) % 8}.dart`
              : `package:ext${(r >>> 4) % 97}/src/thing.dart`;
      } else if (lang === 'kotlin') {
        // A share of wildcard imports: `.*` lands on the package fan-out tier,
        // which returns a LIST and is the only tier whose output is order-bearing.
        target = local
          ? (r >>> 3) % 3 === 0
            ? collide
              ? d % 7 === 0
                ? `com.example.vendor${d}.*`
                : `com.example.models.*`
              : `com.example.pkg${d}.*`
            : collide
              ? `com.example.models.File${j}`
              : `com.example.pkg${d}.File${j}`
          : (r >>> 3) % 2 === 0
            ? ['java.util.List', 'kotlin.collections.Map', 'kotlinx.coroutines.flow.Flow'][
                (r >>> 4) % 3
              ]
            : `com.ghost${(r >>> 4) % 97}.deep.Missing`;
      } else {
        target = local
          ? collide
            ? `svc${j % dirs}/lib/models/mod${Math.floor(j / dirs)}`
            : `mod${d}/file${j}`
          : (r >>> 3) % 2 === 0
            ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
            : `gem${(r >>> 4) % 97}/missing/thing`;
      }
      imports.push([from, target]);
    }
  }
  return { files, imports };
}

/** The timed loop. A FRESH Set per pass, so every pass pays exactly one index
 *  build — reusing one Set across passes would hide the build after the first
 *  and let a rebuilt-per-import index look free from rep 2 onward. */
function resolveAll(lang, files, imports) {
  const allFilePaths = new Set(files);
  let sink = 0;
  for (const [from, target] of imports) {
    const hit = resolveOne(lang, from, target, allFilePaths);
    if (hit !== null) sink++;
  }
  return sink;
}

function resolveOne(lang, from, target, allFilePaths) {
  if (lang === 'go') return resolveGoImportTarget(target, from, allFilePaths, GO_MODULE);
  if (lang === 'dart') return resolveDartImportTarget(target, from, allFilePaths);
  if (lang === 'ruby') return resolveRubyImportTarget(target, from, allFilePaths);
  if (lang === 'kotlin') {
    return resolveKotlinImportTarget(
      { kind: 'named', localName: 'X', importedName: 'X', targetRaw: target },
      { fromFile: from, allFilePaths },
    );
  }
  return resolveCsharpImportTarget(
    { kind: 'namespace', localName: '_', importedName: '_', targetRaw: target },
    { fromFile: from, allFilePaths },
  );
}

/** Untimed identity pass, one resolve per DISTINCT `from|target`: on a fixed
 *  file set the resolvers are pure, so a repeated pair can only re-derive what
 *  the first occurrence already recorded. */
function outcomesOf(lang, files, imports) {
  const allFilePaths = new Set(files);
  const outcomes = new Set();
  const seen = new Set();
  for (const [from, target] of imports) {
    const key = `${from}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = resolveOne(lang, from, target, allFilePaths);
    const rendered = hit === null ? '<null>' : Array.isArray(hit) ? hit.join(',') : hit;
    outcomes.add(`${key}\u0000${rendered}`);
  }
  return outcomes;
}

/** MIN, not median: both scales are timed in one process and every error source
 *  (GC, scheduler preemption, a noisy CI neighbour) is additive, so the fastest
 *  observed pass is the closest estimate of the uncontended cost. */
function fastest(values) {
  return Math.min(...values);
}

function timeResolution(lang, files, imports) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports);
  const samples = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    resolveAll(lang, files, imports);
    samples.push(performance.now() - t0);
  }
  return fastest(samples);
}

/**
 * Retained JS heap of the `WorkspaceFileIndex` built over `files`.
 *
 * GROWTH form, not the release form `bench/cfg/measure.mjs` uses: the index is
 * memoized in a `WeakMap` keyed on the Set, so releasing it means releasing the
 * Set too, which would fold the Set's own cost into the delta. Here the Set is
 * live across BOTH reads and the `files` array holds the path strings, so the
 * delta is the index's own footprint — the arrays, the three `buildSuffixIndex`
 * maps and `normToRaw` — and not the paths they point at. A forced double GC
 * before each read makes it robust to pre-existing garbage the same way.
 */
function retainedIndexBytes(files) {
  const set = new Set(files);
  GC();
  const before = process.memoryUsage().heapUsed;
  const index = getWorkspaceFileIndex(set);
  GC();
  const after = process.memoryUsage().heapUsed;
  // Keeps both live past the second read, and fails loudly if the corpus ever
  // stops being one distinct path per file (which would silently shrink it).
  if (index.all.length !== files.length || set.size !== files.length) {
    throw new Error(`heap arm corpus is not distinct: ${set.size} of ${files.length}`);
  }
  return Math.max(0, after - before);
}

function measureHeap(lang) {
  if (GC === null) return null;
  const small = buildFiles(lang, HEAP_SMALL, HEAP_PAD, 'unique');
  // The first build in a fresh process reads a few percent low (lazily grown
  // spaces, unJITted build loop); discard it.
  retainedIndexBytes(small);
  const bytesSmall = retainedIndexBytes(small);
  const large = buildFiles(lang, HEAP_LARGE, HEAP_PAD, 'unique');
  const bytesLarge = retainedIndexBytes(large);
  return {
    files_small: HEAP_SMALL,
    files_large: HEAP_LARGE,
    path_segments: small[0].split('/').length,
    bytes_small: bytesSmall,
    bytes_large: bytesLarge,
    mib_large: Number((bytesLarge / 1024 / 1024).toFixed(2)),
    ratio: Number((bytesLarge / bytesSmall / (HEAP_LARGE / HEAP_SMALL)).toFixed(3)),
  };
}

function fingerprint(outcomes) {
  return crypto
    .createHash('sha256')
    .update([...outcomes].sort().join('\n'))
    .digest('hex');
}

const CHECK = process.argv.includes('--check');

// The heap arm is a primary regression detector, but it can only be measured
// with a forced GC. Rather than let `--check` silently PASS with the heap gate
// skipped (a green no-op if someone drops --expose-gc), fail loudly.
if (CHECK && GC === null) {
  process.stderr.write(
    '[import-target --check] FAIL: the retained-heap arm requires --expose-gc. ' +
      'Run: node --expose-gc --import tsx bench/import-target/measure.mjs --check\n',
  );
  process.exit(1);
}

const LANGS = ['go', 'csharp', 'dart', 'ruby', 'kotlin'];
const SCALES = ['small', 'large', 'deep', 'collide', 'collide_large'];
const report = {};
for (const lang of LANGS) {
  const scales = {};
  for (const [name, fileCount, pad, shape] of [
    ['small', SMALL, 0, 'unique'],
    ['large', LARGE, 0, 'unique'],
    ['deep', SMALL, DEEP_PAD, 'unique'],
    ['collide', SMALL, 0, 'collide'],
    ['collide_large', LARGE, 0, 'collide'],
  ]) {
    const { files, imports } = buildRepo(lang, fileCount, pad, shape);
    const outcomes = outcomesOf(lang, files, imports);
    scales[name] = {
      files: files.length,
      imports: imports.length,
      // Reported, not asserted on its own: a corpus edit that collapsed the
      // resolved share would still produce a "valid" fingerprint over far less.
      resolved: resolveAll(lang, files, imports),
      distinct_outcomes: outcomes.size,
      ms: Number(timeResolution(lang, files, imports).toFixed(3)),
      fingerprint: fingerprint(outcomes),
    };
  }
  report[lang] = {
    ...scales,
    scaling_ratio: Number((scales.large.ms / scales.small.ms / (LARGE / SMALL)).toFixed(3)),
    // `scaling_ratio` divides the file count out, so it is scale-invariant and
    // structurally cannot see a cost that grows with path DEPTH instead — and
    // `buildSuffixIndex` (C#, Ruby) and Kotlin's `suffixByStem` both emit one
    // entry per '/' in a path. Same file count, ~6x the components.
    depth_ratio: Number((scales.deep.ms / scales.small.ms).toFixed(3)),
    // Same measurement on the shared-leaf layout. Legitimately above the 1.8
    // budget for go/csharp/dart — see the scope-of-claim note in the header.
    collide_scaling_ratio: Number(
      (scales.collide_large.ms / scales.collide.ms / (LARGE / SMALL)).toFixed(3),
    ),
    fingerprint: scales.large.fingerprint,
  };
}

// AFTER every timing arm, never interleaved with them: the heap arm allocates a
// 32k-path corpus and a ~75 MiB index, and leaving that garbage behind for the
// next language's timed loop to collect would tax an arm it has nothing to do
// with.
for (const lang of HEAP_LANGS) report[lang].heap = measureHeap(lang);

if (!CHECK) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];
for (const lang of LANGS) {
  const got = report[lang];
  const want = baseline.languages[lang];
  if (got.fingerprint !== want.fingerprint) {
    failures.push(
      `${lang}: fingerprint drift ${got.fingerprint} != ${want.fingerprint} — the resolver ` +
        `returned a DIFFERENT target set. That is a behaviour change, not a perf one; see the ` +
        `parity harness in test/unit/scope-resolution/import-target-index-parity.test.ts.`,
    );
  }
  if (got.scaling_ratio > baseline.scaling_budget) {
    failures.push(
      `${lang}: scaling ${got.scaling_ratio} > budget ${baseline.scaling_budget} — per-import ` +
        `cost grows with corpus size again. Timing arm: re-run on an idle machine before ` +
        `investigating; the fingerprint arm never warrants a re-run.`,
    );
  }
  if (got.depth_ratio > baseline.depth_budget[lang]) {
    failures.push(
      `${lang}: depth ${got.depth_ratio} > budget ${baseline.depth_budget[lang]} — cost grows with ` +
        `path DEPTH at a fixed file count, which scaling_ratio divides out and cannot see. ` +
        `Timing arm: re-run on an idle machine before investigating.`,
    );
  }
  if (got.collide_scaling_ratio > baseline.collide_scaling_budget[lang]) {
    failures.push(
      `${lang}: collide scaling ${got.collide_scaling_ratio} > budget ` +
        `${baseline.collide_scaling_budget[lang]} — on the SHARED-LEAF layout (svcN/internal, ` +
        `SrcN/Models, a repeated basename per package) per-import cost grew beyond what this ` +
        `shape already costs by construction. Timing arm: re-run on an idle machine first.`,
    );
  }
  if (got.small.ms > baseline.small_ms_ceiling[lang]) {
    failures.push(
      `${lang}: small arm ${got.small.ms} ms > ceiling ${baseline.small_ms_ceiling[lang]} ms — ` +
        `an ABSOLUTE bound, because a constant-factor regression that grows both arms equally ` +
        `passes the ratio. Timing arm: re-run on an idle machine before investigating.`,
    );
  }
  if (got.collide.ms > baseline.collide_ms_ceiling[lang]) {
    failures.push(
      `${lang}: collide arm ${got.collide.ms} ms > ceiling ${baseline.collide_ms_ceiling[lang]} ` +
        `ms — the ABSOLUTE bound on the shared-leaf layout. Timing arm: re-run on an idle ` +
        `machine before investigating.`,
    );
  }
  for (const arm of ['deep', 'collide']) {
    if (got[arm].resolved !== got.small.resolved) {
      failures.push(
        `${lang}: ${arm} arm resolved ${got[arm].resolved} vs small ${got.small.resolved} — the ` +
          `${arm} arm was supposed to change ${arm === 'deep' ? 'path depth' : 'directory and file NAMING'} ` +
          `and nothing else, so that it times the same workload. An arm that stopped resolving ` +
          `would be timing the null path and its ratio would mean nothing.`,
      );
    }
    // Count-neutral by design, so neutering the arm (DEEP_PAD = 0, a collideDir
    // that forwards to uniqueDir) moves NO asserted count. Comparing the two
    // fingerprints is the only arm that notices.
    if (got[arm].fingerprint === got.small.fingerprint) {
      failures.push(
        `${lang}: ${arm}.fingerprint equals small.fingerprint — the ${arm} arm is resolving the ` +
          `IDENTICAL corpus, so it measures nothing. ` +
          `${arm === 'deep' ? 'DEEP_PAD is 0 or the padding stopped reaching buildFiles' : 'collideDir is returning the uniqueDir layout'}. ` +
          `This is a deterministic arm: a re-run will not change it.`,
      );
    }
  }
  for (const scale of SCALES) {
    for (const field of ['files', 'imports', 'resolved', 'distinct_outcomes', 'fingerprint']) {
      if (got[scale][field] !== want[scale][field]) {
        failures.push(
          `${lang}.${scale}.${field}: ${got[scale][field]} != ${want[scale][field]} — the corpus ` +
            `changed shape or the resolver changed its answer for this arm. Every scale is ` +
            `asserted separately: the arms differ only in padding and layout, so a defect that ` +
            `touches one of them alone moves nothing in the others.`,
        );
      }
    }
  }
}

// Driven by the BASELINE's keys, not the report's, so deleting a heap
// measurement fails instead of silently dropping the gate.
for (const [lang, ceiling] of Object.entries(baseline.heap_ceiling_bytes)) {
  const heap = report[lang]?.heap;
  if (heap == null) {
    failures.push(
      `${lang}: heap arm missing though heap_ceiling_bytes has a budget for it — the retained-` +
        `index measurement was removed or skipped. It is the only arm that can see memory.`,
    );
    continue;
  }
  if (heap.bytes_large > ceiling) {
    failures.push(
      `${lang}: retained WorkspaceFileIndex ${heap.mib_large} MiB at ${heap.files_large} files ` +
        `(${heap.bytes_large} B) > ceiling ${ceiling} B — buildSuffixIndex is O(files × depth) ` +
        `and this is the ABSOLUTE bound on it (#2649). Deterministic: a re-run will not change it.`,
    );
  }
  if (heap.ratio > baseline.heap_ratio_budget) {
    failures.push(
      `${lang}: retained-heap ratio ${heap.ratio} > budget ${baseline.heap_ratio_budget} ` +
        `(${heap.bytes_small} B at ${heap.files_small} files -> ${heap.bytes_large} B at ` +
        `${heap.files_large}) — the index stopped growing linearly in the file count.`,
    );
  }
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[import-target --check] PASS');
