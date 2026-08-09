/**
 * Build-free scaling + identity bench for EVERY import-target resolver in
 * `SCOPE_RESOLVERS` — all sixteen registered languages — over ONE shared corpus
 * so the arms are directly comparable. Seventeen arms, because `csharp` appears
 * twice: once with no csproj configs and once with them (#2902).
 *
 * NO LANGUAGE IS OMITTED, and that is the point of the list rather than an
 * accident of it. Nine of these (go, csharp, csharp_csproj, dart, ruby, kotlin,
 * php, java, cobol) were added as their own O(imports × files) scans were
 * indexed away — #2877/#2878/#2879/#2880, #2872, #2901, #2902, #2908 — and the
 * bench is the forward guard on each. The other eight (swift, rust, python,
 * javascript, typescript, vue, c, cpp) resolve imports through the same
 * registered hook with the same per-run memoized indexes, and were ungated:
 * nothing pinned their output and nothing pinned their scaling. One of them was
 * not hypothetical — JavaScript reached `suffixResolve` with no index at all and
 * measured 25 972 µs per import at 8000 files (#2910) — which is exactly the
 * class of defect the other seven were one commit away from.
 *
 * A C or C++ `#include` is an import site for this purpose and is gated like
 * the other fourteen. See `newPass` for the one structural thing those two need
 * that no other language does.
 *
 * Kotlin also has `bench/kotlin-import-target/`, and this does not replace it:
 * that bench fingerprints both file-set iteration orders and probes the
 * four-tier cascade shape by shape, which this corpus does not. What Kotlin
 * gains here is a second corpus and the arms below that its own bench predates.
 *
 * Each of the first nine resolvers answered its lookups with a full
 * `allFilePaths` scan per import before its fix, so import resolution cost
 * O(imports × files):
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
 * The eight added afterwards are not a second class of arm — they carry the
 * same five timing arms, the same per-scale fingerprint and shape gates and the
 * same budgets. What differs is what each one's cost is a function of, because
 * that decides which arm can actually fail for it:
 *
 *   - swift: `getSwiftModuleIndex` buckets a file under EVERY interior
 *     directory segment, so `Sources/Models/User.swift` answers to `Sources`
 *     and to `Models`. A miss is a Map miss and flat; a HIT returns the whole
 *     module bucket minus the importer, so its cost is the BUCKET size. Nothing
 *     in the unique layout produces a large bucket, which is why its collide
 *     arm is four modules instead of `dirs` of them (`SWIFT_COLLIDE_MODULES`);
 *     measured 3.28 there against 0.90 on file count.
 *   - rust: probes candidate paths with `allFilePaths.has(...)` and never
 *     searches, so its cost is O(path SEGMENTS) and is provably flat in the
 *     file count — measured 1.10 scaling, 1.06 collide scaling. That flatness
 *     IS the assertion, and it is why its collide arm is a deep module tree
 *     with ~2x the `::` segments rather than a shared-leaf layout: a collide
 *     arm built on file count would have been an arm that cannot fail. Note
 *     that `buildRustModuleIndex` lives on a DIFFERENT hook
 *     (`qualified-call.ts::moduleIndexFor`) and is not on this path at all.
 *   - python: `getPythonFileIndex` is keyed and flat on both file count and
 *     bucket cardinality (1.11 / 1.10), but `hasRepoCandidate` and
 *     `resolveAbsoluteFromFiles` each rebuild one ancestor prefix per directory
 *     component of the IMPORTER, so per-import cost is quadratic in path depth:
 *     measured depth_ratio 7.39, by far the largest here, and the reason its
 *     depth budget is 11 rather than the ~2 most languages carry.
 *   - javascript, typescript, vue: one resolver (`resolveTsTarget`) behind
 *     three adapters, so the three corpora are the same shape and differ only
 *     in what actually differs — the extension list (`.js` vs `.ts`) and, for
 *     Vue, the tsconfig alias branch (see `VUE_TSCONFIG`). All three are
 *     miss-dominated bare specifiers, because a relative import resolves by
 *     exact `Set.has` and never reaches the leg that had no index.
 *   - c, cpp: `resolveCppImportTarget` delegates to `resolveCImportTarget`, so
 *     the two share a resolver and differ in extension set and in which adapter
 *     builds the augmented set. Cost is a basename bucket walk with a
 *     depth-then-lexicographic tie-break, so the collide arm (a `mod{n}` header
 *     in every service's `include/`) is where it grows: 2.54 / 2.64 against
 *     1.06 on file count.
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
 *     which is why the budget is per language. Python is the extreme and the
 *     reason the spread is worth a per-language number at all: its index is
 *     depth-free, but `hasRepoCandidate` and `resolveAbsoluteFromFiles` rebuild
 *     an ancestor prefix per importer directory component ON EVERY IMPORT, so
 *     the RESOLVER, not the index, is quadratic in depth — 7.39;
 *   - `collide_scaling_ratio`, the same measurement on a corpus whose
 *     directories SHARE their last segment and whose files share basenames —
 *     see the `collide` section below;
 *   - `heap` (8 of the 17): retained bytes of the per-pass import index, read by
 *     resolving one real import — see the `heap` section below;
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
 *     every ratio;
 *   - a heap FLOOR beside every heap ceiling, and a presence check in front of
 *     every timing budget. Both exist because the same failure has now happened
 *     twice in this file's short life: an arm that stops measuring passes. A
 *     lazy `buildSuffixIndex` made four heap arms read 0 B, and 0 B is under
 *     every ceiling; a deleted budget key makes `got > undefined` false, which
 *     is a deleted gate wearing a passing arm's clothes;
 *   - an INVENTORY arm against `SCOPE_RESOLVERS` itself. `LANG_REGISTRY` claims
 *     to cover every registered resolver; this is what makes the claim true
 *     rather than commented, and it is the arm that would have caught #2910's
 *     language shipping unmeasured.
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
 *     one, so its expensive scale arm is `large`, not `collide_large`;
 *   - of the eight added later, swift (3.28) and c/cpp (2.54/2.64) are the two
 *     that scan a bucket, and they scan DIFFERENT buckets: swift's is the
 *     module's own file list, which it returns, and C's is the basename bucket
 *     its suffix fallback walks. python, javascript, typescript and vue answer
 *     from keyed maps and sit at 1.03-1.10, so they keep the linear budget and
 *     that immunity is their assertion, exactly as for ruby and kotlin;
 *   - rust's collide arm is the one that is NOT a shared-leaf layout, and the
 *     reason is in the list above: file count is not an axis its cost has, so a
 *     shared-leaf rust arm would have been an arm that cannot fail. Its collide
 *     corpus is a deep module tree whose targets carry ~2x the `::` segments,
 *     which is the axis that CAN grow; the ratio across file counts staying at
 *     1.06 on it is the assertion, and `collide_ms_ceiling` bounds the absolute
 *     cost of the long-path probe.
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
 * Four more are gated for the same reason as those four. JavaScript is the
 * clearest case in the file: before #2910 it retained NOTHING because it built
 * no index at all, and it now retains 25.51 MiB at 32 000 files through the
 * same `buildSuffixIndex`. `csharp_csproj` is the newest and the one that
 * proves the arm's design: same corpus and same `getWorkspaceFileIndex` as
 * `csharp`, but its csproj leg asks all three questions instead of one, and it
 * retains 70.29 MiB against C#'s 28.48. Python's `getPythonFileIndex`
 * (9.88 MiB) and C's basename map (9.55 MiB) are an order of magnitude smaller
 * but are the only structure either language keeps, and both are one careless
 * edit — a stored `split('/')` array instead of a depth NUMBER — away from the
 * O(files × depth) shape this arm exists to catch.
 *
 * WHAT THE ARM MEASURES IS NOW THE READ PATTERN, and that is the correction
 * this file most needed. `buildSuffixIndex`'s two suffix maps became lazy
 * (#2903 extended past `dirMap`), and the four original arms — which called
 * `getWorkspaceFileIndex(set)` directly and read `index.all.length` — stopped
 * asking any suffix question, built no map, and reported 0 B at 32 000 files.
 * 0 B is under every ceiling, so `--check` PASSED with four gates that had
 * become ceilings over nothing. Every arm now resolves one real MISSING import
 * through the real resolver, so the maps it forces are the maps production
 * forces; `HEAP_PROBE_TARGET` and `retainedPassBytes` carry the details, and
 * `heap_floor_fraction` is the gate that would have caught the 0 B.
 *
 * SIX of the seventeen are deliberately NOT in `HEAP_LANGS`, every one of them
 * measured before being left out rather than argued out:
 *
 *   - rust builds no index on this hook at all. Measured 16 B at 8000 files and
 *     0 B at 32 000 — the arm would be a ceiling over nothing;
 *   - swift's `byModule` holds one POINTER per (file × interior segment) and
 *     mints no new strings, and it reads 0.98 MB at 8000 files against 0.29 MB
 *     at 32 000 — a four-fold larger corpus reading three times SMALLER, which
 *     is what a measurement below its own noise floor looks like. Gating that
 *     would gate noise;
 *   - COBOL, for the same reason and separately measured: two
 *     `Map<basename, path>`, O(files) with no depth term, 0.54 MB at 8000 files
 *     and 0 B at 32 000;
 *   - typescript and vue run javascript's builder over a same-shaped corpus and
 *     ask it the same questions, so their numbers are duplicates and measurably
 *     so: typescript read 46 208 544 B against javascript's 46 208 832 B, a
 *     288 B difference on 46 MB (0.0006%), and vue read 48 699 384 B, the +5.4%
 *     that four characters of `.vue` instead of `.ts` buys on two thirds of the
 *     paths;
 *   - cpp likewise duplicates c: 10 021 320 B against 10 016 960 B, 0.04% apart.
 *
 * Those four "it would be a duplicate" exclusions are duplicates of a BUILDER
 * and of a READ PATTERN, and both halves have to hold — `csharp_csproj` was on
 * this list on the strength of the first half alone, at +20.8% of the C# index,
 * and reads 2.47x of it now that the second half decides the number. If any of
 * the four ever diverges in what it ASKS, it earns an arm the same way.
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
 * baselines.json. #2910 is the proof that this blind spot is real rather than
 * theoretical: JavaScript's missing index was a scan of
 * `ImportPassCache.normalizedFileList` on EVERY import, which the Set counter
 * could not see, and it took a differential parity test over 211 200 pairs plus
 * this bench's arrival to pin it.
 *
 * COST. ~35 s in report mode and ~42 s for `--check`, down from ~46 s. The
 * timing phase fell from 39.8 s to 28.7 s when `REPS` became per-language (see
 * `repsFor`); `--check` then pays 7.3 s that report mode does not, for the one
 * dynamic import the inventory arm needs. See the wall-clock note in
 * `_arms_note` for the per-language breakdown and for what to drop first if
 * that stops fitting the job.
 *
 * Run:
 *   node --expose-gc --import tsx bench/import-target/measure.mjs           # report
 *   node --expose-gc --import tsx bench/import-target/measure.mjs --check   # CI gate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SupportedLanguages } from 'gitnexus-shared';

import { resolveGoImportTarget } from '../../src/core/ingestion/languages/go/import-target.ts';
import { resolveDartImportTarget } from '../../src/core/ingestion/languages/dart/import-target.ts';
import { resolveRubyImportTarget } from '../../src/core/ingestion/languages/ruby/import-target.ts';
import { resolveCsharpImportTarget } from '../../src/core/ingestion/languages/csharp/import-target.ts';
import { resolveKotlinImportTarget } from '../../src/core/ingestion/languages/kotlin/import-target.ts';
import { resolvePhpImportTargetInternal } from '../../src/core/ingestion/languages/php/import-target.ts';
import { resolveJavaImportTarget } from '../../src/core/ingestion/languages/java/import-target.ts';
import { cobolScopeResolver } from '../../src/core/ingestion/languages/cobol/scope-resolver.ts';
import { resolveSwiftImportTarget } from '../../src/core/ingestion/languages/swift/import-target.ts';
import { resolveRustImportTarget } from '../../src/core/ingestion/languages/rust/import-target.ts';
import { resolvePythonImportTarget } from '../../src/core/ingestion/languages/python/import-target.ts';
import { makeJsResolveImportTarget } from '../../src/core/ingestion/languages/javascript/import-target.ts';
import { makeVueResolveImportTarget } from '../../src/core/ingestion/languages/vue/import-target.ts';
// The two `ScopeResolver`s, not their inner resolvers — see `RESOLVE_HOOK`.
import { typescriptScopeResolver } from '../../src/core/ingestion/languages/typescript/scope-resolver.ts';
import { cScopeResolver } from '../../src/core/ingestion/languages/c/scope-resolver.ts';
import { cppScopeResolver } from '../../src/core/ingestion/languages/cpp/scope-resolver.ts';
// `SCOPE_RESOLVERS` is NOT imported here — see the inventory arm at the bottom,
// which loads it dynamically. Statically it costs 7.3 s of module load (3.3 s
// -> 10.6 s, measured), because reaching the registry pulls in all sixteen
// providers and everything under them, and it is wanted by one `--check` arm
// that runs after the last measurement.

/** The JS and Vue adapter FACTORIES return a closure; the memo they read is
 *  module-level, so one instance per process is both correct and what the
 *  registry does (`resolveImportTarget: makeJsResolveImportTarget()`). */
