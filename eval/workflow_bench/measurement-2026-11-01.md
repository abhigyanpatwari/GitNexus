# Isolated agent comparison, 1 November 2026

Both the MCP and no-GitNexus arms solved all 12 task repetitions. Candidate MCP
cost averaged 9.7% less and agent time 3.0% less, but the saving came from one
task. The other three tasks cost more and took longer with MCP. This four-task
workflow study shows no accuracy gain and does not establish general savings.

## Source and method

[Release evaluation run 41235067712, attempt 4](https://github.com/abhigyanpatwari/GitNexus/actions/runs/41235067712/attempts/4)
completed on 1 November. Its
[sanitized artifact](https://github.com/abhigyanpatwari/GitNexus/actions/runs/41235067712/artifacts/13083871407)
contains candidate/stable reports and diagnostics. The
[published issue update](https://github.com/abhigyanpatwari/GitNexus/issues/3500#issuecomment-6558998393)
records the result and earlier attempts.

- Candidate runtime: `67645411eba7405af9d430d5d8c730596611670b`.
- Stable v1.6.12 runtime and task base: `c4ecf398de637cf779ab2238e69958cfd5d601ce`.
- Harness: `82966afa64ec0cbd0e09084cf7af89067ccf0c2d`.
- Model: `gpt-5.6-sol`, reasoning effort `xhigh`.
- Task-set digest: `51daf0758e8bafc30f0a9c94b254ee2b1592be1d569f2d64a7b3031ff7488c16`.
- Four tasks in one repository, three repetitions per task and arm, for each
  runtime: 48 cells in total. The same hidden oracles grade both arms.

`baseline_nomcp` receives no supplied GitNexus tools, graph or runtime mounts.
MCP `baseline` receives a stdio connection to a runtime in a separate sandbox;
it cannot read that runtime's compiled task fixes. Both use Bubblewrap and the
ordinary repository guidance, with hooks and workflow skills disabled. The
agents retain the task's source and test dependencies. This measures access to
the supplied MCP tools on GitNexus development tasks, not a SWE-bench slice or
the reporter's corpus. It does not measure the plan/work skills.

Before archiving on 7 November, the original reports passed their exact harness
revision's validator, including task/oracle bindings and isolation receipts
(`none` versus `stdio-only`). The release gate passed because candidate MCP lost
no solved repetitions against
stable MCP. That gate does not require cost savings or improved accuracy over
no GitNexus.

## Results

Means include every repetition; each runtime/arm row contains 12 cells.

| Runtime        | Arm         | Solved | Mean reported cost | Mean agent time |
| -------------- | ----------- | ------ | ------------------ | --------------- |
| Candidate      | No GitNexus | 12/12  | $4.1179            | 668.5s          |
| Candidate      | MCP         | 12/12  | $3.7195            | 648.4s          |
| Stable v1.6.12 | No GitNexus | 12/12  | $3.5747            | 713.2s          |
| Stable v1.6.12 | MCP         | 12/12  | $3.4747            | 575.6s          |

Candidate MCP cost changed by **−9.7%** and agent time by **−3.0%** against its
no-GitNexus arm. Stable MCP cost changed by **−2.8%** and time by **−19.3%**.
Both comparisons have unchanged solve counts.

Candidate results by task, each solved 3/3 in both arms:

| Task                     | No-GitNexus mean cost | MCP mean cost | Cost change | Agent time change |
| ------------------------ | --------------------- | ------------- | ----------- | ----------------- |
| Status JSON alias        | $0.7077               | $1.1101       | +56.9%      | +115.4%           |
| C include provenance     | $4.8890               | $5.9373       | +21.4%      | +23.6%            |
| Repository-name filter   | $1.8029               | $2.5199       | +39.8%      | +20.1%            |
| Cross-module parse retry | $9.0720               | $5.3108       | −41.5%      | −42.6%            |

Without the parse-retry task, candidate MCP cost increases **29.3%**. Including
per-cell setup and grading reduces the candidate time saving to about **0.3%**,
before shared sweep setup. `duration_s` records agent time; `cell_duration_s`
includes those per-cell phases. Neither is total infrastructure time.

Cost is the session's reported model-cost estimate, not a provider invoice.
It excludes indexing, grading and infrastructure. The provider ledger could
not attribute charges to individual concurrent cells. Three repetitions on
four tasks in one repository do not establish statistical significance, a
general benefit, or parity between small and large models.

## Earlier attempts and remaining work

Attempts 1–2 failed during runner startup. Attempt 3 timed out with an incomplete
candidate set; its completed stable comparison recorded **28.2% higher MCP cost**
and **45.4% longer agent time**, with 12/12 solves in both arms. Those figures
come from recovered logs in the issue update; its artifact returned 404. They
are not pooled with attempt 4 and are not part of the retained JSON below.

The [24 October comparison](measurement-2026-10-24.md) had readable-runtime
contamination and remains separate historical evidence. The deterministic
32/32 tool-accuracy result recorded there checks fixed tool answers. This
agent comparison did not rerun that corpus and cannot substitute for it.

[Issue #3500](https://github.com/abhigyanpatwari/GitNexus/issues/3500) remains open.
A broader current-agent study against no GitNexus is still needed before making
general accuracy, cost, time or small-model claims. A SWE-bench slice or the
reporter's sanitized tasks would extend coverage; fresh and stale indexes must
be reported separately. The reporter's rerun offer remains paused in
[discussion #3493](https://github.com/abhigyanpatwari/GitNexus/discussions/3493#discussioncomment-18772530).

## Retained measurements and reproduction

[measurement-2026-11-01.json](measurement-2026-11-01.json) retains all 48 cells,
including outcomes, tokens, costs, timing, task/oracle/dependency pins and runtime
exposure receipts. It records the source artifact and SHA-256 hashes of the two
original reports. Only each cell's detailed `session_diagnostics` is omitted;
the artifact retains those diagnostics. This extract supports descriptive
recalculation after artifact expiry (30-day retention); it is not a complete
release-approval report.

Recompute the means and task differences with Python's standard library from
the repository root. This reads saved measurements and makes no model calls:

```sh
python3 - <<'PY'
import json
from pathlib import Path
from statistics import mean

data = json.loads(Path("eval/workflow_bench/measurement-2026-11-01.json").read_text())
for runtime, report in data["reports"].items():
    rows = report["per_run"]
    expected = {(t, n, a) for t in report["tasks"] for n in range(3)
                for a in ("baseline_nomcp", "baseline")}
    assert len(rows) == 24
    assert {(r["task"], r["run"], r["arm"]) for r in rows} == expected
    print(runtime)
    for arm in ("baseline_nomcp", "baseline"):
        cells = [r for r in rows if r["arm"] == arm]
        print(arm, f'{sum(r["resolved"] for r in cells)}/{len(cells)} solved',
              f'${mean(r["cost_usd"] for r in cells):.4f}',
              f'{mean(r["duration_s"] for r in cells):.1f}s')
    groups = [("all tasks", rows)]
    groups += [(t, [r for r in rows if r["task"] == t]) for t in report["tasks"]]
    groups += [("without parse retry", [r for r in rows
                                      if r["task"] != "cross-module-parse-retry"])]
    for name, cells in groups:
        changes = {}
        for metric in ("cost_usd", "duration_s", "cell_duration_s"):
            base = mean(r[metric] for r in cells if r["arm"] == "baseline_nomcp")
            mcp = mean(r[metric] for r in cells if r["arm"] == "baseline")
            changes[metric] = f"{100 * (mcp / base - 1):+.1f}%"
        print(name, changes)
PY
```

To collect a new comparison, follow the
[Release evaluation procedure](README.md#current-workflow). Pin the runtime,
harness, tasks and model; retain every attempted cell and report unsuccessful
outcomes. A new run incurs model and runner costs and measures those new pins,
not a reproduction of these stochastic session outcomes.
