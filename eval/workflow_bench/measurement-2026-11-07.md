# Agent comparison started 7 November 2026

Results are pending for the replacement Terra run. This records the comparison requested for
[issue #3500](https://github.com/abhigyanpatwari/GitNexus/issues/3500); it does not
add a measured result to the [1 November evidence](measurement-2026-11-01.md).

## Run and protocol

- [Release evaluation run 42377890515](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42377890515),
  attempt 1, dispatched on 7 November 2026 at 13:38:32 UTC.
- Candidate runtime and trusted main harness:
  `4ab9e8a48849daab417ccaab7268c946f62ca644`.
- Stable comparator: the workflow resolves the latest published stable release
  at execution time. At dispatch, that release was `v1.6.12`.
- Model: `gpt-6.1-terra`, reasoning effort `xhigh`.
- Four existing release tasks, three repetitions per task and arm, for both
  candidate and stable: **48 planned cells**.
- Arms: `baseline_nomcp` and MCP `baseline`, with eager tool loading. The
  optional CLI-only, deferred-loading and diagnostic-trial experiments are off.

The workflow checks runner readiness, builds isolated candidate/stable runtimes
and checks containment before paid sessions. Its
existing cleanup job stops and verifies the dedicated runner when the run ends.

## Superseded run

The earlier `gpt-5.6-sol/xhigh` evaluation in
[run 42373957594](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42373957594/attempts/1)
was force-cancelled at the user's request. Its paid-session step was cancelled,
and a shutdown-only retry verified the EC2 runner stopped at 13:37:38 UTC.
The old automatic recorder was stopped. Its
[partial artifact](https://github.com/abhigyanpatwari/GitNexus/actions/runs/42373957594/artifacts/13576197271)
is separate historical evidence and is excluded from the Terra comparison.

## Evidence to retain

The workflow writes sanitized reports, per-cell diagnostics and a release gate
to its summary and the `release-agent-evaluation-4ab9e8a48849daab417ccaab7268c946f62ca644`
artifact. Once those outputs exist, retain the measured cells with their exact
runtime/harness/task/oracle bindings and isolation receipts, and recompute the
solve counts, reported model costs and timings before adding conclusions here.

Incomplete or unsuccessful outcomes belong in the record. This remains a
four-task workflow comparison in one repository, not a SWE-bench result or a
basis for general accuracy or savings claims.
