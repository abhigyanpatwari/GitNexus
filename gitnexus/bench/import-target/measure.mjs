/**
 * Build-free scaling + identity bench for EVERY import-target resolver in
 * `SCOPE_RESOLVERS` — the registry decides which, not a list kept here, and the
 * `--check` inventory arm at the foot of this file fails when the two disagree
 * — over ONE shared corpus so the arms are directly comparable. One arm per
 * registered language, plus a second `csharp` arm carrying csproj configs
 * (#2902), so there is one more arm than there are languages. The newest row
 * is `zig` (PR #1432), added the day its resolver registered — the inventory
 * arm below is what noticed it missing, which is the arm doing its job.
 *
 * NO LANGUAGE IS OMITTED, and that is the point of the list rather than an
 * accident of it. Nine of these arms (go, csharp, csharp_csproj, dart, ruby,
 * kotlin, php, java, cobol) were added as their own O(imports × files) scans
 * were indexed away — #2877/#2878/#2879/#2880, #2872, #2901, #2902, #2908 — and
 * the bench is the forward guard on each. The eight added alongside them
 * (swift, rust, python, javascript, typescript, vue, c, cpp) resolve imports
 * through the same registered hook with the same per-run memoized indexes, and
 * were ungated: nothing pinned their output and nothing pinned their scaling.
 * One of them was not hypothetical — JavaScript reached `suffixResolve` with no
 * index at all and measured 25 972 µs per import at 8000 files (PR #2911) —
 * which is exactly the class of defect the other seven were one commit away
 * from.
 *
 * A C or C++ `#include` is an import site for this purpose and is gated like
 * every other registered language. See `newPass` for the one structural thing
 * those two need that no other language does.
 *
 * Kotlin also has `bench/kotlin-import-target/`, and this does not replace it:
 * that bench probes declared-package correctness cases shape by shape. What
 * Kotlin gains here is a second corpus plus shared timing, context and heap
 * arms.
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
 *   - javascript, typescript, vue: one resolver (`resolveTsModule`) behind
 *     three adapters, so the three corpora are the same shape and differ only
 *     in what actually differs — the extension list (`.js` vs `.ts`) and which
 *     config leg the arm exercises (`tsBaseUrlConfig` vs `vueTsconfig`). All
 *     three are miss-dominated bare specifiers.
 *
 *     What they measure CHANGED with #2953. The leg used to be `suffixResolve`,
 *     a repo-wide search for a path ending in the specifier; these three no
 *     longer have it, and resolve only against a declared tsconfig mapping or a
 *     package manifest. Two consequences the numbers show:
 *
 *       - the arms need a `resolutionConfig` to resolve anything at all. With
 *         none they all reported `resolved: 0` — every import correctly
 *         external — while still printing a clean scaling ratio, which is a
 *         bench measuring an empty branch and passing exactly like one
 *         measuring a full one.
 *       - `depth_ratio` is now structurally flat for them, and that is the
 *         result rather than a weakened arm: declared resolution never walks
 *         path components, so the `deep` arm's uniform prefix reaches the
 *         config (see `tsBaseUrlFor`) and its cost is the same keyed lookup the
 *         other arms pay.
 *   - c, cpp: `resolveCppImportTarget` delegates to `resolveCImportTarget`, so
 *     the two share a resolver and differ in extension set and in which adapter
 *     builds the augmented set. Cost is a basename bucket walk with a
 *     depth-then-lexicographic tie-break, so the collide arm (a `mod{n}` header
 *     in every service's `include/`) is where it grows: 2.54 / 2.64 against
 *     1.06 on file count.
 *   - zig: `resolveZigImportInternal` is rust's shape — an `@import("…zig")`
 *     path is walked component by component from the importer's directory and
 *     probed with two `allFiles.has(...)` calls (as written, then `+ '.zig'`),
 *     and a bare name is a Map lookup in the build config or a miss. No index
 *     is built, so the cost is O(path SEGMENTS) and flat in the file count,
 *     and — as for rust — its collide arm is a deep tree whose spellings carry
 *     ~4x the components rather than a shared-leaf layout that cannot fail.
 *     The arm passes NO build config (`buildZon` null): the bare-name legs
 *     (`b.addModule` roots, zon `.path` deps) read `build.zig` / `build.zig.zon`
 *     through `loadZigBuildConfig` and are gated by
 *     `test/unit/zig-import-resolver.test.ts`, so this fingerprint pins the
 *     path-walking resolver alone and does not move when that config parsing
 *     changes.
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
 *     DEPTH instead — and `buildSuffixIndex` (C#, Ruby, PHP, Java) emits one
 *     entry per component. Go, Dart, Kotlin and COBOL have depth-free indexes
 *     (COBOL's are keyed on the basename and nothing else), so they sit near
 *     1.0; the suffix-indexed resolvers sit legitimately above 1.0,
 *     which is why the budget is per language. Python is the extreme and the
 *     reason the spread is worth a per-language number at all: its index is
 *     depth-free, but `hasRepoCandidate` and `resolveAbsoluteFromFiles` rebuild
 *     an ancestor prefix per importer directory component ON EVERY IMPORT, so
 *     the RESOLVER, not the index, is quadratic in depth — 7.39;
 *   - `collide_scaling_ratio`, the same measurement on a corpus whose
 *     directories SHARE their last segment and whose files share basenames —
 *     see the `collide` section below;
 *   - `heap` (all 17): retained bytes of the per-pass import index, read by
 *     resolving one real import — see the `heap` section below. Eight carry a
 *     ceiling, a floor and a ratio; the other nine carry an upper bound only;
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
 *     rather than commented, and it is the arm that would have caught PR #2911's
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
 *     its suffix fallback walks. python answers from keyed maps and sits at
 *     1.03-1.10, and javascript, typescript and vue answer from a declared
 *     config (#2953) — so all four keep the linear budget and that immunity is
 *     their assertion, exactly as for ruby and kotlin;
 *   - rust's collide arm is the one that is NOT a shared-leaf layout, and the
 *     reason is in the list above: file count is not an axis its cost has, so a
 *     shared-leaf rust arm would have been an arm that cannot fail. Its collide
 *     corpus is a deep module tree whose targets carry ~2x the `::` segments,
 *     which is the axis that CAN grow; the ratio across file counts staying at
 *     1.06 on it is the assertion, and `collide_ms_ceiling` bounds the absolute
 *     cost of the long-path probe. zig's collide arm is built the same way and
 *     for the same reason: a deep tree whose `../../…/l4/mod{n}/file.zig`
 *     spellings walk ~4x the components of the unique arm's `../mod{n}/…`.
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
 * clearest case in the file: before PR #2911 it retained NOTHING because it
 * built no index at all, and it now retains 25.51 MiB at 32 000 files through
 * the
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
 * EVERY LANGUAGE IS MEASURED, and the eight-entry list this arm ran on is now
 * the BUDGET tier rather than the measurement tier. That list — `HEAP_LANGS`,
 * now `HEAP_BUDGETED` — was reconciled bidirectionally against its two budget
 * maps and every entry had to produce a reading, but nothing tied it to the
 * property it stood for, "the languages that retain a per-pass index". Its two
 * neighbours in this file do not have that gap: `LANG_REGISTRY` is reconciled
 * against `SCOPE_RESOLVERS.keys()` and `CONTEXT_LANGS` against hook arity, both
 * directions, both derived. Nine languages were excluded on readings taken once
 * and written into this prose, and the paragraph below states the re-entry
 * condition ("if any of the four ever diverges in what it ASKS, it earns an arm
 * the same way") with nothing watching for the divergence.
 *
 * Re-measured — all seventeen, five runs each, one probe per language through
 * the same `retainedPassBytes` — the prose was wrong in three separate ways:
 *
 *   1. THREE OF THE NINE HAD NO STATED REASON AT ALL. The old paragraph opened
 *      "SIX of the seventeen are deliberately NOT in HEAP_LANGS" against a list
 *      of eight, so go, dart and kotlin were excluded silently. All three
 *      retain a real per-pass structure: go's `PackageDirIndex` reads
 *      2 998 464 B, dart's basename buckets 7 834 200 B, and kotlin's
 *      `suffixByStem` cascade 42 802 456 B (40.82 MiB) — above ruby's 39.12 and
 *      java's 33.34, both of which carry a full budget. (Read 48 073 096 B when
 *      this paragraph was written and described as "the second-largest reading
 *      in this file", which it was not even then: csharp_csproj and php both
 *      read higher. #2881 then compacted kotlin's `dirChildren` buckets and
 *      took 11% off it.)
 *   2. TWO OF THE STATED REASONS NO LONGER HOLD. swift was excluded as "below
 *      its own noise floor" on 0.98 MB at 8000 files against 0.29 MB at 32 000;
 *      it now reads 969 120 B and 3 449 216 B, growing the right way. COBOL was
 *      excluded "for the same reason" on 0.54 MB then 0 B; it now reads
 *      536 264 B and 2 320 456 B, ratio 1.082. Neither number moved because
 *      either index changed — the ARM changed, twice, when it started resolving
 *      a real import (#2903) and when `measureHeap` began flattening its
 *      corpus. Both re-measure to within 0.24% peak-to-peak over five runs,
 *      which is not a noise floor.
 *   3. THE PROSE HAD GONE STALE AGAINST ITSELF. It quoted javascript at
 *      46 208 832 B four paragraphs after quoting it at 25.51 MiB
 *      (26 745 296 B), because one number was re-taken with the arm and the
 *      other was only ever written down.
 *
 * Only rust's exclusion survived unchanged: 16 B at 8000 files and 16 B at
 * 32 000, identical in all five runs, because it probes candidate paths with
 * `allFilePaths.has(...)` and builds nothing. zig joined that tier on the same
 * reading for the same reason (`resolveZigImportInternal` holds no per-pass
 * structure at all), and takes rust's absolute 1 MiB bound.
 *
 * So the nine are still not BUDGETED — their ceilings, floors and ratio arms
 * are not this change to write — but they are all measured and all bounded. See
 * `HEAP_BOUNDED` for the gate and `_heap_bound_note` in baselines.json for each
 * language's reading and its own reason, which are not one reason: rust builds
 * nothing; go, dart, kotlin, swift and cobol build something this file has
 * never bounded; and typescript, vue and cpp are duplicates of a BUILDER and of
 * a READ PATTERN, both halves of which have to hold — `csharp_csproj` was
 * excluded on the first half alone, at +20.8% of the C# index, and reads 2.47x
 * of it now that the second half decides the number. Measured here: typescript
 * 26 745 296 B against javascript's 26 745 296 B (byte-identical in four runs
 * of five), cpp 10 023 344 B against c's 10 018 816 B (+0.05%), vue
 * 28 884 016 B (+8.0%, what `.vue` instead of `.ts` buys on two thirds of the
 * paths). The bound is what watches for the divergence the re-entry condition
 * names — and it watches at 1.5x, so it catches a language GROWING an index,
 * not a duplicate drifting by 8%. That limit is stated rather than papered
 * over: the tight form is a same-process ratio against the arm each one
 * duplicates, which is the only form immune to the cross-runner heapUsed drift
 * an absolute bound has to tolerate.
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
 * baselines.json. PR #2911 is the proof that this blind spot is real rather
 * than theoretical: JavaScript's missing index was a scan of
 * `ImportPassCache.normalizedFileList` on EVERY import, which the Set counter
 * could not see, and it took a differential parity test over 211 200 pairs plus
 * this bench's arrival to pin it.
 *
 * THE FIFTH ARGUMENT — `context`, and exactly how much of it is measured. This
 * harness used to call the inner resolvers with THREE arguments while `run.ts`
 * calls `provider.resolveImportTarget` with FIVE, the fifth being
 * `{ parsedFiles, parsedImport }`. Every arm was therefore a measurement of a
 * call shape production never makes, and that is not a cheap thing to get
 * wrong: defeating the `perFileSet` memo behind PHP's `filesByDirectory`
 * measures 197.0 µs -> 9976.2 µs per import (50.6x) with every test still
 * green, and nothing here could see it.
 *
 * `resolveOne` now makes the production call. Four of the seventeen arms can
 * observe it — PHP, Java, Kotlin and Python declare a fifth parameter — and
 * that is ASSERTED rather than asserted-in-a-comment: the
 * inventory arm at the foot of the file reads
 * `SCOPE_RESOLVERS.get(language).resolveImportTarget.length` and reconciles it
 * against `CONTEXT_LANGS` in both directions, so a language that grows a
 * context leg cannot ship with the leg unmeasured. The other thirteen are handed
 * nothing and build no `ParsedFile[]` at all, so their numbers are unmoved.
 *
 * `newPass` mints the `ParsedFile[]` FIRST and derives the path set from it
 * (`new Set(parsedFiles.map(f => f.filePath))`), because that is what `run.ts`
 * does — two independently built lists are a shape the pipeline cannot produce
 * and would let the two memos disagree about which files exist. Both are fresh
 * per pass for the reason the Set always was: `filesByDirectory` (PHP) and
 * `parsedFileByPath` (Python) are `perFileSet` memos keyed on the ARRAY's
 * identity, so a reused array would hide their build from rep 2 onward and
 * `fastest()` takes the minimum.
 *
 * THE LEGS ACTUALLY RUN, which is what a "context is threaded" claim is worth
 * nothing without — a leg that returns early measures nothing, the exact
 * failure the four 0 B heap arms already demonstrated in this file. PHP's needs
 * `parsedImport.kind` to be `named` or `alias` AND `importedSymbolKind` to be
 * `function` or `const`; Python's needs a `named`/`alias` import too, because
 * the synthetic `namespace` spelling this file used to pass makes
 * `pythonImportedSubmoduleTarget` return null and `context.parsedFiles` is then
 * never read at all. A deterministic `context` arm pins both per language: a
 * three-file corpus resolved through `resolveOne` twice, once with the pass's
 * `parsedFiles` and once without, whose two answers must DIFFER and must both
 * equal what baselines.json records. Dropping the fifth argument, dropping
 * `importedSymbolKind`, or reverting Python to `namespace` collapses the two
 * onto one value and fails. PHP and Python still agree with their fallback on
 * the main corpus; Java and Kotlin deliberately have no context-free fallback,
 * so their fingerprints pin the declared-package answers recorded here.
 *
 * WHAT IS STILL NOT MEASURED, narrowed rather than deleted:
 *
 *   - Python's `parsedFileByPath` memo is exercised by the five timing arms and
 *     NOT by the heap arm, and structurally cannot be. `retainedPassBytes`
 *     requires its probe to MISS, while every path that builds that memo runs
 *     through a non-null `packageTarget` which `resolvePythonImportTarget` then
 *     returns. So nothing here bounds that Map's footprint; it is one pointer
 *     per parsed file, O(files) with no depth term, and the count gate in
 *     import-target-index-reuse.contract.test.ts is what holds it to one build
 *     per pass;
 *   - PHP runs with the Composer PSR-4 configuration every production project
 *     supplies. Configured hits and unmatched dependency misses share one
 *     workload, so the Composer gate cannot become an unmeasured fast path;
 *   - the `const` tail of PHP's leg (`candidateFiles.length === 1`) is a
 *     different ANSWER, not a different cost: `function` runs the identical
 *     candidate gather and `localDefs` filter and diverges only in the last two
 *     lines. It is gated by count in the contract test above.
 *
 * COST, and the honest version of it. REPORT mode is ~33-35 s, down from ~46 s:
 * the timing phase fell from 39.8 s to 28.7 s when `REPS` became per-language
 * (see `repsFor`), and that win is real. `--check` is ~44-45 s, which is
 * ESSENTIALLY UNCHANGED from the ~46 s it cost before, because the inventory
 * arm added here loads `pipeline/registry.ts` and that one dynamic import
 * consumes almost the whole `repsFor` win — measured 6.3-6.5 s on one box and
 * 9.3-10.0 s on another, in isolation and after this file's own static imports
 * are already resident. Do not read the two modes as "~46 → ~42": only report
 * mode got faster.
 *
 * MEASURING ALL SEVENTEEN HEAP ARMS instead of eight costs 1.37 s, and that is
 * a measured number rather than the "seconds are free here" the paragraph below
 * would have let it be. Timed per language with the phase instrumented, twice:
 * the heap phase goes 2.06 s -> 3.43 s (1.377 s and 1.370 s added over the two
 * runs). Those figures predate #2960: Kotlin now retains a compact
 * declared-package/module-binding index rather than three path-suffix maps.
 * End to end
 * that is report mode 33.76 s -> 34.93 s (min of three runs each, +1.17 s,
 * consistent with the phase measurement inside run-to-run noise). `--check` was
 * 41.60 s before and reads 41.48-43.56 s after, i.e. the whole-run difference
 * is INSIDE the registry import's own 6.3-10.0 s spread and cannot be resolved
 * at that level — the +1.37 s phase number is the one to quote.
 *
 * That cost was weighed and KEPT, on the one number that decides it: the
 * `benchmarks` job is not CI's critical path. On the last green run of main it
 * finished in 9 m 23 s against 12 m 58 s for the sharded coverage job that
 * gates the merge, so ~4 m 40 s of slack sits above this bench and ten seconds
 * of it buys zero merge latency. Moving the arm into a vitest file would move
 * the registry load ONTO that critical path, and would weaken it besides: from
 * `LANG_REGISTRY`'s `SupportedLanguages` values, which are what the five
 * dispatcher branches key off, down to baselines.json's arm NAMES plus a
 * hand-written rule for de-aliasing `csharp_csproj`. See the wall-clock note in
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
import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.ts';
import { resolvePhpImportTargetInternal } from '../../src/core/ingestion/languages/php/import-target.ts';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.ts';
import { cobolScopeResolver } from '../../src/core/ingestion/languages/cobol/scope-resolver.ts';
import { resolveSwiftImportTarget } from '../../src/core/ingestion/languages/swift/import-target.ts';
import { resolveRustImportTarget } from '../../src/core/ingestion/languages/rust/import-target.ts';
import { resolveZigImportInternal } from '../../src/core/ingestion/import-resolvers/zig.ts';
import { resolvePythonImportTarget } from '../../src/core/ingestion/languages/python/import-target.ts';
import { makeJsResolveImportTarget } from '../../src/core/ingestion/languages/javascript/import-target.ts';
import { makeVueResolveImportTarget } from '../../src/core/ingestion/languages/vue/import-target.ts';
// The two `ScopeResolver`s, not their inner resolvers — see `RESOLVE_HOOK`.
import { typescriptScopeResolver } from '../../src/core/ingestion/languages/typescript/scope-resolver.ts';
import { cScopeResolver } from '../../src/core/ingestion/languages/c/scope-resolver.ts';
import { cppScopeResolver } from '../../src/core/ingestion/languages/cpp/scope-resolver.ts';
// `SCOPE_RESOLVERS` is NOT imported here — see the inventory arm at the bottom,
// which loads it dynamically. Statically it costs 6-10 s of module load
// depending on the box (measured both ways there), because reaching the
// registry pulls in every registered provider and everything under them, and it
// is wanted by one `--check` arm that runs after the last measurement.

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
/** The languages whose retained per-pass index carries a BUDGET — a ceiling, a
 *  floor derived from `heap_reading_bytes`, and the linear-growth ratio arm.
 *  All arms are measured through `retainedPassBytes`, one real import through
 *  the real resolver; this list decides which GATE a reading gets, not whether
 *  it is taken. The configured C# arm stays here because its read pattern
 *  reaches retained structures that the unconfigured arm cannot observe.
 *
 *  The remaining three are `HEAP_BOUNDED`, DERIVED from this list rather than
 *  written beside it, and they carry an upper bound and NO floor. That asymmetry
 *  is the point: a bound catches "this language grew an index", which is the
 *  re-entry condition, while a floor over a reading at or below its own noise
 *  would gate the noise. rust reads 16 B at both scales; swift's ratio is 0.888
 *  and cobol's 1.082, both outside the linearity every budgeted arm shows, so a
 *  floor and a ratio arm would be measuring the measurement. See the MEMORY
 *  section of the header for what re-measuring the full inventory found. */
