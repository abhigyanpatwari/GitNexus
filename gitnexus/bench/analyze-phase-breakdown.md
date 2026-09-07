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
| `import('./platform/capabilities.js')`                |      845 |      3% |
| everything else                                       |    ~3000 |      9% |

The incremental machinery works: the graph write was a 3,980-node subgraph, not
the full 51,288. **Everything the #3194/#3196 parse work optimized is ~9% of
this.**

A FULL-rebuild run of the same repo is 36-39s, with the graph write at ~6.3s and
FTS at ~9.7s. Do not quote those as edit-loop numbers.

## FTS index rebuild — the largest non-resolution cost

Per-index, measured on one leaf-file edit:

```
 3531ms  File.file_fts        <- 35% of FTS on its own
 1558ms  Function.function_fts
  535ms  Method     491ms  Const      466ms  Property
  427ms  Interface  363ms  Class      280ms  TypeAlias
  247ms  Struct     242ms  Variable   234ms  Enum     222ms  Trait   ...
 ------
10203ms across 20 indexes
```

Two findings.

**`File.file_fts` dominates** because File nodes carry file content, so that one
index re-tokenizes ~30MB of source. Changing one file re-tokenizes all of it.

**20 indexes were rebuilt for a two-importer leaf edit.** `touchedFts` is meant
to narrow this, and a separate run rebuilt only 8 — so the narrowing is at least
inconsistent. It has a withdrawal path: `missingSearchFTSIndexTables` returns
`undefined` when the index catalog cannot be read (`fts-indexes.ts:285`), and
`tables: undefined` means rebuild everything. Pin that before optimizing, or the
optimization targets a set that is not actually being narrowed.

The code states the underlying constraint plainly: _"createSearchFTSIndexes
re-tokenizes every stored row on every run."_ Indexes must be dropped for DML
(#2589, #2841), and the only way back is a whole-table rebuild.

Ranked next steps:

1. **Take the FTS rebuild off the critical path.** Nothing in `analyze` reads
   the index — only later searches do. Rebuild lazily on first search or in the
   background after the swap. Removes the cost rather than shrinking it, and the
   degraded-search state is already modelled (`ftsSkipReason`, "degrade rather
   than throw").
2. **Do not rebuild `File.file_fts` when no file content changed.**
3. **Fix or delete the narrowing** — a gate that silently withdraws looks like
   protection and is not.

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

The post-pipeline tail is now fully accounted (99.7%): FTS rebuild, the graph
write, and a 0.8s dynamic `capabilities.js` import between them. What remains
open is the FTS work above, and `scopeResolution` — still the single largest
step, memory-traffic bound, and untouched.

Every optimization in this document that looked compelling from the armchair
died under measurement. Measure first, and check the banner.
