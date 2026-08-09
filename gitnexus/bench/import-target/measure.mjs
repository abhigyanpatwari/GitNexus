/**
 * Build-free scaling + identity bench for the Go, C#, Dart, Ruby (#2877, #2878,
 * #2879, #2880), Kotlin (#2872), PHP (#2901), Java and COBOL (#2908) and C#
 * csproj (#2902) import-target resolvers, over ONE shared corpus so the nine
 * arms are directly comparable.
 *
 * Kotlin also has `bench/kotlin-import-target/`, and this does not replace it:
 * that bench fingerprints both file-set iteration orders and probes the
 * four-tier cascade shape by shape, which this corpus does not. What Kotlin
 * gains here is a second corpus and the arms below that its own bench predates.
 *
 * Each resolver here answered its lookups with a full `allFilePaths` scan per
 * import before its fix, so import resolution cost O(imports × files):
 *
 *   - Go: `findRootPackageFiles` / `findAllFilesInPkgDir`, the latter once per
 *     path segment on the GOPATH fallback — several full scans per import;
 *   - C#: the no-csproj leg took the raw Set past the memoized index the csproj
 *     leg was already using — up to eight passes for a four-segment `using`;
 *   - Dart: one full scan per candidate path, and for an external package both
 *     candidates miss, so both always ran to completion;
 *   - Ruby: a complete `buildSuffixIndex` rebuilt and discarded per `require`;
 *   - PHP: two materialized arrays per import and then no index at all, which
 *     dropped `suffixResolve` onto a linear `findIndex` — one full pass per path
 *     part per extension, and there are ~50 extensions (96.40 ms per import at
 *     20k files, now 0.036 ms);
 *   - Java: one scan for the direct match plus one more per stripped package
 *     prefix, and a JDK or third-party import runs the loop to the end (8.05 ms
 *     per import, now 0.62 ms);
 *   - COBOL: two scans per `COPY` — one per extension tier — each calling
 *     `extname` + `basename` + `toUpperCase` on every path, both always running
 *     to completion because vendor copybooks live outside the repo (3879 µs per
 *     import, now 10.5 µs);
 *   - C# csproj: the namespace-directory fallback re-scanned
 *     `normalizedFileList` per import per matching config (1103 µs, now 7.6 µs).
 *     `csharp` here builds its context with NO `csharpConfigs`, so it can never
 *     reach that leg — `csharp_csproj` is the same corpus with the configs
 *     supplied, and it exists because without it #2902 ships unmeasured.
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
 *     DEPTH instead — and `buildSuffixIndex` (C#, Ruby, PHP, Java) and Kotlin's
 *     `suffixByStem` each emit one entry per component. Go, Dart and COBOL,
 *     whose indexes are depth-free (COBOL's are keyed on the basename and
 *     nothing else), sit at ~0.9-1.0; the others sit legitimately above 1.0,
 *     which is why the budget is per language;
 *   - `collide_scaling_ratio`, the same measurement on a corpus whose
 *     directories SHARE their last segment and whose files share basenames —
 *     see the `collide` section below;
 *   - `heap` (C#, Ruby, PHP, Java): retained bytes of the shared
 *     `WorkspaceFileIndex` — see the `heap` section below;
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
 * cost is NOT corpus-size-independent for the four resolvers that scan a
 * bucket:
 *
 *   - go, csharp and java walk `PackageDirIndex.dirsByLastSegment[seg]`, which
 *     now holds every directory;
 *   - dart walks its basename bucket, which now holds every same-named file;
 *   - ruby, kotlin, php and cobol answer from keyed maps and are collision-
 *     IMMUNE, so their collide budgets are the linear ones — that immunity is
 *     the assertion, and for cobol the arm is also the only one that reaches
 *     the copybook-over-source tier tie-break, which needs one bookname to name
 *     two files;
 *   - csharp_csproj runs the OTHER way: its shared leaf collapses
 *     `dirsByLastSegment` to a single key, which makes the slash-free sweep
 *     (see `CSPROJ_CONFIGS`) cheaper on the collide layout than on the unique
 *     one, so its expensive scale arm is `large`, not `collide_large`.
 *
 * This is a scope-of-claim limit, not a regression: on the MISS path with a
 * shared leaf name the bucket grows with the file count BY CONSTRUCTION, and
 * the indexed code is still faster there than the pre-change full scan. The arm
 * exists so the real shape is measured and pinned, and so nobody reads the 1.8
 * budget as covering it. Narrowing it would mean a reversed-path prefix-range
 * structure, which trades against the O(files × depth) memory
 * `package-dir-index.ts` cites #2649 to avoid — a design change, not a tune.
 *
 * MEMORY — the `heap` arm. C#, Ruby, PHP and Java all resolve through the
 * shared `WorkspaceFileIndex`, and `buildSuffixIndex` under it emits maps at
 * O(files × depth): exactly the profile `package-dir-index.ts` cites #2649 to
 * avoid for itself. That is why this is gated rather than noted — all four
 * retained NOTHING across imports at BASE. C#'s `getWorkspaceFileIndex` was
 * reached only from the csproj branch while the no-csproj leg scanned the Set;
 * PHP and Java scanned on every leg; Ruby rebuilt and discarded a suffix index
 * per `require`. Every other arm here is time or count, and no ratio can see a
 * footprint. Measured in ABSOLUTE bytes, not only as a ratio: the finding is
 * about the footprint itself, and a ratio alone hides a large constant.
 *
 * Two languages are deliberately NOT in `HEAP_LANGS`, and the reasons differ.
 * COBOL's index is two `Map<basename, path>` — O(files) with NO depth term and
 * one small entry per file, structurally incapable of the blow-up this arm
 * watches for; measured at 32 000 files its retained delta does not clear the
 * noise of the measurement itself, so a byte ceiling on it would gate nothing.
 * `csharp_csproj` resolves over the SAME corpus as `csharp` through the same
 * `getWorkspaceFileIndex`, so its number would be a duplicate. Its one
 * distinguishing footprint is `buildSuffixIndex`'s `dirMap`, which #2903 made
 * lazy and which `getFilesInDir` on the csproj leg forces back into existence:
 * measured at +20.8% of the retained C# index at 32 000 files. That is a
 * REPORTED residual, not a gated one — see the residual note in `_arms_note`,
 * which already states that a dirMap-sized addition passes the 1.5x ceiling.
 *
 * KNOWN BLIND SPOT, measured: a full workspace scan reintroduced on 1-in-32
 * imports passes every arm here (dart scored 1.458 scaling, 1.736 ms). The gate
 * that NARROWS it is not a timing gate — the parity test above counts
 * iterations of the file-set Set and reads 14 instead of 1 for that same
 * mutation. It does not CLOSE it: the counter watches the Set, while the
 * resolvers hold materialized arrays of the same file list
 * (`WorkspaceFileIndex.normalized`/`.all`, Dart's basename buckets,
 * `PackageDirIndex.filesByDir`, PHP's `filesByRawDirectory`, COBOL's two tier
 * maps), and a 1-in-32 scan over one of THOSE passes
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
import { resolvePhpImportTargetInternal } from '../../src/core/ingestion/languages/php/import-target.ts';
import { resolveJavaImportTarget } from '../../src/core/ingestion/languages/java/import-target.ts';
import { cobolScopeResolver } from '../../src/core/ingestion/languages/cobol/scope-resolver.ts';
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
/** Languages whose resolvers retain the shared `WorkspaceFileIndex`, all four
 *  of which retained nothing at BASE. COBOL and `csharp_csproj` are absent on
 *  purpose — see the MEMORY section of the header for both reasons. */
