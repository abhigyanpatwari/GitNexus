# Measurement results — 2026-10-25

Baseline: `ee7eff97f7f4eb7d68f7090cba448f7cc8285db2`. Candidate: this refactor before commit. The SHA-256 of sorted changed production paths and file bytes, each separated by NUL, is `b6e82236a38c3a0cbd073f2ef162885613869a32c6da9c2d906ecc85a6ff5ea6`. Both revisions were built independently and used the same installed dependencies.

Runtime: Node v22.23.3, Linux, 12th Gen Intel(R) Core(TM) i9-12900K, one parse worker. Runtimes, dependencies, and temporary corpora were on the same native filesystem. This was a shared development host, without CPU isolation. Full tests and graph indexing were started only after these measurements.

## Extraction work

For all eight providers, scope and structure consumers produced identical semantic hashes. Distinct parameter arrays fell from **2 to 1**. Separate uninstrumented trials called parameter extraction twice on each of 1,000 declarations in a fresh tree; parsing and forced GC were outside the timed region. The table reports medians of nine trials per provider. These small fixtures measure extraction cost, not overall indexing.

| Provider   | Baseline wall ms | Candidate wall ms | Baseline CPU ms | Candidate CPU ms | Root AST accesses before → after |
| ---------- | ---------------: | ----------------: | --------------: | ---------------: | -------------------------------: |
| java       |            32.60 |             15.46 |           60.19 |            32.73 |                          63 → 62 |
| typescript |            37.75 |             19.20 |           64.63 |            36.29 |                          59 → 58 |
| kotlin     |            47.40 |             28.13 |           75.01 |            49.54 |                        105 → 101 |
| csharp     |            60.80 |             30.37 |           92.36 |            52.97 |                        181 → 180 |
| python     |            89.85 |             44.75 |          152.75 |            84.62 |                          67 → 57 |
| php        |            27.56 |             17.37 |           43.57 |            27.17 |                          63 → 62 |
| swift      |            85.46 |             48.28 |           98.17 |            64.23 |                        269 → 246 |
| dart       |            77.63 |             34.35 |          102.06 |            55.27 |                          50 → 66 |

The Dart wrapper-to-inner-declaration lookup adds root-node accesses while avoiding the second parameter traversal. Root access counts do not count descendant reads, `tree`, or `id`; they are not total AST traversal counts. Scope-specific transformations still run independently.

A separate real-worker trace of the repository corpus, aggregated across cold,
warm, and changed-file analysis, recorded **1,391 parameter requests** in both
revisions. They produced **1,391 distinct arrays before and 784 after** (43.6%
fewer). Of 784 declarations, 607 were requested twice and 177 arrow functions were
requested once. Those single requests still incur cache bookkeeping. The observed
migrated callbacks in this corpus were TypeScript; cold analysis parsed 98 of its
142 manifest files. Graph hashes still matched. These trace runs overlapped the
test suite, so their timing and memory values are excluded from the tables below.
The optional preload in [README.md](README.md) reproduces these counters.

## End-to-end analysis

Three paired trials per corpus alternated revision order. Each process ran cold analysis, warm parse-cache replay, and a changed-file analysis. Wall time includes persistence. All six pairs matched structural graph hashes and node/edge counts in every scenario. Cold/warm graphs matched; changed signatures changed the graph. Cold and changed runs used real parser workers; warm runs replayed cache entries without workers.

| Corpus       | Files | Content manifest SHA-256                                           |
| ------------ | ----: | ------------------------------------------------------------------ |
| declarations |    65 | `a8f8aa6206812f6bdcd24fce9d89dcf25d14eaf7b1c86ba49aea1ca64f729e40` |
| repository   |   142 | `ccafcd91d22aaccd886e978717499148823ca804132d64956f7f1ca9e9df1277` |

Wall times are median [minimum–maximum], milliseconds.

