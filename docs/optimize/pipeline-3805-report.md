# PR #3805: identity-read optimization experiment

The additional batching candidate was rejected because it doubled peak resident
memory in the controlled large-table probe. No runtime change was retained.
The runtime remains `6aeeace8e96603fb062dcc709e834042d5a6df74`; this report and
the [measurement receipt](pipeline-3805-results.json) preserve the evidence.

## Matched baseline and candidate

Two independent sessions each measured three real edits in fresh processes and
three in a persistent process. Session two reversed lifecycle and initial runtime
order. Cold seeds were excluded. Every measured pair matched the semantic graph
and persisted call targets; all edits used incremental writes.

| Session                   | Fresh reference → batch | Warm reference → batch |
| ------------------------- | ----------------------- | ---------------------- |
| 1                         | 22.182s → 21.639s       | 22.827s → 20.864s      |
| 2                         | 23.181s → 21.174s       | 19.852s → 18.743s      |
| Median of session medians | 22.682s → 21.406s       | 21.339s → 19.803s      |

The aggregate reductions were 1.275s (5.62%) fresh and 1.536s (7.20%) warm.
The forecast was approximately 1.5–2.5s per 24-second warm edit; the measured
warm reduction is near its lower bound, but cannot qualify as a retained gain.
The required third session was not run after the memory failure. These are
diagnostic candidate results, not confirmed improvements to the final branch.

Both runtimes used Node 22.23.3, LadybugDB 0.22.0, two parsing workers, and a
4 GiB heap. The sparse ingestion corpus was pinned to
`4916e0d5e1f4d6d70d41c1f39cd244bca2c7b390`. The comparison reference was the
unchanged PR runtime; candidate patch SHA-256 was
`8350e17daba98dfbf3042ab233ae7b9c2b924cfcfaa2ccdd979bcb9795812a25`.
The host is shared, and session variation is visible in the table. No holdout
was configured. No full-repository or watch-mode improvement is established.

## Why batching was rejected

The candidate kept both full identity checks and collected complete identity
structs per table, avoiding one asynchronous native call per row. All 33 targeted
tests passed, including corruption detection at both publication boundaries.
Build, source/test typechecks, and changed-file ESLint passed. The native
16K/65K-node benchmark also passed missing/swapped-field controls and checked
selective delete/COPY, checkpoint, and reopen against an independent tuple oracle.

Timing and graph equality did not expose the memory cost. A separate probe used
65,536 Function nodes, a fixed 256 MiB database buffer pool, explicit GC, four
verifier calls, and separate reference/candidate processes on the same seeded
database. Reference peak RSS was 346,552 KiB (338.4 MiB); unbounded collection
reached 709,272 KiB (692.6 MiB). Retained JavaScript heap remained about 30 MB in
both. The native allocation mechanism was not established.

Two scratch alternatives were also unsuitable. Ordered paging failed closed on
a duplicate identity in the healthy fixture; no engine root cause is claimed.
Grouping identities by physical offset preserved the fixture but still reached
675,416 KiB. Neither was incorporated into runtime source.

The correctness review found the measured RSS regression. It was sequential;
the independent adversarial lane did not run under the repository's solo mapping.
Its verdict is **Not ready**. The full suite was not rerun for this rejected
candidate. The earlier unchanged-runtime full-suite result and its setup-test
environment limitation remain documented in [the prior report](lexical-3805-report.md).

## Next measured opportunity

The installed driver exposes `getNextSync()`. A process-local probe retained the
original unfiltered queries and consumed rows synchronously, yielding with
`setImmediate` every 1,024 rows. No installed dependency or runtime source was
modified by this probe.

| Controlled 65K-node probe     | Original reader | Cooperative synchronous reader |
| ----------------------------- | --------------: | -----------------------------: |
| Median of four verifier calls |     3,395.766ms |                      166.648ms |
| Peak RSS                      |     346,552 KiB |                    348,804 KiB |

The standalone native benchmark measured 50.930ms at 16K nodes and 146.986ms at
65K nodes. Both sizes passed the independent oracle after selective writes,
checkpointing, and read-only reopening, and rejected missing/swapped fields.
These are local verifier measurements, not end-to-end timing confirmation.

A next implementation should make this reader opt-in at the two identity-check
call sites, preserving existing connection locking, error propagation, cursor
closing, and default query behavior. It needs yielding/error/cleanup tests,
larger-table memory and responsiveness checks, then three matched fresh/warm
sessions and the full suite. No new dependency is needed.

Fresh graph impact for the shared `readQueryRows` helper is **CRITICAL**:
27 affected symbols, six direct callers and six processes, including query
handling, embedding reads, statistics, and analysis. This expands the approved
mutable scope beyond the reconciliation module and requires maintainer sign-off
under GUARDRAILS.md. A global replacement is not proposed.

## Run state

The one approved implementation experiment completed and was rejected; kept 0,
rejected 1, not selected 0, inconclusive 0, censored 0, experiment errors/timeouts 0.
Scratch paging failure is recorded separately above. The optimization loop took
about 30 minutes before wrap-up; the durable ledger records exact active time.
No judges, subagents, new dependencies, pushes, or PR comments were used. Monetary
cost telemetry was unavailable.

No final speedup or measured zero-percent result is claimed for the unchanged
runtime. The greater-than-5% warm target remains unmet by a retained change;
fresh timing likewise has no new confirmed final value. The next adapter
opportunity is supported by fresh local measurements but remains unimplemented.

Resumable state is under
`.context/compound-engineering/ce-optimize/pipeline-3805/`, including
`experiment-log.yaml`, `spec.yaml`, archived candidate patch and raw measurements.
The tracked receipt beside this report preserves the paired timings, graph
checks, memory samples, native results, and impact report outside that local state.