const HEAP_LANGS = ['csharp', 'ruby', 'php', 'java'];

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
/**
 * The `csharp_csproj` arm's project configs — the whole reason that arm exists.
 *
 * `csharp` builds its context with NO `csharpConfigs`, so every one of its
 * imports takes the no-csproj branch and the csproj leg's namespace-directory
 * index (#2902) would ship unmeasured. Two configs rather than one because the
 * leg's cost is a function of `dirPrefix`'s SHAPE, and one config cannot
 * produce all three:
 *  - `App` + `projectDir: 'src'` gives `dirPrefix = 'src/<relative>'`, which
 *    CONTAINS a slash, so `candidateDirs` answers from the last-segment bucket;
 *  - `Lib` + `projectDir: ''` gives `dirPrefix = '<relative>'`, slash-FREE, the
 *    one leg that sweeps the last-segment KEYS and so is not constant-time;
 *  - `Lib` itself (the import IS the root namespace, no `projectDir` to stand
 *    in) gives an EMPTY `dirPrefix`, answered from `singleSegmentDirs`.
 * All three were a full `normalizedFileList` pass per import before #2902.
 */
const CSPROJ_CONFIGS = [
  { rootNamespace: 'App', projectDir: 'src' },
  { rootNamespace: 'Lib', projectDir: '' },
];
const EXTENSION = {
  go: '.go',
  csharp: '.cs',
  csharp_csproj: '.cs',
  dart: '.dart',
  ruby: '.rb',
  kotlin: '.kt',
  php: '.php',
  java: '.java',
  cobol: '.cbl',
};
/** Directory fan-out. Shared because `buildRepo`'s collide targets address
 *  files by `j % dirs` / `Math.floor(j / dirs)` and must agree with the layout
 *  `buildFiles` produced. */
