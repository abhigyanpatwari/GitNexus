# Deterministic tool accuracy

This small release corpus implements the cheap tool-level checks proposed in
[discussion #3493, comment 18772530](https://github.com/abhigyanpatwari/GitNexus/discussions/3493#discussioncomment-18772530).
The fixed answers come from local fixture source and public issue repros; the
current engine output never defines the expected answer.

With the repository's dependencies installed, run from `gitnexus/`:

```bash
node --import tsx bench/tool-accuracy/run.ts --check --out bench/tool-accuracy/results
npm test -- test/unit/tool-accuracy-score.test.ts
```

The runner uses the real `runPipelineFromRepo`, CSV/database loader, metadata
writer and `LocalBackend.callTool`. It indexes one small temporary TS/Python
repository with PDG enabled and one parser worker. Community/process discovery
is unnecessary for these checks and is disabled. Native parser workers require
the normal build produced by `npm ci`; run `npm run build` after worker changes.
The registry, database and fixture copy are isolated and removed after the run.
Fixture code is parsed, never executed. Extension installation is disabled,
accidental JavaScript fetches fail, and neither embeddings nor paid models run.

`accuracy.json` contains source SHA, working-tree status, fixture SHA-256, issue
IDs, expected/actual answers, precision/recall and raw tool outputs.
`accuracy.md` gives the same fixed-answer verdicts and concise failed answers.
`--out` selects a report directory. Without `--check`, valid observations can be
reported while a new fixed-answer failure is investigated; execution/output
errors always exit nonzero. `--check` additionally enforces the regression gate.

| Fixture / checks                             | Public repro                                                                                                                                                                                         | Fixed-answer contract                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rename/`                                    | [#3486](https://github.com/abhigyanpatwari/GitNexus/issues/3486)                                                                                                                                     | All three Writer.close references; zero edits to comments, strings or unrelated homonyms.                                                                                                    |
| `src/server/`, `test/stub.test.ts`           | [#3487](https://github.com/abhigyanpatwari/GitNexus/issues/3487)                                                                                                                                     | Server beats a same-path test stub; `app.all` has method `*`; Map.get is absent; helper-registered literal route is present.                                                                 |
| `src/web/`                                   | [#3488](https://github.com/abhigyanpatwari/GitNexus/issues/3488)                                                                                                                                     | Both the base-URL template passed to a configured wrapper and a direct literal fetch link their consumer files.                                                                              |
| `src/security.ts`, `src/server/inline.ts`    | [#3489](https://github.com/abhigyanpatwari/GitNexus/issues/3489), [#3490](https://github.com/abhigyanpatwari/GitNexus/issues/3490), [#3491](https://github.com/abhigyanpatwari/GitNexus/issues/3491) | Named and inline unsafe handlers reach the sink; guarded and constant commands have zero taint; statement and function-hop lines are 1-based.                                                |
| `pkg/`                                       | [#3497](https://github.com/abhigyanpatwari/GitNexus/issues/3497)                                                                                                                                     | Direct, chained module-return helper and local module-return helper resolve to the same target.                                                                                              |
| `mod.py`, `callers.py`                       | [#3498](https://github.com/abhigyanpatwari/GitNexus/issues/3498)                                                                                                                                     | Direct, conditional, boolean and module-qualified annotated factories resolve to C.m.                                                                                                        |
| `nested*.py`, `local_import.py`              | [#3499](https://github.com/abhigyanpatwari/GitNexus/issues/3499)                                                                                                                                     | Imports resolve within their lexical scopes; unrelated nested declarations and sibling-local imports cannot capture bare calls.                                                              |
| `summary.py`, 501 deterministic drop records | [#3497](https://github.com/abhigyanpatwari/GitNexus/issues/3497)                                                                                                                                     | Production `summarizeUnresolvedReceivers` retains 500 names and reports one omitted name; querying a capped-out name requires `lower-bound`, while a complete empty summary permits `exact`. |

The 501-name case supplies known suppressed outcomes to the production summary
writer, persists its actual output as metadata and calls real `impact`. It tests
the cap/consumer contract without requiring 501 parser fixtures. It does not
claim parser coverage for those synthetic records. Python checks read actual
`context.outgoing.calls` symbol UIDs, preserving lexical/class ownership.

## Known gaps and repairs

The initial source baseline is
`dd096e690c06e5d54ab3595c63b83f15e04b6191`: **11/31 fixed answers pass, 20 fail**.
Main at `50aa4be3b2c2c9a1561fc44878e5d8f87b99d16e` repaired three #3487 route
checks and all four #3499 checks, and their allowances were removed: **18/31
pass, 13 fail**.
The JSON report records every desired and actual answer independently of gate
status. Callback and guard taint findings are currently documented limitations;
their stronger desired answers remain visible as known gaps.

`known-gaps.json` is an explicit, reviewed list of failing check IDs with issue,
reason and observed baseline answers. There is no wildcard, skip, automatic
baseline-update command or production-engine fix in this corpus. The gate:

- Rejects new failing checks, unknown/malformed allowances and missing/malformed
  tool outputs, exceptions, truncation and incomplete fixture extraction.
- Rejects a previously correct fact disappearing or a new incorrect fact
  appearing inside an existing gap. Partial repairs can still proceed.
- Rejects a passing check whose allowance remains: **remove the allowance in the
  PR that repairs the case**, so the fixed answer protects future releases.

Changing a fixture requires reviewing its fixed answers and the line anchors in
`FIXTURE_ANCHORS` (`expectations.ts`); the runner and a unit test fail when an anchor
no longer matches its fixture line. Broadening an allowance requires review of the actual repro;
never change an expected answer simply to match current output.