const jsResolveImportTarget = makeJsResolveImportTarget();
const vueResolveImportTarget = makeVueResolveImportTarget();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 400;
const LARGE = 1600;
const IMPORTS_PER_FILE = 8;
/** Extra directory components prepended in the `deep` arm — see `depth_ratio`. */
const DEEP_PAD = 16;
/**
 * `fastest()` below is a min-of-N estimator, so N is the noise knob: raising it
 * lowers and stabilises the minimum. `depth_ratio` divides two sub-3 ms
 * measurements, and Dart's are sub-1 ms, so it is by far the noisiest number
 * here. Measured over 22 `--check` runs on an idle box: at N=5 it tripped its
 * own budget ~1 run in 20, at N=7 Dart still swung 3.0x peak-to-peak and
 * tripped once. N=15 (which matches `bench/cfg`, `bench/schema-pairs` and
 * `bench/callable-value-flow`) collapsed every language to a 1.13-1.26x swing
 * with 22/22 passing; the distributions are recorded in `_arms_note`.
 *
 * N used to be 15 for EVERY arm, set globally by the noisiest cell. That paid
 * the noisiest cell's insurance premium on cells a thousand times its size:
 * the recorded overshoot of min-of-K against min-of-15 is a function of the
 * cell's absolute duration, not of the language — 31.8% on `swift.small`
 * (0.43 ms) and 37.6% on `dart.collide` (1.5 ms) at the extreme, but at most
 * 6.3% at K=7 for every cell at or above 10 ms.
 *
 * So N is picked PER LANGUAGE, from the cost of its cheapest arm: 15 while that
 * is under `REPS_CHEAP_MS`, and `~REPS_BUDGET_MS` worth of samples above it,
 * floored at `REPS_MIN`. Per language rather than per cell so all five arms of
 * a language share one estimator and the four ratios stay comparisons of like
 * with like. In practice that is still 15 for go, csharp, dart, kotlin, java,
 * cobol, swift, rust, python, c and cpp — every language the flakiness above
 * was ever about — and 7-8 for php, csharp_csproj, ruby, javascript, typescript
 * and vue, whose cheapest cell is 20-28 ms. Replayed against two independent
 * runs' sample sets it saved 12.8 s and 12.4 s of a 46 s run with all 85 cells
 * passing all five gates at 0.4-0.7 of budget, and min-of-7 reads slightly
 * HIGHER than min-of-15, so the gates get marginally more sensitive rather than
 * less. The chosen N is reported per language as `reps`.
 */
const REPS_MAX = 15;
const REPS_MIN = 7;
/** Sampling budget per cell for the languages that do not get `REPS_MAX`. */
const REPS_BUDGET_MS = 150;
/** Below this a cell is small enough for the min-of-N estimator itself to be
 *  the dominant error, so it gets the full `REPS_MAX` regardless of budget. The
 *  nearest language on either side of it is 3.2 ms and 20.0 ms, so nothing sits
 *  near the boundary. */
