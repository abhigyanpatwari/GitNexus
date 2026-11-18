# Java ingestion measured results

2026-11-16, macOS arm64, Node 26.9.0, Apple M5 Pro. Original source: `26636d7a058d32c165999ab5f28a8a2540f50df5`. The changed runtime is pinned by build/dependency digests in [evaluation.json](evaluation.json); it was measured from the working implementation before commit.

Both builds use the same source/expectation fingerprints. `--full` takes the minimum of 15 capture samples after two warmups and three cold-pipeline samples after one warmup. Capture excludes parsing; pipeline includes real worker parsing and resolution, with database writes, communities and process extraction excluded. Other validation jobs were idle.

| Shape | Original exact cases | Changed exact cases |      Capture ms | Cold pipeline ms | Pipeline change |
| ----- | -------------------: | ------------------: | --------------: | ---------------: | --------------: |
| small |              205/405 |             405/405 |   192.2 → 264.6 |    714.3 → 761.9 |           +6.7% |
| large |             805/1581 |           1581/1581 |  741.7 → 1015.6 |  1779.9 → 2076.6 |          +16.7% |
| dense |            1029/2029 |           2029/2029 | 1047.7 → 1505.0 |  2495.1 → 2980.2 |          +19.4% |

All 4,015 case evaluations pass across the three nested workload shapes. These counts describe this synthetic corpus, with reused cases across shapes. They do not establish general Java accuracy or compiler completeness. Every current check retains exact targets, independent forbidden-target checks and workload fingerprints.

The first implementation passed the growth budgets but spent 44–79% more cold-pipeline time than the original. A work-count probe found 10/30 files re-extracted, of which eight had identical scopes, definitions, references and capture facts. Narrowing only the verification trigger reduced re-extraction to the two changed files. Capture, exact-target and full graph fingerprints stayed identical; cold-pipeline time fell 26–33% relative to that implementation. The remaining measured pipeline cost is 7–19% above the original. Capture cost remains about 37–44% higher.

All four normalized growth metrics pass the 2.0 budgets. A separate `--full --record` and `--full --check` also pass. Absolute old/new timings are reviewed observations; the automatic performance gates constrain same-run growth, rather than an absolute latency SLA. Full samples and repeated-run observations are retained in [evaluation.json](evaluation.json).

## Review follow-up

The table above is the original measurement. Review follow-ups changed one case family: the two `P4 local element identity` cases (formerly "local element proof refusal") now expect the block-local `User` class (`LocalElement$1User` / `LocalElement$2User`) instead of an empty set, since a local class in scope wins over the import (JLS 6.3). Positive/negative case counts move by two per shape (small 262/143 → 264/141). The baseline was re-recorded with `--full --record` and passes `--check`; no other capture, target or graph fingerprint changed for this corpus. [evaluation.json](evaluation.json) keeps the original run unchanged.

## Existing gates

- Receiver resolution: both arms pass after a measured baseline update. Java `indexElement` changes from `VISIBLE-GAP` to `RESOLVES`; non-Java shape/count entries remain unchanged.
- Java Lombok synthesis: exact 2,000/6,400-method fingerprints and its growth gate pass.
- Java overload resolution: 128/512/2,048-unit spread/concentrated workloads pass exact call-target, cache-count and normalized scaling checks across cold/warm/changed scenarios (three samples).

## Receiver count-arm accounting

Java call-drop receipts increase from 50 to 63 in the unchanged combined corpus. [receiver-delta.json](receiver-delta.json) preserves all 13 exact sites, caller IDs, old/new target IDs and receipts. No new source references were introduced: both analyses checked 2,010 sites.

Nine existing JDK container calls now report unresolved receivers because declaration typing retains `List`, `Map` and `Optional`, rather than replacing them with their elements. Those nine had no graph edges in either runtime. Four foreach calls refuse imported FQNs in the combined corpus, which contains 26 `models.User` and 13 `models.Repo` declarations. Both original and changed runtimes retain all four exact targets, with zero call drops, when each fixture is indexed separately. The resolver does not invent module boundaries to select an owner from that invalid combined Java workspace.

## Reproduce

Follow [README.md](README.md) to build/select both runtimes, run `--full --observe` for the original and `--full` for the changed build, review the results, then explicitly record/check the baseline. Keep timing runs serial and idle. Conservative inference limits and excluded pipeline phases are stated there.
