# Agent comparison started 7 November 2026

Results are pending. This records the new run requested for
[issue #3500](https://github.com/abhigyanpatwari/GitNexus/issues/3500); it does not
add a measured result to the [1 November evidence](measurement-2026-11-01.md).

## Run and protocol

- [Release evaluation run 42373957594](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42373957594),
  attempt 1, dispatched on 7 November 2026 at 12:46:28 UTC.
- Candidate runtime and trusted main harness:
  `4ab9e8a48849daab417ccaab7268c946f62ca644`.
- Stable comparator: the workflow resolves the latest published stable release
  at execution time. At dispatch, that release was `v1.6.12`.
- Model: `gpt-5.6-sol`, reasoning effort `xhigh`.
- Four existing release tasks, three repetitions per task and arm, for both
  candidate and stable: **48 planned cells**.
- Arms: `baseline_nomcp` and MCP `baseline`, with eager tool loading. The
  optional CLI-only, deferred-loading and diagnostic-trial experiments are off.

The EC2 startup and runner-online checks passed. The workflow builds isolated
candidate/stable runtimes and checks containment before paid sessions. Its
existing cleanup job stops and verifies the dedicated runner when the run ends.

## Evidence to retain

The workflow writes sanitized reports, per-cell diagnostics and a release gate
to its summary and the `release-agent-evaluation-4ab9e8a48849daab417ccaab7268c946f62ca644`
artifact. Once those outputs exist, retain the measured cells with their exact
runtime/harness/task/oracle bindings and isolation receipts, and recompute the
solve counts, reported model costs and timings before adding conclusions here.

Incomplete or unsuccessful outcomes belong in the record. This remains a
four-task workflow comparison in one repository, not a SWE-bench result or a
basis for general accuracy or savings claims.