const dirsFor = (fileCount) => Math.max(4, Math.floor(fileCount / 8));
/** File stems follow each language's own naming convention, because C#'s and
 *  PHP's suffix maps carry a case-insensitive tier and a lower-cased corpus
 *  would leave it answering the same question twice. */
const PASCAL_CASE_FILES = new Set(['csharp', 'csharp_csproj', 'kotlin', 'php', 'java', 'cobol']);

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
  if (lang === 'php') return d % 7 === 0 ? `src/App/Ns${d}/Sub/Ns${d}` : `src/App/Ns${d}`;
  if (lang === 'java') {
    return d % 7 === 0
      ? `mod${d}/src/main/java/com/example/pkg${d}/inner/pkg${d}`
      : `mod${d}/src/main/java/com/example/pkg${d}`;
  }
  // COBOL resolves on the BASENAME alone (`path.basename(fp, ext)`), so its
  // directories are pure realism — a copybook library beside the programs.
  if (lang === 'cobol') return d % 3 === 0 ? `copybooks/grp${d}` : `src/prog${d}`;
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
  if (lang === 'php') return `svc${d}/src/Models`;
  if (lang === 'java') {
    return d % 7 === 0
      ? `svc${d}/src/main/java/com/example/model/inner/model`
      : `svc${d}/src/main/java/com/example/model`;
  }
  if (lang === 'cobol') return `svc${d}/copybooks`;
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
  const dirs = dirsFor(fileCount);
  const files = [];
  // `csharp_csproj` is `csharp` with a different CONTEXT and nothing else. The
  // alias is here, in the one place that mints paths, rather than as a second
  // copy of the same layout in `uniqueDir`/`collideDir`: it makes the two arms'
  // corpora identical by construction, so a later edit to C#'s layout cannot
  // silently desynchronize them and turn the comparison into two experiments.
  const layout = lang === 'csharp_csproj' ? 'csharp' : lang;
  const ext = EXTENSION[layout];
  const prefix = pad === 0 ? '' : Array.from({ length: pad }, (_, n) => `d${n}`).join('/') + '/';
  for (let i = 0; i < fileCount; i++) {
    const d = i % dirs;
    const dir = shape === 'collide' ? collideDir(layout, d) : uniqueDir(layout, d);
    // In the collide shape Dart, Ruby, PHP and COBOL carry a REPEATED basename
    // — the term their indexes bucket or key on (COBOL's two tier maps are
    // keyed on the uppercased basename and NOTHING else). `i / dirs` is unique
    // within a directory (8 files land in each) and identical across
    // directories, which is exactly the `models.dart` / `models.rb`-in-every-
    // package convention. Go, C#, Kotlin and Java bucket on the DIRECTORY
    // instead, so their stems stay unique and the shared leaf segment is what
    // collides for them.
    const collideStem =
      layout === 'dart' || layout === 'ruby' || layout === 'cobol' || layout === 'php';
    const [fileStem, modStem] = PASCAL_CASE_FILES.has(layout) ? ['File', 'Mod'] : ['file', 'mod'];
    const stem =
      shape === 'collide' && collideStem ? `${modStem}${Math.floor(i / dirs)}` : `${fileStem}${i}`;
    // Go's package leg must exclude `_test.go`; keep a real share of them.
    // Kotlin resolves `.kt` and `.kts` through the same stem maps; keep both.
    // COBOL's copybook tier (`.cpy`) BEATS its source tier (`.cbl`) on the same
    // bookname, so both extensions have to be present for that tie-break to be
    // reachable at all — and in the collide shape, where basenames repeat, one
    // bookname really does land in both tiers.
    const suffix =
      layout === 'go' && i % 6 === 0
        ? '_test.go'
        : layout === 'kotlin' && i % 11 === 0
          ? '.kts'
          : layout === 'cobol' && i % 3 === 0
            ? '.cpy'
            : ext;
    files.push(`${prefix}${dir}/${stem}${suffix}`);
  }
  return files;
}

