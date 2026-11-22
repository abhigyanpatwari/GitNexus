# PR #3929 scaling results

Measured on 2026-11-14, Linux, Node v22.23.3, 12th Gen Intel(R) Core(TM) i9-12900K, one LadybugDB
execution thread and a 128 MiB buffer pool. This was a shared development host
(load average 6.0 at the start of the baseline run and 2.9 at the start of the
candidate run). Each input size used a fresh process, two warmups and seven
measured invocations.

The baseline is commit `5340562f5c0b1475f796ddfaf4abe4d780118ed2`: the
PR's first change, which loads expected files with `filePath IN $filePaths`,
500 files per query. The candidate is commit
`e6fa28fcba582d076e62b9c19c20c00dd1d8afcd`: one join query per group of
named files, every pass naming its files first, per-file ID maps and a fixed
per-file row order. Both were measured from clean checkouts with the harness of
the candidate commit (`--root` selects the checkout under test):

- Baseline extractor: `18d3ab554d7191ac47ef6570c126b3ac65a483edf3578b13257838a1bcd1bd72`
- Candidate extractor: `288fc2c3371e47e3acbdf7ba21e36ee227ffd915331fa8dbdbaeb5ed5c81b9a8`
- Shared harness: `2d6b525e24db45cf04a6b3f7c927416af520a0c5447e9352e0b0a54cfaf95c9d`

Both runs used identical harness, lockfile and scaling-guard hashes. All nine
full-contract fingerprints agree. Raw samples, native PROFILE plans and gates
are in [baseline.json](results/baseline.json) and
[candidate.json](results/candidate.json). See [README.md](README.md) for commands,
measurement boundaries and the workload definitions.

## Verdict

The baseline **fails** the 1.5 normalized-growth gate. For a 16× input increase:

| Cost                        | Baseline growth | Candidate growth | Baseline normalized factor | Candidate factor |
| --------------------------- | --------------: | ---------------: | -------------------------: | ---------------: |
| Spread-file scanned tuples  |            144× |              16× |                       9.00 |             1.00 |
| Dense-file handler-ID reads |         255.07× |              16× |                      15.94 |             1.00 |

Batching 500 files reduces query count but rescans all symbol tables per batch.
Separately, searching a file's symbol array for every handler repeats work as
both the handler count and file size grow. Timings alone missed both problems:
the baseline's wall-time factors stayed under 1.5 on these inputs.

The candidate **passes every adjacent-size and full-span comparison** for wall
time, CPU, endpoint heap, endpoint RSS, process maximum RSS, scanned tuples,
returned rows and handler-ID reads. Its worst normalized wall-time factor is
1.0865; its worst CPU factor is 1.0127. The work counters grow exactly with
input size in the spread and dense cases. Sparse requests return the six rows of
the requested file at every size.

An intermediate revision (`2ebbdd79d`) replaced the 500-file batches above 500
files with one scan of every symbol row. It kept scanned tuples linear, and
returned the rows of every file in the repository. This harness now holds as
many unrequested symbols as requested ones and checks the returned rows, and
that revision fails it at the first size above 500 files (spread, N=1,024:
12,288 rows returned for 6,144 requested). On a 120,000-symbol on-disk database
with 501 handler files, a separate probe measured 9.3 s for that revision,
0.42 s for the baseline, 6.3 s for one query per file and 0.24 s for the
candidate (one thread, medians of three, same shared host).

## All measured sizes

Times are per-extraction medians. Revisions ran sequentially, not as interleaved
pairs, so these timings illustrate this host's runs rather than establish a
portable speedup or a strict cross-revision regression bound.

| Arm    |     N | Baseline ms | Candidate ms | Baseline max RSS MiB | Candidate max RSS MiB |
| ------ | ----: | ----------: | -----------: | -------------------: | --------------------: |
| Spread |   256 |      168.61 |       110.09 |               210.58 |                217.22 |
| Spread | 1,024 |      548.67 |       465.07 |               225.00 |                235.40 |
| Spread | 4,096 |    2,650.61 |     1,758.12 |               264.44 |                327.47 |
| Dense  |   256 |      121.43 |       108.19 |               211.44 |                220.93 |
| Dense  | 1,024 |      486.06 |       470.17 |               222.93 |                227.79 |
| Dense  | 4,096 |    2,122.60 |     1,426.29 |               265.58 |                290.84 |
| Sparse |   256 |       10.22 |         9.63 |               205.91 |                214.51 |
| Sparse | 1,024 |        7.22 |         9.43 |               206.59 |                221.22 |
| Sparse | 4,096 |        9.99 |        12.18 |               234.39 |                263.00 |

At N=4,096 the spread workload's native scanned tuples drop from 442,368 to
49,152, and the dense workload's ID reads drop from 16,781,312 to 24,576.

The candidate's process maximum RSS is higher at the largest sizes (spread 327
against 264 MiB, dense 291 against 266 MiB at N=4,096). Its normalized growth
factors for the three memory measures stay at 0.35 or below.

One query returns every named file's rows, so its duration and memory grow with
the rows requested; a batch that fails or exceeds the pool's query timeout falls
back to one query per file. Neither these checks nor the implementation claim
linearity for all source scanning, name resolution, or failure paths in complete
group sync. The fixtures name every route file through the graph; files found
only by the source scan are covered by the unit tests, not by this harness.

## Validation

- The baseline completed all nine cases and failed the work-scaling gate; the
  candidate completed the same cases and passed.
- Affected group unit and integration suites, the native symbol-query
  integration test, the route round-trip integration tests and the test-list
  guards: **88 files, 1,570 tests passed** at the candidate commit.
- Production and test TypeScript checks: passed. Prettier: passed. ESLint: no
  errors.
- GitNexus change analysis at the candidate commit: 10 files, 49 symbols, no
  affected execution flow, low risk. Upstream impact of `HttpRouteExtractor`
  reaches group sync, auto-sync and the MCP `group_sync` tool.

CI runs the complete gate in the existing serial benchmark job and uploads its
JSON even when the gate fails. These results describe local validation.
