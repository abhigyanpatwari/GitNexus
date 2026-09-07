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

Corpus: this repository, `git archive` of HEAD into a scratch dir, then
`git init && git add -A && git commit`. 5350 paths, 2234 parseable, ~30MB.
16 workers, `dist` on a local overlay filesystem (see "Filesystem" below).
Phase numbers come from the `✓ Phase: <name> (<ms>)` lines under
`NODE_ENV=development`.

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

One file changed out of 5350, on a git repo. **36.5s total.**

| phase                               |      ms | share |
| ----------------------------------- | ------: | ----: |
| scopeResolution                     |  14,717 |   40% |
| unlogged — graph emit + FTS rebuild | ~18,000 |   49% |
| parse                               |   2,832 |    8% |
| all other phases                    |  ~1,200 |    3% |

The parse cache works: it replays 2231 of 2232 chunks. **Everything the parse
work optimized is that 8%.** The other 92% is not incremental at all — the run
banner says so directly: _"Rebuilt the graph and FTS while reusing cached
parser output."_

Note the ~18s sits **outside the phase runner**, so every `✓ Phase` line is
blind to it. `phasesSum` and the log span agree exactly; the gap is wall-clock
before the first phase and after the last.

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

The ~18s of graph emit + FTS rebuild is **unprofiled**. It is the largest
single share of the edit loop and nothing is known about it beyond the banner.
Profile it before proposing anything — two optimizations in this document
looked compelling until measured.
