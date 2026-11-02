# Analyze phase breakdown — where the time actually goes

Updated 2026-11-01 with scope-emission measurements after #3796 merged, plus
production-hardening measurements on LadybugDB **0.22.0** for unchanged dirty checkouts.
Records what the `analyze`
pipeline costs per phase and the results of optimization experiments.
The September measurements remain below as historical
evidence; the corpus and analyzer have changed, so they are not a controlled
before/after comparison.

Unlike `parse-throughput.md` (a synthetic-fixture scaffold), these numbers come
from a real repo corpus. They are not a CI gate; the gate for the parse
dispatch path is `bench/parse-dispatch-rounds/`.

---

## Current measurements — 2026-10-31

### Environment and timing boundaries

- Analyzer and corpus: main at `82966afa64ec0cbd0e09084cf7af89067ccf0c2d`.
  Built once with `npm ci`; no changes to the build between samples.
- Dependencies: `@ladybugdb/core` **0.22.0**, packaged FTS **0.22.0**,
  `tree-sitter` **0.25.1**. Node **v22.23.3**, Linux x64, Intel Core i9-12900K,
  24 logical CPUs, about 31.2 GiB RAM. This is a shared development host.
- Corpus: a detached git checkout of that commit, **7,726 tracked paths**,
  **3,353 indexed files**, **3,090 parseable files** in **276 chunks**.
  Both runtime and corpus are on local `/tmp` overlay storage, outside the
  workspace's 9p mount. Index storage and GitNexus home are disposable and
  isolated; shared-store reuse is disabled.
- Options: 16 workers, 8 GiB parent V8 heap limit, full content retention and
  FTS, no embeddings or PDG, `skipAgentsMd: true`, `skipSkills: true`,
  `verbose: true`. No `force` flag. Other analysis limits retain their defaults.
- Total is wall time around `await runFullAnalysis(...)`, after importing the
  analyzer. It excludes CLI startup, the analyzer import, post-run graph
  hashing, and process shutdown. Each sample runs in a new Node process.
- "Fresh" means no index or parse cache. OS filesystem caches were not flushed;
  an earlier setup run had already read the corpus. That run disabled FTS with
  `GITNEXUS_LBUG_EXTENSION_INSTALL=never` and is excluded from the results.
  Valid runs use `load-only`, which successfully loads the packaged extension
  without downloading it.

Pipeline timings use the existing `NODE_ENV=development` phase logs.
`PROF_SCOPE_RESOLUTION=1` supplies per-language internals and `PROF_LBUG_LOAD=1`
supplies the graph-load interval. FTS is timed from the `fts` progress callback
at 85% to `Search indexes ready` at 90%; verbose callbacks also time each index.
All samples use this same instrumentation. The residual is total time minus
these intervals and the remaining pipeline phases; it is not a CPU profile.
The parse interval includes cache hydration and worker startup; graph loading
includes CSV emission and native COPY. Neither isolates JavaScript CPU time.

### Fresh index, one-file edits, and unchanged controls

Run order: one fresh index, an unchanged clean-checkout control, three successive
one-file edits, then a repeat with **no further edit** to the dirty checkout.
The edit replaces `gitnexus/src/cli/update-notice.ts` with its pristine contents
plus `\n// phase-breakdown trial N\n`, for `N = 1, 2, 3`. These are uncommitted,
comment-only changes; they measure the smallest edit path, not API changes,
deletions, or large change sets.

All values below are seconds. Each column is one complete sample; rounding can
make the components differ from the total by 1ms.

| Step                             |       Fresh |      Edit 1 |      Edit 2 |      Edit 3 | Dirty repeat |
| -------------------------------- | ----------: | ----------: | ----------: | ----------: | -----------: |
| **Total**                        | **166.015** | **120.361** | **122.634** | **126.342** |  **110.820** |
| Parsing                          |      62.823 |       6.598 |       6.995 |       6.750 |        6.748 |
| Scope resolution                 |      70.335 |      73.987 |      75.941 |      77.268 |       87.054 |
| Graph load                       |      10.145 |       5.141 |       5.251 |       4.813 |        0.007 |
| FTS                              |      16.072 |      12.792 |      13.095 |      15.731 |        0.510 |
| Other pipeline phases            |       3.143 |       3.307 |       3.255 |       3.308 |        1.025 |
| Residual outside those intervals |       3.498 |      18.536 |      18.097 |      18.472 |       15.476 |

