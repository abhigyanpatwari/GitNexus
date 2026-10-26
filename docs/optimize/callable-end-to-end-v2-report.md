# Callable indexing: confirmed end-to-end improvement

The retained change reduces complete indexing time by **5.78% on the repository workload** and **5.87% on held-out declarations**, compared with PR #3726 before the identity optimization. Both comparisons pass the predeclared 3% paired improvement threshold and all graph/cache correctness checks. The same candidate also improves on the pre-refactor control.

## Change

The existing identity-guard subprocess samples up to 16 distributed metadata requests. It uses synchronous filesystem reads when the sample completes within 8 ms, avoiding thread-pool overhead on fast storage; otherwise it retains concurrent asynchronous batches. Sampling stops when the budget is exhausted. All requests still run, results retain their original order, and file states, symlink targets, directory inventories and before/after mutation checks are preserved. The subprocess boundary and direct-validator fallback remain in place.

This affects the subprocess path used for large guard sets on writable installations. It does not remove method-extractors: the original refactor shares pure declaration facts while each consumer keeps its graph/resolution responsibilities.

## Complete indexing measurements

Each cell is baseline → candidate, in seconds. Values are medians of three alternating pairs. A total is the median of each process's cold + warm + changed runs, so it need not equal the sum of the three column medians.

| Workload     | Baseline     |            Cold |          Warm | One file changed |           Total | Total reduction |
| ------------ | ------------ | --------------: | ------------: | ---------------: | --------------: | --------------: |
| Repository   | Pre-refactor | 13.992 → 13.645 | 4.512 → 4.044 |    5.592 → 5.228 | 23.961 → 22.964 |           4.16% |
| Repository   | Initial PR   | 13.972 → 13.498 | 4.538 → 4.012 |    5.565 → 5.226 | 24.159 → 22.762 |           5.78% |
| Declarations | Pre-refactor |   9.821 → 9.103 | 2.620 → 2.331 |    3.530 → 3.203 | 15.987 → 14.624 |           8.52% |
| Declarations | Initial PR   |   9.369 → 9.112 | 2.626 → 2.321 |    3.562 → 3.228 | 15.601 → 14.686 |           5.87% |

Versus the initial PR, warm runs improve by 11.59% on the repository workload and 11.63% on held-out declarations. Changed-file runs improve by 6.09% and 9.39%, respectively. Cold medians are lower, but the paired cold result does not establish a consistent improvement above 3%. No required objective violates its 3% regression limit.

Every repository pair improves total time by more than 4% versus the pre-refactor control and more than 5.6% versus the initial PR. Held-out pairs improve by more than 5.2% and 5.8%, respectively. Identical-runtime A/A total variation is −0.83% to +1.12% for the repository corpus and −2.38% to +0.60% for declarations.

[Repository run](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40271406528) and [held-out run](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40272393865) both succeeded. [Machine-readable measurements](callable-end-to-end-v2-results.json) preserve all metric samples, correctness receipts, source identities, runner metadata and decisions.

## Reproduction and measurement boundaries

- Control: `f759753794fda8e399d670ef7f04b9d7473d6082`; initial PR: `b31dfb73c368f3d1254cfafb6eb6b2ed7453e221`.
- Candidate: the initial PR plus the [tested patch](https://github.com/abhigyanpatwari/GitNexus/blob/4b274ae0645d185b91ee1d1f94000d2ee3e634e2/docs/optimize/callable-end-to-end-experiment/candidate.patch).
- The [temporary experiment workflow](https://github.com/abhigyanpatwari/GitNexus/blob/58db59f0e2936757179bdb22575ba203e2319f5f/.github/workflows/callable-end-to-end.yml) builds all three revisions with the same installed dependencies, then runs the frozen benchmark serially on a dedicated Ubuntu runner with four CPUs and Node 22.23.3. It is kept on the experiment branch, outside the product PR.
- The benchmark uses one real parser worker, a 128 MiB database buffer pool, full graph persistence, and cold/warm/one-file-change scenarios. FTS and embeddings are disabled. Shared index storage is disabled.
- Every child gets a fresh private `XDG_RUNTIME_DIR`. Identity caches live outside `GITNEXUS_HOME`; isolating only the repository would leave rebuild-dependent cache asymmetry. The workload and measurement code were frozen before selection; the declaration holdout ran only after selection qualified.
- Across both runs, 108 complete analyses preserve structural graph hashes. Warm runs reparse zero files, and changed runs reparse exactly one. Community/process clustering output is excluded from structural hashes because it is nondeterministic.
- These are two fixed workloads, not a guarantee for every repository or filesystem. Earlier shared-host timings were inconclusive and are not the basis for this claim.

## Validation and rejected alternatives

Build, production/test typechecks, formatting and scoped ESLint pass. The final candidate passes 242 tests across 12 files, including the new I/O-route tests, identity invalidation/symlink tests, packaged-parser identity test, setup tests and native rename tests. The new tests exercise ordered results beyond a batch boundary, missing/invalid paths, symlinks, and directory mutation rejection on both I/O paths.

An earlier full local suite reported 28,404 passes, 89 skips, six failures and a native-worker abort. Every failing file and the aborting file passed the 242-test follow-up with inherited `CODEX_HOME` removed from that test process and an already available compatible libstdc++. No package dependency changed. The full suite was not rerun locally; its earlier failure remains recorded.

The parent-map/source-range experiment passed 219 focused tests but did not improve overall time and failed its warm-run gate; it was reverted. Leaf-operand fast paths passed 31 tests and reduced native field reads by 15.7%, but extraction time did not improve; they were also reverted. Neither parser experiment is included in the retained change.

Impact analysis identifies identity validation as HIGH risk upstream of analysis/status/finalization. Review checked the real subprocess script, all probe modes, its callers and the direct fallback. Sequential review followed the repository's no-subagent mapping; no independent model review is claimed. The change preserves cache formats and validation checks and needs no migration.

Graph change analysis was rerun after staging. It maps the runtime change but remains partial because the new test file is absent from the baseline index. The test is checked by its executed Vitest cases and direct call-site review; the empty graph caller count is not treated as an all-clear.
