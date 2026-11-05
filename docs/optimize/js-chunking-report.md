# JavaScript chunking measurements

The offset lookup change reduces repeated indexed calls into the existing tree-sitter binding. No dependency, native package, cache, parser-selection rule, or chunk-layout version changes.

The final normalized latency improvement is **7.36% on selection fixtures and 4.95% on held-out fixtures**. The original rule requires at least 5% on both sets, so the automatic decision remains **inconclusive**. After reviewing the measured result and validation, the user explicitly accepted the near-threshold improvement and authorized publication on 2026-11-05. This is a recorded acceptance exception, not a pass under the original rule.

## Final original-to-candidate comparison

Reference: `c15f48f0e855152273d5073a1c658bdfe45ba204`.
Candidate source SHA-256: `6945ab039b2656925dc2d9bb215a4d1baed9be847ccbadcba3a9cdf484e4d17f`.
The PR merged main as `8edb6aa60` during measurement. None of the four scoped embedding files or dependencies changed in that merge; production validation was repeated on that head.

| Set       | Reference control ratio | Candidate ratio | Normalized improvement | 5% gate         |
| --------- | ----------------------: | --------------: | ---------------------: | --------------- |
| Selection |                1.000613 |        0.926967 |                7.3601% | Pass            |
| Held out  |                0.991017 |        0.942005 |                4.9456% | Below threshold |

Each ratio is candidate aggregate time divided by the paired original revision. The table compares medians of five runs against the reference controls. Direct paired ratios and all five control values are recorded in [baseline.json](../../gitnexus/bench/embedding-chunking/baseline.json). Final selection ratios ranged from 0.893854 to 0.957175; held-out ratios ranged from 0.913070 to 0.943434. These are synthetic measurements on one shared Linux x64 machine with Node 22.23.3, not whole-index throughput claims.

Each run warms both revisions, calibrates batch size, and measures nine alternating baseline/candidate pairs per fixture. Garbage collection runs outside timed batches. Selection covers short functions, flat statements, nested statements, large arrays, long literals, Unicode, Python and classes. Held-out inputs cover switch statements, argument lists, C++ and CRLF source. Held-out feedback did not generate or tune further implementations.

## Experiments

| Change                              | Forecast                                        | Observed outcome                                                                                                                      |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bulk sibling handles                | 3–10% lower selection latency                   | 5.44% slower in exploration; reverted                                                                                                 |
| Offset lookup with bounded fallback | 5–9% lower selection latency                    | Initial confirmation: 6.78% selection / 5.73% held out. Fresh final confirmation: 7.36% / 4.95%; inconclusive under the original rule |
| Batch top-level callable children   | About 2% aggregate upper bound from the profile | Not selected; below the required improvement                                                                                          |

The offset variant initially changed output on sparse arrays and large overlap. Native offset lookup can skip a named child across punctuation-only subtrees; the candidate verifies the preceding sibling and falls back to indexed search. Its overlap lookup also stays within unprocessed siblings. Both safeguards have small real-parser regressions that fail when the corresponding safeguard is removed.

## Validation

- 48 exact-output configurations across selection and held-out inputs.
- 168 stress comparisons and 400 deterministic malformed-input comparisons match the original revision, including text, ordering, offsets and line ranges. The original frozen timing oracle did not cover all sparse-array and large-overlap cases; supplemental checks caught those gaps before acceptance. Future optimization runs should include them in the initial correctness gate.
- 151 focused tests pass on the updated PR head; execution audit reports zero errors, failures or unverified tests.
- Build, source/test typechecks and formatting pass. Repository-wide lint reports zero errors; existing warnings remain. The final changed-file lint also has zero errors.
- The full pipeline benchmark completed 25 cohorts / 400 pairs, and both native processes exited successfully before publication. Embedding input counts and character totals match the previous PR candidate in all cohorts. Refreshed diagnostic values are in `baseline.json`; the runner remains [measure.mjs](../../gitnexus/bench/embedding-chunking/measure.mjs), called directly from `.github/workflows/ci-tests.yml`.
- Source impact reaches `astChunk`, `chunkNode` and `runEmbeddingPipeline`. The source change analysis is LOW. Test-file callers are unresolved by the graph; Vitest discovery and the execution audit verify the test path. Global flow discovery is bounded, so this is not a complete PDG claim.

Before optimization, parsing accounted for about 73–80% of nested/array CPU samples and refinement for 11–13%. These are pre-change attribution figures; remaining opportunity has not been re-profiled. Top-level batching was estimated below the acceptance bar before held-out evaluation.

## Run record

The search ran for 47 minutes 21 seconds and stopped after two experiments without an accepted improvement. Three implementation variants were built: one reverted variant and two versions of the offset variant. Outcomes: kept 0, reverted 1, inconclusive 1, not selected 1, errors/timeouts/censored/deferred 0. No worker, judge or external scoring calls were made; session model cost is not exposed or dollar-capped. Production validation after the search is reported separately above.

After the search stopped, the user accepted the offset lookup variant with the instruction “nice push it.” One change is retained by that explicit exception: 7.36% improvement on selection fixtures and 4.95% on held-out fixtures. The original automatic decision and the search outcome counts above are preserved.

The local reproducibility ledger, frozen timing harness, oracle, raw samples, source patch and supplemental probes are under `.context/compound-engineering/ce-optimize/js-chunking/` in the PR workspace. The original baseline and final candidate are compared directly in the final records; no standalone gain is counted as an integrated contribution.