The edit median is **122.634s**, range **120.361–126.342s**, with three samples
on a shared host. This sequence measures the unmodified main baseline.

The graph contains **117,437 nodes / 352,781 relationships / 3,463 communities /
767 processes**. These reported counts matched across runs. The fresh index
built all **23** configured FTS indexes. Every edit reported:

- `changedFiles: 1`, `deletedFiles: 0`, `affectedDependents: 6`,
  `writeMode: "incremental"`, and no rebuild reasons.
- **22 files reparsed / 3,068 cached**; 273 chunk hits and 3 misses.
- A row-removal set of **71 paths**, followed by a load of **6,941 nodes /
  59,204 relationships**. The write set extends beyond the changed file and its
  six importer dependents.
- **9 FTS indexes rebuilt**: File, Function, Class, Method, Interface, TypeAlias,
  Const, Property, Route. In Edit 2, Function took **4.885s**, File **4.423s**,
  and the remaining seven indexes plus orchestration **3.786s**.

**The two unchanged controls behave differently.** Immediately after the fresh
index, the clean checkout returned `alreadyUpToDate: true` in **1.245s**, without
running the pipeline. Repeating analysis after Edit 3, with the same uncommitted
contents, took **110.820s** and did not return `alreadyUpToDate`. It reported
**zero changed files**, two reparsed files and 3,088 cache hits, but still spent
**87.054s in scope resolution**. Community/process phases were skipped, the
graph loader received zero nodes and relationships, and only `Class.class_fts`
was rebuilt. This is a measured dirty-worktree repeat, not a full-rebuild
fallback or another edit sample.

The fresh run and three edits also matched a filtered in-memory graph hash
(excluding node content, Folder/Community/Process nodes, and CONTAINS,
MEMBER_OF, STEP_IN_PROCESS edges). The dirty repeat skips derived graph phases
and is excluded from that comparison. This is not a persisted-graph or query
equivalence test. Runs emitted warnings for two dropped scope sites and for
callable-flow/process limits; the timings describe that default bounded
configuration, not complete graph coverage.

### Where the edit time goes now

In Edit 2, the sample with the median total, scope resolution is **61.9%** of
wall time. Summing the existing per-language profiler gives:

| Scope-resolution work                    |    Seconds |
| ---------------------------------------- | ---------: |
| `emit`                                   | **49.604** |
| `resolve`                                |      7.043 |
| Other work inside the internal timers    |      4.482 |
| Phase time outside those internal timers |     14.812 |
| **Whole phase**                          | **75.941** |

`emit` alone is **40.4% of the entire edit run**. TypeScript reports **2,865 /
2,865 pre-extracted hits** in every edit sample, yet resolution and emission
still process the corpus. The 14.812s outside the internal timers includes
ParsedFile loading and other phase work; it was not separately instrumented,
so it must not all be labeled rehydration.

The separate **18.097s run residual** includes work outside the pipeline,
graph-load and FTS timers, such as incremental deletion, reconciliation,
checkpoints, and publication. Those costs were not individually timed. The
graph-load profiler reports `mode=overlap`; its CSV and COPY subfields must not
be interpreted as separate CPU costs.

These measurements identified two targets: an early exit for an unchanged dirty
snapshot and reducing repeated scope emission. The early-exit experiment below
demonstrates a speedup for unchanged snapshots. Repeated scope emission remains
the target for actual edits. No scriptc build or alternate native-linking
strategy was measured; these results do not establish a compiler migration's
benefit.

### Experimental unchanged-dirty fast path — 2026-10-31

Candidate: `experiment/unchanged-dirty-fastpath`, based on the same main commit
`82966afa64ec0cbd0e09084cf7af89067ccf0c2d`. The production change is confined to
`src/core/run-analyze.ts`; native dependencies and the storage schema are
unchanged. This is an experimental result, not a released optimization.

Each variant used its own runtime, corpus checkout, index, and GitNexus home.
Both corpora started with the identical comment-only edit from Edit 3 above.
Both indexes were seeded before timing, with stable runner identities throughout
the measured sequence. Setup runs, including the candidate's rebuild after a
code revision, are excluded. Hardware, options, instrumentation, and timing
boundaries match the baseline section. Our regression tests started after the
timing runs; other workloads on the shared host were not isolated.