/**
 * The import one file issues in the UNIQUE-LEAF layout `uniqueDir` produced.
 *
 * The TARGET axis is split from the DIRECTORY axis exactly the way `uniqueDir`
 * and `collideDir` split it above — two flat functions, selected once — rather
 * than a `collide ?` ternary threaded through five languages' `local ? …`
 * ladders. `local` picks in-repo vs external; the handful of MISS lines that
 * are identical between the two shapes are duplicated on purpose, because the
 * alternative is four levels of nesting in a single expression.
 */
function uniqueTarget(lang, { local, r, d, j }) {
  if (lang === 'go') {
    return local
      ? `${GO_MODULE.modulePath}/src/pkg${d}`
      : (r >>> 3) % 2 === 0
        ? ['fmt', 'os', 'net/http', 'encoding/json'][(r >>> 4) % 4]
        : `github.com/org/repo${(r >>> 4) % 97}/pkg/util`;
  }
  if (lang === 'csharp') {
    return local
      ? `App.Ns${d}`
      : (r >>> 3) % 2 === 0
        ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 4) % 3]
        : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
  }
  if (lang === 'csharp_csproj') {
    // The mix is the arm. `System` and `Ghost{n}.Deep.Missing` match NEITHER
    // root namespace, so they `continue` straight out of the config loop
    // (csharp.ts:231-241) and never reach the indexed leg at all — an arm built
    // on the no-csproj arm's spelling mix would measure #2902 not at all. They
    // are kept as the fast-`continue` control at 1 slot in 8; the other four
    // external slots address a root namespace on purpose.
    if (local) return `App.Ns${d}`;
    const leg = (r >>> 3) % 5;
    // Matches `App`, misses every directory: `dirPrefix = 'src/Missing{n}'`,
    // whose last segment buckets to nothing. 2 slots in 8.
    if (leg < 2) return `App.Missing${(r >>> 4) % 97}`;
    // Matches `Lib`, whose `projectDir` is empty, so `dirPrefix` is slash-FREE
    // and `candidateDirs` sweeps the last-segment keys — the one leg of the
    // three whose cost is not constant in the corpus. See `_arms_note`.
    if (leg === 2) return `Lib.Missing${(r >>> 4) % 97}`;
    // The import IS a root namespace with no `projectDir`: `dirPrefix` is
    // EMPTY, the query no last-segment bucket expresses, answered from
    // `singleSegmentDirs`.
    if (leg === 3) return 'Lib';
    return (r >>> 4) % 2 === 0
      ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 5) % 3]
      : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
  }
  if (lang === 'dart') {
    return local
      ? `package:app/feature${d}/file${j}.dart`
      : (r >>> 3) % 3 === 0
        ? ['dart:core', 'dart:async', 'dart:io'][(r >>> 4) % 3]
        : `package:ext${(r >>> 4) % 97}/src/thing.dart`;
  }
  if (lang === 'kotlin') {
    // A share of wildcard imports: `.*` lands on the package fan-out tier,
    // which returns a LIST and is the only tier whose output is order-bearing.
    return local
      ? (r >>> 3) % 3 === 0
        ? `com.example.pkg${d}.*`
        : `com.example.pkg${d}.File${j}`
      : (r >>> 3) % 2 === 0
        ? ['java.util.List', 'kotlin.collections.Map', 'kotlinx.coroutines.flow.Flow'][
            (r >>> 4) % 3
          ]
        : `com.ghost${(r >>> 4) % 97}.deep.Missing`;
  }
  if (lang === 'php') {
    // Backslash-separated, the way a `use` statement is actually written; the
    // resolver normalizes them. No composer.json is threaded (the adapter's
    // `resolutionConfig` is left undefined), so every one of these lands on
    // `suffixResolve` — the leg that ran one `findIndex` over every file per
    // path part per extension, ~50 of them, and measured 96.40 ms per import at
    // 20k files before #2901.
    return local
      ? `App\\Ns${d}\\File${j}`
      : (r >>> 3) % 2 === 0
        ? [
            'Psr\\Log\\LoggerInterface',
            'Symfony\\Component\\Console\\Command',
            'Doctrine\\ORM\\EntityManager',
          ][(r >>> 4) % 3]
        : `Vendor${(r >>> 4) % 97}\\Ghost\\Missing`;
  }
  if (lang === 'java') {
    // Java has NO in-repo-namespace gate (#2910 is filed for it), so a JDK
    // import genuinely can resolve to a local file — `java.util.List` would
    // answer to a `util/List.java` anywhere in the repo, and the progressive
    // stripping loop would find it by its bare basename. These spellings are
    // chosen to miss on THIS corpus (whose files are all `File{i}.java` under
    // `…/pkg{d}/`) and the resolved count is asserted, not assumed.
    return local
      ? (r >>> 3) % 3 === 0
        ? `com.example.pkg${d}.*`
        : `com.example.pkg${d}.File${j}`
      : (r >>> 3) % 2 === 0
        ? ['java.util.List', 'java.io.IOException', 'java.util.concurrent.ConcurrentHashMap'][
            (r >>> 4) % 3
          ]
        : `com.google.common.vendor${(r >>> 4) % 97}.Missing`;
  }
  if (lang === 'cobol') {
    // `COPY` takes a bare bookname. A share of the local ones is spelled in
    // lower case: COBOL is case-insensitive and the resolver upper-cases the
    // target, so those must resolve to the same file — free coverage of the
    // one transformation on the lookup path.
    return local
      ? (r >>> 3) % 3 === 0
        ? `file${j}`
        : `File${j}`
      : (r >>> 3) % 2 === 0
        ? ['DFHAID', 'DFHBMSCA', 'SQLCA', 'CICSDEF'][(r >>> 4) % 4]
        : `VENDOR${(r >>> 4) % 97}`;
  }
  return local
    ? `mod${d}/file${j}`
    : (r >>> 3) % 2 === 0
      ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
      : `gem${(r >>> 4) % 97}/missing/thing`;
}