const HEAP_BUDGETED = [
  'csharp',
  'csharp_csproj',
  'ruby',
  'php',
  'java',
  'python',
  'c',
  // Promoted once every language was actually measured. Each retains a real
  // per-pass structure and each grows LINEARLY with the file count (ratio
  // 0.996-1.004 against a 1.25 budget over 8000 -> 32000 files), so each can
  // carry the full ceiling + floor + ratio set rather than a bound alone.
  // Kotlin now retains its declared-package/module-binding index. Its measured
  // 32000-file reading and standard 1.5x ceiling are recorded in baselines.json.
  'kotlin',
  'dart',
  'go',
  'cpp',
];
// javascript, typescript and vue were budgeted here until #2953 and are now
// BOUNDED, which is a demotion in gate strength and a promotion in what the
// number means. They retained ~26.7 MiB each because they built a per-pass
// `SuffixIndex` over the whole file list; they no longer build one at all,
// because declared resolution derives nothing from the file set — a candidate
// comes from a tsconfig mapping or a manifest and is checked with one
// `Set.has`. The readings are 0-16 B.
//
// A floor over a reading at or below its own noise gates the noise, which is
// the same reason rust sits in this tier at 16 B — so they take a bound and no
// floor. The bound is what still matters: it catches these three growing an
// index again, which is the re-entry condition for the cost #2911 and #1918
// were about.