Run order was candidate 1, baseline 1, baseline 2, candidate 2, candidate 3,
baseline 3. Each run used a new Node process and made no source change.

| Unchanged dirty snapshot | Main baseline (s) | Candidate (s) |
| ------------------------ | ----------------: | ------------: |
| Sample 1                 |           102.494 |         1.657 |
| Sample 2                 |           101.905 |         1.640 |
| Sample 3                 |           102.688 |         1.552 |
| **Median**               |       **102.494** |     **1.640** |

The ratio of medians is **62.50×**, a **98.40% reduction** in elapsed analysis
time for this workload. All three baseline runs reported zero changed files,
but ran the pipeline and rewrote the database. All three candidate runs returned
`alreadyUpToDate: true` without a pipeline result. SHA-256 of the complete
LadybugDB file was identical before and after each candidate run. Reported graph
counts remained **117,437 nodes / 352,781 relationships** in both variants.

The candidate retains the existing rebuild and configuration gates. For an
eligible dirty checkout, it verifies the recorded dirty files, enumerates the
current covered paths, and compares their content hashes with the indexed
snapshot. Missing or changed bytes, coverage changes, scan failures, incomplete
scope receipts, and unknown dirty paths fall through to analysis. The full
coverage check also catches edits hidden by Git's `assume-unchanged` flag.
This deliberately conservative path does not accelerate every dirty checkout,
including snapshots containing deleted or unindexed dirty paths.

For a functional control, both corpora then received the same new exported
function and unique search token in `gitnexus/src/cli/update-notice.ts`. Baseline
took **168.291s**, candidate **149.265s**. Each reported one changed file,
22 reparsed files, 3,068 cached files, an incremental write, and no rebuild
reasons. Both produced **117,438 nodes / 352,782 relationships**, with matching
filtered in-memory graph hashes under the exclusions documented above.
Read-only queries against the persisted databases also returned identical
results: the new function and its location, one File FTS hit for the token, and
all **34** Function-to-Function call edges touching the edited file, including
confidence and reason. These are targeted checks, not exhaustive graph equality.

This real-edit pair is **not evidence of an edit speedup**: it has one sample per
variant and the shared host's one-minute load rose from 5.62 to 13.85 during the
baseline run. Repeating the candidate after that edit took **1.821s**, returned
already up to date, and again preserved the database bytes.

Validation covered **158 targeted tests across seven files**, including **13 new
fast-path cases** for native FTS/database preservation, real edits, additions,
deletions, renames, partial reverts, hidden edits, scan-policy changes, recovery,
and scan failures. The initial run passed 136 tests; 22 existing cases failed
with changing-runtime guards or incomplete reads of compiled JavaScript. All
22 passed when rerun in a fresh runtime copy with identical source. Hashes of
all **2,340 compiled build files** stayed unchanged throughout that rerun.
The build, `tsc --noEmit`, formatting, and diff checks passed; targeted ESLint
reported no errors. This was targeted validation, not the full repository suite.

To reproduce, seed each variant independently with the same dirty source, then
use the harness below in separate processes with no further edits. Keep the
runtime fixed after seeding. Record `alreadyUpToDate`, rebuild reasons, graph
counts, and a database-file hash before/after each repeat. Follow with the same
real edit in both corpora and verify persisted symbol, call-edge, and FTS results.
Do not combine these no-op timings with the actual-edit baseline.

### Production hardening — 2026-11-01

Review found a freshness race in the experiment: per-file hashes were read from
disk after parsing. A file edited between parsing and hashing could therefore
have a new hash beside an older graph; the next dirty repeat incorrectly returned
already up to date. A regression test reproduced that behavior before the fix.

Git repositories now capture hashes before parsing and retain only paths that
the pipeline actually indexed. An edit during analysis differs from that receipt
on the next run, which reconciles the graph before allowing another unchanged
repeat. This moves the existing content-hash pass and adds a path-only scan; it
does not introduce another full-content hashing pass. The analyzer still reads a
live working tree, not an atomic filesystem snapshot.

The dedicated native integration suite, `test/integration/analyze-dirty-snapshot.test.ts`,
covers both fresh and incremental versions of the race, as well as the original
fast-path and fallback cases. It is registered in the sequential LadybugDB
project and in the Windows/macOS CI subset. Database preservation uses an exact
byte comparison; the FTS check fails rather than skips when CI requires FTS.