const REPS_CHEAP_MS = 5;
const WARMUP = 2;

/** N for one language, from one warmed pass of its cheapest arm. */
function repsFor(probeMs) {
  if (probeMs < REPS_CHEAP_MS) return REPS_MAX;
  return Math.min(REPS_MAX, Math.max(REPS_MIN, Math.ceil(REPS_BUDGET_MS / probeMs)));
}

/** Heap arm. Far more files than the timing arms because the finding
 *  is an ABSOLUTE footprint at repository scale, and 1600 files would report a
 *  fraction of a MiB — a number no ceiling could usefully bound. `HEAP_PAD`
 *  keeps the paths at a plausible monorepo depth: `buildSuffixIndex` is
 *  O(files × depth), so a flat corpus would understate it by ~4x. */
const HEAP_SMALL = 8000;
const HEAP_LARGE = 32000;
const HEAP_PAD = 8;
/** The languages whose retained per-pass index is measured, all eight the same
 *  way — `retainedPassBytes`, one real import through the real resolver. The
 *  first five reach the shared `WorkspaceFileIndex` and retained NOTHING at
 *  BASE; `csharp_csproj` is the same corpus through the same index under the
 *  csproj context, and it is here rather than excluded as a duplicate because
 *  after #2903 its READ PATTERN, not its corpus, decides the number. Eight of
 *  seventeen: COBOL, rust, swift, typescript, vue and cpp are absent on purpose
 *  and the MEMORY section of the header gives a separate reason for each. */
const HEAP_LANGS = ['csharp', 'csharp_csproj', 'ruby', 'php', 'java', 'javascript', 'python', 'c'];

/**
 * Needs `node --expose-gc` to force collection for a clean delta; without it
 * the heap metric is reported as null and its `--check` gate would be skipped,
 * which is why `--check` refuses to run without the flag (see below).
 *
 * TWO cycles because the value is a `WeakMap`'s: the first clears the entry
 * once its key is unreachable, the second collects what the entry held. That is
 * not always enough — PHP reaches the shared index through a second per-file-
 * set memo of its own (`getPhpWorkspaceIndex` wraps `getWorkspaceFileIndex`,
 * both keyed on the same Set) and that chain measured FOUR cycles to release,
 * with two leaving 9.3 MB of the previous read still counted live. The answer
 * to that is `HEAP_RETAINED`, which removes the need to release anything inside
 * a measurement window, plus the deeper drain `measureHeap` runs between
 * languages where a late free costs nothing. Cycles are not the knob: with
 * `HEAP_RETAINED` in place, two and four produce byte-identical readings, and
 * four cost 4.5 s of wall clock over a retained heap this size.
 */
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
/**
 * The `tsconfigPaths` the Vue arm threads as `resolutionConfig`.
 *
 * The Vue adapter is `resolveTsTarget` with `language: TypeScript` and nothing
 * else, so with a null config its arm would be a byte-for-byte re-run of the
 * TypeScript one over a differently-spelled corpus. The alias branch
 * (`standard.ts:57-70`) is the one leg of the shared resolver that neither the
 * `javascript` arm (which pins `tsconfigPaths: null`) nor the `typescript` arm
 * here reaches, so wiring it is what makes this a third measurement rather than
 * a third copy — and every local Vue import below is spelled `@/…`.
 */
const VUE_TSCONFIG = { tsconfigPaths: { aliases: new Map([['@/', 'src/']]), baseUrl: '.' } };
/** Keyed by LAYOUT name, so there is no `csharp_csproj` row: `buildFiles`
 *  aliases that arm to `csharp` before this table is read. */
const EXTENSION = {
  go: '.go',
  csharp: '.cs',
  dart: '.dart',
  ruby: '.rb',
  kotlin: '.kt',
  php: '.php',
  java: '.java',
  cobol: '.cbl',
  swift: '.swift',
  rust: '.rs',
  python: '.py',
  javascript: '.js',
  typescript: '.ts',
  vue: '.vue',
  c: '.c',
  cpp: '.cpp',
};
/** C and C++ resolve `#include` against HEADERS, which reach the resolver
 *  through `resolutionConfig` rather than through `allFilePaths` — see
 *  `newPass`. Half of each corpus is headers; this is their extension. */
const HEADER_EXTENSION = { c: '.h', cpp: '.hpp' };
/** Directory fan-out. Shared because `buildRepo`'s collide targets address
 *  files by `j % dirs` / `Math.floor(j / dirs)` and must agree with the layout
 *  `buildFiles` produced. */
const dirsFor = (fileCount) => Math.max(4, Math.floor(fileCount / 8));
/** Swift's collide arm, and the ONLY place a bucket size is pinned by a
 *  constant rather than by `dirsFor`. A module bucket is what Swift returns, so
 *  its cardinality has to grow with the corpus for the arm to measure anything:
 *  four modules means fileCount/4 per bucket (100 at `collide`, 400 at
 *  `collide_large`), which is the shape a small SPM package actually has. */
const SWIFT_COLLIDE_MODULES = 4;
/** File stems follow each language's own naming convention, because C#'s and
 *  PHP's suffix maps carry a case-insensitive tier and a lower-cased corpus
 *  would leave it answering the same question twice. Keyed by LAYOUT name, like
 *  `EXTENSION` — no `csharp_csproj` row, for the same reason. */
const PASCAL_CASE_FILES = new Set([
  'csharp',
  'kotlin',
  'php',
  'java',
  'cobol',
  // Swift types and Vue SFCs are PascalCase by universal convention.
  'swift',
  'vue',
]);
/** Rust and Python name a DIRECTORY as a module through a well-known file, so
 *  the first file minted in each directory is that file rather than a numbered
 *  one. Every in-repo target below resolves to one of them. */
const PACKAGE_STEM = { rust: 'mod', python: '__init__' };

/**
 * The end of a per-language dispatcher, where five of them used to fall through
 * to a bare `return`.
 *
 * Four of those fallthroughs meant "ruby" and the fifth meant "csharp". So
 * `ruby` appeared nowhere in this file except `EXTENSION` and the language
 * list, and — the part that matters — a language added to the list but missed
 * in the dispatchers would have been benchmarked as RUBY'S CORPUS RESOLVED BY
 * C#'S RESOLVER: five plausible timings, a stable fingerprint, and a permanent
 * pass over a language nobody had measured. Every dispatcher now names its last
 * branch and throws here instead, so the missing wiring is a crash on the first
 * run rather than a green gate.
 */
function unwiredLanguage(where, lang) {
  return new Error(
    `bench: ${where} has no branch for '${lang}'. Every language in LANG_REGISTRY needs one in ` +
      `uniqueDir, collideDir, uniqueTarget, collideTarget and resolveOne. (uniqueDir and ` +
      `collideDir see the LAYOUT name, which is never 'csharp_csproj' — buildFiles aliases it ` +
      `to 'csharp'.) Falling through here used to hand the language another one's corpus or ` +
      `another one's resolver, and nothing in --check could tell.`,
  );
}

/**
 * UNIQUE-LEAF layout: one directory name per index, so no two directories share
 * a last segment and no two files share a basename. Every index bucket holds
 * exactly one entry. A nested same-name directory in one repo slice is the
 * shape whose handling the first-`indexOf` tie-break decides (see
 * package-dir-index.ts), and the shape Kotlin's `dirChildren` resolves the same
 * way.
 */