| Corpus / scenario      |            Baseline |           Candidate | Median change |
| ---------------------- | ------------------: | ------------------: | ------------: |
| declarations / cold    |    6621 [6485–7814] |    7616 [6773–8238] |        +15.0% |
| declarations / warm    |    2939 [2754–3693] |    3027 [2828–3125] |         +3.0% |
| declarations / changed |    3565 [3564–4160] |    3721 [3343–4708] |         +4.4% |
| repository / cold      | 13737 [11731–15283] | 16039 [10623–18116] |        +16.8% |
| repository / warm      |    6829 [5838–7794] |   7580 [5162–10662] |        +11.0% |
| repository / changed   |    7556 [6348–7656] |    8035 [5832–9154] |         +6.3% |

Additional medians, shown baseline → candidate. RSS is the sampled peak, CPU includes workers, and GC measures only the main isolate. Parsing is a progress-callback interval rather than an exclusive profile.

| Corpus / scenario      |            CPU ms |       RSS MiB |    Main GC ms | Parsing interval ms |
| ---------------------- | ----------------: | ------------: | ------------: | ------------------: |
| declarations / cold    |   7367.8 → 8149.3 | 530.5 → 558.7 | 131.4 → 170.2 |     3286.3 → 3211.9 |
| declarations / warm    |   2931.8 → 2876.1 | 636.6 → 651.3 | 195.1 → 198.4 |       175.6 → 154.4 |
| declarations / changed |   3397.3 → 3522.6 | 708.9 → 713.0 | 121.3 → 120.9 |     1008.0 → 1060.6 |
| repository / cold      | 17199.8 → 20591.9 | 759.5 → 753.4 | 229.3 → 306.4 |     6954.7 → 8205.3 |
| repository / warm      |   7137.5 → 7288.9 | 883.5 → 873.4 | 248.3 → 268.6 |       299.7 → 315.3 |
| repository / changed   |   7698.1 → 8652.0 | 951.2 → 954.2 | 253.2 → 261.4 |     1202.5 → 1242.8 |

The final end-to-end medians were slower. An earlier complete six-pair run, before the narrow Python/Dart wrapper identity correction, showed cold median changes of +1.7% for declarations and −4.4% for repository sources. The final run also shifted warm-cache timings, where the extraction cache is not used. These observations and the wide overlapping ranges leave the overall indexing effect unresolved; they do **not** establish a speedup or rule out a regression. Repeat on an isolated host and larger representative corpora before claiming an end-to-end gain.

The isolated measurement does establish lower repeated parameter-extraction cost. It does not account for workload-dependent cache bookkeeping across every declaration shape. Retention remained bounded in the forced-GC probe: **100/100 discarded trees were collected in both revisions**. Post-GC main heap was 6.87 MiB before and 6.88 MiB after. Warm reparse counts were zero; changed-file runs reparsed one file. The RSS sample and small lifetime probe cannot establish a general peak-memory improvement.

Reproduce with the command and limitations in [README.md](README.md). The harness emits per-trial JSON, including all phase intervals, CPU, GC, sampled/cumulative RSS, cache counts, corpus manifests, graph hashes, and parameter-only timings.

## Mixed-provider worker parity

Three additional paired runs used `--providers-only`: eight provider files plus
the changed-file probe. Every run asserted that each provider emitted its sample
callable and a resolved call to it. The fixtures include Java records, C# primary
constructors, Kotlin companions, overloads, Python decorators, PHP variadics, and
Swift/Dart constructors. Swift's existing `Function` classification is preserved.

All pairs matched **47 structural nodes and 46 edges** in every scenario. Cold
runs parsed nine files; warm runs parsed zero; changed runs parsed one. The cold
and warm graph hash was
`131f1043fb43b9635228595748bd1a15d853b10f86ed40902303612918b15169`;
the changed graph hash was
`93734f2c8ea9ba0d8841e269467dc49cd2289be83aa18b13a8cebe871a6106ab`.
The corpus manifest was
`0a75726a1e88b189f63675a9e12476ca3d928d1a25ed4abf9648efbd0c9b339f`.
These extra runs overlapped the full test suite and provide correctness evidence;
their timing and memory measurements are excluded from the performance tables.