The hardened build was reseeded and measured against the same pinned main
runtime, with three unchanged dirty repeats per variant. The corpora retained
the identical exported function from the October functional control, so both
contained **117,438 nodes / 352,782 relationships**. The seed rebuild took
150.305s and is excluded. Options and timing boundaries are unchanged.

| Unchanged dirty snapshot | Main baseline (s) | Hardened candidate (s) |
| ------------------------ | ----------------: | ---------------------: |
| Sample 1                 |           134.649 |                  2.200 |
| Sample 2                 |           127.837 |                  1.868 |
| Sample 3                 |           101.765 |                  1.960 |
| **Median**               |       **127.837** |              **1.960** |

This is **65.21×** by ratio of medians (**98.47% less elapsed time**). Every
candidate repeat returned already up to date without running the pipeline and
preserved the complete database file's SHA-256. All six runs retained native
FTS and matched graph counts. Run order was candidate, baseline, baseline,
candidate, candidate, baseline. Other validation ran on the same host; observed
one-minute load ranged from 9.23 to 16.69. These results confirm the benefit for
unchanged dirty repeats, not a speedup for real edits or an improvement over the
October speedup ratio.

A subsequent real-edit control added the same exported function and search
token to both corpora. Main took **121.055s**, candidate **140.828s**. Both
reported one changed file, 22 reparsed files, six importer dependents, an
incremental write and no rebuild reasons. Filtered in-memory graph hashes and
the persisted new function, its File FTS hit, and all 34 call edges touching the
edited file matched. Counts were **117,439 nodes / 352,783 relationships**.
The next candidate repeat returned already up to date in **1.545s**.

The candidate was slower in this single real-edit pair. Scope-resolution time
was 73.939s on main and 91.838s on the candidate, accounting for most of the
19.773s difference; the first pipeline progress event arrived at 0.923s and
1.569s respectively. Those phase timings locate the difference, but do not
establish its cause. Host load changed and this pair has one sample per
variant: neither a real-edit speedup nor a stable regression is established.

### Scope-emission experiment after #3796 — 2026-11-01

Baseline runtime and corpus: merged main at
`568ebdc1d9e6fce80a4da306bcb1ecebb20b60e4`. This includes the dirty-snapshot
shortcut and the intervening Java overload changes. The corpus now has **3,375
indexed files**, **3,111 parseable files**, **118,517 nodes / 356,369 relationships /
3,495 communities / 767 processes**. These measurements form a new paired
comparison; the earlier corpus timings are not its baseline.

A separate Node CPU profile of a one-file edit identified repeated namespace
lookups inside receiver-bound call emission. The main-thread profile recorded
**29.6s in garbage collection**, **21.7s inclusive in `emitReceiverBoundCalls`**,
and **6.2s inclusive in `collectNamespaceTargets`**. Those intervals overlap and
must not be added. The profile includes startup and post-run graph hashing;
its **140.158s** analysis run is excluded from the timing comparison below.

The candidate adds a proof to `createNamespaceTargetCache`: while traversing a
file's scopes, record whether any resolved namespace import could produce a
target. If that traversal is complete and has none, return one empty map for
covered scopes instead of repeatedly resolving named imports and rebuilding
empty maps. The lexical receiver-position policy remains unchanged. Incomplete
scope views and lookups outside the traversed scopes retain the existing path.
This changes no native bindings, dependencies, public flags or graph schema.

Each runtime and corpus has its own index and stable runner identity. Both are
on local overlay storage. The first use of the separate baseline runtime caused
an identity rebuild; that setup run is excluded. Candidate seeding is also
excluded. The timer, options and instrumentation match the method above:
Node **22.23.3**, LadybugDB/FTS **0.22.0**, Tree-sitter **0.25.1**, 16 workers,
8 GiB parent heap limit, full retention and FTS, no embeddings or PDG. CPU
profiling is disabled for every sample in the table.

Each edit replaces `gitnexus/src/cli/update-notice.ts` with its pristine contents
plus `\n// scope-emission profile trial N\n`, for `N = 3, 4, 5`. These measure the
smallest one-file edit path. Run order is baseline 1, candidate 1, candidate 2,
baseline 2, baseline 3, candidate 3. No local test suite runs alongside them.
The host remains shared; one-minute loads recorded before and after the samples
range from **1.67 to 4.51**.

