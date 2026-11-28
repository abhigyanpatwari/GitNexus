# TypeScript ingestion correctness and scaling

From `gitnexus/`, build the runtime and check the reviewed baseline:

```sh
npm run build
node bench/typescript-ingestion/measure.mjs --check
```

To compare the same workload across two clean builds, run this harness against
each package with the same locked dependencies and Node version. Keep timing
runs serial while the machine is idle.

```sh
node bench/typescript-ingestion/measure.mjs --root /path/to/built/original/gitnexus --observe
node bench/typescript-ingestion/measure.mjs --root /path/to/built/candidate/gitnexus --check
```

`--observe` records the original build's mismatches without failing on them.
The report includes their counts and exact source and destination IDs.
`--check` requires every expected target set, the workload and graph
fingerprints, and normalized growth within the reviewed budgets.

The corpus exercises Map destructuring, `instanceof` guards, and TypeScript
and JavaScript module ownership. Competing owners use the same member names.
The compiler selects `Value.save` for the second element of an
`Iterable<[Key, Value]>`. The small, wide and dense workloads include 16, 64
and 256 copies of that call respectively.
The guard cases check the compiler-selected method after both branches rejoin, inside
the `else` branch, and after assignment. The three shapes contain 512, 2,048 and
8,192 expected call edges respectively.
The module fixtures cover conflicting and agreeing export paths, explicit
re-exports, nested namespaces, local, quoted, and default export aliases,
private names, unbound star exports, and TypeScript type-only exports. Each
caller is compared by exact graph ID. A missing or wrong target is reported by
case family, and negative controls require an empty target set.

| Shape | Independent units | Batches per unit |
| ----- | ----------------: | ---------------: |
| Small |                 8 |                2 |
| Wide  |                32 |                2 |
| Dense |                32 |                8 |

Five measured capture samples use pre-parsed ASTs. Three measured cold
pipeline samples include worker parsing and resolution through in-memory
graph construction. The harness rotates shape order and takes the median.
Growth is the ratio of time per case across shapes. The 1.5 budget allows
timing variance as input grows fourfold. It applies to this synthetic
workload. The report also gives cumulative process peak RSS.

A durable cache replay checks cold and warm graph equality. The harness edits
one receiver fixture and one barrel, then compares the replayed graph with a
fresh graph and verifies the three changed targets. See the separate
[property-dispatch benchmark](../typescript-property-dispatch/README.md) for
speculative call fan-out.

To time database publication on a real source tree, select one commit for both
runtimes. This archives GitNexus's tracked CLI and shared source, analyzes it
with two parse workers in a temporary index, and reopens the persisted graph.
FTS and embeddings are disabled. Treat this as an observation because native
database throughput varies by machine.

```sh
node bench/typescript-ingestion/measure-index.mjs --ref SHA --root /path/to/built/original/gitnexus
node bench/typescript-ingestion/measure-index.mjs --ref SHA
```

## Measured comparison

[Evaluation data](evaluation.json) records the samples, workload fingerprints,
and runtime parse identities. The comparison uses `fcde41a8` as its base, the
same installed dependencies, and Node 26.9.0 on macOS arm64.

| Shape | Exact target sets on main | Exact target sets on the candidate |
| ----- | ------------------------: | ---------------------------------: |
| Small |                 256 / 688 |                          688 / 688 |
| Wide  |             1,024 / 2,752 |                      2,752 / 2,752 |
| Dense |            4,096 / 11,008 |                    11,008 / 11,008 |

Across the three shapes, the candidate recovers 6,048 missing expected edges
and removes 4,368 unexpected edges. Its normalized capture growth was 1.03
for breadth and 0.94 for density. Cold pipeline growth was 0.43 and 0.65 on
the same axes. This run overlapped other local validation. Raw timings in the
evaluation data are diagnostic. Warm replay reused 153 files and parsed zero. The
edited replay parsed two files and reused 151.

Cold database publication on pinned GitNexus source used the quoted-export
implementation at `b558b4d37`. Both builds parsed 1,243 files and reopened
1,247 persisted file nodes. The samples ran in main, candidate, candidate,
main order while other local validation was active.

| Runtime   | Publication samples |   Median | Persisted call edges between functions and methods |
| --------- | ------------------: | -------: | -------------------------------------------------: |
| Main      |   88.50 s, 112.17 s | 100.33 s |                                             32,327 |
| Candidate |    98.21 s, 96.44 s |  97.32 s |                                             32,373 |

The publication median was 3.0% lower in this comparison. The repeated
call fingerprints were stable within each build. The source tree measures
publication cost and graph changes, while the generated fixtures supply the
expected-target oracle.

The parse-reuse comparison against `302969291` adds 257 ingestion relationships on the frozen CLI source corpus. All existing relationship IDs were preserved. The reason on 22 existing imports now records that their exports are type-only. `file-result-reuse/baseline.json` records the two source tree IDs for each runtime, the corpus digest, and the five exact graph fingerprints per runtime. To refresh those expectations, run the baseline and candidate on the same base `gitnexus/src` directory, compare their graph rows, and record each phase's digest and counts. Other inputs use strict equality.

The sparse lexical-lookup corpus adds 107 relationships. Its manifest is keyed by the Git tree IDs of `gitnexus/src/core/ingestion` and `gitnexus-shared/src/scope-resolution`. Five existing imports now carry a type-only reason. The parity check pins their count and digest separately from the 107 additions and compares every other row exactly.
