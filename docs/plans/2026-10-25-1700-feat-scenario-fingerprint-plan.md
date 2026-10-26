---
title: Scenario fingerprint — mutation-free duplicate verdicts for the test scenario map
date: 2026-10-25
status: implemented
origin: docs/plans/2026-10-23-test-scenario-map-design.md
branch: feat/test-dupe-detector (PR #3686)
---

# Scenario fingerprint

## Problem

Two tests are duplicates when they run the **same execution path** on the **same input data** and
check the **same expectation** (maintainer definition, 2026-10-25). The scenario map decides
repeats from mutation kill sets: about 4 h and 30 runner-hours per full run, and most pairs end
Inconclusive on runtime-class kills and hangs.

## Evidence (run 40208819019, verdict engine 3, mutation as reference)

- Pairs whose V8 block sets are identical, whose checks-and-context keys match, whose input facets
  and discarded values are equal with nothing unresolved, and whose trace is clean: **26**.
  Mutation calls 13 of them strong repeats (all 13 of the run); the other 13 it could not decide
  (timeouts, runtime-class kills), and their titles show the same input and expectation. **None**
  is Distinct or Row.
- The static `same-test` scan flags 25 of the 26; the one it misses is a renamed clone
  (`method-props.test.ts` lines 47 and 185, `findString` renamed `findStr`).
- Every triple-equal pair whose kills differ carries an unresolved input (`it.each` rows whose
  value only shapes filesystem state): the fail-closed rule already holds them out.
- Mutation is only informative where inputs are unresolved: 1,066 pairs in 38 groups, about
  1.4 h of the 42.9 h estimated cost.

## Decisions

- **F1 (maintainer):** the fingerprint is the primary verdict; mutation is optional evidence.
- **F2 (maintainer):** the weekly run is fingerprint only; mutation runs on manual dispatch.
- **F3 (maintainer):** a labelled pull request (`scenario-map`) gets the deep run (fingerprint
  plus mutation over the possible duplicates); no automatic PR run.
- **F4 (maintainer):** optimise the deep run as far as possible and measure it locally, not on CI.
- **F5:** different input data is not a duplicate. A pair with equal shape and different values
  is a table-row candidate, decided without mutation.
- **F6:** an input the static extraction cannot resolve, a missing facet or checks key, a residual
  body difference, an unsupported construct, or a trace that is not clean makes a pair at most a
  possible duplicate, never a duplicate (fail-closed, design R2, D1).
- **F7:** the deep run mutates only groups with a possible duplicate, and in each such group only
  the tests of those pairs, over the files those tests executed.

## Fingerprint verdicts (pure, `verdict/fingerprint.ts`)

Per candidate pair, first rule that holds:

| Verdict            | Rule                               | When                                                                 |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------- |
| out-of-scope       | `not-eligible`                     | a test is outside the eligible category                              |
| inconclusive       | `path-unattributable`              | a test ran concurrently                                              |
| distinct           | `path-differs`                     | the V8 block sets differ                                             |
| possible-duplicate | `checks-unknown` / `facet-unknown` | a checks key or facet is missing and nothing known differs           |
| different-checks   | `same-input-different-checks`      | same path and input (equal, resolved), checks differ                 |
| distinct           | `checks-differ`                    | checks differ otherwise                                              |
| distinct           | `input-shape-differs`              | facet fingerprints differ                                            |
| table-row          | `input-values-differ`              | same shape, discarded values differ                                  |
| table-row          | `runtime-values-differ`            | equal static values, trace veto                                      |
| possible-duplicate | `input-unresolved`                 | equal, with an unresolved input (F6)                                 |
| possible-duplicate | `trace-unknown`                    | equal and resolved, trace not clean (inconclusive, missing, not run) |
| duplicate          | `same-path-input-expectation`      | everything equal, resolved, trace clean                              |

A `// dupe-ok:` reason on either test moves the pair to `kept`.

## Units

- **U1** `verdict/fingerprint.ts` and its tests (one case per rule).
- **U2** report: `fingerprint` section and `mutation` scope; markdown and issue body lead with
  duplicates and possible duplicates; weak tests and gaps only when mutation ran. Report schema
  bump.
- **U3** CLI: `--mutation none|possible-duplicates|all` on `plan` and `all`; value flow skips the
  PDG static check unless `all`; the re-plan keeps only the groups F7 names, trimmed; merge
  computes fingerprints always and mutation verdicts only for the mutated pairs; zero shards is a
  valid plan.
- **U4** controls: fingerprint expectations in `expected.json`, written from the rules above
  before any run, and checked by the controls stage.
- **U5** workflow: weekly fingerprint; dispatch input `mutation`; `pull_request: labeled`
  (`scenario-map`) with mutation `possible-duplicates`; per-ref concurrency for PR runs; shard jobs
  skipped at zero shards; PR runs write no issue and no baseline.
- **U6** docs: design doc, workflow and CLI headers.
- **U7** local measurement (bounded, `nice -n 19`, concurrency at most 4): the full fingerprint
  run, and the deep run over the possible duplicates.

## Verification

`tsc` (src and tests), eslint, prettier, the scenario-map unit tests, the local controls run, and
U7's timings recorded in the design doc.

## Results (2026-10-25)

- U1-U5 committed on PR #3686. The controls fixture matches all 16 fingerprint and all 16 mutation
  expectations (local run, 43 min).
- Fingerprint-only run, all 4,632 eligible tests, locally: 8.2 min (plan 5.4, trace 2.6), 2 GB
  peak RSS. 26 duplicates (the 26 the evidence predicted), 109 possible duplicates in 17 groups,
  945 table rows, 5,184 distinct.
- Deep run over the possible duplicates, on CI (run 40268120818, the `scenario-map` label): 5 min 42 s
  end to end, the shard 1.3 min for 5 groups and 844 mutants. It settles 35 of the 38 possible
  duplicates mutation can reach (31 Row, 1 Distinct, 3 weak repeats; 3 Inconclusive); 71 test
  `tools/mutation/` code outside the mutation scope. Its merge missed the single shard artifact
  (unpacked into the download path itself); fixed in the workflow's placement step.

## Extension: every unit and integration test (maintainer, 2026-10-26)

The fingerprint needs no Stryker run, so its scope is no longer bound to the mutation runner's
validated category. **F8:** the fingerprint covers every `*.test.ts` under `gitnexus/test/unit`
and `gitnexus/test/integration`; mutation stays on the gate-validated pure-JS envelope.

- **E1** Eligibility carries `fingerprintFiles` besides the mutation-eligible `files`; a test's
  verdict input carries `eligible` (mutation), `fingerprintEligible` and `passed`.
- **E2** Layer 1 runs the base config's sequential `lbug-db` files with one worker, the rest with
  `--concurrency` workers, and joins both into one work file.
- **E3** The trace run uses the same two partitions.
- **E4** Fingerprint rule `not-passing`: a test that did not pass in Layer 1 makes its pairs
  Inconclusive. The mutation target keeps only pairs whose two tests are mutation-eligible.
- **E5** Measure Layer 1 on a sample of integration files locally; shard Layer 1 on CI when the
  whole set does not fit one plan job.