| One-file edit | Main baseline (s) | Candidate (s) |
| ------------- | ----------------: | ------------: |
| Sample 1      |           122.120 |       111.554 |
| Sample 2      |           126.536 |       114.429 |
| Sample 3      |           124.307 |       116.258 |
| **Median**    |       **124.307** |   **114.429** |

The ratio of medians is **1.086×**, or **7.95% less elapsed time**. Every paired
candidate sample is faster. This is an edit-path improvement; the earlier 65×
result measures unchanged dirty repeats.

Independent medians of the existing phase timers locate the reduction:

| Interval                                                  | Main baseline (s) | Candidate (s) |
| --------------------------------------------------------- | ----------------: | ------------: |
| Scope resolution                                          |            77.028 |        66.340 |
| `emit`, summed across languages (inside scope resolution) |            50.616 |        38.961 |
| Parsing                                                   |             6.995 |         6.966 |
| Graph load                                                |             5.044 |         5.179 |
| FTS                                                       |            13.041 |        12.510 |

All six runs reported **one changed file**, **22 reparsed / 3,089 cached files**,
six importer dependents, an incremental write, no rebuild reasons, and available
native FTS. Their reported graph counts and filtered in-memory node/relationship
hashes matched exactly under the exclusions defined above. The same default
bounded-analysis configuration applies; this is not exhaustive persisted-graph
equivalence or a claim about every repository, language mix or change-set size.

A functional control then added two exported functions, one calling the other,
and a unique search token to the same file in both corpora. Both produced
**118,519 nodes / 356,372 relationships** and matching filtered graph hashes.
Read-only native queries returned identical function IDs and source spans, the
same File FTS hit, and all **35** Function-to-Function call edges touching the
file, including confidence and reason. The new caller-to-callee edge was present
with confidence **0.85** and reason `local-call`. This control took 138.832s on
main and 117.450s on the candidate; it is one pair and is excluded from the
comment-edit medians above.

### Reproducing the timing boundaries

Use separate runtime and corpus checkouts of the pinned commit on local storage.
Build the runtime once with `npm ci`, then leave `dist` and dependencies unchanged.
Use a fresh corpus index for the first sample; retain that index and its parse
cache for the unchanged and edit samples. Set `BENCH_ROOT` to an isolated scratch
directory and `CORPUS` to the git checkout's absolute path. From the runtime's
`gitnexus/` directory, this collects the same timing boundaries:

```bash
mkdir -p "$BENCH_ROOT/home" "$BENCH_ROOT/xdg"
NODE_ENV=development PROF_SCOPE_RESOLUTION=1 PROF_LBUG_LOAD=1 \
GITNEXUS_HOME="$BENCH_ROOT/home" XDG_RUNTIME_DIR="$BENCH_ROOT/xdg" \
GITNEXUS_SHARED_STORE=off GITNEXUS_LBUG_EXTENSION_INSTALL=load-only \
node --max-old-space-size=8192 --input-type=module - "$CORPUS" <<'JS'
import { performance } from 'node:perf_hooks';
import { runFullAnalysis } from './dist/core/run-analyze.js';
const start = performance.now();
const events = [];
const result = await runFullAnalysis(process.argv[2], {
  skipAgentsMd: true, skipSkills: true, workerPoolSize: 16, verbose: true,
}, {
  onProgress(phase, percent, message) {
    events.push({ ms: performance.now() - start, phase, percent, message });
  },
  onLog(message) {
    events.push({ ms: performance.now() - start, message });
  },
});
const wallMs = performance.now() - start;
console.log(JSON.stringify({
  wallMs, events, stats: result.stats, incrementalStats: result.incrementalStats,
  alreadyUpToDate: result.alreadyUpToDate, rebuildReasons: result.rebuildReasons,
  ftsSkipped: result.ftsSkipped,
  reparsedFiles: result.pipelineResult?.reparsedFileCount,
  cachedFiles: result.pipelineResult?.parseCacheHitFileCount,
}));
JS
```

