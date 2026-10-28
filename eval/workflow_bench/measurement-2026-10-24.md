# Agent evaluation evidence, 24 October 2026

The latest completed comparison does **not** demonstrate an accuracy gain or
cost saving. Its MCP arm could read compiled code containing later task fixes,
so it also cannot isolate the effect of tool assistance.

## Historical measurements

[Release evaluation run 40015796596](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40015796596)
started on 23 October and completed on 24 October. The sanitized artifact is
`release-agent-evaluation-62a6f67083fcd1f85634a49b118b4faf3fd5198d`
(artifact ID `12541246950`). Both JSON reports contain all 24 expected cells;
their totals were independently recomputed from all 48 per-run records.
The [sanitized source reports](measurement-2026-10-24.json) are retained here
so these observations remain reproducible after the workflow artifact expires.

- Candidate: `62a6f67083fcd1f85634a49b118b4faf3fd5198d`.
- Stable runtime and task base: `c4ecf398de637cf779ab2238e69958cfd5d601ce`.
- Harness: `466d56280a37cb3dae9cdce8788937964824a3d5`.
- Model: `gpt-5.6-sol`, effort `xhigh`.
- Task-set digest: `51daf0758e8bafc30f0a9c94b254ee2b1592be1d569f2d64a7b3031ff7488c16`.
- Four tasks, three repetitions per arm. Both arms use the same task pins and
  hidden oracles; the no-GitNexus arm receives no supplied graph or tools.

| Runtime | Arm | Solved | Mean reported cost | Mean agent time |
| --- | --- | --- | --- | --- |
| Candidate | No GitNexus | 12/12 | $3.0913 | 617.0s |
| Candidate | MCP, readable runtime | 12/12 | $3.7592 | 585.4s |
| Stable | No GitNexus | 12/12 | $3.2524 | 756.2s |
| Stable | MCP, readable runtime | 12/12 | $4.7397 | 729.3s |

Candidate MCP cost increased **21.6%** and agent time decreased **5.1%**.
Stable MCP cost increased **45.7%** and agent time decreased **3.6%**.
Accuracy was unchanged in both comparisons. Cost comes from session reports,
not invoices; indexing, grading, and infrastructure are excluded. Three
repetitions on four development tasks do not establish significance or a
general product benefit. The release gate checks quality against stable; a
passing gate is not evidence of savings against no GitNexus.

## Deterministic tool accuracy

At source revision `d8a256a03a101a767dc4e1118913c679af740336`, the existing
tool-accuracy corpus passes **32/32**, with no allowances or execution failures.
This includes the Python receiver, lexical scope, and summary lower-bound
checks discussed in issues #3497–#3499. It verifies fixed tool answers, not
coding-agent success or cost.

Reproduce from `gitnexus/`:

```sh
node --import tsx bench/tool-accuracy/run.ts --check --out /tmp/tool-accuracy
```

The local run needed a compatible C++ runtime to load the native parser. Its
first attempt could not load `GLIBCXX_3.4.31`; that attempt was an execution
failure, not a measured tool result.

## Corrected comparison and remaining work

The harness correction moves the release baseline's MCP runtime into a
sibling read-only sandbox. The coding agent receives only a stdio socket.
Host-generated rows record `runtime_exposure`, and release/PR validation
rejects missing or incompatible receipts. Workflow arms that intentionally
expose the CLI retain their different boundary.

The protected Release evaluation workflow executes main's trusted harness,
including PR previews. A fresh isolated comparison therefore requires this
correction to merge first. After merge, dispatch `release-evaluation.yml` on
`main` with `candidate_ref` set to the full merged commit SHA, model
`gpt-5.6-sol`, effort `xhigh`, and `runner_only=false`. The existing workflow
runs all four tasks three times per arm for candidate and stable, publishes
sanitized reports, and stops its runner.

Verify all 48 unique cells, the exact runtime/harness/task bindings, both arm
receipts, unsuccessful outcomes, and cost/time totals. Publish the result even
if it shows no gain. Historical artifacts cannot substitute for this run.

Keep [issue #3500](https://github.com/abhigyanpatwari/GitNexus/issues/3500)
open until the clean measurement is published. A broader SWE-bench or reporter
corpus, including separate fresh/stale-index conditions, remains necessary
before making claims beyond this small task set. The reporter paused their
rerun offer in [discussion #3493](https://github.com/abhigyanpatwari/GitNexus/discussions/3493#discussioncomment-18772530).
