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

The table preserves the original grading results. The [investigation below](#investigation)
found that the repository-filtering oracle bypasses the public MCP policy wrapper and
rejects a working implementation at that boundary. The recorded 10/12 versus 12/12
therefore does not establish a behavioral regression; these historical rows have not
been rescored.

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

## Investigation

### Repository filtering: the oracle tests a narrower implementation boundary

The task requests a `name_contains` parameter on the **MCP tool**, with filtering
before pagination. The [hidden oracle](https://github.com/abhigyanpatwari/GitNexus/blob/4ab9e8a48849daab417ccaab7268c946f62ca644/eval/workflow_bench/oracles/inv-feature-list-repos-filter.oracle.test.ts)
instead calls `LocalBackend.callTool` directly. The MCP server wraps that backend in
`McpRepositoryPolicy.scopeBackend`, which has its own repository-listing path.

Candidate repetitions 1 and 2 changed `repository-policy.ts` and `tools.ts`, leaving
`local-backend.ts` unchanged. Both passed their authored tests and typecheck but failed
the hidden oracle. The [evaluation job log](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42377890515/job/128421934470)
shows their final policy blob as `9c81614` (16:57:36 and 16:58:11 UTC). Stable
repetitions 1 and 2 show the same blob prefix at 15:15:10 and 15:15:13 UTC.

Reconstruction from the pinned task source and the visible diff produced policy blob
`9c81614948d4ebdb4455197b725da40ffa093355`, matching that logged prefix. Its dispatch
handles filtered calls before the unconfigured-policy fallback:

```ts
if (method === 'list_repos' && (this.configured || params?.name_contains !== undefined)) {
  return this.listReposPage(backend, params);
}
if (!this.configured) return backend.callTool(method, params);
```

An isolated reproduction at task revision `c4ecf398` used the reconstructed policy
and an optional string schema field corresponding to the submissions' `tools.ts`
change. Through `createMCPServer` and an MCP client connected by `InMemoryTransport`,
all original behavioral assertions passed: mixed-case matching, both pages, filtered
totals, `hasMore`/`nextOffset`, no matches, and no-filter compatibility. Restoring the
unmodified policy made this same public-surface test fail. The original backend-only
oracle still failed with the reconstructed policy, returning total 3 instead of 2.

This reproduces an oracle false negative for the requested MCP surface. It is not a
complete replay of the four submitted patches: public logs truncate diffs, and the
local reproduction used Vitest 5.0.5 with available dependencies rather than the
run's full dependency snapshot. Preserve the recorded outcomes and correct the
oracle boundary before drawing accuracy conclusions or spending on a replacement run.
The two other stable failures have not been explained by this reproduction.

### Cost: additional uncached context explains the reported difference

Candidate MCP used 121 graph calls, returning 520,437 bytes, with 109 calls before
the first edit in their respective sessions. It also made 242 source reads, including
100 following graph references; no GitNexus made 287 source reads. Repository filtering
alone used 35 graph calls and 53 source reads, versus 41 source reads without GitNexus.
Graph retrieval reduced some source reading but also added context and tool activity.

Every reported cell cost reproduces, to its four-decimal rounding, using weights of
$5 / $6.25 / $0.50 / $25 per million ordinary input / cache-creation input /
cache-read input / output tokens. These are weights inferred from the recorded CLI
estimates, not verified Terra billing rates. Candidate MCP's $1.9625 additional
reported spend decomposes as follows:

| Counter | MCP minus no GitNexus | Contribution under recorded cost weights |
| --- | ---: | ---: |
| Ordinary input | -4,518 | -$0.0226 |
| Cache-creation input | +640,026 | +$4.0002 |
| Cache-read input | -3,779,084 | -$1.8895 |
| Output | -5,017 | -$0.1254 |

Newly cached input increased 55.4%, outweighing fewer cached reads and output tokens.
The eager MCP arm exposed up to 23 tools, compared with 6 ordinary tools; provider
request telemetry reports serialized tool payloads between 13,161 and 64,627 bytes.
This supports testing tool-description and retrieval overhead. It does not isolate
which extra tokens came from schemas, instructions, or tool results. Provider telemetry
has no per-cell join, and its estimated cost is zero, so it cannot independently
confirm dollar savings or overhead. Both runtimes recorded zero failed provider
requests; the session diagnostics recorded zero API retries.

The aggregate time saving is concentrated in the C-include task. One no-GitNexus
repetition took 2,109.4 seconds, including 1,825.7 seconds waiting on tools. Across the
other three tasks, MCP took 13.5% longer and reported 21.3% more cost. These are
descriptive observations from three repetitions, not evidence of a general speedup.

### Overlap check against PR #3842

[PR #3842](https://github.com/abhigyanpatwari/GitNexus/pull/3842), checked at
`f3e687a55e947d0bfb47aa698f56dac0b82bbca6`, addresses analysis recovery, vector readiness,
and RAM admission. Its `local-backend.ts` changes concern checkpoint metadata and
per-query embedding-width diagnostics. The filtering oracle, task specification,
repository policy, MCP tool definitions, and release gate are byte-for-byte unchanged
between the measured revision, that PR head, and its base `423a79e6`.

That PR does not fix this oracle mismatch or change the cost measurement protocol.
Follow-up here should start with public-MCP oracle coverage, retaining a failing
unimplemented control and accepting both backend and policy-wrapper implementations.
Then use a bounded comparison to distinguish eager-tool overhead from retrieval and
instruction overhead. Analysis recovery and memory-admission changes remain #3842's
scope. No runtime or harness fix is included in this evidence update.

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