/**
 * The arms handed the fifth `context` argument — `{ parsedFiles, parsedImport }`
 * — because their registered hook DECLARES it. Four of seventeen arms, and the
 * inventory arm at the foot of this file reconciles that claim against
 * `SCOPE_RESOLVERS` in both directions rather than trusting this line.
 *
 * These are also the only arms for which `newPass` builds a `ParsedFile[]` at
 * all. Building one for the other thirteen would cost their timed loop an
 * O(files) allocation per pass that no resolver of theirs can even observe —
 * their hooks declare three or four parameters — so their numbers stay exactly
 * where they were.
 */
const CONTEXT_LANGS = ['php', 'java', 'kotlin', 'python'];

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
 * The `resolutionConfig` the ts-family arms thread (#2953).
 *
 * These three used to run with `tsconfigPaths: null` for javascript and
 * typescript and an alias map for vue, because the leg being measured was
 * `suffixResolve` — a repo-wide search for a path ending in the specifier,
 * which needs no configuration to answer and answered even when nothing
 * declared the import. #2953 deleted that leg for the ts family: a specifier
 * now resolves only against a declared tsconfig mapping or a package manifest.
 *
 * With no config, therefore, all three arms resolve NOTHING — every import is
 * correctly external — and the bench measures an empty branch while reporting a
 * perfect scaling ratio. A bench that measures nothing passes exactly like one
 * that measures something, so each arm is given the config its corpus is
 * spelled for, and the two configs cover the two legs the new resolver has:
 *
 *  - `TS_BASE_URL` — `baseUrl` at the repo root, so `src/mod3/file7` resolves
 *    the way a `baseUrl` project's absolute import does. Used by javascript and
 *    typescript.
 *  - `vueTsconfig` — a `paths` PATTERN, which is a different branch:
 *    longest-prefix selection and `*` substitution, then a candidate probe per
 *    target. Every local Vue import below is spelled `@/…`, so the vue arm
 *    stays a third measurement rather than a third copy — the same role it had
 *    before, now against the branch that replaced the alias rewrite.
 *
 * Not covered here: the workspace-manifest leg
 * (`node-workspace-packages.ts`), which is a `Map.get` on a package name and
 * does not scale with the file set.
 */
const tsBaseUrlConfig = (baseUrl) => ({
  tsconfigs: { scopes: [{ dir: '', baseUrl, paths: [] }] },
  nodeWorkspacePackages: null,
});
const vueTsconfig = (baseUrl) => ({
  tsconfigs: {
    scopes: [
      { dir: '', baseUrl, paths: [{ pattern: '@/*', targets: [joinBase(baseUrl, 'src/*')] }] },
    ],
  },
  nodeWorkspacePackages: null,
});
const joinBase = (baseUrl, rest) => (baseUrl === '' ? rest : `${baseUrl}/${rest}`);
/**
 * The `deep` arm prepends a UNIFORM `d0/…/d15/` prefix to every path
 * (`buildFiles`), and the import spellings do not change. Under the old suffix
 * matcher that was the point: the resolver walked path components, so depth was
 * the cost. Declared resolution never walks — the config names an exact base —
 * so the prefix has to reach the config or the whole arm resolves nothing and
 * measures the miss path at depth instead of the hit path at depth.
 */
const tsBaseUrlFor = (pad) =>
  pad === 0 ? '' : Array.from({ length: pad }, (_, n) => `d${n}`).join('/');
const phpComposerConfigFor = (pad) => ({
  psr4: new Map([['App', joinBase(tsBaseUrlFor(pad), 'src/App')]]),
  authoritativePsr4: new Set(['App']),
});
const renderPhpComposerConfig = (config) =>
  [...config.psr4]
    .map(([namespace, directory]) => `${namespace || '<root>'}=${directory || '<root>'}`)
    .sort()
    .join(';');
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
  zig: '.zig',
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
 * shape the first-`indexOf` tie-break used to reject (see package-dir-index.ts);
 * #2881 removed that tie-break from every resolver that had it, so the go,
 * csharp, java and kotlin arms all resolve their `d % 7` slice now.
 *
 * A repeat the query cannot ask about leaves the arm blind, which is why go's
 * slice repeats the WHOLE package path: a Go import addresses `src/pkg{d}`, and
 * `…/internal/pkg{d}` does not end with that, so the old rule was never even
 * reached and every go arm sat still through the fix. Java, C# and Kotlin query
 * the whole dotted path FIRST and only fall back to the tail through
 * progressive stripping, so their slices — which repeat the last segment only —
 * move through that fallback rather than the primary query. The consequence is
 * measured and worth knowing: a partial revert that reinstates first-occurrence
 * only for multi-segment package paths is caught on the go arm alone.
 */
function uniqueDir(lang, d, i) {
  // Go's nested slice repeats the WHOLE queried path (`src/pkg{d}`), not just
  // its last segment. `src/pkg{d}/internal/pkg{d}` repeated only `pkg{d}`, so
  // the query `src/pkg{d}` failed on "the directory ends with the package path"
  // and never reached the first-occurrence rule at all — Go's arms did not move
  // when #2881 removed that rule, which would have shipped a widened bucket
  // with no bench coverage while C# and Java were re-baselined for it.
  if (lang === 'go') return d % 7 === 0 ? `src/pkg${d}/internal/src/pkg${d}` : `src/pkg${d}`;
  // Leaf-only repeat, deliberately: this layout is shared with the
  // `csharp_csproj` arm, whose configs mint `dirPrefix` against `src/Ns{d}`, so
  // deepening it to the full `App/Ns{d}` query path resolves that arm to ZERO
  // and breaks its same-workload invariant. C# therefore exercises the removed
  // rule through progressive stripping rather than through its primary query.
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
  // One flat `src/mod{d}/` per index and NO nested slice, on purpose: a Zig
  // import is spelled RELATIVE TO THE IMPORTER, and `uniqueTarget` does not
  // know which file issues it, so every importer has to sit at one depth for
  // `../mod{n}/file{j}.zig` to mean the same file from all of them. The miss
  // share the other unique arms take from a nested directory comes from the
  // target instead (see `uniqueTarget`).
  if (lang === 'zig') return `src/mod${d}`;
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
    // `…/sub/internal` repeats only the last segment, which the ends-with test
    // answers on its own; `…/internal/sub/svc{d}/internal` is the shape the
    // removed first-occurrence rule used to reject (see `uniqueDir`).
    if (d % 7 === 0) return `svc${d}/internal/sub/svc${d}/internal`;
    return d % 5 === 1 ? `svc${d}/internal/shared` : `svc${d}/internal`;
  }
  // Leaf-only repeat here too, and unlike the kotlin arm below that is not a
  // blind spot — measured, base against head over this exact corpus. C#'s match
  // test is an unanchored ends-with and its cascade strips leading segments, so
  // `App.Src{d}.Models` reaches `Models` after two strips and finds
  // `Src{d}/Models/Inner/Models`, whose FIRST `/Models/` is not its last: the
  // removed first-occurrence rule rejected it and the current one takes it. The
  // `csharp` collide fingerprint therefore moves across #2881 (03c9afe33276
  // head, 89d0a054b617 base) with the resolved count unchanged at 1153 — the
  // arm sees the change, it just sees it as different ANSWERS rather than more
  // of them. Deepening the slice to `Src{d}/Models/Inner/Src{d}/Models` only
  // moves which strip level finds it; both layouts move base -> head, so it
  // buys nothing here.
  //
  // And it costs, because the `csharp_csproj` constraint binds this arm too —
  // differently from the way it binds `uniqueDir`. There, deepening resolves
  // that arm to ZERO. Here it resolves MORE: `Lib` has `projectDir: ''`, so its
  // `dirPrefix` is `Src{d}/Models`, which is not a segment suffix of
  // `…/Inner/Models` and is one of `…/Inner/Src{d}/Models`. Measured, the
  // csproj arm's collide `resolved` goes 979 -> 1153 against its `small` 979,
  // which is the same-workload invariant `--check` asserts. (Worth recording
  // while it is measured: with the shipped layout BOTH csproj arms are blind to
  // #2881 — unique and collide fingerprints identical base and head — because
  // `getFilesInDir` is keyed on segment-aligned directory SUFFIXES and neither
  // nested slice is one. Closing that is the deepening plus a mirrored miss for
  // the csproj arm's `d % 7` slice, i.e. a corpus redesign and four
  // re-baselines, not this edit.)
  if (lang === 'csharp') return d % 7 === 0 ? `Src${d}/Models/Inner/Models` : `Src${d}/Models`;
  if (lang === 'dart') return `pkg${d}/lib/src`;
  if (lang === 'kotlin') {
    return d % 7 === 0
      ? // Repeats the WHOLE queried path (`com.example.models`), not just the
        // `models` leaf. With a leaf-only repeat this arm was structurally
        // blind to the #2881 rule: a full revert of the Kotlin guards left both
        // collide fingerprints unmoved, because `com/example/models` is not a
        // suffix of `…/models/inner/models` and the query never reached the
        // rule. Deepening it is the only corpus edit in this file that buys
        // coverage — the same deepening applied to the java and kotlin UNIQUE
        // arms was measured and reverted, because progressive stripping lands
        // those queries on the same file either way.
        `mod${d}/src/main/kotlin/com/example/models/inner/com/example/models`
      : `mod${d}/src/main/kotlin/com/example/models`;
  }
  if (lang === 'php') return `src/App/Svc${d}/Models`;
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
  // Rust's reasoning, verbatim: the resolver walks path components and probes
  // `.has()`, never searches, so file count is not an axis its cost has and a
  // shared-leaf layout would be an arm that cannot fail. A deep tree is the
  // axis that CAN grow — `collideTarget` spells its imports up through the
  // tree and back down, ~4x the components of the unique arm.
  if (lang === 'zig') return `src/l0/l1/l2/l3/l4/mod${d}`;
  throw unwiredLanguage('collideDir', lang);
}

/**
 * The file paths of one synthetic repository. `dirs` grows with the file count
 * so directory fan-out is realistic at both scales rather than collapsing onto
 * a handful of buckets.
 *
 * `pad` prepends that many extra directory components to every path. Every
 * path-based resolver keeps the same answer under that padding. Kotlin's
 * package facts are also unchanged by it. The padding therefore changes path
 * depth without changing what resolves, making `deep` a clean depth
 * measurement rather than a different corpus.
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
  // One real suffix decoy makes the PHP external gate observable: with the
  // gate, Vendor0 stays unresolved; without it, suffix fallback resolves this
  // path and the exact fingerprint/external-probe result changes.
  if (layout === 'php' && files.length > 0) {
    files[files.length - 1] = `${prefix}legacy/Vendor0/Ghost/Missing.php`;
  }
  return files;
}

/**
 * ONE `ParsedFile`, and the ONE place in this file that spells that shape.
 *
 * CARRIES THE FIELDS THE RESOLVERS READ AND NOTHING ELSE, deliberately.
 * `filesByDirectory` reads `filePath`; PHP's declaring-file filter reads
 * `localDefs[].type` and `localDefs[].qualifiedName`; Python's
 * `pythonFileExportsName` reads `localDefs[].qualifiedName`. `scopes`,
 * `parsedImports` and `referenceSites` are on the real shape and are inert on
 * this path, and the timed corpora are rebuilt inside every pass (see
 * `newPass`), so filling them would charge the RESOLUTION arms for extraction
 * work that happens in another phase entirely.
 *
 * `nodeId` is inert as well — checked, not assumed: neither
 * `php/import-target.ts` nor `python/import-target.ts` mentions it, and they are
 * the two modules `resolveOne` enters. It is minted anyway because it is on the
 * real shape, and its spelling is therefore free to be uniform.
 *
 * Both callers come through here — `buildParsedFiles` for the timed and heap
 * corpora, `CONTEXT_PROBE` for the `context` arm's hand-built ones. It used to
 * be spelled out twice, ~900 lines apart, differing only in that `nodeId`; this
 * is an untyped `.mjs`, so nothing would have failed at build if `ParsedFile`
 * grew a field and only one of the two copies learned about it.
 */