Capture stdout and stderr for each sample. Reject an edit sample if it has
rebuild reasons, reports a full write, or skips FTS. The clean unchanged control
must return `alreadyUpToDate: true`; record the dirty repeat separately. Do not
reuse `--force` to measure edits, change the runtime between samples, or compare
a no-op with an actual edit.

## Historical measurements — 2026-09-06/07

The following measurements were taken while landing #3194, #3196 and #3200.
Their optimization experiments have not been repeated against the October
corpus or LadybugDB 0.22.0. Claims about limits and rejected approaches below
describe that September baseline.

### Method, and one trap that invalidates everything

**The corpus must be a git repository.** A non-git checkout cannot record a
schema fingerprint, so the tool forces a full rebuild on every run and prints:

> `non-git repositories never record a schema fingerprint, so this run rebuilds regardless`

A "warm" run measured that way is a forced cold rebuild wearing a warm label. A
37.7s figure was recorded that way during this work and was meaningless. On a
real git repo an unchanged re-analyze short-circuits to `Already up to date`.

**And the analyzer binary must not change between runs.** Rebuilding or
re-copying `dist` changes the runner identity, and the tool then prints:

> `analyzer runner identity changed ...; forcing a full rebuild so the index
provenance matches the analyzer`

Every run after a rebuild is a full rebuild. To measure the incremental path,
run once to stamp the identity, then edit and run again **without touching
`dist`**. An earlier revision of this document reported full-rebuild numbers as
if they were incremental for exactly this reason; they are corrected below.

**And a mark on an `await` is not a mark on that call.** The post-pipeline tail
was timed by injecting timestamp marks into a disposable `dist`. An `await` that
directly follows native work also absorbs whatever libuv still had queued, so
the cost lands on the wrong line — that is how 845ms ended up attributed to a
dynamic import that actually costs 0.035ms. Sanity-check any mark that lands on
a call with no plausible work in it.

That is three separate "silently fall back to full work" guards — non-git
corpus, runner identity, and the escalation gate. Read the banner on every run
before trusting a number.

Corpus: this repository, `git archive` of HEAD into a scratch dir, then
`git init && git add -A && git commit`. 5350 paths, 2234 parseable, ~30MB.
16 workers, `dist` on a local overlay filesystem (see "Filesystem" below).
Phase numbers come from the `✓ Phase: <name> (<ms>)` lines under
`NODE_ENV=development`; the post-pipeline tail has no such lines and was
measured by injecting timestamp marks into a disposable copy of the built
`dist`.

---

### Cold analyze

|                  | before #3194 | after #3196 |
| ---------------- | -----------: | ----------: |
| total            |       110.3s |   **63.6s** |
| parse            |        74.0s |       36.0s |
| scopeResolution  |        17.0s |       16.0s |
| all other phases |         1.2s |        1.2s |
| dispatches       |          221 |          15 |

Graph output identical throughout: 51,286 nodes / 163,092 edges / 2106 clusters
/ 759 flows.

### Re-analyze after a one-file edit — the developer loop

Leaf file (`cli/update-notice.ts`, 2 importers), stable runner identity, so the
incremental path is genuinely taken. **31.7s total.**

| step                                                  |       ms |   share |
| ----------------------------------------------------- | -------: | ------: |
| scopeResolution                                       |   ~13900 |     44% |
| **FTS index rebuild** (`buildSearchIndexesOrDegrade`) | **7525** | **24%** |
| graph write (`loadGraphToLbug`, subgraph)             |     3566 |     11% |
| parse                                                 |    ~2800 |      9% |
| post-FTS event-loop drain (see below)                 |      845 |      3% |
| everything else                                       |    ~3000 |      9% |

The 845ms was originally recorded against `import('./platform/capabilities.js')`.
That import is not the cost: the CLI already imports the module statically, so a
cached dynamic import measures 0.035ms and `getRuntimeCapabilities()` 0.1ms. The
`await` there is the first yield after the native FTS build, so it absorbs
whatever libuv work was still queued. Any mark placed on an `await` immediately
after native work charges that work to the wrong line.

The incremental machinery works: the graph write was a 3,980-node subgraph, not
the full 51,288. **Everything the #3194/#3196 parse work optimized is ~9% of
this.**

A FULL-rebuild run of the same repo is 36-39s, with the graph write at ~6.3s and
FTS at ~9.7s. Do not quote those as edit-loop numbers.

### FTS index rebuild — the largest non-resolution cost, and it is a floor

