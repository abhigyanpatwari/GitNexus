# Analyze phase breakdown — where the time actually goes

Measured 2026-09-06/07 while landing #3194, #3196 and #3200. Records what the
`analyze` pipeline costs per phase, and — as importantly — the optimizations
that were measured and **rejected**, so the next person does not re-derive them.

Unlike `parse-throughput.md` (a synthetic-fixture scaffold), these numbers come
from a real repo corpus. They are not a CI gate; the gate for the parse
dispatch path is `bench/parse-dispatch-rounds/`.

---

## Method, and one trap that invalidates everything

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

## Cold analyze

|                  | before #3194 | after #3196 |
| ---------------- | -----------: | ----------: |
| total            |       110.3s |   **63.6s** |
| parse            |        74.0s |       36.0s |
| scopeResolution  |        17.0s |       16.0s |
| all other phases |         1.2s |        1.2s |
| dispatches       |          221 |          15 |

Graph output identical throughout: 51,286 nodes / 163,092 edges / 2106 clusters
/ 759 flows.

## Re-analyze after a one-file edit — the developer loop

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

## FTS index rebuild — the largest non-resolution cost, and it is a floor

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

### Four ways out, all measured, all closed

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

### The one lever left: overlap

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

## scopeResolution is memory-traffic bound, not algorithmic

`--cpu-prof` of a one-file-edit run, top main-thread self time:

```
4294ms  (garbage collector)
1552ms  v8.deserialize
 756ms  crypto update
 728ms  runScopeResolution
 620ms  scope-resolution/pipeline/reconcile-ownership
 380ms  v8-sidecar walk
 323ms  internString
```

then a tail of passes at 200–750ms (`emitReceiverBoundCalls`,
`emitCallableValueFlow`, `buildGraphNodeLookup`, `resolveReferenceSites`).

No dominant hot function, nothing quadratic. The cost is rehydrating every
file's `ParsedFile` from the durable `.v8` shards into main-thread memory and
re-running every pass over them.

**So the win is not caching resolution output** — that stores more of exactly
what is already the memory problem, and #2649 (large-repo OOM) is the standing
constraint. The win is skipping rehydration and re-resolution for files whose
inputs provably did not change, as a streaming/bounded design.

---

## Measured and rejected

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

## Open

The post-pipeline tail is fully accounted (99.7%): FTS rebuild, the graph write,
and 0.8s of post-FTS event-loop drain between them.

FTS is closed as an optimization target except for the overlap above, which is a
scheduling change to `run-analyze.ts`'s open/close discipline rather than
anything about FTS. `scopeResolution` is the single largest step, memory-traffic
bound, and still untouched.

Every optimization in this document that looked compelling from the armchair
died under measurement. Measure first, and check the banner.
