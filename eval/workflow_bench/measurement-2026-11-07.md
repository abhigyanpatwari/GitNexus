# Agent comparison started 7 November 2026

[Release evaluation run 42377890515](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42377890515) completed with workflow conclusion **success**.
Run record updated at 2026-11-07T17:29:14Z. Attempt 1; dispatched at 2026-11-07T13:38:32Z.

## Superseded run

The earlier `gpt-5.6-sol/xhigh` evaluation in [run 42373957594](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42373957594/attempts/1)
was force-cancelled as requested. A shutdown-only retry verified EC2 stopped at 13:37:38 UTC before the Terra restart. Its [partial artifact](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42373957594/artifacts/13576197271)
is separate historical evidence and is excluded from the Terra comparison below.

## Protocol and evidence

- Candidate runtime and harness: `4ab9e8a48849daab417ccaab7268c946f62ca644`.
- Stable comparator: `v1.6.12`, `c4ecf398de637cf779ab2238e69958cfd5d601ce`.
- Model: `gpt-6.1-terra`, reasoning effort `xhigh`.
- Four release tasks, three repetitions per task and arm, for candidate and stable: 48 planned cells.
- Arms: `baseline_nomcp` and MCP `baseline`, with eager tool loading; optional experiments disabled.

[Source artifact](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42377890515/artifacts/13582479568)
was downloaded and its SHA-256 matched GitHub's artifact digest.

Both original reports passed the validator from the pinned harness, including all 48 unique
cells, task/oracle/dependency bindings and isolation receipts (`none` versus `stdio-only`).

## Results

| Runtime   | Arm         | Solved | Mean reported model cost | Mean agent time |
| --------- | ----------- | ------ | ------------------------ | --------------- |
| Candidate | No GitNexus | 12/12  | $2.3030                  | 526.0s          |
| Candidate | MCP         | 10/12  | $2.4666                  | 400.2s          |
| Stable    | No GitNexus | 12/12  | $2.2927                  | 456.1s          |
| Stable    | MCP         | 8/12   | $2.4467                  | 398.6s          |

Each task below has three repetitions per arm. Changes compare MCP with its own no-GitNexus arm.

| Runtime   | Task                               | No-GitNexus solves | MCP solves | Cost change | Agent time change |
| --------- | ---------------------------------- | ------------------ | ---------- | ----------- | ----------------- |
| Candidate | `trivial-status-json-alias`        | 3/3                | 3/3        | +37.8%      | -20.1%            |
| Candidate | `inv-feature-c-include-provenance` | 3/3                | 3/3        | -22.4%      | -54.4%            |
| Candidate | `inv-feature-list-repos-filter`    | 3/3                | 1/3        | +37.9%      | +44.1%            |
| Candidate | `cross-module-parse-retry`         | 3/3                | 3/3        | +15.7%      | +11.3%            |
| Stable    | `trivial-status-json-alias`        | 3/3                | 3/3        | +38.6%      | +7.6%             |
| Stable    | `inv-feature-c-include-provenance` | 3/3                | 2/3        | +64.9%      | -8.5%             |
| Stable    | `inv-feature-list-repos-filter`    | 3/3                | 1/3        | +36.5%      | +16.1%            |
| Stable    | `cross-module-parse-retry`         | 3/3                | 2/3        | -25.1%      | -36.0%            |

The release gate checks per-task solve counts against stable. It does not require savings
or improved accuracy against no GitNexus. See the workflow summary for its decision.

## Retained measurements

[measurement-2026-11-07.json](measurement-2026-11-07.json) retains every available cell,
including outcomes, costs, token counters, timing and isolation receipts. Only detailed
`session_diagnostics` are omitted; the source artifact retains those diagnostics. Original
report hashes and the source artifact checksum identify the provenance. This extract is
descriptive data and cannot approve a release.

To recompute the means and task differences, use the standard-library calculation in the
[1 November report](measurement-2026-11-01.md#retained-measurements-and-reproduction),
changing its JSON filename to `measurement-2026-11-07.json`. Its completeness assertions
intentionally reject incomplete evidence.

## Limits

Costs are session-reported model estimates, not provider invoices. They exclude indexing,
grading and infrastructure. Agent time excludes setup and grading; per-cell timings remain
in the JSON when available. Four tasks in one repository do not establish statistical
significance, general savings or small-model parity. This is a workflow comparison, not a
SWE-bench slice. It does not rerun the deterministic tool-accuracy corpus.

Keep this run separate from the [1 November comparison](measurement-2026-11-01.md).
Harness and dependency changes prevent attributing cross-date differences solely to the runtime.
[Issue #3500](https://github.com/abhigyanpatwari/GitNexus/issues/3500) remains open for broader evaluation.