function uniqueDir(lang, d, i) {
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
  // SPM. The nested slice makes one file's interior segments repeat
  // (`Sources/Mod7/Internal/Mod7/File7.swift`), and `getSwiftModuleIndex`
  // pushes once per segment, so that file appears TWICE in module `Mod7`'s
  // returned list. Real layout, real output; the fingerprint pins it.
  if (lang === 'swift') {
    return d % 7 === 0 ? `Sources/Mod${d}/Internal/Mod${d}` : `Sources/Mod${d}`;
  }
  // Cargo. The nested slice has NO `mod{d}/mod.rs`, so `crate::mod{d}::thing`
  // misses there — the same resolves/misses split every other unique arm has.
  if (lang === 'rust') return d % 7 === 0 ? `src/mod${d}/inner` : `src/mod${d}`;
  if (lang === 'python') return d % 7 === 0 ? `pkg${d}/inner` : `pkg${d}`;
  if (lang === 'javascript' || lang === 'typescript') return `src/mod${d}`;
  // Vue's local imports are all `@/…`, which the alias rewrites to `src/…`, so
  // the whole corpus must live under `src/` for that branch to hit.
  if (lang === 'vue') return `src/mod${d}`;
  // C and C++ split headers from sources — the shape that makes
  // `resolutionConfig` load-bearing. Odd `i` is the header.
  if (lang === 'c' || lang === 'cpp') return i % 2 === 1 ? `include/comp${d}` : `src/comp${d}`;
  if (lang === 'ruby') return `lib/mod${d}`;
  throw unwiredLanguage('uniqueDir', lang);
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
function collideDir(lang, d, i) {
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
  // Swift's collision axis is neither a shared directory name nor a shared
  // basename: `byModule` is KEYED on the module name, so what grows a bucket is
  // FEWER modules holding MORE files. `SWIFT_COLLIDE_MODULES` of them, so the
  // bucket a hit returns is fileCount/4 — 100 entries at 400 files and 400 at
  // 1600 — and a hit copies that whole bucket minus the importer.
  if (lang === 'swift') return `Sources/Mod${d % SWIFT_COLLIDE_MODULES}`;
  // Rust's cost is O(path SEGMENTS), not O(files) — it probes candidate paths
  // with `.has()` and never searches. So its collide arm is a deep module tree
  // whose targets carry ~2x the `::` segments, which is the axis that CAN grow;
  // that the ratio across file counts stays flat on it is the assertion.
  if (lang === 'rust') return `src/l0/l1/l2/l3/l4/mod${d}`;
  // The `inner` slice mirrors the unique arm's, and for the same reason: it is
  // where the in-repo target misses, so both arms resolve the same count.
  if (lang === 'python') return d % 7 === 0 ? `svc${d}/models/inner` : `svc${d}/models`;
  if (lang === 'javascript' || lang === 'typescript') return `pkg${d}/src`;
  if (lang === 'vue') return `src/pkg${d}/components`;
  if (lang === 'c' || lang === 'cpp') return i % 2 === 1 ? `svc${d}/include` : `svc${d}/src`;
  if (lang === 'ruby') return `svc${d}/lib/models`;
  throw unwiredLanguage('collideDir', lang);
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
    const dir = shape === 'collide' ? collideDir(layout, d, i) : uniqueDir(layout, d, i);
    // In the collide shape Dart, Ruby, PHP and COBOL carry a REPEATED basename
    // — the term their indexes bucket or key on (COBOL's two tier maps are
    // keyed on the uppercased basename and NOTHING else). `i / dirs` is unique
    // within a directory (8 files land in each) and identical across
    // directories, which is exactly the `models.dart` / `models.rb`-in-every-
    // package convention. Go, C#, Kotlin and Java bucket on the DIRECTORY
    // instead, so their stems stay unique and the shared leaf segment is what
    // collides for them.
    const collideStem =
      layout === 'dart' ||
      layout === 'ruby' ||
      layout === 'cobol' ||
      layout === 'php' ||
      // The three added later that also bucket or key on the BASENAME:
      // JS/TS `buildSuffixIndex` (one entry per path suffix, so the last
      // component is the shortest key), Vue through the same index, Python's
      // `byBasename`, and C/C++'s basename map — for the last, only the header
      // half is addressable, so only it repeats (see below).
      layout === 'javascript' ||
      layout === 'typescript' ||
      layout === 'vue' ||
      layout === 'python' ||
      layout === 'c' ||
      layout === 'cpp';
    const [fileStem, modStem] = PASCAL_CASE_FILES.has(layout) ? ['File', 'Mod'] : ['file', 'mod'];
    let stem =
      shape === 'collide' && collideStem ? `${modStem}${Math.floor(i / dirs)}` : `${fileStem}${i}`;
    // Rust's `mod.rs` and Python's `__init__.py`: one per directory, and the
    // file every in-repo target of theirs resolves to. Minted at the first file
    // of each directory (`i < dirs`, so `d === i`), which is why both arms'
    // resolved counts are the count of in-repo imports either way.
    if (PACKAGE_STEM[layout] !== undefined && i < dirs) stem = PACKAGE_STEM[layout];
    // C and C++ address only HEADERS, so only their stems repeat in the collide
    // shape; the sources stay unique and are pure corpus weight, exactly as in a
    // real tree where nobody `#include`s a `.c`.
    if ((layout === 'c' || layout === 'cpp') && i % 2 === 0) stem = `src${i}`;
    // Go's package leg must exclude `_test.go`; keep a real share of them.
    // Kotlin resolves `.kt` and `.kts` through the same stem maps; keep both.
    // COBOL's copybook tier (`.cpy`) BEATS its source tier (`.cbl`) on the same
    // bookname, so both extensions have to be present for that tie-break to be
    // reachable at all — and in the collide shape, where basenames repeat, one
    // bookname really does land in both tiers.
    // A Vue repo is `.vue` SFCs plus plain `.ts` modules, and only the second
    // kind reaches the extension-guessing leg (SFC imports carry `.vue`
    // explicitly), so both have to be present for both legs to be measured.
    // C/C++ alternate header and source; the header half is the addressable one.
    const suffix =
      layout === 'go' && i % 6 === 0
        ? '_test.go'
        : layout === 'kotlin' && i % 11 === 0
          ? '.kts'
          : layout === 'cobol' && i % 3 === 0
            ? '.cpy'
            : layout === 'vue' && i % 3 === 0
              ? '.ts'
              : HEADER_EXTENSION[layout] !== undefined && i % 2 === 1
                ? HEADER_EXTENSION[layout]
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
 * than a `collide ?` ternary threaded through seventeen languages' `local ? …`
 * ladders. `local` picks in-repo vs external; the handful of MISS lines that
 * are identical between the two shapes are duplicated on purpose, because the
 * alternative is four levels of nesting in a single expression.
 */
function uniqueTarget(lang, { local, r, d, j, dirs }) {
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
  if (lang === 'swift') {
    // `import X` names an SPM MODULE, never a file, so there is no `.File{j}`
    // spelling to mint: the target is the module and the answer is its whole
    // file list. The misses are the frameworks that ship with the platform and
    // the SPM packages that live in `.build/`, i.e. outside the corpus.
    return local
      ? `Mod${d}`
      : (r >>> 3) % 2 === 0
        ? ['Foundation', 'UIKit', 'Combine', 'SwiftUI'][(r >>> 4) % 4]
        : `ExternalPkg${(r >>> 4) % 97}`;
  }
  if (lang === 'rust') {
    // `crate::mod{d}::thing` resolves by PROBING: `src/mod{d}/thing.rs`,
    // `src/mod{d}/thing/mod.rs`, `src/mod{d}.rs`, then `src/mod{d}/mod.rs`,
    // which hits. The `d % 7` slice has no `mod.rs` at that path and misses,
    // which is where the resolved count comes from.
    return local
      ? `crate::mod${d}::thing`
      : (r >>> 3) % 2 === 0
        ? ['std::collections::HashMap', 'tokio::sync::mpsc', 'serde::Deserialize'][(r >>> 4) % 3]
        : `ghost${(r >>> 4) % 97}::Missing`;
  }
  if (lang === 'python') {
    // Dotted absolute imports. The stdlib spellings and the unknown
    // distributions both die at `hasRepoCandidate`, which is the gate that
    // keeps `django.apps` off a local `accounts/apps.py`.
    return local
      ? `pkg${d}.file${j}`
      : (r >>> 3) % 2 === 0
        ? ['os.path', 'collections.abc', 'django.db.models'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}.deep.missing`;
  }
  if (lang === 'javascript' || lang === 'typescript') {
    // BARE specifiers, not relative ones. A relative import resolves by exact
    // `Set.has` and never reaches `suffixResolve` — the leg that had no index
    // for JavaScript until #2910 and cost 25 972 µs per import at 8000 files —
    // so a corpus of `./sibling` imports would measure the wrong function.
    return local
      ? `src/mod${d}/file${j}`
      : (r >>> 3) % 2 === 0
        ? ['react', 'lodash/fp', '@scope/ui/dist/index'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/lib/missing`;
  }
  if (lang === 'vue') {
    // Every in-repo import is `@/…`, so the alias branch runs on all of them.
    // The `.vue` share carries its extension (SFC imports always do) and takes
    // the exact-path leg; the `.ts` share omits it and takes the guessing leg.
    return local
      ? j % 3 === 0
        ? `@/mod${d}/File${j}`
        : `@/mod${d}/File${j}.vue`
      : (r >>> 3) % 2 === 0
        ? ['vue', 'pinia', '@vueuse/core'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/lib/Missing.vue`;
  }
  if (lang === 'c' || lang === 'cpp') {
    // `#include "comp{d}/file{j}.h"`. `j | 1` picks the HEADER half of the
    // corpus — the even half is `.c`/`.cpp` and nothing includes those. The
    // misses are the two kinds a real tree has: a system header that is not in
    // the repo at all, and a vendored path that does not exist.
    const h = HEADER_EXTENSION[lang];
    const jj = j | 1;
    return local
      ? `comp${jj % dirs}/file${jj}${h}`
      : (r >>> 3) % 2 === 0
        ? ['stdio.h', 'stdlib.h', 'string.h'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/missing${h}`;
  }
  if (lang === 'ruby') {
    return local
      ? `mod${d}/file${j}`
      : (r >>> 3) % 2 === 0
        ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
        : `gem${(r >>> 4) % 97}/missing/thing`;
  }
  throw unwiredLanguage('uniqueTarget', lang);
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
  if (lang === 'swift') {
    // Four modules instead of `dirs` of them, so the bucket a hit returns holds
    // fileCount/4 files and grows with the corpus. Same in-repo share, same
    // resolved count; the only thing that changed is bucket cardinality.
    return local
      ? `Mod${d % SWIFT_COLLIDE_MODULES}`
      : (r >>> 3) % 2 === 0
        ? ['Foundation', 'UIKit', 'Combine', 'SwiftUI'][(r >>> 4) % 4]
        : `ExternalPkg${(r >>> 4) % 97}`;
  }
  if (lang === 'rust') {
    // ~2x the `::` segments of the unique arm, in both the hits and the misses,
    // because SEGMENT COUNT is the only axis this resolver's cost has. The
    // `d % 7` slice names a module that exists nowhere, mirroring the unique
    // arm's `inner` slice, so the resolved count is unchanged. The external
    // spellings run the prefix-shortening loop in `resolveModulePath` to the
    // end — two `.has()` probes per shortened prefix — which is the longest
    // path through the function and the one worth an absolute ceiling.
    return local
      ? d % 7 === 0
        ? `crate::l0::l1::l2::l3::l4::vendor${d}::thing::Inner`
        : `crate::l0::l1::l2::l3::l4::mod${d}::thing::Inner`
      : (r >>> 3) % 2 === 0
        ? [
            'std::collections::hash_map::HashMap',
            'tokio::sync::mpsc::channel',
            'serde::de::value::MapDeserializer',
          ][(r >>> 4) % 3]
        : `ghost${(r >>> 4) % 97}::deep::nested::more::Missing`;
  }
  if (lang === 'python') {
    // A `models` package in every service and a repeated `mod{n}.py` inside it,
    // so `byBasename` holds one entry per service for each stem and the
    // fewest-segments-then-lexicographic tie-break in `resolveAbsoluteFromFiles`
    // actually has something to break. The external spelling shares the
    // basename and still misses — `vendor{n}` fails `hasRepoCandidate`.
    return local
      ? `svc${j % dirs}.models.mod${Math.floor(j / dirs)}`
      : (r >>> 3) % 2 === 0
        ? ['os.path', 'collections.abc', 'django.db.models'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}.models.mod0`;
  }
  if (lang === 'javascript' || lang === 'typescript') {
    // `pkg{n}/src/mod{m}` in every package. `buildSuffixIndex` is a KEYED map
    // that keeps one path per suffix, so this is the arm that asserts the
    // ts-family resolver is collision-immune. The external spelling must not
    // share the repeated stem, or it would suffix-match a real file and the
    // corpus would stop being miss-heavy (measured: 67% resolved instead of
    // 36% when it was `vendor{n}/src/mod{m}`).
    return local
      ? `pkg${j % dirs}/src/mod${Math.floor(j / dirs)}`
      : (r >>> 3) % 2 === 0
        ? ['react', 'lodash/fp', '@scope/ui/dist/index'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/src/ghost${(r >>> 4) % 8}`;
  }
  if (lang === 'vue') {
    return local
      ? j % 3 === 0
        ? `@/pkg${j % dirs}/components/Mod${Math.floor(j / dirs)}`
        : `@/pkg${j % dirs}/components/Mod${Math.floor(j / dirs)}.vue`
      : (r >>> 3) % 2 === 0
        ? ['vue', 'pinia', '@vueuse/core'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/components/Ghost${(r >>> 4) % 8}.vue`;
  }
  if (lang === 'c' || lang === 'cpp') {
    // A `mod{n}` header in every service's `include/`, which is what a C tree
    // looks like. The basename bucket the suffix fallback walks now holds one
    // candidate per service, so the depth-then-lexicographic tie-break decides
    // — and the bucket grows with the corpus, which is why this arm carries its
    // own scaling budget.
    const h = HEADER_EXTENSION[lang];
    const jj = j | 1;
    return local
      ? `include/mod${Math.floor(jj / dirs)}${h}`
      : (r >>> 3) % 2 === 0
        ? ['stdio.h', 'stdlib.h', 'string.h'][(r >>> 4) % 3]
        : `vendor${(r >>> 4) % 97}/mod0${h}`;
  }
  if (lang === 'ruby') {
    // `models/mod{n}.rb` in every package. Ruby answers `require` from a keyed
    // suffix map, so the repeated basename cannot grow a bucket: this arm
    // asserts that immunity, which is why its collide budget is the linear one.
    return local
      ? `svc${j % dirs}/lib/models/mod${Math.floor(j / dirs)}`
      : (r >>> 3) % 2 === 0
        ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
        : `gem${(r >>> 4) % 97}/missing/thing`;
  }
  throw unwiredLanguage('collideTarget', lang);
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

/**
 * The per-pass state one resolver sees: the file set it is handed, and the
 * `resolutionConfig` the orchestrator threads beside it.
 *
 * `allFilePaths` is a FRESH Set per pass on purpose — every per-file-set memo
 * in `import-resolvers/per-file-set.ts` is keyed on that object's identity, so
 * reusing one Set across passes would hide the index build after the first and
 * let a rebuilt-per-import index look free from rep 2 onward.
 *
 * `config` is why this exists as a function rather than a `new Set(files)` at
 * three call sites. Three languages here need one and they need three different
 * things:
 *
 *  - C and C++ take their HEADERS through `resolutionConfig`, not through
 *    `allFilePaths`. The phase hands the C resolver the `.c` files it
 *    classified and the header scan separately, and
 *    `augmentedFilePathsFor(allFilePaths)(headerPaths)` unions the two ONCE per
 *    pass — a two-input memo, so both inputs have to be pass-stable or it
 *    rebuilds an O(files) Set per include. Splitting the corpus here is what
 *    makes that union reachable at all; handing the resolver one pre-merged set
 *    would leave the memo, and the shape it exists for, unmeasured.
 *  - Vue takes `tsconfigPaths`, and the alias branch is the one leg of the
 *    shared ts-family resolver its arm covers that the other two do not.
 *
 * `csharp_csproj` is the precedent and stays where it is: a per-language
 * CONTEXT over a corpus aliased to another language's, rather than a new axis.
 */
function newPass(lang, files) {
  if (HEADER_EXTENSION[lang] !== undefined) {
    const sources = [];
    const headers = [];
    for (const f of files) (f.endsWith(HEADER_EXTENSION[lang]) ? headers : sources).push(f);
    return { allFilePaths: new Set(sources), config: new Set(headers) };
  }
  if (lang === 'vue') return { allFilePaths: new Set(files), config: VUE_TSCONFIG };
  return { allFilePaths: new Set(files), config: undefined };
}

/** The timed loop. One `newPass` per pass, so every pass pays exactly one index
 *  build — see `newPass`. */
function resolveAll(lang, files, imports) {
  const pass = newPass(lang, files);
  let sink = 0;
  for (const [from, target] of imports) {
    const hit = resolveOne(lang, from, target, pass);
    if (hit !== null) sink++;
  }
  return sink;
}

function resolveOne(lang, from, target, pass) {
  const allFilePaths = pass.allFilePaths;
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
  if (lang === 'swift') {
    return resolveSwiftImportTarget(
      { kind: 'namespace', localName: 'X', importedName: 'X', targetRaw: target },
      { fromFile: from, allFilePaths },
    );
  }
  if (lang === 'rust') return resolveRustImportTarget(target, from, allFilePaths, undefined);
  if (lang === 'python') {
    // The spelling `pythonScopeResolver` falls back to when the orchestrator
    // has no `parsedImport` for the edge. A `named` import would additionally
    // take the submodule-precedence branch, which re-enters the resolver twice
    // per import and would measure that recursion rather than the index.
    return resolvePythonImportTarget(
      { kind: 'namespace', localName: '_', importedName: '_', targetRaw: target },
      { fromFile: from, allFilePaths },
    );
  }
  if (lang === 'javascript') return jsResolveImportTarget(target, from, allFilePaths);
  if (lang === 'vue') return vueResolveImportTarget(target, from, allFilePaths, pass.config);
  // TypeScript, C and C++ go through the registered `ScopeResolver` hook rather
  // than an inner resolver, because for all three the thing under test lives IN
  // the adapter: TypeScript's `tsPassCacheFor` memo is private to
  // `typescript/scope-resolver.ts`, and C's and C++'s `augmentedFilePathsFor`
  // is private to theirs. Calling past it would benchmark a copy of the adapter
  // instead of the adapter.
  if (lang === 'typescript') {
    return typescriptScopeResolver.resolveImportTarget(target, from, allFilePaths, undefined);
  }
  if (lang === 'c') {
    return cScopeResolver.resolveImportTarget(target, from, allFilePaths, pass.config);
  }
  if (lang === 'cpp') {
    return cppScopeResolver.resolveImportTarget(target, from, allFilePaths, pass.config);
  }
  if (lang === 'csharp' || lang === 'csharp_csproj') {
    return resolveCsharpImportTarget(
      { kind: 'namespace', localName: '_', importedName: '_', targetRaw: target },
      {
        fromFile: from,
        allFilePaths,
        // The ONLY difference between the two C# arms. Present, the adapter
        // takes the csproj branch and never falls through to the no-csproj legs.
        ...(lang === 'csharp_csproj' ? { csharpConfigs: CSPROJ_CONFIGS } : {}),
      },
    );
  }
  throw unwiredLanguage('resolveOne', lang);
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
  const pass = newPass(lang, files);
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
    const hit = resolveOne(lang, from, target, pass);
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

function timeResolution(lang, files, imports, reps) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports);
  const samples = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    resolveAll(lang, files, imports);
    samples.push(performance.now() - t0);
  }
  return fastest(samples);
}

/**
 * One WARMED pass, used only to size `reps` for the language.
 *
 * Run on the `small` arm, and `small` is measurably the cheapest of the five
 * for every language where the answer can differ — all six that come out below
 * `REPS_MAX` (csharp_csproj, ruby, php, javascript, typescript, vue). Three
 * languages do have a cheaper arm — cobol's `collide` by 45%, kotlin's by 7%,
 * dart's `deep` by a few percent — and all three sit so far under
 * `REPS_CHEAP_MS` that either reading returns 15. `small` is also the arm
 * `small_ms_ceiling` bounds, so it is the one number here a reader already has
 * an intuition for.
 *
 * Warmed rather than taken from the WARMUP passes themselves: an unwarmed pass
 * reads several times high, which would push the expensive languages to
 * `REPS_MIN` for the wrong reason.
 */
function probeMs(lang, files, imports) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports);
  const t0 = performance.now();
  resolveAll(lang, files, imports);
  return performance.now() - t0;
}

/**
 * Retained JS heap of everything one language derives from one file set —
 * measured by RESOLVING AN IMPORT through it, never by calling a builder.
 *
 * THE ARM READS WHAT THE LANGUAGE READS, and that is now the whole design.
 * Until #2903 was extended to the two suffix maps, four of these arms called
 * `getWorkspaceFileIndex(set)` directly and read `index.all.length`, which asks
 * no suffix question at all. That was harmless only while `buildSuffixIndex`
 * built both maps eagerly. The moment they went lazy the direct call built NO
 * map, all four arms reported 0 B at 32 000 files, and 0 B is under every
 * ceiling — four gates silently became ceilings over nothing, which is exactly
 * the failure this file's header warns about for rust and cobol. Driving the
 * real resolver cannot fail that way: whatever maps the language forces are the
 * maps it forces in production, and if a resolver starts asking a new question
 * the number moves on its own instead of needing this file edited.
 *
 * It also happens to be the only form available for half of these languages —
 * Swift's `getSwiftModuleIndex`, Python's `getPythonFileIndex`, C's
 * `suffixIndex` and the ts-family `passCacheFor` are private to their modules,
 * and exporting four builders to feed a bench would widen four module surfaces
 * for a measurement's convenience. Now that all eight arms use one form, the
 * readings ARE comparable to one another (they were not before).
 *
 * GROWTH form, not the release form `bench/cfg/measure.mjs` uses: every index
 * here is memoized in a `WeakMap` keyed on the Set, so releasing it means
 * releasing the Set too, which would fold the Set's own cost into the delta.
 * Here the pass is live across BOTH samples and the `files` array holds the
 * path strings, so the delta is the derived structures' own footprint and not
 * the paths they point at. For C and C++ it legitimately includes the augmented
 * Set, which is part of what they hold; for every language it includes the one
 * or two resolve-cache entries the probe leaves behind.
 */
function retainedPassBytes(lang, files, probeTarget) {
  const pass = newPass(lang, files);
  // See `HEAP_RETAINED`: nothing built for this language is released until the
  // next one starts, so no deferred collection can land between the two samples
  // below and cancel part of the delta.
  HEAP_RETAINED.push(pass);
  GC();
  const before = process.memoryUsage().heapUsed;
  const hit = resolveOne(lang, files[0], probeTarget, pass);
  GC();
  const after = process.memoryUsage().heapUsed;
  // A HIT would mean the reading is a materialized answer rather than the
  // index, and — for the languages whose cascade returns early — that the legs
  // past the hit were never reached and their structures never built.
  if (hit !== null) {
    throw new Error(`heap probe '${probeTarget}' resolved for ${lang}; it must MISS: ${hit}`);
  }
  // Fails loudly if the corpus ever stops being one distinct path per file,
  // which would silently shrink every reading here.
  const size = pass.allFilePaths.size + (pass.config instanceof Set ? pass.config.size : 0);
  if (size !== files.length) {
    throw new Error(`heap arm corpus is not distinct: ${size} of ${files.length}`);
  }
  return Math.max(0, after - before);
}

/**
 * Every pass this arm builds, held alive ON PURPOSE until the next language
 * starts.
 *
 * A `heapUsed` delta is only the new structures if nothing OLD is released
 * between its two samples, and that is not a property a forced GC can be
 * trusted to establish: measured, the previous read's index survived a
 * two-cycle collect at the next read's baseline and was dropped by the collect
 * before its second sample, so the two cancelled and the arm reported 249 200 B
 * for a 9.3 MB index (PHP) and 329 064 B for a 6.7 MB one (JavaScript, once,
 * non-reproducibly — the same defect with a different language's timing).
 *
 * Holding the passes removes the precondition instead of tuning it: nothing a
 * measurement window depends on is ever collectable inside it, so the delta
 * cannot absorb a late free no matter how many cycles the collector needs.
 * Byte-identical readings at two and at four `gc()` cycles are the evidence
 * that it works, where without it the two disagree by 9 MB.
 *
 * Emptied once per language, in `measureHeap`, which is the one place a late
 * free is harmless: it happens before that language's first baseline and
 * outside both of its measurement windows, and it is followed by a drain deeper
 * than any chain here has needed. Never emptying at all also works and is what
 * this was first measured with, but it peaks at ~380 MB and costs 4.5 s,
 * because every forced collection from that point on has to mark it.
 */
const HEAP_RETAINED = [];

/**
 * The import each heap language resolves to force its build. A MISS in every
 * case (asserted above), so the reading is the index and not a materialized
 * answer, and so the cascade runs to completion instead of returning at the
 * first leg.
 *
 * Each spelling is one the language's own corpus already mints in
 * `uniqueTarget`, so the arm forces the same read pattern the timing arms do —
 * which after #2903 is what decides the number:
 *
 *   - `csharp` and `java` ask `index.get` and never `getInsensitive`, so the
 *     case-folded map is never built (49.6% of the eager Java index was dead);
 *   - `php` asks `getInsensitive` and never `get` (49.4% dead), and builds its
 *     own first-proper-suffix map on top;
 *   - `ruby` and the ts family read `get(s) || getInsensitive(s)`, so they pay
 *     for both — the second one DERIVED from the first, which is why they cost
 *     less than two independent traversals;
 *   - `csharp_csproj` additionally asks `getFilesInDir`, forcing the `dirMap`
 *     #2903 made lazy. It is the witness that the read pattern IS the
 *     footprint: same corpus and same `getWorkspaceFileIndex` as `csharp`,
 *     three times the retained bytes.
 */
const HEAP_PROBE_TARGET = {
  csharp: 'Ghost0.Deep.Missing',
  // Matches the `App` root namespace and no directory, so it runs the config
  // loop's single-file leg (`get` + `getInsensitive`) AND its directory leg
  // (`getFilesInDir`) before answering null — the three-map read pattern.
  csharp_csproj: 'App.Missing0',
  ruby: 'gem0/missing/thing',
  php: 'Vendor0\\Ghost\\Missing',
  java: 'com.google.common.vendor0.Missing',
  javascript: 'vendor0/lib/missing',
  python: 'vendor0.deep.missing',
  c: 'vendor0/missing.h',
};

/**
 * `buildFiles` mints every path with a template literal, and V8 represents
 * those as ROPES — the concatenation is not materialized until something forces
 * it. The first traversal that slices a path (`lastIndexOf('/')`, `toLowerCase`,
 * every index builder here) flattens it, which allocates the flat string AND
 * drops the rope's now-unreachable pieces, so a build measured over an
 * unflattened corpus reports the index MINUS that net release: measured 11%
 * low, uniformly, on every language whose index slices paths.
 *
 * It biased the arm in the one direction that matters. `bytes_small` was read
 * over a corpus a discarded warm-up pass had already flattened and
 * `bytes_large` over a fresh one, so every `ratio` here was ~0.85-0.89 for
 * structures that are exactly linear in the file count — the ratio budget was
 * bounding an artefact. Flattened first, all eight read 0.99-1.02.
 *
 * It also retires the warm-up pass, which was never about JIT: with the corpus
 * flat, a language's first and second reads of the same file count agree to
 * within 0.3%.
 */
function flatten(files) {
  for (const file of files) file.lastIndexOf('/');
  return files;
}

function measureHeap(lang) {
  if (GC === null) return null;
  // Release the PREVIOUS language's passes here and nowhere else, then drain
  // them twice over. This is the one point at which a deferred collection is
  // free: it is before this language's first baseline and outside both of its
  // measurement windows, so however many cycles the release needs, it cannot
  // land between a `before` and an `after`.
  HEAP_RETAINED.length = 0;
  GC();
  GC();
  const probe = HEAP_PROBE_TARGET[lang];
  const read = (files) => retainedPassBytes(lang, files, probe);
  const small = flatten(buildFiles(lang, HEAP_SMALL, HEAP_PAD, 'unique'));
  const bytesSmall = read(small);
  const large = flatten(buildFiles(lang, HEAP_LARGE, HEAP_PAD, 'unique'));
  const bytesLarge = read(large);
  return {
    files_small: HEAP_SMALL,
    files_large: HEAP_LARGE,
    path_segments: small[0].split('/').length,
    probe,
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

/**
 * Every arm, and the registered language each one exercises.
 *
 * This used to be a hand-written list of seventeen strings under a comment
 * claiming it was "every language in `SCOPE_RESOLVERS`" — a claim nothing in
 * the file could check, because the file never imported the registry. Adding a
 * resolver to `pipeline/registry.ts` is two lines, neither of which is this
 * one, so a seventeenth registered language would have shipped ungated and
 * printed PASS. That is not a hypothetical failure mode: JavaScript reached
 * `suffixResolve` with no index at all and measured 25 972 µs per import at
 * 8000 files (#2910) for exactly as long as nothing gated it.
 *
 * So the list is DERIVED and the claim is ASSERTED. `LANGS` is this table's
 * keys, and the `--check` inventory arm below fails when a registered resolver
 * has no arm here (or an arm names a language the registry does not have) —
 * the same shape `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`
 * uses ten files away, and the same "one row per language" table
 * `bench/cfg/measure.mjs` keeps.
 *
 * The mapping is many-to-one on purpose: `csharp` and `csharp_csproj` are two
 * arms over one registered resolver, differing only in whether `csharpConfigs`
 * is supplied, because the no-csproj arm returns before it can reach the leg
 * #2902 indexed.
 */
const LANG_REGISTRY = {
  go: SupportedLanguages.Go,
  csharp: SupportedLanguages.CSharp,
  csharp_csproj: SupportedLanguages.CSharp,
  dart: SupportedLanguages.Dart,
  ruby: SupportedLanguages.Ruby,
  kotlin: SupportedLanguages.Kotlin,
  php: SupportedLanguages.PHP,
  java: SupportedLanguages.Java,
  cobol: SupportedLanguages.Cobol,
  swift: SupportedLanguages.Swift,
  rust: SupportedLanguages.Rust,
  python: SupportedLanguages.Python,
  javascript: SupportedLanguages.JavaScript,
  typescript: SupportedLanguages.TypeScript,
  vue: SupportedLanguages.Vue,
  c: SupportedLanguages.C,
  cpp: SupportedLanguages.CPlusPlus,
};
const LANGS = Object.keys(LANG_REGISTRY);
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
  // Sized once per language, from the FIRST arm — `small`, the cheapest — so
  // all five arms share one estimator and the four ratios below stay
  // comparisons of like with like. See `repsFor`.
  let reps = null;
  for (const [name, fileCount, pad, shape] of ARMS) {
    const { files, imports } = buildRepo(lang, fileCount, pad, shape);
    const { outcomes, resolved } = identityPass(lang, files, imports);
    if (reps === null) reps = repsFor(probeMs(lang, files, imports));
    scales[name] = {
      files: files.length,
      imports: imports.length,
      // Reported, not asserted on its own: a corpus edit that collapsed the
      // resolved share would still produce a "valid" fingerprint over far less.
      resolved,
      distinct_outcomes: outcomes.size,
      ms: Number(timeResolution(lang, files, imports, reps).toFixed(3)),
      fingerprint: fingerprint(outcomes),
    };
  }
  report[lang] = {
    ...scales,
    // Reported so a triager can see which estimator produced the five ms
    // numbers above; environment-derived, so never asserted.
    reps,
    scaling_ratio: Number((scales.large.ms / scales.small.ms / (LARGE / SMALL)).toFixed(3)),
    // `scaling_ratio` divides the file count out, so it is scale-invariant and
    // structurally cannot see a cost that grows with path DEPTH instead — and
    // `buildSuffixIndex` (C#, Ruby, PHP, Java, and the whole ts family) and
    // Kotlin's `suffixByStem` all emit one entry per '/' in a path, and
    // Python's ancestor walk rebuilds one prefix per component PER IMPORT.
    // Same file count, ~6x the components.
    depth_ratio: Number((scales.deep.ms / scales.small.ms).toFixed(3)),
    // Same measurement on the shared-leaf layout. Legitimately above the 1.8
    // budget for go/csharp/dart — see the scope-of-claim note in the header.
    collide_scaling_ratio: Number(
      (scales.collide_large.ms / scales.collide.ms / (LARGE / SMALL)).toFixed(3),
    ),
    fingerprint: scales.large.fingerprint,
  };
}

// AFTER every timing arm, never interleaved with them, and now for a second
// reason as well as the first. The first: the heap arm allocates a 32k-path
// corpus and a ~70 MiB index per language, and leaving that behind for the next
// language's timed loop to collect would tax an arm it has nothing to do with.
// The second: `HEAP_RETAINED` holds a language's whole corpus and index alive
// across both of its reads — up to ~92 MiB for `csharp_csproj` — and that must
// not overlap a measurement of time.
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
        `parity harnesses in test/unit/scope-resolution/*-import-target-parity.test.ts and the ` +
        `all-languages adapter guard in import-target-index-reuse.contract.test.ts.`,
    );
  }
  // One shape, five facts, so the five budgets read side by side and the shared
  // trailing sentence exists once instead of drifting into five wordings. Each
  // `why` stays the arm's OWN: it is what tells a triager which corpus shape
  // regressed, and flattening it would cost the message its whole value.
  // `key` is the baselines.json path the budget came from, so the presence
  // check below can name it.
  const timingChecks = [
    {
      label: 'scaling',
      key: 'scaling_budget',
      got: got.scaling_ratio,
      budget: baseline.scaling_budget,
      why: 'per-import cost grows with corpus size again.',
    },
    {
      label: 'depth',
      key: `depth_budget.${lang}`,
      got: got.depth_ratio,
      budget: baseline.depth_budget?.[lang],
      why:
        'cost grows with path DEPTH at a fixed file count, which scaling_ratio divides out and ' +
        'cannot see.',
    },
    {
      label: 'collide scaling',
      key: `collide_scaling_budget.${lang}`,
      got: got.collide_scaling_ratio,
      budget: baseline.collide_scaling_budget?.[lang],
      why:
        'on the SHARED-LEAF layout (svcN/internal, SrcN/Models, a repeated basename per package) ' +
        'per-import cost grew beyond what this shape already costs by construction.',
    },
    {
      label: 'small arm ms',
      key: `small_ms_ceiling.${lang}`,
      got: got.small.ms,
      budget: baseline.small_ms_ceiling?.[lang],
      why:
        'an ABSOLUTE bound, because a constant-factor regression that grows both arms equally ' +
        'passes the ratio.',
    },
    {
      label: 'collide arm ms',
      key: `collide_ms_ceiling.${lang}`,
      got: got.collide.ms,
      budget: baseline.collide_ms_ceiling?.[lang],
      why: 'the ABSOLUTE bound on the shared-leaf layout.',
    },
  ];
  for (const check of timingChecks) {
    // PRESENCE FIRST, because `got > undefined` is `false`: without this, going
    // from a budget to no budget is going from a gate to no gate, and the run
    // still prints PASS. All five maps are complete today, which is exactly
    // when the check is worth adding — every one of the four per-language
    // lookups above is one deleted key away from a silent no-op. The heap arm
    // never had the hole because it iterates the BASELINE's keys; the timing
    // arms iterate LANGS, so they have to ask.
    if (typeof check.budget !== 'number') {
      failures.push(
        `${lang}: no ${check.label} budget — baselines.json has no numeric ${check.key}. ` +
          `A missing budget is a DELETED GATE, not a passing arm: the comparison below reads ` +
          `\`${check.got} > undefined\`, which is false for every possible measurement. ` +
          `Deterministic: a re-run will not change it.`,
      );
      continue;
    }
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
      `${lang}: retained per-pass import index ${heap.mib_large} MiB at ${heap.files_large} ` +
        `files (${heap.bytes_large} B) > ceiling ${ceiling} B — these indexes are built at ` +
        `O(files × depth) and this is the ABSOLUTE bound on that (#2649). Deterministic: a ` +
        `re-run will not change it.`,
    );
  }
  // A FLOOR as well as a ceiling, and it is the arm that would have caught the
  // one defect this whole block exists for. When `buildSuffixIndex` went lazy,
  // these four arms stopped asking a suffix question, built no map and reported
  // 0 B at 32 000 files — and 0 B is under every ceiling, so `--check` printed
  // PASS over four gates that had become ceilings over nothing. A ceiling can
  // only ever say "not too big"; nothing said "still measuring something".
  //
  // Set as a fraction of the ceiling rather than as a second hand-maintained
  // map, so the two cannot drift apart. At 0.33 x a ceiling that is itself
  // 1.5x the measurement, the floor sits at half the measured size — far below
  // any plausible drift (the readings reproduce to the byte across processes)
  // and far above the collapse it watches for. A genuine 2x memory WIN trips it
  // too, and that is intended: it must be explained and re-baselined, exactly
  // like a fingerprint move.
  const floor = ceiling * baseline.heap_floor_fraction;
  if (heap.bytes_large < floor) {
    failures.push(
      `${lang}: retained per-pass import index ${heap.bytes_large} B at ${heap.files_large} ` +
        `files < floor ${Math.round(floor)} B (${baseline.heap_floor_fraction} x ceiling ` +
        `${ceiling}) — this arm has almost certainly stopped MEASURING rather than started ` +
        `saving. Probe '${heap.probe}' resolves through the real resolver; if a leg it used to ` +
        `reach now returns earlier, or an index it forced is now built lazily behind a question ` +
        `nobody asks, the arm reads ~0 and every ceiling above passes. Deterministic: a re-run ` +
        `will not change it.`,
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

// INVENTORY, the arm that makes "every registered language is gated" a checked
// claim instead of a comment. `LANG_REGISTRY` is a hand-written table — it has
// to be, since each row also implies five dispatcher branches — but which
// languages it must contain is not a judgement call, and this is where the two
// are reconciled. Both directions: a resolver registered with no arm here is
// the #2910 hole (a language shipping unmeasured), and an arm naming a language
// the registry does not have is a bench measuring something the pipeline no
// longer runs.
//
// Loaded HERE, after the last measurement, rather than imported at the top.
// Reaching `pipeline/registry.ts` drags in all sixteen scope resolvers and
// their providers — 7.3 s of module load, measured, against 39 s of actual
// benchmarking — and this arm is the only thing in the file that wants it. The
// side benefit is that both modes now measure in the same module state: report
// mode never loads the registry, and `--check` loads it only once every number
// has been taken.
const { SCOPE_RESOLVERS } =
  await import('../../src/core/ingestion/scope-resolution/pipeline/registry.ts');
const registeredLanguages = [...SCOPE_RESOLVERS.keys()].sort();
const benchedLanguages = [...new Set(Object.values(LANG_REGISTRY))].sort();
for (const language of registeredLanguages) {
  if (benchedLanguages.includes(language)) continue;
  failures.push(
    `${language} is registered in SCOPE_RESOLVERS but has no arm in LANG_REGISTRY — its ` +
      `import-target resolver is ungated: nothing pins its output and nothing pins its scaling. ` +
      `That is the state JavaScript was in at 25 972 µs per import (#2910). Add a row, then the ` +
      `five dispatcher branches it needs (uniqueDir, collideDir, uniqueTarget, collideTarget, ` +
      `resolveOne) and a baselines.json entry. Deterministic: a re-run will not change it.`,
  );
}
for (const language of benchedLanguages) {
  if (registeredLanguages.includes(language)) continue;
  failures.push(
    `LANG_REGISTRY names '${language}', which is not in SCOPE_RESOLVERS — this bench is gating a ` +
      `resolver the pipeline no longer registers. Deterministic: a re-run will not change it.`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[import-target --check] PASS');
