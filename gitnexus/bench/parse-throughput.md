# Parse-throughput benchmark (scaffold)

> **Status: methodology + harness scaffold, no measurement data yet.**
> The Latest measurement table below contains `_TBD_` placeholders.
> This file ships intentionally without numbers — populating it
> requires a dedicated bench-pass against the U6 fixture (and ideally
> a real-world TS-root-scale repo) on consistent hardware, which is
> tracked as future work rather than gated on PR #1693's merge.
> Until the table is populated, the load-bearing perf-regression
> protection lives in `gitnexus/test/integration/parse-impl-large-fixture.test.ts`
> (U6, 30 s wall-clock budget via `Promise.race`).

Tracks `runChunkedParseAndResolve` wall-clock + peak heap on a synthetic
fixture so PR #1693's "analyze no longer hangs on TS-root-shaped loads"
claim is measurable, not just asserted by smoke tests. The harness
recipe below is deliberately small enough to re-run in a few minutes
when the bench-pass is undertaken.

---

## Methodology

### Fixture

Synthetic TypeScript repo, _not_ a clone of microsoft/TypeScript. CI cost
of cloning real-world repos is prohibitive; the synthetic shape exercises
the same pipeline paths (chunking, deferred extraction, cross-chunk
imports + heritage) without the disk-I/O overhead. Larger numbers can be
manually captured against real repos and cross-referenced here, but the
authoritative regression-tracking shape is the synthetic fixture so runs
are reproducible across hardware.

The fixture matches the structure pinned by
`gitnexus/test/integration/parse-impl-large-fixture.test.ts` (U6):

- 15 small modules (`mod0.ts` … `mod14.ts`), one exported function each.
- 1 dense `complex.ts` with 30 functions + 1 class + 1 interface.
- 1 `index.ts` re-exporting every symbol from every module.

`GITNEXUS_CHUNK_BYTE_BUDGET=64` forces multi-chunk parsing on this small
fixture — without that override the whole thing fits in one chunk and
the deferred-extraction path is not exercised end-to-end.

### What to measure

| Metric                      | How                                                                              |
| --------------------------- | -------------------------------------------------------------------------------- |
| Wall-clock total            | `Date.now()` delta around `runChunkedParseAndResolve`                            |
| Peak heap                   | Sample `process.memoryUsage().heapUsed` every 50 ms during the run; keep the max |
| Chunks observed             | Count distinct `Parsing chunk X/Y` progress messages                             |
| `getStats()` final snapshot | Quarantined paths, dropped slots, breaker state                                  |

### Hardware shape (record alongside each measurement)

- OS + version
- CPU model + logical core count
- RAM
- Node version
- gitnexus commit SHA (so the snapshot is anchored to a tree, not "main")

---

## Harness recipe

The U6 test (`test/integration/parse-impl-large-fixture.test.ts`) is the
checked-in mini-benchmark — it exercises the same fixture and bounds the
wall-clock at 30 s via `Promise.race`. To produce a richer snapshot for
this doc, run it under instrumentation:

```bash
# From the gitnexus/ subdir:
cd gitnexus
# The worker pool is the sole parse path, so every run needs the dist worker
# (`npm run build`) and a pool size pinned via GITNEXUS_WORKER_POOL_SIZE.

# Single-worker-pool baseline (closest analog to the old single-threaded run —
# sequential parsing was removed, so a 1-worker pool is the floor):
npm run build && \
  GITNEXUS_WORKER_POOL_SIZE=1 \
  GITNEXUS_VERBOSE=1 \
  npx vitest run test/integration/parse-impl-large-fixture.test.ts --reporter=verbose

# Multi-worker path:
npm run build && \
  GITNEXUS_WORKER_POOL_SIZE=4 \
  GITNEXUS_PARSE_CHUNK_CONCURRENCY=2 \
  GITNEXUS_VERBOSE=1 \
  npx vitest run test/integration/parse-impl-large-fixture.test.ts --reporter=verbose
```

For peak-heap sampling, wrap the dispatch call in a Node script that
polls `process.memoryUsage()`. A future helper at
`gitnexus/bench/scripts/parse-throughput.ts` would automate this — the
plan's stretch goal. Until that lands, capture peak heap manually via:

```bash
node --inspect=0 \
  --require ./scripts/heap-sampler.js \
  ./node_modules/.bin/vitest run test/integration/parse-impl-large-fixture.test.ts
```

---

## Latest measurement