/**
 * The same import in the SHARED-LEAF layout `collideDir` produced. Each
 * language's local spelling is chosen so this arm resolves exactly as many
 * imports as the unique arm does (asserted): same workload, different layout.
 */
function collideTarget(lang, { local, r, d, j, dirs }) {
  if (lang === 'go') {
    return local
      ? // The replicated package is addressed by the path it shares, so the
        // module leg matches every service at once (`dirCount > 1`).
        d % 5 === 1 && d % 7 !== 0
        ? `${GO_MODULE.modulePath}/internal/shared`
        : `${GO_MODULE.modulePath}/svc${d}/internal`
      : (r >>> 3) % 2 === 0
        ? ['fmt', 'os', 'net/http', 'encoding/json'][(r >>> 4) % 4]
        : // Ends in the shared segment, so the GOPATH fallback walks the whole
          // bucket three times and still returns null: the MISS path this arm
          // exists to measure.
          `github.com/org/repo${(r >>> 4) % 97}/internal`;
  }
  if (lang === 'csharp') {
    return local
      ? // `Vendor` has no directory anywhere, mirroring the unique arm's
        // nested-same-name slice, which also resolves to nothing.
        d % 7 === 0
        ? `App.Src${d}.Vendor`
        : `App.Src${d}.Models`
      : (r >>> 3) % 2 === 0
        ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 4) % 3]
        : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
  }
  if (lang === 'csharp_csproj') {
    // Same five families as the unique arm, in the same proportions, so the
    // resolved count is identical by construction (asserted). Two things change.
    //
    // The local spelling moves onto the SECOND config: the collide layout puts
    // nothing under `src/`, so `projectDir: 'src'` addresses no directory here
    // and `App.Src{d}.Models` would resolve nothing. `Lib` (`projectDir: ''`)
    // addresses `Src{d}/Models` directly — the same relayout-not-reworkload
    // substitution every other language makes in this function.
    //
    // And `dirsByLastSegment` collapses from one key per directory to the
    // single key `Models`, which makes the slash-free SWEEP cheaper here than
    // on the unique layout while making the bucket the nested slice walks hold
    // every directory — the inverse of the go/csharp/dart collide arms, whose
    // every term gets worse. See `_arms_note`.
    if (local) return `Lib.Src${d}.Models`;
    const leg = (r >>> 3) % 5;
    if (leg < 2) return `App.Missing${(r >>> 4) % 97}`;
    if (leg === 2) return `Lib.Missing${(r >>> 4) % 97}`;
    if (leg === 3) return 'Lib';
    return (r >>> 4) % 2 === 0
      ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 5) % 3]
      : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
  }
  if (lang === 'dart') {
    return local
      ? `package:app/pkg${j % dirs}/lib/src/mod${Math.floor(j / dirs)}.dart`
      : (r >>> 3) % 3 === 0
        ? ['dart:core', 'dart:async', 'dart:io'][(r >>> 4) % 3]
        : // A repeated basename under a directory nothing carries: both
          // candidates walk the whole basename bucket and miss.
          `package:ext${(r >>> 4) % 97}/other/mod${(r >>> 4) % 8}.dart`;
  }
  if (lang === 'kotlin') {
    // Same wildcard share as the unique arm; `vendor${d}` is the collide
    // layout's spelling of a package that exists nowhere.
    return local
      ? (r >>> 3) % 3 === 0
        ? d % 7 === 0
          ? `com.example.vendor${d}.*`
          : `com.example.models.*`
        : `com.example.models.File${j}`
      : (r >>> 3) % 2 === 0
        ? ['java.util.List', 'kotlin.collections.Map', 'kotlinx.coroutines.flow.Flow'][
            (r >>> 4) % 3
          ]
        : `com.ghost${(r >>> 4) % 97}.deep.Missing`;
  }
  if (lang === 'php') {
    // `Models\Mod{n}` is carried by every service, so the segment-suffix key it
    // resolves through holds one entry no matter how many files exist: PHP
    // answers from keyed maps and is collision-IMMUNE, which is what this arm
    // asserts. The local spelling still always resolves, as it does on the
    // unique layout — PHP's cascade strips leading segments, so even the
    // nested-same-name slice is reachable by a shorter suffix.
    return local
      ? `App\\Models\\Mod${Math.floor(j / dirs)}`
      : (r >>> 3) % 2 === 0
        ? [
            'Psr\\Log\\LoggerInterface',
            'Symfony\\Component\\Console\\Command',
            'Doctrine\\ORM\\EntityManager',
          ][(r >>> 4) % 3]
        : `Vendor${(r >>> 4) % 97}\\Ghost\\Missing`;
  }
  if (lang === 'java') {
    // `com.svc{d}.model` matches no directory, but its LAST segment is the one
    // every directory now ends in, so `firstFileDirectlyInPkgDir` walks the
    // whole `model` bucket twice — at the direct match and again after the
    // first strip — before the third strip finds `model` on its own. That walk
    // is the non-constant term this arm exists to measure. `vendor` buckets to
    // nothing, mirroring the unique arm's nested slice, which also misses.
    return local
      ? (r >>> 3) % 3 === 0
        ? d % 7 === 0
          ? `com.svc${d}.vendor.*`
          : `com.svc${d}.model.*`
        : `com.example.model.File${j}`
      : (r >>> 3) % 2 === 0
        ? ['java.util.List', 'java.io.IOException', 'java.util.concurrent.ConcurrentHashMap'][
            (r >>> 4) % 3
          ]
        : `com.google.common.vendor${(r >>> 4) % 97}.Missing`;
  }
  if (lang === 'cobol') {
    // The repeated basename is COBOL's ONLY collision axis, and its index is a
    // keyed map, so this arm asserts immunity. It also reaches the tier
    // tie-break the unique arm cannot: `Mod{n}` now names both a `.cpy` and a
    // `.cbl`, and the copybook must win regardless of Set-iteration order.
    return local
      ? (r >>> 3) % 3 === 0
        ? `mod${Math.floor(j / dirs)}`
        : `Mod${Math.floor(j / dirs)}`
      : (r >>> 3) % 2 === 0
        ? ['DFHAID', 'DFHBMSCA', 'SQLCA', 'CICSDEF'][(r >>> 4) % 4]
        : `VENDOR${(r >>> 4) % 97}`;
  }
  return local
    ? `svc${j % dirs}/lib/models/mod${Math.floor(j / dirs)}`
    : (r >>> 3) % 2 === 0
      ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
      : `gem${(r >>> 4) % 97}/missing/thing`;
}