const probeFile = (filePath, defs) => ({
  filePath,
  moduleScope: filePath,
  scopes: [],
  parsedImports: [],
  localDefs: defs.map(([type, qualifiedName], n) => ({
    nodeId: `${filePath}#${n}`,
    filePath,
    type,
    qualifiedName,
  })),
  referenceSites: [],
});

const javaProbeFile = (filePath, packageName) => ({
  ...probeFile(filePath, []),
  captureSideChannel: {
    kind: 'java',
    packageFact: { status: 'known', packageName },
    classAnnotations: [],
  },
});

const kotlinProbeFile = (filePath, packageName, exportName) => {
  const base = probeFile(filePath, [['Class', `${packageName}.${exportName}`]]);
  const def = base.localDefs[0];
  const moduleScope = `module:${filePath}`;
  return {
    ...base,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        filePath,
        bindings: new Map([[exportName, [{ def, origin: 'local' }]]]),
        ownedDefs: [def],
        imports: [],
        typeBindings: new Map(),
      },
    ],
    captureSideChannel: {
      kind: 'kotlin',
      companionScopes: [],
      packageFact: { status: 'known', packageName },
      classAnnotations: [],
    },
  };
};

function javaBenchmarkPackage(filePath) {
  const uniquePackage = /\/com\/example\/(pkg\d+)(?:\/|$)/.exec(`/${filePath}`)?.[1];
  if (uniquePackage !== undefined) return `com.example.${uniquePackage}`;

  return /\/svc\d+\/.*\/com\/example\/model(?:\/|$)/.test(`/${filePath}`)
    ? 'com.example.model'
    : '';
}

function kotlinBenchmarkPackage(filePath) {
  const rootedPath = '/' + filePath;
  const uniquePackage = /\/com\/example\/(pkg\d+)(?:\/|$)/.exec(rootedPath)?.[1];
  if (uniquePackage !== undefined) return `com.example.${uniquePackage}`;
  return /\/com\/example\/models(?:\/|$)/.test(rootedPath) ? 'com.example.models' : '';
}

/**
 * The `ParsedFile[]` the orchestrator threads beside the path set, for the three
 * languages whose hook declares a `context` — see `CONTEXT_LANGS`.
 *
 * Two defs per file, and both are real shapes rather than padding. PHP keeps
 * classes and functions in SEPARATE symbol tables, so `App\Ns7\File7` naming
 * both a class and a function is ordinary PHP — and it is what makes the leg's
 * two halves reachable on the same corpus: the class def exercises the
 * `def.type !== expectedType` reject (which returns before the split) and the
 * function def exercises the `split(/[\\.]/).at(-1)` compare that decides the
 * match. The qualified name carries two separators because that split's cost is
 * a function of how many there are, and a one-segment name would understate it.
 *
 * The owner segment is the file's own directory name (`Ns7`, `Models`, `pkg7`),
 * which is stable across the `small`, `deep` and `collide` arms — so the `deep`
 * arm differs from `small` in path DEPTH alone, exactly as it does for the path
 * set. `filesByDirectory` is exact and linear in the file count; the shared
 * suffix index remains the path-depth-sensitive structure this arm measures.
 */