> _No measurement data has been collected yet — this file is the
> methodology + harness scaffold. The U6 smoke test confirms the
> worker-pool path stays well within its wall-clock budget, but every
> throughput/heap cell below is a `_TBD_` placeholder for a future
> bench-pass._

The U6 integration test (`gitnexus/test/integration/parse-impl-large-fixture.test.ts`)
runs the worker pool — the sole parse path now that sequential parsing
has been removed (disabling the pool on a repo with parseable files
raises a hard `WorkerPoolDisabledError`). It completes the synthetic
fixture well within the 30 s `Promise.race` wall-clock budget on the
development machine, but no worker-pool throughput/heap numbers have been
captured yet, so the rows below are all `_TBD_`. (An earlier ~6 s figure
recorded here was measured on the now-removed sequential path; it has
been dropped rather than relabelled as a worker-pool baseline, since the
two paths are not comparable.)

| Path                                                                      | files/s | wall-clock | peak heap | chunks | quarantined |
| ------------------------------------------------------------------------- | ------- | ---------- | --------- | ------ | ----------- |
| Worker pool, `--workers 1` (`GITNEXUS_WORKER_POOL_SIZE=1`), concurrency 1 | _TBD_   | _TBD_      | _TBD_     | _TBD_  | 0           |
| Worker pool, `--workers 4`, concurrency 2                                 | _TBD_   | _TBD_      | _TBD_     | _TBD_  | 0           |

**Hardware:** _TBD — record OS, CPU, RAM, Node version, gitnexus SHA at
the time of the bench-pass that populates the table above._

---

## Operator-tuning quick reference

Cross-links to the env vars documented in the [README](../../README.md#environment-variables).
Use this section as a starting point when the benchmark numbers above
suggest a tuning opportunity for your hardware shape.

- **CPU-bound, big repo, lots of cores:** raise `GITNEXUS_WORKER_POOL_SIZE`
  past the default cap of 16. The 16-worker cap exists because past that
  point main-thread merge / extraction dominates; if you've measurably
  ruled that out, the env var lifts the cap explicitly. (See
  `worker-pool.ts` `DEFAULT_POOL_SIZE_CAP`.)
- **Slow files (large minified JS, deep TS types):** raise
  `GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS` past 30 000 ms. The cumulative
  budget is 5× this value (U10 pins this) so a 60 s idle timeout permits
  300 s of total retry-and-split wall-clock before quarantining the file.
- **Constrained container (cgroup CPU limit):** the pool now uses
  `os.availableParallelism()` (U3 H2), which honors cgroup limits — no
  manual `GITNEXUS_WORKER_POOL_SIZE` override needed unless the auto-
  resolved value is too aggressive for your I/O budget.
- **Long-running host (eval-server, MCP daemon) running back-to-back
  analyzes:** `--workers` is now threaded through `AnalyzeOptions`
  (U2 B2), so per-invocation sizing is honored without `process.env`
  state leaking across calls. `GITNEXUS_VERBOSE` is similarly snapshot/
  restore-bracketed.

---

## What this benchmark does NOT measure

- **Real-repo performance.** The synthetic fixture is sized for CI; it
  doesn't exercise the cumulative-load shape (50k files, occasional
  pathological file) that drove the original PR #1693 hang report. Real-
  repo numbers should be captured ad-hoc against the user's target repo
  and cross-referenced here only as supplementary evidence.
- **Worker-pool resilience under real crashes.** That's verified by the
  `worker-pool.test.ts` integration tests (real `process.exit`, real
  `error` events, real protocol violations) and the unit suite. The
  benchmark cares about throughput on the happy path.
- **IPC repack throughput.** Phase 3 of the PR #1693 plan introduces a
  transferList + binary wire-format IPC repack (U16-U17). Once that
  lands, an `IPC repack` row should be added to the "Latest measurement"
  table above with before/after numbers on the same hardware.

---

## Related artifacts

- Plan: `docs/plans/2026-05-20-001-feat-pr1693-resilience-hardening-and-ipc-repack-plan.md`
- Integration test (mini-benchmark with wall-clock guard): `gitnexus/test/integration/parse-impl-large-fixture.test.ts` (U6)
- Operator env-var reference: `README.md` → Environment variables
- Resilience layer tests: `gitnexus/test/unit/worker-pool-resilience.test.ts`,
  `worker-pool-cumulative-timeout.test.ts`,
  `worker-pool-windows-quarantine.test.ts`,
  `worker-pool-slot-generation.test.ts`