A true incremental leaf edit rebuilds **8** of the 20 configured indexes — the
tables the writeback actually DMLs. Per-index cost (measured against a copy of
the corpus index, `bench/` probe, reproduced within 2% of the in-analyze number):

```
 3541ms  File.file_fts        <- 47% of the incremental FTS cost on its own
 1696ms  Function.function_fts
  521ms  Method     506ms  Const      486ms  Property
  403ms  Interface  324ms  Class      291ms  TypeAlias
 ------
 7769ms  8 indexes   (in-analyze: 7525ms)
```

A FULL rebuild does all 20 and costs ~10.2s; the extra 12 indexes are only
~2.5s, so **the narrowing is already doing its job**. An earlier revision of
this document called the narrowing "inconsistent" because one run rebuilt 8 and
another 20 — the 20-index run was a forced full rebuild (the runner-identity
trap above), not a leaf edit. There is nothing to fix there.

`File.file_fts` dominates because File rows carry whole-file content: 2442 rows,
32.9 MB, and Ladybug tokenizes at ~9.8 MB/s.

#### Four ways out, all measured, all closed

**Narrow further — no.** The 8 tables are exactly the ones holding rows for the
6 files in the write set (1 changed + 5 importers). There is no fat.

**Build the indexes concurrently — impossible.** A second connection issuing
`CREATE_FTS_INDEX` fails immediately:

> `Cannot start a new write transaction in the system. Only one write transaction at a time is allowed in the system.`

Eight builds on one connection serialize exactly (7886ms concurrent vs 7769ms
serial).

**Raise the connection's thread count — no effect.** min-of-3 wall time at
4 / 8 / 16 / default(24) threads: 7298 / 7133 / 7109 / 7345 ms, inside the ~400ms
per-config spread. CPU burned does move — 8.8s / 9.7s / 11.8s / 13.6s — so the
default over-subscribes ~60% for nothing, but wall time is flat.

