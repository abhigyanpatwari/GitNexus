# Per-file parser-result reuse benchmark

[#3849](https://github.com/abhigyanpatwari/GitNexus/issues/3849) is caused by using a complete source chunk as the reuse key. This benchmark compares the original chunk cache with independently keyed file results stored in compressed packs. Worker jobs remain batched.

## Reproduce

Build both revisions with their locked dependencies. Run the driver from the candidate `gitnexus/` directory; `--dist` chooses which compiled implementation it loads. Preserve the baseline build before modifying source.

```sh
npm run build
node bench/file-result-reuse/measure.mjs --files 1024 --workers 2
node bench/file-result-reuse/measure.mjs --dist /path/to/baseline/gitnexus/dist --files 1024 --workers 2
node bench/file-result-reuse/measure.mjs --corpus /path/to/frozen/gitnexus/src --workers 2
node bench/file-result-reuse/measure.mjs --dist /path/to/baseline/gitnexus/dist --corpus /path/to/frozen/gitnexus/src --workers 2
```

Run at least three fresh processes per revision and corpus, alternating revisions. Each process creates a fresh temporary repository/cache, then runs cold, unchanged, one-file edit, two-file edit, and repacking scenarios. The edits add exported functions. Repacking changes the existing chunk byte budget to 4 KiB. The driver removes its temporary data afterward.

## CI acceptance gate

`.github/workflows/ci-tests.yml` runs `measure.mjs --check` on both the 1,024-file synthetic fixture and the same frozen base-revision source corpus. It builds the PR base (or the parent on pushes) separately using its lockfile. Each arm runs in a fresh process with two parser workers and a 4 GiB Node heap, alternating order for one excluded warmup pair and seven measured pairs.

```sh
node bench/file-result-reuse/measure.mjs --check \
  --baseline-dist /path/to/baseline/gitnexus/dist \
  --pairs 7 --workers 2 --files 1024 --output /tmp/file-result-reuse/measure.json
# Repeat with --corpus /path/to/baseline/gitnexus/src for the real-source gate.
```

When the base uses chunk caching, the upper bound of the paired 95% interval must show at least 5% faster repeated analyses and strictly lower peak process RSS. Repeated analyses sum warm, one-file edit, two-file edit, and repacking, including cache save. Each individual phase may regress by at most 15%; cold cache bytes must fall by at least 50%. Cache size does not substitute for the RSS check. When the base already uses per-file caching, each metric instead has a 5% regression budget, so subsequent unrelated PRs do not need to reproduce the original improvement.

The gate uses the existing paired log-ratio bootstrap/Student-t calculation from the analyze/resume benchmark. Inconclusive intervals fail. Missing samples, changed runtime or corpus identities, unequal parsed graphs, incorrect reparse counts, invalid measurements, and worker failures also fail. Smoke runs with fewer than seven pairs cannot pass `--check`. CI retains `measure.json`, a Markdown summary, and every trial log even on failure. Historical `results.json` is not an acceptance input.

`pipelineMs` measures ingestion and whole-repository resolution; `withSaveMs` adds parser-cache publication. Neither includes graph database publication, embedding generation, or CLI startup. `peakRssKb` is the cumulative process high-water mark, not a phase-local peak or a sum of child processes. Cache sizes include both manifests and payloads.

Report schema 2 retains the complete graph `digest` for cold/warm and two-edit/repack equality within each runtime. Cross-version comparisons use `parsedDigest`, `parsedNodes`, and `parsedEdges`, which exclude Community/Process nodes and every edge touching them. All remaining node and edge properties participate. This allows intentional derived-ID migrations without hiding parser-output regressions. Both runtimes still execute and time the complete pipeline; the performance limits are unchanged. Schema 1 reports must be remeasured with the current driver.

## Recorded comparison

Baseline source: `18b28f1261ad7bc91282ce4fa7c5004296503bb5`. Candidate compiled tree SHA-256: `331a89ddd96ea3683e973f291df413ad522805da8c89fd3d76b4d4817e0cc0e0`. [results.json](results.json) records every measurement, source/build digest, Node version, worker count, and the driver checkout SHA. The candidate was measured before its final commit; its compiled-tree digest identifies the tested implementation. The baseline build is independent of the driver checkout SHA.

Linux x64, Node 22.23.3, two parser workers, zstd level 3. The host was a shared container with concurrent test suites; these timings are observations, not an isolated-host performance claim. The synthetic corpus has 1,024 TypeScript files with 21 functions each and chained imports. The real corpus contains the 1,126 TypeScript source files archived from the baseline `gitnexus/src/`.

Wall times below are medians of three fresh processes, including parser-cache save.

| Corpus | Scenario | Baseline seconds | Per-file seconds | Baseline reparses | Per-file reparses |
| --- | --- | ---: | ---: | ---: | ---: |
| synthetic | cold | 15.60 | 16.96 | 1024 | 1024 |
| synthetic | warm | 4.25 | 4.48 | 0 | 0 |
| synthetic | edit | 5.49 | 5.71 | 8 | 1 |
| synthetic | two-edits | 5.21 | 5.63 | 13 | 2 |
| synthetic | repack | 18.46 | 4.98 | 1022 | 0 |
| real | cold | 75.66 | 85.18 | 1126 | 1126 |
| real | warm | 29.32 | 23.49 | 0 | 0 |
| real | edit | 33.96 | 29.30 | 14 | 1 |
| real | two-edits | 28.86 | 29.99 | 24 | 2 |
| real | repack | 114.88 | 30.43 | 1126 | 0 |

| Corpus | Cold cache baseline | Cold cache per-file | Files baseline / per-file | Final process RSS baseline / per-file |
| --- | ---: | ---: | ---: | ---: |
| synthetic | 79.33 MiB | 6.64 MiB | 258 / 4 | 982 / 835 MiB |
| real | 285.96 MiB | 28.82 MiB | 263 / 4 | 2018 / 1945 MiB |

All baseline/candidate graph digests match for each corresponding scenario in both corpora. Unchanged and repacked candidate runs start no worker pool. Single-file and two-file edits dispatch exactly one and two files respectively. The larger corpus drops from about 286 MiB to 29 MiB of parser cache. Whole-repository resolution still runs, so fewer reparsed files do not imply proportional end-to-end speedups.

Individual wall-time observations, in seconds:

| Corpus | Revision | Cold | Warm | One edit | Two edits | Repack |
| --- | --- | --- | --- | --- | --- | --- |
| synthetic | baseline | 15.60, 18.70, 14.16 | 4.26, 4.25, 3.74 | 6.15, 5.49, 4.93 | 5.79, 5.20, 5.21 | 19.40, 18.46, 16.55 |
| synthetic | candidate | 17.34, 16.96, 15.34 | 4.48, 4.81, 3.88 | 5.71, 6.56, 4.79 | 5.63, 7.08, 4.63 | 4.98, 7.13, 4.47 |
| real | baseline | 75.66, 68.26, 85.90 | 24.69, 29.32, 33.55 | 29.02, 33.96, 37.93 | 26.58, 28.86, 37.07 | 112.73, 114.88, 168.74 |
| real | candidate | 85.18, 88.38, 64.29 | 27.31, 21.96, 23.49 | 30.78, 24.51, 29.30 | 33.69, 24.61, 29.99 | 31.06, 24.79, 30.43 |

An earlier synthetic comparison separated baseline and candidate measurements in time. It showed a cold/warm timing increase during heavier host contention; the raw observations are retained under `earlierSyntheticNoncontemporaneous`. The table uses a subsequent alternating baseline/candidate series on the same final artifact. The real-source series also has substantial timing spread. Use the reparse counts, graph equality, and cache sizes as the deterministic results; repeat timings on an idle machine before making deployment-specific latency claims.

## Regression coverage

The original real-worker four-file same-bucket reproduction reparsed all four files after one edit. The regression failed with expected `1`, received `4` before integration, and passes with per-file reuse. `file-results-reuse.test.ts` also checks add/delete/rename/repacking, full graph equality with PDG on/off and multiple languages, and isolated facts/scope corruption. Worker, store, publication, quarantine, identity, and real process-exit recovery suites cover the persistence and failure paths.

Format changes cause one cold parse. Per-file keys bind path, contents, parser identity, and effective extraction options. Facts and scopes have separate bounded compressed sections with runtime, binding, length, and checksum validation. Selected scope packs are pinned for the run; publication copies validated compressed records under the existing lock and preserves sibling entries and staged-repair precedence.