function buildParsedFiles(lang, files) {
  const parsedFiles = [];
  for (const filePath of files) {
    if (lang === 'java') {
      parsedFiles.push(javaProbeFile(filePath, javaBenchmarkPackage(filePath)));
      continue;
    }
    if (lang === 'kotlin') {
      const slash = filePath.lastIndexOf('/');
      const stem = filePath.slice(slash + 1, filePath.lastIndexOf('.'));
      parsedFiles.push(kotlinProbeFile(filePath, kotlinBenchmarkPackage(filePath), stem));
      continue;
    }
    const slash = filePath.lastIndexOf('/');
    const stem = filePath.slice(slash + 1, filePath.lastIndexOf('.'));
    const parent = slash < 0 ? '' : filePath.slice(0, slash);
    const owner = parent.slice(parent.lastIndexOf('/') + 1);
    const qualifiedName = lang === 'php' ? `App\\${owner}\\${stem}` : `${owner}.${stem}`;
    parsedFiles.push(
      probeFile(filePath, [
        ['Class', qualifiedName],
        ['Function', qualifiedName],
      ]),
    );
  }
  return parsedFiles;
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
    if (local) {
      const namespace = d % 7 === 0 ? `Ns${d}\\Sub\\Ns${d}` : `Ns${d}`;
      const leadingSeparator = (r >>> 3) % 4 === 0 ? '\\' : '';
      return `${leadingSeparator}App\\${namespace}\\File${j}`;
    }
    return (r >>> 3) % 2 === 0
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
    // for JavaScript until PR #2911 and cost 25 972 µs per import at 8000
    // files — so a corpus of `./sibling` imports would measure the wrong one.
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
  if (lang === 'zig') {
    // `@import("../mod{n}/file{j}.zig")`, importer-relative — every file sits
    // in `src/mod{d}/`, so one `..` reaches `src/` from all of them (see
    // `uniqueDir`). The target is file `j`'s OWN directory, `j % dirs`, so a
    // hit is a real file; the `d % 7` slice names an `inner/` that exists
    // nowhere and misses, which is where the resolved count comes from, as in
    // the rust arm. One local spelling in three drops the extension, which is
    // the second `.has()` probe (`candidate + '.zig'`) — the leg an
    // extension-only corpus would never reach. The misses are the three
    // kinds a Zig file has: the compiler's own modules (`std`, `builtin`,
    // `root`), which the resolver rejects by name before any walk; a bare
    // package name with no build config to map it, which falls through every
    // leg to null; and a relative path to a vendored file that is not in the
    // corpus, which walks to the end and misses on both probes.
    if (local) {
      if (d % 7 === 0) return `../mod${d}/inner/file${j}.zig`;
      return (r >>> 3) % 3 === 0 ? `../mod${j % dirs}/file${j}` : `../mod${j % dirs}/file${j}.zig`;
    }
    const miss = (r >>> 3) % 3;
    if (miss === 0) return ['std', 'builtin', 'root'][(r >>> 4) % 3];
    if (miss === 1) return `ghost${(r >>> 4) % 97}`;
    return `../vendor${(r >>> 4) % 97}/missing.zig`;
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
      ? // This used to send the `d % 7` slice to `App.Src{d}.Vendor`, a
        // namespace with no directory anywhere, to mirror the unique arm's
        // nested-same-name slice, which also resolved to nothing. #2881 made
        // that slice resolve, so the mirror has to as well — otherwise this arm
        // stops resolving as many imports as `small`, which is the invariant
        // that makes the two timings comparable and is asserted below.
        `App.Src${d}.Models`
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
    // Same wildcard share and declared-package workload as the unique arm.
    // Directory collisions must not affect semantic package resolution.
    return local
      ? (r >>> 3) % 3 === 0
        ? `com.example.models.*`
        : `com.example.models.File${j}`
      : (r >>> 3) % 2 === 0
        ? ['java.util.List', 'kotlin.collections.Map', 'kotlinx.coroutines.flow.Flow'][
            (r >>> 4) % 3
          ]
        : `com.ghost${(r >>> 4) % 97}.deep.Missing`;
  }
  if (lang === 'php') {
    if (local) {
      const leadingSeparator = (r >>> 3) % 4 === 0 ? '\\' : '';
      return `${leadingSeparator}App\\Svc${j % dirs}\\Models\\Mod${Math.floor(j / dirs)}`;
    }
    return (r >>> 3) % 2 === 0
      ? [
          'Psr\\Log\\LoggerInterface',
          'Symfony\\Component\\Console\\Command',
          'Doctrine\\ORM\\EntityManager',
        ][(r >>> 4) % 3]
      : `Vendor${(r >>> 4) % 97}\\Ghost\\Missing`;
  }
  if (lang === 'java') {
    // Every file declares the same package despite living under different
    // service paths. Exact and wildcard imports therefore exercise one growing
    // declared-package bucket without relying on directory layout.
    return local
      ? (r >>> 3) % 3 === 0
        ? 'com.example.model.*'
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
  if (lang === 'zig') {
    // The same three families in the same proportions as the unique arm, so
    // the resolved count is identical by construction (asserted), spelled up
    // six levels to `src/` and back down through `l0/…/l4` — thirteen
    // components against the unique arm's three, in the hits and in the path
    // misses alike, because component count is the only axis this resolver's
    // cost has. The `d % 7` slice and the extension-less third mirror the
    // unique arm's; the by-name misses are unchanged, since no walk is what
    // they measure.
    const up = '../../../../../../l0/l1/l2/l3/l4';
    if (local) {
      if (d % 7 === 0) return `${up}/mod${d}/inner/file${j}.zig`;
      return (r >>> 3) % 3 === 0
        ? `${up}/mod${j % dirs}/file${j}`
        : `${up}/mod${j % dirs}/file${j}.zig`;
    }
    const miss = (r >>> 3) % 3;
    if (miss === 0) return ['std', 'builtin', 'root'][(r >>> 4) % 3];
    if (miss === 1) return `ghost${(r >>> 4) % 97}`;
    return `${up}/vendor${(r >>> 4) % 97}/missing.zig`;
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
  if (lang === 'php' && imports.length > 0) {
    imports[0] = [files[0], 'Vendor0\\Ghost\\Missing'];
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
 *
 * `parsedFiles` is the third pass-stable object, present for `CONTEXT_LANGS`
 * and undefined for everyone else. It is built BEFORE the path set and the path
 * set is derived FROM it, which is not a stylistic choice: `run.ts` does
 * `new Set(parsedFiles.map((f) => f.filePath))`, so two independently built
 * lists would be a shape the pipeline cannot produce. Fresh per pass for
 * exactly the reason the Set is — `filesByDirectory` and `parsedFileByPath` are
 * `perFileSet` memos keyed on this ARRAY's identity, so reusing one array would
 * hide their build from rep 2 onward and `fastest()` reports the minimum.
 */
function newPass(lang, files, pad = 0) {
  if (HEADER_EXTENSION[lang] !== undefined) {
    const sources = [];
    const headers = [];
    for (const f of files) (f.endsWith(HEADER_EXTENSION[lang]) ? headers : sources).push(f);
    return { allFilePaths: new Set(sources), config: new Set(headers) };
  }
  if (lang === 'vue') {
    return { allFilePaths: new Set(files), config: vueTsconfig(tsBaseUrlFor(pad)) };
  }
  // javascript and typescript resolve their `src/mod{d}/file{j}` locals through
  // `baseUrl`; without a config every arm would correctly resolve nothing and
  // measure an empty branch (#2953 — see `tsBaseUrlConfig`).
  if (lang === 'javascript' || lang === 'typescript') {
    return { allFilePaths: new Set(files), config: tsBaseUrlConfig(tsBaseUrlFor(pad)) };
  }
  if (CONTEXT_LANGS.includes(lang)) {
    const parsedFiles = buildParsedFiles(lang, files);
    restoreBenchmarkSideChannels(lang, parsedFiles);
    return {
      allFilePaths: new Set(parsedFiles.map((f) => f.filePath)),
      config: lang === 'php' ? phpComposerConfigFor(pad) : undefined,
      parsedFiles,
    };
  }
  return { allFilePaths: new Set(files), config: undefined };
}

/**
 * The `{ parsedFiles, parsedImport }` object `run.ts` mints per import — per
 * import there too, so this allocation is production's, not the bench's.
 *
 * `undefined` when the pass carries no parsed workspace, which happens in
 * exactly one place: the CONTROL half of the `context` arm, whose whole job is
 * to prove the arm can tell the two call shapes apart.
 */
const contextFor = (pass, parsedImport) =>
  pass.parsedFiles === undefined
    ? undefined
    : { parsedFiles: pass.parsedFiles, parsedImport, filesSkipped: 0 };

function restoreBenchmarkSideChannels(lang, parsedFiles) {
  const resolver =
    lang === 'java' ? javaScopeResolver : lang === 'kotlin' ? kotlinScopeResolver : undefined;
  if (resolver === undefined) return;
  resolver.loadResolutionConfig?.('');
  for (const parsed of parsedFiles) resolver.applyCaptureSideChannel?.(parsed);
}

/** The timed loop. One `newPass` per pass, so every pass pays exactly one index
 *  build — see `newPass`. */
function resolveAll(lang, files, imports, pad = 0) {
  const pass = newPass(lang, files, pad);
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
    const parsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: target,
    };
    return kotlinScopeResolver.resolveImportTarget(
      target,
      from,
      allFilePaths,
      pass.config,
      contextFor(pass, parsedImport),
    );
  }
  // `pass.config` is undefined for PHP, so no composer.json: the PSR-4 mapping
  // legs are skipped and every import lands on the suffix cascade #2901
  // indexed. The FIFTH argument is the production one, and
  // `importedSymbolKind: 'function'` is what opens the named/alias leg over
  // `filesByDirectory(context.parsedFiles)` — see THE FIFTH ARGUMENT. It runs
  // on every import rather than on a share of them because the leg is the point
  // of the arm and it costs the cascade nothing: `resolvePhpImportInternal`
  // has already returned by the time the leg is consulted, so this arm still
  // measures everything it measured before, plus the leg.
  //
  // `importedName` is inert here and stays 'X' like the java and kotlin arms:
  // the leg derives the name it matches on from `targetRaw` itself, so
  // computing a real one would be a split per import charged to the timed loop
  // for a field nothing reads.
  if (lang === 'php') {
    return resolvePhpImportTargetInternal(
      target,
      from,
      allFilePaths,
      pass.config,
      contextFor(pass, {
        kind: 'named',
        localName: 'X',
        importedName: 'X',
        targetRaw: target,
        importedSymbolKind: 'function',
      }),
    );
  }
  if (lang === 'java') {
    const parsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: target,
    };
    return javaScopeResolver.resolveImportTarget(
      target,
      from,
      allFilePaths,
      pass.config,
      contextFor(pass, parsedImport),
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
  // Quotes already stripped — `configs/zig.ts` strips them before this call in
  // production too. `null` build config: this arm pins the path walk alone
  // (see the header); the config legs are gated by their own unit tests.
  if (lang === 'zig') return resolveZigImportInternal(from, target, allFilePaths, null);
  if (lang === 'python') {
    // `from <target> import X` — the spelling the orchestrator actually hands
    // the provider, and the ONLY one that reads `context.parsedFiles`: a
    // `namespace` import makes `pythonImportedSubmoduleTarget` return null, the
    // submodule-precedence branch never runs and the field is dead. This arm
    // used to pass that synthetic namespace spelling and skipped the branch
    // for exactly that reason, which is what made the field unmeasurable.
    //
    // So the arm now pays the branch: a package probe, a `parsedFileByPath`
    // lookup over the resolved package's `localDefs`, and a submodule probe —
    // up to three entries into the resolver per import, which is why its ms
    // numbers are several times what the namespace spelling read. That IS the
    // per-import cost of a `from … import …` in production.
    //
    // 'X' names nothing the corpus declares, on purpose: `pythonFileExportsName`
    // then scans the whole `localDefs` list and returns false, so every
    // resolving import runs the submodule probe too. That is the expensive
    // half of the branch — a name the package DOES export short-circuits at
    // the first def — and matches corpus property 1 above.
    //
    // The `{ fromFile, allFilePaths, parsedFiles }` shape is exactly what
    // `pythonScopeResolver` builds from the context before calling this.
    return resolvePythonImportTarget(
      { kind: 'named', localName: 'X', importedName: 'X', targetRaw: target },
      { fromFile: from, allFilePaths, parsedFiles: pass.parsedFiles },
    );
  }
  if (lang === 'javascript') {
    return jsResolveImportTarget(target, from, allFilePaths, pass.config);
  }
  if (lang === 'vue') return vueResolveImportTarget(target, from, allFilePaths, pass.config);
  // TypeScript, C and C++ go through the registered `ScopeResolver` hook rather
  // than an inner resolver, because for all three the thing under test lives IN
  // the adapter: TypeScript's `tsPassCacheFor` memo is private to
  // `typescript/scope-resolver.ts`, and C's and C++'s `augmentedFilePathsFor`
  // is private to theirs. Calling past it would benchmark a copy of the adapter
  // instead of the adapter.
  if (lang === 'typescript') {
    return typescriptScopeResolver.resolveImportTarget(target, from, allFilePaths, pass.config);
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
function identityPass(lang, files, imports, pad = 0) {
  const pass = newPass(lang, files, pad);
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
    const rendered = renderResolved(hit);
    outcomes.add(`${key}\u0000${rendered}`);
  }
  return { outcomes, resolved };
}

/** One resolver answer as a comparable string. Kotlin and Java can return a
 *  LIST (their wildcard tier), so the array form is part of the shape, and
 *  `<null>` keeps a miss distinct from a resolver that answered the empty
 *  string. Shared by the fingerprint above and by the `context` arm below, so
 *  the two never drift into reporting one answer two ways. */
function renderResolved(hit) {
  if (hit === null) return '<null>';
  return Array.isArray(hit) ? hit.join(',') : hit;
}

/** MIN, not median: both scales are timed in one process and every error source
 *  (GC, scheduler preemption, a noisy CI neighbour) is additive, so the fastest
 *  observed pass is the closest estimate of the uncontended cost. */
function fastest(values) {
  return Math.min(...values);
}

function timeResolution(lang, files, imports, reps, pad = 0) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports, pad);
  const samples = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    resolveAll(lang, files, imports, pad);
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
function probeMs(lang, files, imports, pad = 0) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports, pad);
  const t0 = performance.now();
  resolveAll(lang, files, imports, pad);
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
function retainedPassBytes(lang, files, probeTarget, pad = 0) {
  const pass = newPass(lang, files, pad);
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
  // A mapped-but-missing class forces the Composer mapping and suffix-index
  // read paths. The separate external probe below keeps the fast gate visible.
  php: 'App\\HeapGhost0\\AbsentHeapProbe',
  java: 'com.google.common.vendor0.Missing',
  javascript: 'vendor0/lib/missing',
  python: 'vendor0.deep.missing',
  c: 'vendor0/missing.h',
  // The entries below cover the BOUNDED tier — see `HEAP_BOUNDED`, which
  // derives to cobol, swift and rust; the rest were promoted. Same rule as the
  // budgeted ones above: a spelling `uniqueTarget` already mints for that language, and
  // one that MISSES, so the reading is the index and the cascade runs to the
  // end. Chosen from the miss family that reaches furthest into each cascade:
  //   - `go` names a missing package inside GO_MODULE, which reaches the
  //     package-directory lookup and forces `PackageDirIndex`;
  //   - `dart` is an external package, so BOTH candidate paths miss and both
  //     walk the basename bucket to completion;
  //   - `kotlin` misses after building its declared-package/module-binding index;
  //   - `cobol` misses in both tier maps, `swift` in `byModule`, and `rust`
  //     probes candidate paths and builds nothing — that last is the reading
  //     the exclusion rests on, and `zig` shares it exactly;
  //   - `typescript`, `vue` and `cpp` carry the same spelling shape as the
  //     `javascript` and `c` arms they are excluded as duplicates OF, so the
  //     bound compares like with like. `vue`'s is bare rather than `@/…`
  //     because the alias branch rewrites to `src/` and would resolve.
  go: 'example.com/mod/repo0/pkg/util',
  dart: 'package:ext0/src/thing.dart',
  kotlin: 'com.ghost0.deep.Missing',
  cobol: 'VENDOR0',
  swift: 'ExternalPkg0',
  rust: 'ghost0::Missing',
  // A relative path to a file the corpus does not hold: both `.has()` probes
  // miss after the full component walk, which is the longest leg the resolver
  // has (a by-name miss returns before any walk).
  zig: '../vendor0/missing.zig',
  typescript: 'vendor0/lib/missing',
  vue: 'vendor0/lib/Missing.vue',
  cpp: 'vendor0/missing.hpp',
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
  const read = (files) => retainedPassBytes(lang, files, probe, lang === 'php' ? HEAP_PAD : 0);
  const small = flatten(buildFiles(lang, HEAP_SMALL, HEAP_PAD, 'unique'));
  const bytesSmall = read(small);
  const large = flatten(buildFiles(lang, HEAP_LARGE, HEAP_PAD, 'unique'));
  const bytesLarge = read(large);
  const phpGateShape =
    lang === 'php'
      ? (() => {
          const externalProbe = 'Vendor0\\Ghost\\Missing';
          const config = phpComposerConfigFor(HEAP_PAD);
          const pass = newPass(lang, large, HEAP_PAD);
          return {
            resolution_config: renderPhpComposerConfig(config),
            external_probe: externalProbe,
            external_result: renderResolved(resolveOne(lang, large[0], externalProbe, pass)),
          };
        })()
      : {};
  return {
    files_small: HEAP_SMALL,
    files_large: HEAP_LARGE,
    path_segments: small[0].split('/').length,
    probe,
    bytes_small: bytesSmall,
    bytes_large: bytesLarge,
    mib_large: Number((bytesLarge / 1024 / 1024).toFixed(2)),
    ratio: Number((bytesLarge / bytesSmall / (HEAP_LARGE / HEAP_SMALL)).toFixed(3)),
    ...phpGateShape,
  };
}

/**
 * The `context` arm's corpora — one per `CONTEXT_LANGS` entry, each a handful
 * of files carrying ONE import whose answer DIFFERS between the production
 * five-argument call and the three-argument one this harness used to make.
 *
 * That difference is the whole arm. PHP and Python need it because their main
 * corpus answers agree with the fallback. Java and Kotlin deliberately return
 * null without declared-package context; this tiny positive probe isolates the
 * adapter contract from aggregate corpus changes. Timing cannot prove any of
 * these; a dropped context makes the arms faster, and nothing here has a lower
 * bound on ms.
 *
 * All probes are resolved THROUGH `resolveOne`, not through the resolvers directly,
 * because what is under test is this file's threading rather than the
 * resolvers' behaviour. The control differs in exactly one thing:
 * `pass.parsedFiles` is undefined, which `contextFor` turns into no fifth
 * argument at all.
 */
const CONTEXT_PROBE = {
  /**
   * `use function App\Ns0\Dup;` where the CLASS `Dup` lives in `Dup.php` and
   * the FUNCTION `Dup` lives in `Helpers.php`. PHP keeps the two in separate
   * symbol tables and PSR-4 maps only the class, which is the case the leg
   * exists for: the suffix cascade answers the file whose NAME matches the last
   * segment, the leg answers the file that DECLARES the function. Two distinct
   * non-null paths, so neither half of the arm can be mistaken for a miss, and
   * `Alpha.php` is a third file in the same directory so the candidate gather
   * has something to reject.
   */
  php: {
    from: 'src/App/Ns0/Alpha.php',
    target: 'App\\Ns0\\Dup',
    parsedFiles: [
      probeFile('src/App/Ns0/Alpha.php', [['Class', 'App\\Ns0\\Alpha']]),
      probeFile('src/App/Ns0/Dup.php', [['Class', 'App\\Ns0\\Dup']]),
      probeFile('src/App/Ns0/Helpers.php', [['Function', 'App\\Ns0\\Dup']]),
    ],
  },
  /** A declared package resolves its type only when the parsed workspace arrives. */
  java: {
    from: 'app/Main.java',
    target: 'com.example.model.User',
    parsedFiles: [
      javaProbeFile('app/Main.java', 'app'),
      javaProbeFile('weird/path/User.java', 'com.example.model'),
    ],
  },
  /** A Kotlin export resolves from its package fact and module binding only. */
  kotlin: {
    from: 'app/Main.kt',
    target: 'com.example.model.User',
    parsedFiles: [
      kotlinProbeFile('app/Main.kt', 'app', 'main'),
      kotlinProbeFile('weird/path/UserSource.kt', 'com.example.model', 'User'),
    ],
  },
  /**
   * `from pkg import X`, with `pkg/__init__.py` exporting `X` AND a same-named
   * submodule `pkg/X.py` beside it — the precedence CPython documents and the
   * one `pythonFileExportsName` exists to reproduce. With the parsed workspace
   * the package's own export wins (`pkg/__init__.py`); without it the export is
   * invisible, the submodule probe runs and `pkg/X.py` wins.
   *
   * `X` rather than a prettier name because `resolveOne` passes `importedName:
   * 'X'`: the probe is tied to the spelling the timing arms use, so changing
   * one without the other fails here.
   *
   * This corpus also catches a revert to the synthetic `namespace` spelling,
   * which no exact-value assertion could: that spelling never reads
   * `parsedFiles`, so BOTH halves answer `pkg/__init__.py` and the
   * with/without inequality below is what notices.
   */
  python: {
    from: 'app/main.py',
    target: 'pkg',
    parsedFiles: [
      probeFile('pkg/__init__.py', [['Function', 'pkg.X']]),
      probeFile('pkg/X.py', [['Function', 'pkg.X.run']]),
      probeFile('app/main.py', [['Function', 'app.main.run']]),
    ],
  },
};

/** Resolve the probe twice through `resolveOne` — once with the pass's parsed
 *  workspace, once without — and report both answers. Deterministic and
 *  microseconds, so it runs in report mode too. */
function measureContext(lang) {
  const { from, target, parsedFiles } = CONTEXT_PROBE[lang];
  const allFilePaths = new Set(parsedFiles.map((f) => f.filePath));
  const config = lang === 'php' ? phpComposerConfigFor(0) : undefined;
  const answer = (files) => {
    restoreBenchmarkSideChannels(lang, files ?? []);
    return renderResolved(
      resolveOne(lang, from, target, { allFilePaths, config, parsedFiles: files }),
    );
  };
  return {
    target,
    with_context: answer(parsedFiles),
    without_context: answer(undefined),
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
 * This used to be a hand-written list of language strings under a comment
 * claiming it was "every language in `SCOPE_RESOLVERS`" — a claim nothing in
 * the file could check, because the file never imported the registry. Adding a
 * resolver to `pipeline/registry.ts` is two lines, neither of which is this
 * one, so a newly registered language would have shipped ungated and
 * printed PASS. That is not a hypothetical failure mode: JavaScript reached
 * `suffixResolve` with no index at all and measured 25 972 µs per import at
 * 8000 files (PR #2911) for exactly as long as nothing gated it.
 *
 * So the list is DERIVED and the claim is ASSERTED. `LANGS` is this table's
 * keys, and the `--check` inventory arm below fails when a registered resolver
 * has no arm here (or an arm names a language the registry does not have) —
 * the same shape `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`
 * uses ten files away, and the same "one row per language" table
 * `bench/cfg/measure.mjs` keeps.
 *
 * The mapping is many-to-one only for C#: the configured arm reaches the
 * csproj branch that the default arm cannot observe. PHP's sole arm carries
 * its production Composer configuration directly.
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
  zig: SupportedLanguages.Zig,
};
const LANGS = Object.keys(LANG_REGISTRY);
/**
 * The heap arm's SECOND tier: every arm that is not budgeted, and the reason it
 * is a `filter` over `LANGS` rather than a second list beside `HEAP_BUDGETED`.
 *
 * The two tiers partition `LANGS` by construction, so there is no third state a
 * language can be in — the state the nine spent this file's whole life in,
 * where "not budgeted" and "not measured" were the same thing and neither was
 * derived from anything. Adding a registered language now costs a bound whether
 * or not anyone thinks about memory: the inventory arm gives it a `LANGS` row,
 * this line gives it a tier, and the presence check below fails until it has a
 * key. Deriving it also means the two tiers cannot overlap or leave a gap, which
 * two hand-written lists could do in either direction.
 *
 * A bound and NOT a floor, deliberately, and the boundary is the one thing here
 * worth re-reading before moving a language across it: a floor asserts "this
 * arm is still measuring something", which is a claim about an index the file
 * has budgeted, and rust's 16 B cannot carry it. What every one of the nine CAN
 * carry is "the exclusion still holds" — that this language has not grown an
 * index since it was left out. See the TIER TWO loop at the foot of the file,
 * and `_heap_bound_note` in baselines.json for each language's reason.
 */
const HEAP_BOUNDED = LANGS.filter((lang) => !HEAP_BUDGETED.includes(lang));
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
    const { outcomes, resolved } = identityPass(lang, files, imports, pad);
    if (reps === null) reps = repsFor(probeMs(lang, files, imports, pad));
    scales[name] = {
      files: files.length,
      imports: imports.length,
      // Reported, not asserted on its own: a corpus edit that collapsed the
      // resolved share would still produce a "valid" fingerprint over far less.
      resolved,
      distinct_outcomes: outcomes.size,
      ms: Number(timeResolution(lang, files, imports, reps, pad).toFixed(3)),
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
    // `buildSuffixIndex` (C#, Ruby, PHP, Java, and the whole ts family) emits
    // one entry per '/' in a path, while Kotlin's declared-package index is
    // depth-free, and
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
//
// `LANGS`, not `HEAP_BUDGETED`: which tier a language is in decides its GATE,
// not whether it is read. Measured cost of the nine extra arms is 1.37 s — this
// phase goes 2.06 s -> 3.43 s, of which kotlin alone is 0.57 s. See COST.
for (const lang of LANGS) report[lang].heap = measureHeap(lang);

// Deterministic and microseconds — it resolves six imports over three tiny
// corpora — so unlike the heap arm it neither needs nor deserves isolation from
// the timing phase. It runs last only because it reads best beside the heap arm
// in the report.
for (const lang of CONTEXT_LANGS) report[lang].context = measureContext(lang);

if (!CHECK) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];

/**
 * PRESENCE, for one budget, in the one place that spells the reason.
 *
 * A missing budget is a DELETED GATE, not a passing arm: `got > undefined` is
 * `false`, `ceiling * undefined` is `NaN` and `bytes < NaN` is `false`, so every
 * comparison in this file answers "within budget" for every possible
 * measurement the moment its key stops being a number. Each of the three call
 * sites below is one deleted key away from a silent no-op, and the run still
 * prints PASS.
 *
 * `Number.isFinite` rather than `typeof === 'number'`: over JSON input the two
 * agree (JSON cannot express NaN or Infinity), and the stricter one is the one
 * whose name says what the gate needs.
 *
 * The two per-site facts stay the caller's, because they are what a triager acts
 * on: `reads` is the comparison that silently stopped gating, quoted, and
 * `scope` is what deleting this one key actually costs — a single arm, or all
 * eight at once. Only the shared framing and the shared trailing sentence live
 * here. Returns the message rather than pushing it, so the timing loop can
 * `continue` past a budget it must not then compare against.
 */
const requireNumericBudget = ({ key, value, reads, scope }) =>
  Number.isFinite(value)
    ? null
    : `no numeric ${key} in baselines.json — a missing budget is a DELETED GATE, not a passing ` +
      `arm: the comparison it gates reads \`${reads}\`, which is false for every possible ` +
      `measurement. ${scope} Deterministic: a re-run will not change it.`;

/**
 * The REVERSE direction of a reconciliation: every key declared in `label` that
 * `codeList` does not name.
 *
 * The forward direction ("the code has an arm with no budget") is a presence
 * check inside whichever loop iterates the code's list. This is the other way
 * round — a budget, a baseline block or a registry row for an arm that is never
 * measured — and no forward check can see it, because the thing it names is
 * exactly the thing nothing iterates.
 *
 * `codeListName` and `why` stay the caller's: which list is authoritative and
 * what the orphan costs are the two facts that differ between the three arms,
 * and flattening them would leave a triager with a name and no reading of it.
 */
function expectNoOrphanKeys(label, declaredKeys, codeList, codeListName, why) {
  for (const key of declaredKeys) {
    if (codeList.includes(key)) continue;
    failures.push(
      `${label} has an entry for '${key}', which is not in ${codeListName} — ${why} ` +
        `Deterministic: a re-run will not change it.`,
    );
  }
}

/** The corpus-shape facts asserted for one timing scale. */
const SCALE_SHAPE = {
  fields: ['files', 'imports', 'resolved', 'distinct_outcomes', 'fingerprint'],
  why:
    'the corpus changed shape or the resolver changed its answer for this arm. Every scale is ' +
    'asserted separately: the arms differ only in padding and layout, so a defect that touches ' +
    'one of them alone moves nothing in the others.',
};
/** The same, for the heap arm — the four inputs that decide what it measures.
 *  Asserted for all seventeen arms, budgeted tier and bounded tier alike, and it is
 *  the bounded tier that needs it most: a bound is a single comparison, so a
 *  probe swapped for one that reaches less is a bound over a smaller workload
 *  and there is no floor beside it to notice.
 *  `bytes_small`/`bytes_large` are deliberately NOT here: they are bounded by
 *  `heap_ceiling_bytes` and `heap_reading_bytes` with ~50% of slack either way
 *  (`heap_bound_bytes` with 50% on the one side), because a Node major or a
 *  different platform moves heapUsed accounting and an exact-equality arm on a
 *  byte count would be a re-baseline per runner. */
const HEAP_SHAPE = {
  fields: ['files_small', 'files_large', 'path_segments', 'probe'],
  why:
    'these four decide WHAT the heap arm measures and nothing else here can see them move — a ' +
    'probe that stops reaching a leg, or two file counts collapsed onto one, leaves every ' +
    'ceiling, floor, bound and ratio passing over an arm that changed workload. Deterministic: ' +
    'a re-run will not change it.',
};
const PHP_HEAP_SHAPE = {
  fields: [...HEAP_SHAPE.fields, 'resolution_config', 'external_probe', 'external_result'],
  why:
    HEAP_SHAPE.why +
    ' PHP also pins the Composer mapping and a suffix-matchable external decoy so the mapped ' +
    'index path and the external fast gate remain separate observable arms.',
};
/** The same, for the `context` arm. All three fields are exact strings, not
 *  bounds: this arm has no measurement noise at all — it resolves one import
 *  two ways over a three-file corpus — so anything less than equality would be
 *  slack for nothing. */
const CONTEXT_SHAPE = {
  fields: ['target', 'with_context', 'without_context'],
  why:
    'the fifth `context` argument stopped reaching this resolver, reached it in a different ' +
    'shape, or the resolver changed what it does with it. `with_context` is what the five-argument ' +
    'call `run.ts` makes answers and `without_context` is what the three-argument one this bench ' +
    'used to make answers; both are pinned, so a change is attributed rather than guessed. ' +
    'Deterministic: a re-run will not change it.',
};
/** Every asserted arm for one language, derived so a new scale is covered by
 *  construction. The heap arm is present for EVERY language now — it used to be
 *  conditional on `HEAP_LANGS`, which is what let the other nine be measured by
 *  nothing and pinned by nothing; the two tiers below decide which gate the
 *  reading gets. The context arm is still conditional, on `CONTEXT_LANGS`, which
 *  the registry-arity arm at the foot of the file pins to the hooks that DECLARE
 *  a fifth parameter. */
const armShapes = (lang) => [
  ...SCALES.map((scale) => [scale, SCALE_SHAPE]),
  ['heap', lang === 'php' ? PHP_HEAP_SHAPE : HEAP_SHAPE],
  ...(CONTEXT_LANGS.includes(lang) ? [['context', CONTEXT_SHAPE]] : []),
];

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
    // PRESENCE FIRST — see `requireNumericBudget` for why. All five maps are
    // complete today, which is exactly when the check is worth having: every one
    // of the four per-language lookups above is one deleted key away from a
    // silent no-op. The heap arm HAD THE SAME HOLE and the comment here used to
    // deny it: iterating the BASELINE's keys protects that loop against a
    // deleted MEASUREMENT, which is a different thing from a deleted BUDGET.
    // See `heapBudgetChecks`.
    const missing = requireNumericBudget({
      key: check.key,
      value: check.budget,
      reads: `${check.got} > undefined`,
      scope: `That leaves ${lang}'s ${check.label} arm ungated.`,
    });
    if (missing !== null) {
      failures.push(`${lang}: ${missing}`);
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
  // The `context` arm's own discriminator, and the same shape of gate as the
  // deep/collide fingerprint comparison above: `armShapes` pins WHAT the two
  // call shapes answer, and this pins that they still answer DIFFERENTLY.
  // Without it the arm degrades exactly the way `DEEP_PAD = 0` degrades the
  // depth arm — a probe on which both halves agree asserts two copies of one
  // number. Deleting the fifth argument from `resolveOne`, deleting
  // `importedSymbolKind` from PHP's import, or reverting Python to the
  // `namespace` spelling all land here, and NOTHING else in this file would
  // notice: on the main corpus the leg agrees with the cascade, so the
  // fingerprints do not move, and a dropped context only makes the timing arms
  // faster.
  if (CONTEXT_LANGS.includes(lang) && got.context.with_context === got.context.without_context) {
    failures.push(
      `${lang}: context arm answers '${got.context.with_context}' with AND without the pass's ` +
        `parsedFiles — the fifth argument is not reaching the resolver, or the leg behind it no ` +
        `longer runs (PHP needs parsedImport.kind named|alias AND importedSymbolKind ` +
        `function|const; Python needs named|alias, since a namespace import never reads ` +
        `parsedFiles). run.ts calls resolveImportTarget with five arguments and this bench must ` +
        `too. Deterministic: a re-run will not change it.`,
    );
  }
  // ONE loop for every arm's corpus shape, timing and heap alike. The heap arm
  // was reported here and asserted nowhere, which made the four fields that
  // decide WHAT it measures free to move: `HEAP_PROBE_TARGET.csharp_csproj`
  // swapped for a target matching no `CSPROJ_CONFIGS` rootNamespace skips the
  // whole config loop, so the `getFilesInDir` and `getInsensitive` legs never
  // run, and the arm the MEMORY section calls "the witness that the read
  // pattern IS the footprint" quietly becomes a two-map arm — measured
  // 73 703 384 -> 59 921 216 B, ratio 1.017 -> 1.011, ceiling and floor both
  // still passing. `HEAP_SMALL` set equal to `HEAP_LARGE` is the same shape of
  // hole: it makes `ratio` identically ~1.0 and leaves `bytes_large` untouched.
  for (const [arm, shape] of armShapes(lang)) {
    for (const field of shape.fields) {
      if (got[arm][field] !== want[arm]?.[field]) {
        failures.push(
          `${lang}.${arm}.${field}: ${got[arm][field]} != ${want[arm]?.[field]} — ${shape.why}`,
        );
      }
    }
  }
}

// PRESENCE FIRST for the two SCALAR heap budgets, for exactly the reason the
// five timing budgets get it — and the reason the comment up there used to give
// for the heap arm not needing it was wrong. Iterating the baseline's keys
// protects the loop below against a deleted MEASUREMENT (`heap == null`, right
// there); it does nothing about a deleted BUDGET. These two keys are scalars
// rather than per-language maps, so deleting either is one keystroke that
// silently disables that arm for ALL EIGHT languages at once. That makes them
// the widest-blast-radius keys in this file, not the safest — which is what
// their `scope` sentence says and the per-language ones do not.
const heapBudgetChecks = [
  { key: 'heap_floor_fraction', value: baseline.heap_floor_fraction, reads: 'bytes_large < NaN' },
  { key: 'heap_ratio_budget', value: baseline.heap_ratio_budget, reads: 'ratio > undefined' },
];
const heapArmScope = `This one key gates all ${HEAP_BUDGETED.length} budgeted heap arms at once.`;
for (const check of heapBudgetChecks) {
  const missing = requireNumericBudget({ ...check, scope: heapArmScope });
  if (missing !== null) failures.push(missing);
}

// And EXACT KEY EQUALITY between each tier's CODE list and the baseline maps
// that gate it, because the loops below iterate the baseline: delete one
// language's ceiling and that language drops out of the loop entirely — still
// measured, still printed, never checked. Both directions, the same shape as the
// LANG_REGISTRY/SCOPE_RESOLVERS inventory arm at the bottom of the file. The
// forward direction (a language with no budget) is the per-language presence
// check inside each loop; this is the reverse (a budget with no arm).
//
// Three maps rather than two: `heap_bound_bytes` is reconciled against
// `HEAP_BOUNDED` exactly as the other two are against `HEAP_BUDGETED`, so a
// language promoted from bounded to budgeted has to move its key in the same
// edit — leave the bound behind and it is an orphan here, take the bound away
// without adding a ceiling and the presence check fires there.
const heapBudgetMaps = [
  ['heap_ceiling_bytes', baseline.heap_ceiling_bytes, HEAP_BUDGETED, 'HEAP_BUDGETED'],
  ['heap_reading_bytes', baseline.heap_reading_bytes, HEAP_BUDGETED, 'HEAP_BUDGETED'],
  ['heap_bound_bytes', baseline.heap_bound_bytes, HEAP_BOUNDED, 'HEAP_BOUNDED'],
];
for (const [key, map, codeList, codeListName] of heapBudgetMaps) {
  expectNoOrphanKeys(
    `baselines.json ${key}`,
    Object.keys(map ?? {}),
    codeList,
    codeListName,
    'the bench budgets a heap arm it does not measure.',
  );
}

// The two heap tiers are a PARTITION of LANGS by construction (`HEAP_BOUNDED`
// is a filter over it), so the only way a name can be in neither is for
// `HEAP_BUDGETED` to hold one `LANGS` does not — a typo, or a language dropped
// from the registry with its budget left behind. That name would then be
// measured by nothing, and the loop below would report it as a missing arm
// without ever saying why; this says why.
expectNoOrphanKeys(
  'HEAP_BUDGETED',
  HEAP_BUDGETED,
  LANGS,
  'LANGS',
  'that name is in neither heap tier, because HEAP_BOUNDED is derived as the languages LANGS ' +
    'has and this list does not — so its budget gates nothing and its language, if it has one, ' +
    'is bounded by nothing.',
);
// The same, for the probe map. The forward direction — a language with no probe
// — is caught by the `heap.probe` shape assertion (`undefined` never equals a
// recorded string), so what is left is a probe kept for an arm that no longer
// runs, which reads as coverage and is not.
expectNoOrphanKeys(
  'HEAP_PROBE_TARGET',
  Object.keys(HEAP_PROBE_TARGET),
  LANGS,
  'LANGS',
  'the bench carries a heap probe for a language it does not benchmark.',
);

// The same reverse direction for the context arm. The forward direction (a
// language in CONTEXT_LANGS with no baseline block) is `armShapes`, which
// compares against `want.context?.[field]` and fails on undefined; this is the
// other way round — a baseline block for a language the bench hands no context
// is a gate over an arm that is never measured, and `armShapes` would never
// look at it.
expectNoOrphanKeys(
  'baselines.json languages.*.context',
  Object.keys(baseline.languages).filter((lang) => baseline.languages[lang].context !== undefined),
  CONTEXT_LANGS,
  'CONTEXT_LANGS',
  'the bench pins an arm it does not run.',
);

// TIER ONE, the budgeted arms: ceiling, floor and ratio, all three unchanged.
//
// Driven by HEAP_BUDGETED, the CODE's list, exactly as the timing arms iterate
// LANGS — so a deleted budget key is a presence failure rather than a language
// that quietly stops being iterated. A deleted MEASUREMENT still fails too:
// `measureHeap` now runs for every language, so a `heap == null` here is the arm
// having been removed or skipped.
for (const lang of HEAP_BUDGETED) {
  const ceiling = baseline.heap_ceiling_bytes?.[lang];
  const reading = baseline.heap_reading_bytes?.[lang];
  // `reads` names the comparison each key gates further down: the ceiling is
  // compared directly, the reading only after `reading * heap_floor_fraction`
  // has turned a missing one into `NaN`.
  for (const [key, value, reads] of [
    ['heap_ceiling_bytes', ceiling, 'bytes_large > undefined'],
    ['heap_reading_bytes', reading, 'bytes_large < NaN'],
  ]) {
    const missing = requireNumericBudget({
      key: `${key}.${lang}`,
      value,
      reads,
      scope:
        `This loop iterates HEAP_BUDGETED precisely so that deleting the key fails here instead ` +
        `of dropping ${lang} out of the gate.`,
    });
    if (missing !== null) failures.push(`${lang}: ${missing}`);
  }
  const heap = report[lang]?.heap;
  if (heap == null) {
    failures.push(
      `${lang}: heap arm missing though HEAP_BUDGETED names it — the retained-index measurement ` +
        `was removed or skipped. It is the only arm that can see memory.`,
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
  // Taken as a fraction of the RECORDED READING, not of the ceiling. It used to
  // be 0.33 x the ceiling, with the comment claiming that put it "at half the
  // measured size" — true only for as long as every ceiling stayed at exactly
  // 1.5x its reading, which is a convention this file states and nothing
  // enforces. Re-tuning one ceiling upward would have loosened that language's
  // floor by the same factor, in the one direction the floor exists to watch.
  // 0.5 x the reading is the same effective floor today (within 0.8% for all
  // eight) and says what it means. `heap_reading_bytes` is the measurement the
  // ceiling is derived from too, so the pair still moves together on a
  // re-baseline — far below any plausible drift (the readings reproduce to the
  // byte across processes) and far above the collapse it watches for. A genuine
  // 2x memory WIN trips it too, and that is intended: it must be explained and
  // re-baselined, exactly like a fingerprint move.
  const floor = reading * baseline.heap_floor_fraction;
  if (heap.bytes_large < floor) {
    failures.push(
      `${lang}: retained per-pass import index ${heap.bytes_large} B at ${heap.files_large} ` +
        `files < floor ${Math.round(floor)} B (${baseline.heap_floor_fraction} x recorded ` +
        `reading ${reading}) — this arm has almost certainly stopped MEASURING rather than started ` +
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

/**
 * TIER TWO, the bounded arms: ONE comparison, and what it is a comparison FOR.
 *
 * `heap_bound_bytes` is the "exclusion still holds" bound. It does not claim
 * these indexes are small enough, which is what a ceiling claims about a
 * budgeted one; it claims each is still the SIZE the decision to leave it out
 * was taken on. `HEAP_BOUNDED` derives to SEVEN today — cobol, swift, rust,
 * the ts family (#2953), and zig, which reads what rust reads (16 B) because
 * `resolveZigImportInternal` builds nothing and takes rust's absolute bound.
 * The prose below still counts nine because six were promoted to tier one
 * after it was written; read the counts as history, and `HEAP_BOUNDED` itself
 * as the answer. The re-entry condition the MEMORY section states — "if any of
 * the four ever diverges in what it ASKS, it earns an arm the same way" — is a
 * claim about growth, and this is the only thing in the file that can see it.
 *
 * NO FLOOR, and the reason is per language rather than uniform. rust (and zig)
 * reads 16 B because it builds nothing, so any floor at all would be a floor
 * on noise and `1.5 x 0 B` is 0 — its bound is ABSOLUTE (1 MiB) for the same
 * reason: a multiplier on 16 B fails on the first byte of anything. The other eight are
 * stable enough today to floor (0.24% peak-to-peak at worst over five runs).
 * The two this paragraph named as floor candidates, kotlin and dart, TOOK that
 * promotion: both now carry a ceiling and a recorded reading in tier one, which
 * is what the paragraph said the promotion had to be. What this tier is NOT is a
 * weaker version of tier one — it is a different question, asked of the
 * languages tier one does not ask it of.
 */
const heapBoundScope =
  `That leaves the arm bounded by nothing, which is the state all nine of these were in before ` +
  `they were measured.`;
for (const lang of HEAP_BOUNDED) {
  const bound = baseline.heap_bound_bytes?.[lang];
  const missing = requireNumericBudget({
    key: `heap_bound_bytes.${lang}`,
    value: bound,
    reads: 'bytes_large > undefined',
    scope: heapBoundScope,
  });
  if (missing !== null) failures.push(`${lang}: ${missing}`);
  const heap = report[lang]?.heap;
  if (heap == null) {
    failures.push(
      `${lang}: heap arm missing though HEAP_BOUNDED names it — every registered language is ` +
        `measured now, and the tier only decides which gate the reading gets.`,
    );
    continue;
  }
  if (missing === null && heap.bytes_large > bound) {
    failures.push(
      `${lang}: retained per-pass import index ${heap.mib_large} MiB at ${heap.files_large} ` +
        `files (${heap.bytes_large} B) > bound ${bound} B — this language is EXCLUDED from the ` +
        `budgeted heap tier, and the bound is what says the exclusion still holds. It has grown ` +
        `a structure, or started asking its index a question it did not ask when the exclusion ` +
        `was recorded. Read _heap_bound_note in baselines.json for this language's reason and ` +
        `its recorded reading, then either explain the growth or promote it to HEAP_BUDGETED ` +
        `with a ceiling, a reading and a floor. Deterministic: a re-run will not change it.`,
    );
  }
}

// INVENTORY, the arm that makes "every registered language is gated" a checked
// claim instead of a comment. `LANG_REGISTRY` is a hand-written table — it has
// to be, since each row also implies five dispatcher branches — but which
// languages it must contain is not a judgement call, and this is where the two
// are reconciled. Both directions: a resolver registered with no arm here is
// the PR #2911 hole (a language shipping unmeasured), and an arm naming a
// language the registry does not have is a bench measuring something the
// pipeline no longer runs.
//
// Loaded HERE, after the last measurement, rather than imported at the top.
// Reaching `pipeline/registry.ts` drags in every registered scope resolver and
// its providers, and this arm is the only thing in the file that wants it. The
// side benefit is that both modes now measure in the same module state: report
// mode never loads the registry, and `--check` loads it only once every number
// has been taken.
//
// It is NOT cheap and the header says so plainly rather than rounding it down:
// 6.3-6.5 s on one box and 9.3-10.0 s on another, measured in isolation with
// this file's own static imports already resident, which is most of the
// `repsFor` win and the whole reason `--check` did not get faster. Kept anyway,
// because the `benchmarks` job runs ~4.5 minutes clear of CI's critical path,
// so the seconds buy nothing, and because the alternative reconciles arm NAMES
// where this reconciles the `SupportedLanguages` values the dispatchers key
// off. See COST in the header.
const { SCOPE_RESOLVERS } =
  await import('../../src/core/ingestion/scope-resolution/pipeline/registry.ts');
const registeredLanguages = [...SCOPE_RESOLVERS.keys()].sort();
const benchedLanguages = [...new Set(Object.values(LANG_REGISTRY))].sort();
for (const language of registeredLanguages) {
  if (benchedLanguages.includes(language)) continue;
  failures.push(
    `${language} is registered in SCOPE_RESOLVERS but has no arm in LANG_REGISTRY — its ` +
      `import-target resolver is ungated: nothing pins its output and nothing pins its scaling. ` +
      `That is the state JavaScript was in at 25 972 µs per import (PR #2911). Add a row, then ` +
      `the five dispatcher branches it needs (uniqueDir, collideDir, uniqueTarget, collideTarget, ` +
      `resolveOne) and a baselines.json entry. Deterministic: a re-run will not change it.`,
  );
}
// The reverse half is the same loop as the two above it, so it goes through the
// same helper. Only the FORWARD half stays written out: its message is a
// five-step remediation for adding a language, which no shared framing carries.
expectNoOrphanKeys(
  'LANG_REGISTRY',
  benchedLanguages,
  registeredLanguages,
  'SCOPE_RESOLVERS',
  'this bench is gating a resolver the pipeline no longer registers.',
);

// The SAME reconciliation for `CONTEXT_LANGS`, against the registry rather than
// against a claim in a comment. `run.ts` passes the fifth argument to every
// provider; which ones can OBSERVE it is decided by how many parameters each
// hook declares, and that is a number the registry can be asked for. Today
// exactly four answer 5 (php, java, kotlin, python) and the other thirteen answer 3 or 4 —
// which is why thirteen arms can ignore this whole question and their numbers
// did not move when it was fixed.
//
// `Function.length` stops at the first defaulted or rest parameter, so a hook
// written as `(a, b, c, d, context = {})` would read 4 and slip past this arm.
// The shared contract declares the parameter as `context?:`, which compiles to
// a plain parameter, so every resolver written against it counts — and one that
// is not is one this arm asks you to look at.
const CONTEXT_PARAM_COUNT = 5;
const contextLanguages = new Set(CONTEXT_LANGS.map((lang) => LANG_REGISTRY[lang]));
for (const [language, resolver] of SCOPE_RESOLVERS) {
  const declares = resolver.resolveImportTarget.length >= CONTEXT_PARAM_COUNT;
  const benched = contextLanguages.has(language);
  if (declares === benched) continue;
  failures.push(
    declares
      ? `${language}'s resolveImportTarget declares ${resolver.resolveImportTarget.length} ` +
          `parameters, so it can read the { parsedFiles, parsedImport } context run.ts passes, ` +
          `but no arm here supplies one — that leg is measured by nothing. Add the language to ` +
          `CONTEXT_LANGS, thread the context in resolveOne, and give it a CONTEXT_PROBE whose ` +
          `two answers differ. Deterministic: a re-run will not change it.`
      : `CONTEXT_LANGS names '${language}', whose resolveImportTarget declares only ` +
          `${resolver.resolveImportTarget.length} parameters — it cannot observe a context, so ` +
          `this bench is building a ParsedFile[] per pass that nothing reads and asserting a ` +
          `context arm that cannot fail. Deterministic: a re-run will not change it.`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[import-target --check] PASS');