/**
 * One synthetic repository per language: the file set plus the import list each
 * file issues.
 */
function buildRepo(lang, fileCount, pad = 0, shape = 'unique') {
  const dirs = dirsFor(fileCount);
  const files = buildFiles(lang, fileCount, pad, shape);
  const mintTarget = shape === 'collide' ? collideTarget : uniqueTarget;

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
      imports.push([from, mintTarget(lang, { local, r, d, j, dirs })]);
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
  // No `resolutionConfig`, so no composer.json: the PSR-4 legs are skipped and
  // every import lands on the suffix cascade #2901 indexed.
  if (lang === 'php') return resolvePhpImportTargetInternal(target, from, allFilePaths);
  if (lang === 'java') {
    return resolveJavaImportTarget(
      { kind: 'named', localName: 'X', importedName: 'X', targetRaw: target },
      { fromFile: from, allFilePaths },
    );
  }
  // The `ScopeResolver` hook itself — COBOL's copy index has no other export.
  if (lang === 'cobol') return cobolScopeResolver.resolveImportTarget(target, from, allFilePaths);
  return resolveCsharpImportTarget(
    { kind: 'namespace', localName: '_', importedName: '_', targetRaw: target },
    {
      fromFile: from,
      allFilePaths,
      // The ONLY difference between the two C# arms. Present, the adapter takes
      // the csproj branch and never falls through to the no-csproj legs.
      ...(lang === 'csharp_csproj' ? { csharpConfigs: CSPROJ_CONFIGS } : {}),
    },
  );
}