**Skip `File.file_fts` when content did not change — cannot happen.** Any file
edit changes a File row, and Ladybug's FTS is not incremental: an index built
before an insert does not see the new row, so a changed row forces a whole-table
rebuild. Dropping `content` from the index takes it 3541ms → **241ms**, but that
is deleting full-file keyword search (#2317/#2323), not optimizing it. Capping
the indexed content is a bad trade — the size distribution is flat, so a 64 KB
cap still indexes 90% of the bytes while truncating the 72 largest files.

#### The one lever left: overlap

The FTS build runs on a libuv thread, not the main thread, and fully overlaps
blocking JS:

```
index alone                    3859ms
index + 3000ms of JS burn      3337ms      (serial would be ~6859ms)
```

So the 3.5s File index could hide entirely behind the pipeline's ~17s of
main-thread JS. File rows are the only ones that make this possible: they are
`{ name, filePath }` from `processStructure`, with content lazy-read from disk at
CSV time, so they are fully determined by the file scan — before parsing, before
resolution.

Two things block it today, and neither is small:

1. The DB is **closed** for the whole pipeline (`closeLbug` before
   `runPipelineFromRepo`, `initLbug` after). An early File write means holding a
   write handle across the pipeline.
2. It moves `liveIndexMutationStarted` before the pipeline. A pipeline failure
   would then leave the live index with fresh File content and stale symbols,
   instead of untouched.

### scopeResolution — 14.7s, and it is two different problems

`PROF_SCOPE_RESOLUTION=1` already exists and reports the internal split. Marks
injected around the phase supply the rest. On a one-file edit:

| step                         |       ms |   share |
| ---------------------------- | -------: | ------: |
| ParsedFile store rehydration |     4426 |     30% |
| **`emit`**                   | **7161** | **49%** |
| `resolve`                    |      966 |      7% |
| `finalize`                   |      552 |      4% |
| `extract`                    |      369 |      3% |
| per-language teardown, misc  |     ~750 |      5% |

`extract` is small because the parse cache works: 2121/2121 pre-extracted hits
on the TypeScript pass. Nothing here re-parses.

#### Rehydration: three full store scans, one per language

The corpus resolves three languages — python (54 files), typescript (2121),
javascript (59) — and `loadParsedFilesForPaths` walks **every** shard on each
pass. The store is 413 shards / 301 MB. A pass that wants a single file costs
335 ms, because the skip decision needs the envelope's path listing and that
listing is only trustworthy after the payload digest is checked.

So the fixed cost is paid per language, and **it scales with language count**,
not with how many files that language has. Measured, min-of-5, three passes:

```
before   python 411ms   typescript 2872ms   javascript 507ms   = 3834ms
after    python 415ms   typescript 2805ms   javascript 248ms   = 3484ms
```

Memoizing each shard's authenticated listing for the run removes the repeat
scans (−350 ms here; roughly −250 ms per additional language elsewhere). The
first pass is unchanged by construction — it is what populates the memo.

What is left is a floor. The digest is **not** the cost: SHA-256 over all
301 MB takes 134 ms (2.25 GB/s, hardware-accelerated), so swapping it for
CRC-32 would buy ~90 ms and cost an envelope-format bump. The remainder is
`v8.deserialize` (~1240 ms) plus the cross-shard string intern walk
(~1085 ms), and the intern walk is not optional — dropping it regresses
retained heap ~59%, which is #2649's constraint.

#### `emit` is the real target

7.2s, 49% of the phase and ~21% of the whole edit loop. It is a fan of passes,
each walking every reference site in the repo:

```
1828ms  emitCallableValueFlow      480ms  emitFreeCallFallback
1590ms  emitReceiverBoundCalls     426ms  emitReferencesViaLookup
 681ms  resolveDefGraphId          313ms  emitUniqueNamePropertyAccesses
 529ms  lookupCore                 280ms  emitReturnShapeMemberAccesses
 472ms  tryEmitEdge                222ms  emitPropertyDispatchCalls
 449ms  getScope
```

No hot inner loop, nothing quadratic, no single pass worth more than 12% of the
phase. Micro-optimizing any of them is not the win.

The win is not running them. A one-file edit re-emits all 163,094 edges to
write a 3,980-node subgraph. Every pass above runs over all 2121 TypeScript
files because the pipeline rebuilds the full in-memory graph every run and only
the DB _write_ is incremental. Making `emit` incremental means knowing which
files' edges can change when one file's registry contribution changes — which
is a design, not a patch, and #2649 rules out "just cache the emitted edges".

---

### Measured and rejected

Recorded because each cost real time to establish and each looks attractive
from the armchair.

**More workers buys nothing.** Isolated-harness wall time at 16 / 20 / 24
workers: 44.1s / 44.8s / 43.3s — a 1.5s spread against a 3.7s within-size
spread. A full-analyze sweep appeared to show 20 beating 16 by 6.3s; it was
noise, and the sweep was invalid anyway because `GITNEXUS_WORKER_POOL_SIZE` was
silently clamped at the time (fixed in #3200). `DEFAULT_POOL_SIZE_CAP = 16`
stands.

**Bundling the worker entry buys ~250ms.** Worker boot profiled at 12.2s per
worker, of which `getPackageScopeConfig` 5.86s + `internalModuleStat` 3.14s +
`lstat`/`open` ~2.2s — ESM module resolution, not native grammars (all 11
`tree-sitter-*` imports together are 33ms) and not V8 compile (53ms;
`NODE_COMPILE_CACHE` gives zero gain). An esbuild bundle takes 16-worker boot
8.6s → 0.37s.

**That was a filesystem artifact.** On a normal overlay filesystem the same
boot is 515ms stock vs 263ms bundled — 0.2% of a 110s analyze. The 8.6s only
reproduces with the repo on a 9p mount (WSL2 `D:\`). Dropped.

Caveat carried by every number here: `dist` on a 9p mount costs ~3.5s of a 73s
run (73.0s vs 69.6s on overlay). Measure on a local filesystem.

---

### Open at the September baseline

The post-pipeline tail is fully accounted (99.7%): FTS rebuild, the graph write,
and 0.8s of post-FTS event-loop drain between them.

FTS is closed as an optimization target except for the overlap above, which is a
scheduling change to `run-analyze.ts`'s open/close discipline rather than
anything about FTS.

`scopeResolution` is now broken down. Its rehydration half has a floor and one
repeat-scan win that is taken. Its other half — `emit`, 7.2s — is the largest
remaining target in the whole edit loop, and the only way at it is incremental
resolution.

Every optimization in this document that looked compelling from the armchair
died under measurement. Measure first, and check the banner.
