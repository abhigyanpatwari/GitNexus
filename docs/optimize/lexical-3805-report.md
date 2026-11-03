# PR #3805 optimization assessment — 2026-11-03

No additional runtime optimization met the acceptance limits. The final runtime
is unchanged at `6aeeace8e96603fb062dcc709e834042d5a6df74`. The local
`optimize/lexical-3805` branch adds complete baseline collection, reversible
runtime ordering, regression tests, and measurement receipts.

## Measurements and decisions

Each session ran three real edits per lifecycle against matched unchanged-PR
controls. Cold seeds were excluded. A second session reversed both lifecycle
and initial runtime order. Values below are medians of session medians; with
two sessions, the outer median is their midpoint. Negative changes mean less
elapsed time.

| Candidate | Sessions | Fresh: reference → candidate | Change | Warm: reference → candidate | Change | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Reuse claim buckets and specialize singleton selection | 1 | 29.799s → 32.233s | +8.17% | 34.280s → 33.238s | −3.04% | Rejected: fresh regression |
| Replace intermediate claim-selection arrays with scans | 2 | 26.347s → 25.941s | −1.54% | 23.526s → 23.491s | −0.15% | Inconclusive |

The limits were a repeatable warm-process improvement greater than 5%, at most
3% fresh-process regression, and three independent confirmation sessions before
any keep. Neither candidate reached confirmation eligibility. The second
candidate's first session improved neither objective; adding another session
cannot satisfy the configured requirement that every paired session improve
beyond the threshold. The decision helper returned terminal inconclusive after
the requested second sample. There is no confirmed additional speedup, and no
final before/after speedup is claimed for the unchanged runtime.

The [experiment receipt](../../gitnexus/bench/lexical-lookup/optimization-20261103.json)
contains all samples, graph hashes, call targets, memory/load diagnostics,
candidate patch hashes, forecasts, and decision outputs. It records 18 paired
edits across the two experiments: 36 measured analyses plus 12 cold seeds.

## Baseline identity and uncertainty

Both experiment runtimes used Node 22.23.3, LadybugDB 0.22.0, two workers and a
4 GiB heap. The sparse ingestion corpus was pinned to
`4916e0d5e1f4d6d70d41c1f39cd244bca2c7b390`. The host was shared; other workloads
were observable during measurement. The first large apparent warm gain in the
second experiment disappeared in its completed session median.

The earlier [PR-versus-base receipt](../../gitnexus/bench/lexical-lookup/baseline-20261103.json)
used PR `6b487a5` and base `4916e0d`, before the PR merged a Kotlin grammar
update. Its three independent sessions measured 28.494s → 27.552s fresh and
30.276s → 29.814s warm. Candidate session variation was 5.02% fresh and 17.01%
warm, so those small gains are inconclusive. Those older timings were never
used to score the newer experiments. The remote PR still pointed to `6aeeace8`
when checked during wrap-up.

Selection and reporting used the same sparse corpus. No holdout was configured,
and these results establish neither a full-repository nor a watch-mode speedup.

## What profiling justified trying

The unchanged PR's diagnostic CPU profile attributed about 7.8% of elapsed time
to lexical lookup, including claim selection. Garbage collection occupied 8.5%.
The CPU profile overlapped indexing, so it was used to locate costs, not to score
candidates. A separate allocation profile attributed approximately 1.6 GiB of
temporary allocations to claim selection, about 20% of sampled allocations.
These are cumulative allocation estimates, not live heap or peak RSS.

The first candidate's forecast was roughly 0.3–1.5s per 30s edit, plus unknown
GC savings. Its warm gain was smaller than the required threshold and fresh
time regressed. The second forecast was roughly 0.5–1.5s; its measured aggregate
warm reduction was only 0.035s. Allocation reduction alone did not establish an
elapsed-time benefit.

Remaining binding-filter and cycle-detection work has smaller attributed cost.
Its elapsed benefit remains unconfirmed and is unlikely to clear this run's 5%
threshold independently. A quieter benchmark host would help evaluate smaller
changes; broader pipeline changes require a separately scoped experiment.

## Correctness and retained changes

All 18 experiment edit pairs matched source/semantic graph hashes and persisted
call targets. Every edit changed the target between `save` and `load`; the runs
rejected no-op, skipped-FTS, collapsed-graph, or non-incremental shortcuts.
Derived communities/processes are excluded from the semantic digest, as in the
existing benchmark protocol.

The first candidate passed 3,472 scope tests and 72,000 differential comparisons.
The second passed 3,471 scope tests, 72,000 lookup comparisons, and 50,000
additional selector comparisons covering ordering, merges, hoisting, activation,
and non-finite positions. These counts describe separate runs and should not be
added as distinct tests. Both experimental source patches remain isolated.

The retained benchmark changes add `GITNEXUS_LEXICAL_BENCH_SCREEN=0` to retain
all pairs and `GITNEXUS_LEXICAL_BENCH_BASE_FIRST=0` to reverse initial ordering.
Defaults are preserved. Deterministic fresh/persistent regression tests verify
that even a slower candidate produces every requested sample and that temporary
control files are removed.

Final source and test typechecks, targeted tests, ESLint, formatting, and staged
diff checks passed. Complete graph change analysis reported 18 changed symbols
across six files, low risk, and no partial or truncated result. The benchmark's
external CI uses were also checked; an empty graph caller set was not treated
as proof that it was unused.

The full suite ran for 93 minutes: 31,567 tests passed, four failed, and 103
were skipped. All four failures were in unchanged Codex setup tests whose
temporary home directories were bypassed by the inherited `CODEX_HOME` setting.
Rerunning both affected files with child-process-only `env -u CODEX_HOME`
passed all 62 tests. The full suite was not repeated with that environment
correction; its original failure result remains in the validation receipt.

No final three-session timing confirmation was run: no runtime candidate
qualified for retention, and the remaining experiment budget could not fit
another confirmation cycle. Final elapsed-time values therefore remain
unconfirmed; unchanged runtime source is not a measured zero-percent gain.

## Run accounting

The optimization loop ran for 46 minutes 9 seconds. Kept: 0; rejected: 1;
inconclusive: 1; not selected: 0; censored: 0; errors/timeouts: 0. The remaining
hypothesis was deferred because it lacked a supported gain above the threshold
and the remaining approved time could not fit another full confirmation cycle.
No dependencies were added. No judges or subagents were used; monetary cost
telemetry was unavailable.

The resumable local ledger is
`.context/compound-engineering/ce-optimize/lexical-3805/experiment-log.yaml`,
with the approved `spec.yaml` beside it. The receipts linked above preserve the
measurements in the branch. No PR updates or pushes were made by this run.
