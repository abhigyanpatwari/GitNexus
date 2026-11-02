# PL/SQL parse-throughput bench

`measure.mjs` times `extractPlSqlFacts` (SQL\*Plus/conditional-compilation
pre-pass, `/` segment split, ANTLR SLL→LL parse, fact extraction) on a
synthetic package body of 60 and 240 subprograms, after one warm-up pass.

```sh
node --import tsx bench/plsql-parse/measure.mjs          # print JSON
node --import tsx bench/plsql-parse/measure.mjs --check  # CI guard
```

`--check` gates correctness and shape, not absolute speed:

- **fingerprint**: sha256 over the facts of every `lang-resolution/plsql-*`
  fixture file plus a 20-subprogram synthetic body. Re-baseline
  `baselines.json` only for an intended facts change.
- **synthetic bodies** parse with no erroneous or timed-out segment.
- **scaling ratio** `(t_240 / t_60) / (lines ratio)` stays under 1.5. About
  1.0 is linear; a quadratic regression shows up near 4.0.

## Measurements

Apple Silicon laptop, Node 25, single thread.

| Input                                                                                                                  | Lines   | Result                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| Synthetic body, 60 subprograms, cold (first parse in the process)                                                      | 783     | 677 ms                                                                                    |
| Synthetic body, 60 subprograms, warm                                                                                   | 783     | 125 ms/kLOC                                                                               |
| Synthetic body, 240 subprograms, warm                                                                                  | 3,123   | 116 ms/kLOC (scaling ratio 0.93)                                                          |
| Corpus: utPLSQL, Logger, Alexandria, OOS-Utils, Oracle sample schemas (618 claimed files, one process, one cold start) | 121,292 | 58–62 s end to end through `processPlSql` (about 490 ms/kLOC), 0 segments at the deadline |

The corpus is not vendored; the processor-level number is a manual
measurement to compare against. It roughly doubles on a machine under memory
pressure, so compare runs taken back to back. Real code costs more per line than the
synthetic body: deeper expressions, more SQL and more LL fallbacks.

Parsing runs on the main thread inside the `plsql` phase and facts are not
cached across runs (PLSQL-07 in `docs/languages/plsql-ingestion-gaps.md`).