/** The single untimed identity pass, producing BOTH non-timing results: the
 *  distinct `from|target → result` set the fingerprint hashes, and `resolved`
 *  counted over every import. One resolve per DISTINCT pair — on a fixed file
 *  set the resolvers are pure, so a repeated pair can only re-derive what the
 *  first occurrence already recorded, and the memoized `key → wasNull` answers
 *  the count for the repeat. Merged from two passes that each walked the whole
 *  corpus; the duplicate resolves measured ~1.15 s of an 11.4 s run.
 *
 *  Deliberately NOT shared with `resolveAll`, which is the TIMED loop: the memo
 *  that makes this pass cheap is exactly what would hide the cost that loop
 *  exists to measure. */
function identityPass(lang, files, imports) {
  const allFilePaths = new Set(files);
  const outcomes = new Set();
  const wasNullByKey = new Map();
  let resolved = 0;
  for (const [from, target] of imports) {
    const key = `${from}\u0000${target}`;
    let wasNull = wasNullByKey.get(key);
    if (wasNull !== undefined) {
      if (!wasNull) resolved++;
      continue;
    }
    const hit = resolveOne(lang, from, target, allFilePaths);
    wasNull = hit === null;
    wasNullByKey.set(key, wasNull);
    if (!wasNull) resolved++;
    const rendered = wasNull ? '<null>' : Array.isArray(hit) ? hit.join(',') : hit;
    outcomes.add(`${key}\u0000${rendered}`);
  }
  return { outcomes, resolved };
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

const LANGS = ['go', 'csharp', 'csharp_csproj', 'dart', 'ruby', 'kotlin', 'php', 'java', 'cobol'];
/** name, file count, depth padding, directory/basename layout. */
const ARMS = [
  ['small', SMALL, 0, 'unique'],
  ['large', LARGE, 0, 'unique'],
  ['deep', SMALL, DEEP_PAD, 'unique'],
  ['collide', SMALL, 0, 'collide'],
  ['collide_large', LARGE, 0, 'collide'],
];
/** Derived, never hand-written: the shape/fingerprint gate below iterates these
 *  names, so a new arm is asserted by construction rather than measured,
 *  printed and silently left out of the gate. */
const SCALES = ARMS.map(([name]) => name);
const report = {};
for (const lang of LANGS) {
  const scales = {};
  for (const [name, fileCount, pad, shape] of ARMS) {
    const { files, imports } = buildRepo(lang, fileCount, pad, shape);
    const { outcomes, resolved } = identityPass(lang, files, imports);
    scales[name] = {
      files: files.length,
      imports: imports.length,
      // Reported, not asserted on its own: a corpus edit that collapsed the
      // resolved share would still produce a "valid" fingerprint over far less.
      resolved,
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
  // One shape, five facts, so the five budgets read side by side and the shared
  // trailing sentence exists once instead of drifting into five wordings. Each
  // `why` stays the arm's OWN: it is what tells a triager which corpus shape
  // regressed, and flattening it would cost the message its whole value.
  const timingChecks = [
    {
      label: 'scaling',
      got: got.scaling_ratio,
      budget: baseline.scaling_budget,
      why: 'per-import cost grows with corpus size again.',
    },
    {
      label: 'depth',
      got: got.depth_ratio,
      budget: baseline.depth_budget[lang],
      why:
        'cost grows with path DEPTH at a fixed file count, which scaling_ratio divides out and ' +
        'cannot see.',
    },
    {
      label: 'collide scaling',
      got: got.collide_scaling_ratio,
      budget: baseline.collide_scaling_budget[lang],
      why:
        'on the SHARED-LEAF layout (svcN/internal, SrcN/Models, a repeated basename per package) ' +
        'per-import cost grew beyond what this shape already costs by construction.',
    },
    {
      label: 'small arm ms',
      got: got.small.ms,
      budget: baseline.small_ms_ceiling[lang],
      why:
        'an ABSOLUTE bound, because a constant-factor regression that grows both arms equally ' +
        'passes the ratio.',
    },
    {
      label: 'collide arm ms',
      got: got.collide.ms,
      budget: baseline.collide_ms_ceiling[lang],
      why: 'the ABSOLUTE bound on the shared-leaf layout.',
    },
  ];
  for (const check of timingChecks) {
    if (check.got > check.budget) {
      failures.push(
        `${lang}: ${check.label} ${check.got} > budget ${check.budget} — ${check.why} ` +
          `Timing arm: re-run on an idle machine before investigating.`,
      );
    }
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
