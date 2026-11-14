# PR #3929 scaling results

Measured on 2026-11-14, Linux, Node v22.23.3, Intel i9-12900K, one LadybugDB
execution thread and a 128 MiB buffer pool. This was a shared development host;
no builds, tests or indexing from this task ran alongside the final measurements.
Each input size used a fresh process, two warmups and seven measured invocations.

The baseline is the unmodified PR head
`5340562f5c0b1475f796ddfaf4abe4d780118ed2`. The candidate is that head plus the
local extractor change, **not** a separate committed revision. The reports record
the dirty tree and exact source hashes:

- Baseline extractor: `18d3ab554d7191ac47ef6570c126b3ac65a483edf3578b13257838a1bcd1bd72`
- Candidate extractor: `210fb03a7059baf2411761df6a24f642ba246e551bf3476a28ebf7c90a5689c6`
- Shared harness: `1501559a95231c27fa36e4f466bbaa8d561fba6dbb646a579eb9fd9d6ec1feae`

Both runs used identical harness, lockfile and scaling-guard hashes. All nine
full-contract fingerprints agree. Raw samples, native PROFILE plans and gates
are in [baseline.json](results/baseline.json) and
[candidate.json](results/candidate.json). See [README.md](README.md) for commands,
measurement boundaries and the workload definitions.

## Verdict

The original PR **fails** the 1.5 normalized-growth gate. For a 16× input increase:

| Cost                        | Original growth | Corrected growth | Original normalized factor | Corrected factor |
| --------------------------- | --------------: | ---------------: | -------------------------: | ---------------: |
| Spread-file scanned tuples  |            144× |              16× |                       9.00 |             1.00 |
| Dense-file handler-ID reads |         255.07× |              16× |                      15.94 |             1.00 |

Batching 500 files reduces query count but still rescans all symbol tables per
batch. Separately, searching a file's symbol array for every handler repeats
work as both the handler count and file size grow. Timings alone missed both
problems: the original PR's wall-time factors stayed under 1.5 on these inputs.

The candidate **passes every adjacent-size and full-span comparison** for wall
time, CPU, endpoint heap, endpoint RSS, process maximum RSS, scanned tuples and
handler-ID reads. Its worst normalized wall-time factor is 0.9894; its worst
CPU factor is 0.9767. The work counters grow exactly with input size in both
spread and dense cases. Sparse requests retain selective results and constant
ID-lookup work.

## All measured sizes

Times are per-extraction medians. Revisions ran sequentially, not as interleaved
pairs, so these timings illustrate this host's runs rather than establish a
portable speedup or a strict cross-revision regression bound.

| Arm    |     N | Original ms | Candidate ms | Original max RSS MiB | Candidate max RSS MiB |
| ------ | ----: | ----------: | -----------: | -------------------: | --------------------: |
| Spread |   256 |       67.67 |        72.66 |               217.11 |                213.31 |
| Spread | 1,024 |      292.95 |       258.40 |               227.41 |                217.95 |
| Spread | 4,096 |    1,450.74 |     1,022.65 |               265.82 |                254.18 |
| Dense  |   256 |       71.53 |        66.35 |               211.37 |                217.30 |
| Dense  | 1,024 |      284.80 |       261.80 |               216.23 |                218.86 |
| Dense  | 4,096 |    1,268.69 |     1,007.64 |               253.87 |                253.52 |
| Sparse |   256 |        4.25 |         4.93 |               206.46 |                209.36 |
| Sparse | 1,024 |        5.05 |         4.69 |               208.50 |                210.04 |
| Sparse | 4,096 |        5.68 |         5.51 |               222.46 |                216.46 |

At N=4,096 the spread workload's native scanned tuples drop from 221,184 to
24,576, and the dense workload's ID reads drop from 16,781,312 to 24,576.

The complete-scan strategy retains all symbol rows when it activates, including
files without requested handlers. That memory tradeoff is explicit; the sparse
arm tests one requested file and does not characterize every partially sparse
repository. Query failures retain the prior per-file fallback. Neither these
checks nor the implementation claim linearity for all source scanning, name
resolution, or failure paths in complete group sync.

## Validation

- The original head completed all nine cases and failed the work-scaling gate;
  the corrected candidate completed the same cases and passed.
- Affected group unit/integration suites, the native symbol-query integration
  test, and the shared scaling-guard tests: **81 files, 1,474 tests passed**.
- Full `npm test`: **34,098 passed, 5 failed, 104 skipped**. Four failures in
  unchanged Codex setup tests came from inherited `CODEX_HOME` bypassing their
  temporary home directories; both setup suites passed all 73 tests with that
  variable removed from the test process. The remaining embedding-recovery
  case exceeded its 120-second timeout under the full run and passed in an
  isolated rerun (97.30 seconds for the run). All five failing cases passed on
  focused reruns; the full suite was not rerun.
- Production and test TypeScript checks and `npm run build`: passed.
- Prettier and `git diff --check`: passed. ESLint: no errors; seven existing
  warnings in the extractor.
- GitNexus impact at the pinned head flags the shared extractor HIGH and its
  prefetch helper CRITICAL. Traced callers include group sync, auto-sync and MCP.
  After refreshing the index, change analysis covers all nine changed files and
  maps them to six execution flows, with no partial or truncated result.

CI now runs the complete gate in the existing serial benchmark job and uploads
its JSON even when the gate fails. These results describe local validation;
the new CI step has not run on GitHub yet.
