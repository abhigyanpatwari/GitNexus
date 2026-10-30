# Skill benchmark — evolve review quality, measure workflow cost

Measures whether the `gitnexus-plan` → `gitnexus-work` engineering workflow
actually saves tokens versus a baseline agent on the same tasks, using real
headless Claude Code sessions. Usage and reported model cost come from
parent-captured CLI events; model cost is not a provider invoice or a measure
of indexing, infrastructure, or subscription costs.

## What it compares

| Arm                         | Sessions                                                                | Notes                                                                                               |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `workflow`                  | `gitnexus-plan` on the task, then `gitnexus-work` on the produced plan  | The skills must be installed (`gitnexus setup`, or repo-local `.claude/skills/`)                    |
| `candidate_workflow`        | same sessions as `workflow`, with a candidate skill overlay             | Paired with `workflow` on the same task/ref/model                                                   |
| `workflow_direct`           | one `gitnexus-work` direct-mode session                                 | The middle option — execution discipline without a planning pass                                    |
| `candidate_workflow_direct` | same session as `workflow_direct`, with a candidate skill overlay       | Paired with `workflow_direct` on the same task/ref/model                                            |
| `ce_workflow`               | `ce-plan` on the task, then `ce-work` on the produced plan              | External comparator: the explicitly supplied, pinned compound-engineering plugin's plan→work family |
| `ce_workflow_direct`        | one `ce-work` direct-mode session                                       | External comparator paired with `workflow_direct`                                                   |
| `review`                    | one `gitnexus-review` session over an immutable historical PR snapshot  | Emits strict `review-output.json`; hidden human labels score quality after the session              |
| `candidate_review`          | the same review with a `gitnexus-review` candidate overlay              | Paired with `review` on the same case/ref/model/runtime                                             |
| `ce_review`                 | one pinned `ce-code-review` session over the same changes               | External comparator paired with both review arms                                                    |
| `baseline`                  | one session with the identical task text                                | `--disallowedTools Skill` so it cannot borrow the workflow; same repo, same MCP tools               |
| `baseline_cli`              | one session with the same read-only tools behind a `gitnexus` command   | No MCP tools, so no tool catalog in context; opt-in, Bubblewrap only (see below)                     |
| `baseline_nomcp`            | one session without installed GitNexus tools, graph, or workflow skills | Measures the no-GitNexus comparator; included by default                                            |

The default sweep runs `workflow`, `workflow_direct`, `baseline`, and
`baseline_nomcp`, each three times (`--runs 3`). That is 12 cells per selected
task; the `workflow` arm has separate planning and execution sessions.
Budget for the complete sweep before running it. For an inexpensive smoke
check, explicitly select `--runs 1 --arms baseline_nomcp baseline`; a smoke
check is not evidence of savings.

Every arm runs in a fresh detached git worktree of the task's `ref`, once per
repetition. The model-visible `verify` command is recorded as
`authored_tests_passed`, but cannot certify its own solution: `resolved` also
requires the task's harness-owned hidden behavioral oracle to pass. Token
savings on a failed task are flagged, not celebrated, and diff churn
(files/+insertions/−deletions vs the starting commit) is recorded as a cheap
over-engineering proxy. Task `class` labels (trivial → investigation →
cross-module) make the report readable as a routing table: the boundary where
`workflow` starts beating `workflow_direct` and `baseline` is the boundary
lfg's gate and work's direct-mode triage should encode.

Compare GitNexus-enabled arms with `baseline_nomcp` to measure tool benefit.
Compare `workflow` or `workflow_direct` with MCP-enabled `baseline` to measure
workflow overhead. A lower model bill is only useful alongside at least the
same solve rate: retain failed runs, report each task and repetition, and pin
the model, source, runtime, and grader. Three repetitions are a starting point,
not statistical proof. Smaller tool responses measure one input-cost component;
they do not establish lower total session cost or better task accuracy.

### CLI-only arm

`baseline_cli` asks how much of `baseline`'s extra cost is the MCP tool
catalog, which the client re-sends on every turn whether or not a tool is
called. The agent has no MCP tools; `gitnexus` on its `PATH` is a
standard-library shim that forwards one call per invocation to the same
per-cell isolated MCP endpoint `baseline` uses, restricted to the same
read-only tools. Tool output is the server's own text, so the arms differ only
in how tools are described: always (MCP catalog) or on demand (`gitnexus help`,
`gitnexus help <command>`). The prompt adds one short note naming the command.
The candidate runtime stays in the sibling server sandbox, as for `baseline`.

Compare `baseline_cli` with `baseline` for the catalog's share of the cost and
with `baseline_nomcp` for what remains. It is not a release gate input: the
Release evaluation workflow runs it only when dispatched with `cli_arm: true`,
into its own output directory, and publishes a descriptive
`cli-arm-comparison` summary (`python -m workflow_bench.cli_arm_report`).

## Quick start

```bash
cd eval
export GITNEXUS_BENCH_ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
uv run --locked --extra dev python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
  --model claude-sonnet-4-20250514
```

Scenarios marked `expensive: true` are skipped unless
`--include-expensive` is supplied. The report names both selected and skipped
tasks so an omitted cell cannot be mistaken for evidence.

CE comparator arms never discover a user-level plugin. Supply an exact plugin
release explicitly; both flags are mandatory whenever any `ce_*` arm is
selected:

```bash
uv run --locked --extra dev python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
  --model claude-sonnet-4-20250514 \
  --arms workflow ce_workflow \
  --ce-plugin-dir /opt/operator-input/compound-engineering-3.19.0 \
  --ce-plugin-version 3.19.0
```

The runner verifies the manifest version, copies only the plugin manifests,
skills, scripts, and assets into a bounded no-symlink snapshot, and mounts
that snapshot read-only only for CE arms. Every CE result records its exact
plugin version and content-manifest digest.

Output: `results/wfbench-<timestamp>/results.jsonl` (every run, with session
ids for transcript drill-down) and `report.md` (medians per task per arm,
plus a savings row: input / cache / output tokens, cost, wall time).

## Release evaluation

### Measure an unmerged PR against a previous run

Add **`run-cost-evaluation`** to an open PR targeting `main`:

```bash
gh pr edit 3621 --add-label run-cost-evaluation
```

Only a repository **Maintain or Admin** role's label event can request this paid
comparison; Write, Triage and Read roles cannot. The
trusted dispatcher pins the labeled head and selects the newest successful main
Release evaluation with a full release artifact (searching the latest 100 runs),
using `gpt-5.6-sol` at `xhigh`. It skips previews and runner-only probes. An
incompatible or expired baseline fails before paid sessions; it never starts a
fresh paid baseline automatically. The authorized request calls the reusable
evaluator; PR inputs are absent from manual dispatch. Ordinary pushes do not
request runs.
Remove and re-add the label to request another measurement; rerunning the label
dispatcher itself is ignored. The evaluator checks the live label and head on
resolution and immediately before paid sessions. Removing the label prevents
sessions that have not started; use Actions cancellation for a run already active.

This preview measures only the PR runtime's MCP arm: all four tasks, three
repetitions each. It reuses the selected run's MCP measurements as the historical
comparison and does not rerun no-MCP or stable sessions. A moved PR head,
different model/effort, changed measurement inputs, stale evidence, or incompatible
task/oracle/dependency pins rejects the comparison. Per-task solve counts remain
visible alongside billed model cost; incomplete evidence cannot claim savings.

The harness and protected runner still execute from `main`; the PR runtime is
built and run in the existing containment. Results use the separate
`pr-cost-comparison-<sha>` artifact and schema, and cannot approve a release.
Cost differences against a historical run are descriptive measurements, not
proof of statistical significance or attribution to only that PR.

### RC regression decision

`workflow_bench.release_gate` compares a candidate report with a freshly
measured stable-runtime report. Both reports must use the same trusted harness,
task/oracle pins, model, reasoning effort and repetition count. Each task must
solve at least as many repetitions with the candidate as with stable; gains on
one task cannot offset losses on another. Invalid, stale or incomplete evidence
fails closed. Cost, duration and both no-GitNexus comparisons remain descriptive
measurements, not additional pass criteria or claims of statistical significance.

```bash
uv run --locked --extra dev python -m workflow_bench.release_gate \
  --candidate candidate/agent-evaluation.json --candidate-sha <full-rc-sha> \
  --stable stable/agent-evaluation.json --stable-sha <full-stable-sha> \
  --out public
```

The command writes `release-quality-gate.json` and `release-quality-gate.md`
and exits nonzero on rejection. Its caller must authenticate the reports and
resolve the published stable and exact candidate revisions independently;
self-reported metadata does not establish provenance. Release evaluation
resolves the latest published stable release and the requested candidate
itself, then measures both with main's trusted harness. The comparison is a
regression signal for published RCs; it does not block RC publication.

### Current workflow

Following [discussion #3493](https://github.com/abhigyanpatwari/GitNexus/discussions/3493#discussioncomment-18772530),
release evidence is split by cost:

1. Every CI run, RC and stable release runs the offline
   [tool-accuracy corpus](../../gitnexus/bench/tool-accuracy/README.md) against
   the real ingestion pipeline and tools. Its fixed answers cover #3486–3491
   and #3497–3499. `accuracy.json` and `accuracy.md` report every failing answer,
   precision/recall and source/fixture revisions. The initial reviewed gaps
   remain failures in the accuracy total. The gate rejects new/worsened failures,
   missing outputs and repaired allowances that have not been removed.
2. **Release evaluation**, before each stable release and weekly against the
   latest RC, runs three fresh paired repetitions of every scenario
   on both candidate and stable runtimes, including the expensive task, using
   `baseline_nomcp` and MCP `baseline`.
   Every task starts at the immutable v1.6.12 commit; all four tasks remain
   unsolved there. The hidden graders have tested negative/positive controls,
   including retry implementations in either the pipeline or worker pool.

Run **Release evaluation** from `main` before cutting a stable tag. Set
`candidate_ref` to the full, already-reviewed stable commit SHA. The workflow
uses main's trusted harness and `--gitnexus-root` to select a separate immutable
runtime checkout.
Candidate installs run in Bubblewrap with only that checkout (minus `.git`)
writable, system tools read-only, and a cleared environment. Locked downloads
run without package scripts; every lifecycle script then runs with no network. The trusted harness
and host command files are not mounted into the candidate build.
Before any paid sessions, `workflow_bench.release_preflight` builds and
materializes the real sanitized graphs for both runtimes on the runner's temp
filesystem. A copy or containment failure stops the workflow at that point.
Buffered copies use the same 2 GiB hard ceiling as snapshot capture, including
on filesystems without reflinks. This preflight adds an offline graph build per
runtime; the measured runner rebuilds its own graphs to retain its existing
provenance and cache lifecycle. Preflight output is not release evidence.
The report records runtime/harness SHAs, task and oracle digests, model/effort,
every repetition, solve counts, cost and agent wall time. Failed
solutions stay in the denominator. Infrastructure/session failures, missing
costs, incomplete pairs or failed containment make evidence incomplete.

To isolate MCP description overhead, enable the manual `mcp_tool_loading`
input (off by default). The normal candidate/stable pairs retain eager loading;
an additional candidate sweep runs `baseline` with `--mcp-tool-loading deferred`
(12 extra paid cells for the current four-task suite). Before any paid session,
an offline canary drives the pinned Claude CLI through the real LiteLLM gateway:
the initial request must omit MCP descriptions, discovery must load and execute
the selected tool, and an unused tool's description must remain absent.

The switch explicitly sets `ENABLE_TOOL_SEARCH` and includes `ToolSearch` in
both CLI tool lists. Merely improving agent instructions cannot change an eager
catalog. Hooks remain disabled and prompts, read-only MCP tools, model, effort,
and outputs remain the same. Each sweep rebuilds its graph from the same
sanitized task commit using the same runtime. The additional discovery turn may
offset catalog savings; the benchmark measures the net result.

The separate `mcp-tool-loading.json` / `.md` report requires all three modes'
task/run cells, matching runtime/harness revisions, prompts, dependencies and
sanitized task commits. It retains failed repairs and rejects missing cells,
duplicate cells, missing counters and infrastructure failures before calculating
savings. It reports solved counts, costs, time, turns and cache/output tokens.
This is a descriptive experiment, not release approval or statistical proof.
The workflow runs the deferred sweep after the existing pairs; repeat with
reversed order before interpreting a small difference as a reliable gain.

For local paired sweeps, use `--arms baseline_nomcp baseline --mcp-tool-loading
eager` followed by `--arms baseline --mcp-tool-loading deferred` with the same
pinned inputs and separate output directories. Summarize with:

```bash
uv run --locked --extra dev python -m workflow_bench.mcp_loading_report \
  --eager candidate/raw/results.jsonl --deferred candidate/deferred/results.jsonl \
  --metadata candidate/metadata.json --out public
```

Stable publishing requires a successful default-branch evaluation for that
**exact commit, measured by main's current evaluator**, no more than seven days
old. The publish job loads `eval/` from main's head rather than the release
commit, so later task changes on main do not strand an already-measured
release. A report counts only when its `harness_sha` is the commit its
scheduled or manually dispatched `main` run executed, and GitHub's comparison
from that commit to main's head changes nothing under `eval/`,
`.github/workflows/release-evaluation.yml` or `.github/claude-canary-runtime/`.
An unavailable or truncated (300-file) comparison rejects the run. Any change
to the harness, graders, task pins or agent CLI therefore requires a fresh
Release evaluation. Runs are tried newest first; a rejected run does not hide an
older valid one, and when none passes the error lists each rejection.
It validates task pins, individual cells and recomputed totals before publishing to npm
or either Docker registry. Docker publication also runs the cheap accuracy
gate once before both image builds, then builds the verified immutable commit.
Every release attaches the cheap accuracy evidence; stable releases also attach
and include their paired agent report. RCs publish after CI without waiting for
a paid run. The weekly comparison checks that the latest RC preserves each
covered task's MCP solve count relative to stable. The comparison does not require GitNexus to beat the no-MCP arm or claim that
four tasks establish general improvements.

The Wednesday release comparison reuses the existing schedule controls:
`GITNEXUS_EVOLUTION_ENABLED=true` and `GITNEXUS_EVOLUTION_WORKERS=3` enable
both weekly workflows; disabling evolution also disables scheduled release
comparisons. No additional opt-in variable or model credential is required.
Manual release evaluation remains available independently. Scheduled runs
resolve the newest published RC to its
commit before execution. The protected `gitnexus-evolution` environment remains
restricted to main and supplies the existing model secrets. Evaluation runs on
the dedicated self-hosted EC2 runner. The paid step has a 19-hour cap inside a
21-hour job and also stops 90 minutes before the configured external shutdown,
leaving time to upload summaries when a benchmark step fails. Raw transcripts, internal instructions, local
paths and session files are never uploaded or attached to releases.

The no-GitNexus arm receives no indexed graph, registry, runtime mounts or CLI
wrapper, and inherited graph-first directives are removed while ordinary
repository development and test guidance is preserved. Both arms load that
guidance through the same startup mode. Skills/commands and GitNexus MCP tools
are disabled in the no-tool arm, and repository/plugin hooks are disabled in
both arms. It fails closed when Bubblewrap is unavailable. It retains the repository source and
ordinary test dependencies required by the tasks; rebuilding tools from that
source is not prevented. The comparison therefore measures access to the
provided GitNexus tools on these GitNexus development tasks. The MCP baseline
receives only a per-cell Unix socket: its candidate runtime, shared package,
registry, and host launcher are outside the agent filesystem. The host records
`runtime_exposure: stdio-only` for this arm and `none` for the no-tool arm.
Release and PR comparison validation reject missing or incompatible receipts.
Older measurements exposed readable compiled runtime code, including later
task implementations; they remain historical evidence and cannot satisfy this
isolated comparison contract. Workflow/CLI arms retain their runtime mounts and
are labeled `readable`.

The [24 October evidence report](measurement-2026-10-24.md) retains the latest
historical measurements, current tool-accuracy result, and post-merge rerun
procedure. Those historical agent results do not show an accuracy or cost gain.

This corpus uses a **fresh index at each task base**. A nightly stale Hermes
index is a separate condition and must not be pooled with it. Import the
reporter's sanitized task bundle and Hermes fresh/stale fixtures when available;
private repositories and raw transcripts are outside the current corpus.

## Trust model — fail-closed Linux containment

Task files and candidate prose remain untrusted executable inputs. Every
setup, verifier, incumbent, and candidate cell therefore runs in a
preflighted Bubblewrap boundary with a private home/config/temp, a
self-contained clone, a PID namespace, bounded process-tree ownership, and a
deny-by-default environment. Task-declared dependency roots are mounted
read-only, while graph assets are rebuilt by the harness as described below.
Claude uses `dontAsk` mode with strict clone-local MCP configuration and
repository/plugin hooks disabled. Both implementation baselines load ordinary
repository instructions; the no-tool arm disables skills and uses an empty
MCP configuration. Bash children do
not inherit the model credential and their network sandbox denies all
domains.

The release baseline's candidate MCP server runs in a sibling Bubblewrap
boundary, reached by a stdio socket connector. Workflow/CLI arms retain a nested
server boundary. In both cases its
workspace (including the graph), registry, compiled runtime and shared package
mounts are read-only. Its home and temporary directories are private tmpfs,
and it has a fresh PID namespace and `/proc`, no network or capabilities, and
no model credentials or agent state. MCP startup and tool handlers therefore
cannot write patches that would be credited to the agent; the agent retains
its writable workspace for implementation tasks. Mutating MCP tools are not
granted in any phase.

The cell owns the socket listener and its servers through the existing managed
process supervisor and an outer PID namespace. Each connection starts one
server; reconnects are sequential. Server failures invalidate the cell, and
teardown reaps detached descendants before removing the socket. Native canaries
in `test_proposer_sandbox.py` run in the required Linux containment job; a local
namespace skip does not prove isolation.

Prebuilt task `.gitnexus` assets are rejected. For each task commit, the
harness creates the deterministic parentless snapshot first, removes every
analyzer-visible path or stored source reference to the benchmark harness,
neutralizes target-controlled GitNexus config/ignore files, and builds one
fresh PDG index offline with `--pdg --index-only --no-stats`. It then proves
that neither whole graph nodes nor relationships contain a harness marker and
caches only the bound metadata/database assets for reuse by paired arms.

Each selected task also declares a bounded hidden `oracle` command and file
set. The harness captures those regular, non-symlink files into an immutable
in-memory snapshot before any arm runs and binds the command, paths, sizes, and
raw bytes into the task digest. Before any task asset or model session, each
disposable clone that contains the benchmark harness is rewritten to a clean,
parentless snapshot without `eval/workflow_bench`; all original refs, reflogs,
and unreachable Git objects are pruned so `git show` cannot recover the hidden
bytes. Only after the model exits (and after the authored-test signal is
collected) does the harness materialize the oracle beneath a private host
root, mount it read-only at a random workspace sibling, and supply that mount
through `GITNEXUS_BENCH_ORACLE_ROOT`. This layout preserves hidden tests'
`../gitnexus` imports as the credited candidate checkout. Authored and hidden
verifiers run with the complete workspace read-only and networking unshared;
hidden stdout/stderr is never persisted. The harness re-checks every oracle
byte and erases the mountpoint before churn/patch capture. Shipped Vitest
oracles use the staged, digest-bound `vitest.config.mts`; a candidate cannot
replace repo test config or setup hooks to make the hidden test vacuously pass.
The hidden command invokes the read-only dependency's Vitest binary directly,
without an `npx` configuration/resolution layer.

Every evaluated repo-local skill root is over-mounted read-only for the full
model session, and an immutable empty user-level skills directory prevents a
writable `$HOME` skill from shadowing it. Skill-use evidence comes only from
the bounded stream captured directly from Claude stdout by the parent. The
runner parses every event through EOF and requires a terminal result. A
background-task completion can start another foreground turn in the pinned
Claude CLI: those results must have distinct IDs in the same session, complete
per-turn usage, successful outcomes, and nondecreasing cumulative cost. The
runner sums their tokens and turn counts, takes the last cumulative cost, and
measures the whole process duration including the background wait. Missing,
replayed, mismatched, or unsuccessful continuations remain excluded. It correlates
an exact Skill request ID with one later successful result, structurally
redacts the event objects, and stores the canonical redacted JSONL with a
digest. Files written beneath the agent's `$HOME` are never trusted as
evidence.

Release evaluation allows 3600 seconds per session in both runtimes and arms.
Run `38873262106` hit the former 1800-second limit twice while still editing
and testing; the longer ceiling gives those sessions headroom, not a guarantee
of completion. The overall deadline and 5400-second evidence/cleanup reserve
remain enforced. Treat this ceiling and the result-accounting change as harness
differences when comparing against older runs; invalid historical measurements
are not repaired retroactively.

Sessions use a private home without stored Claude login/keychain state, and
do not inherit `ANTHROPIC_AUTH_TOKEN`. Supply an Anthropic API key
through `GITNEXUS_BENCH_ANTHROPIC_API_KEY` (preferred) or `--anthropic-api-key`;
the harness maps it to `ANTHROPIC_API_KEY` only for the trusted Claude parent
and scrubs it from agent-launched tools. `GITNEXUS_BENCH_AUTH_TOKEN` and
`--auth-token` remain as aliases. OpenAI keys are not a drop-in
replacement: pass `--openai-api-key` / `GITNEXUS_BENCH_OPENAI_API_KEY` with
`gpt-*` / `o*` / `openai/*` model ids and the harness starts a loopback
LiteLLM proxy. The OpenAI key stays on that host process; Claude still sees
only a minted `ANTHROPIC_API_KEY` plus `ANTHROPIC_BASE_URL`.

The trusted Claude CLI still needs outbound access to the explicitly supplied
model endpoint. This is not a network broker, so the CLI itself retains that
egress; agent-launched tools do not. Missing Bubblewrap, unsupported hosts,
invalid mounts, or namespace preflight failure stop before model invocation.
Native benchmark execution is therefore Linux/WSL2-only. Evidence assembly
and hand-authored overlay preparation can happen elsewhere, but
`--initial-overlay` does not bypass containment.

For a local diagnostic inside a container that blocks user namespaces, an
operator may explicitly choose the non-containment host backend:

```bash
UNSAFE_NO_BWRAP=1 RUNS=1 ./workflow_bench/run-evolution.sh
```

This mode runs review sessions directly in disposable host worktrees and is
**not** a security boundary: it does not isolate the network or create a PID
namespace, and a session that can `chmod` can undo the workspace lock. The
harness drops write bits on the whole clone, with no carve-out, so accidental
`npm install` / analyze writes cannot invalidate review evidence. The review
artifact is not in the clone at all: it lives in a writable directory bound at
`/review-output`, outside the workspace.
Sandbox cleanup restores owner write bits before deleting the private TMPDIR,
because a session that `copytree`s the locked clone would otherwise leave
non-empty 0555 directories that `rmtree` cannot remove. Historical review
SHAs that gitignore `.claude/skills/*` are force-added when the harness seeds
or overlays the evaluated `gitnexus-review` skill.
Treat model and verifier processes as able to access host files and
credentials available to the invoking user. It is restricted to the review
benchmark, forbidden with `--apply` and whenever `CI` is set;
promotion-capable and CI runs must use Bubblewrap.

## Prompt and skill evolution loop

Prompts age as models and tool harnesses change. Treat the current skills and
router thresholds as an incumbent policy, not permanent truth. Candidate
changes run offline in the same throwaway clones as the incumbent; production
skills never rewrite themselves from a live task.

On the self-hosted evolution box, `run-evolution.sh` passes
`--max-runtime-from-instance-window` and the CLI derives its own cap from
`/proc/uptime` at startup (24h EventBridge window minus a 90-minute upload
reserve), in the same breath as it starts the clock that cap is measured
against — a budget computed anywhere earlier is spent by the seconds between. A `workflow_dispatch` that lands on an
already-running instance therefore exits in-process instead of vanishing when
the box stops — a cancelled GitHub job skips even `if: always()`, which is
how run 33962002890 lost 51 finished sessions. Local runs are uncapped.

Both skill evolution and release evaluation manage the existing dedicated EC2
runner through hosted startup and cleanup jobs. They share a concurrency group
for the whole run, so neither can stop the instance during the other's work.
GitHub keeps only one pending run per group, even with `cancel-in-progress:
false`: a newer queued run of either workflow cancels the older pending one.
A release evaluation dispatched for a stable publish can therefore be dropped
while it waits behind a running evolution. Do not queue another run behind a
pending release evaluation, and confirm its **Start the dedicated EC2 runner**
job ran before relying on its evidence. If the run shows Cancelled, dispatch it
again once the group is free.
Startup waits for EC2 running and both health checks, then a native pickup probe
must finish within five minutes. If the probe fails, the hosted check cancels
its own run to clear the queued job. A second hosted watchdog bounds pickup of
the paid job. Only these watchdogs have Actions write permission.

The protected `gitnexus-evolution` environment holds these four settings
(configured and verified by the live probes below):

| Setting                                | Kind     | Purpose                                         |
| -------------------------------------- | -------- | ----------------------------------------------- |
| `GITNEXUS_EVOLUTION_AWS_ROLE_ARN`      | Secret   | AWS role assumed through GitHub OIDC            |
| `GITNEXUS_EVOLUTION_EC2_INSTANCE_ID`   | Secret   | Dedicated runner instance                       |
| `GITNEXUS_EVOLUTION_AWS_REGION`        | Variable | Instance region                                 |
| `GITNEXUS_EVOLUTION_STOP_SCHEDULE_UTC` | Variable | Actual weekly EventBridge stop, `DAY HH:MM` UTC |

No long-lived AWS credential is stored. The AWS action obtains short-lived
credentials using GitHub OIDC. The role trusts only this repository's
`gitnexus-evolution` environment and permits EC2 DescribeInstances and
DescribeInstanceStatus, with StartInstances and StopInstances scoped to the
dedicated instance. Missing configuration or access fails closed.
The workflow does not create IAM roles, instances, secrets or schedules.

A main-branch dispatch of either workflow with `runner_only=true` starts the
instance, proves native runner pickup, then stops it without paid model calls.
Cleanup runs on a hosted runner after success or failure and verifies EC2 is
actually `stopped`; an accepted StopInstances response alone does not pass.
Startup failures also attempt immediate cleanup. Keep the existing EventBridge
stop watchdog enabled because interrupted or force-cancelled GitHub cleanup
cannot guarantee shutdown. Paid work respects the earlier of the configured
weekly stop and a 24-hour cap, with a 90-minute evidence reserve.

Choose **Re-run all jobs** after a failed run to repeat startup and pickup.
Partial retries cannot reuse a previous attempt's startup: the affected probe
or paid job runs on a hosted runner and fails promptly with that instruction,
instead of waiting on the stopped instance.

PR tests use a fake AWS CLI to cover transitions, denial, lost responses,
timeouts, cleanup and workflow wiring. On 2026-10-09, `runner_only=true`
dispatches of both workflows started the instance, ran the native pickup probe
on the dedicated runner and verified the instance stopped (runs 37893007912 and
37895899767, from temporary branches with a runner-only guard exception).

CI separately runs a six-cell paired evaluator canary using the real pinned
Claude CLI, Bubblewrap, built MCP runtime, hidden grading and public report
commands. Only its small corpus and local model replies are scripted. One
failed repair must stay in the report. This proves execution and accounting;
the canary is not paid-model performance evidence for a stable release.

A review generation is 6 tasks × 3 arms × 3 runs. Serial workers=1 at ~19
minutes per session is a 16-hour job (run 33962002890). Two harness changes
cut that without shrinking the gate:

- **Comparator reuse.** `evolve.py` forwards the seed / prior generation as
  `--reuse-results`. Incumbent `review` and `ce_review` rows are copied into
  the new `results.jsonl` when model, effort, task SHA, prompt digest, oracle
  bytes, incumbent skill digest, CE plugin digest, and sandbox backend still
  match. Candidate arms always run. A weekly generation with an unchanged
  incumbent therefore pays 18 sessions, not 54. A promotion, model change,
  task-corpus change, or harness `RUNTIME_DIGEST` change invalidates the
  lock and re-runs the comparators.
- **Sanitized clone templates.** Each unique task SHA is cloned and
  sanitized once. Cells copy that parentless snapshot (reflink when the
  filesystem allows) instead of `git clone --no-local` plus repack/prune/fsck
  54 times. Isolation is a private `.git`, not a second copy of full history.

Dispatch defaults to `--workers 3` so those 18 paid cells can overlap. Size
workers to the host: a cell that loses CPU and hits the session ceiling is
an excluded run the gate refuses.

Build an overlay that mirrors only the canonical repo-local skill paths:

```text
/tmp/gn-skill-candidate/
└── .claude/skills/
    ├── gitnexus-plan/SKILL.md
    └── gitnexus-work/SKILL.md
```

The overlay may contain Markdown files from either of those two skill
trees. The runner rejects every other path, including source, test, and MCP
configuration files, so a candidate cannot improve its score by changing the
task or verifier. Arm selection is derived from the touched skill and must be
exact: a plan-only overlay runs the workflow pair; any work overlay runs both
workflow and direct-work pairs. Subsets and unrelated extra pairs fail before
paid work. For a work overlay:

```bash
cd eval
uv run --locked --extra dev python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml \
  --runs 3 --workers 1 --model claude-sonnet-4-20250514 \
  --arms workflow candidate_workflow \
         workflow_direct candidate_workflow_direct \
  --candidate-overlay /tmp/gn-skill-candidate
```

Candidate runs start from the same task commit, then receive a clean ephemeral
commit containing the overlay. `results.jsonl` records the named model, task
commit, task-prompt digest, skill digest, overlay digest, hidden-oracle
command/manifest/content digests, immutable dependency content/manifest
digests, separate authored-test and oracle outcomes,
timestamp, local session ids, and digest-bound parent-captured event-stream
artifacts. Those artifacts are the trajectory evidence: cluster failures and
expensive detours, propose one bounded prompt change, and feed it back as the
next overlay.

When candidate arms are present the runner also writes schema-6
`promotion.json`. It
binds the immutable overlay digest, benchmark model, truthful candidate origin
(a named proposer model or `manual-initial-overlay`), selected
task definitions, resolved commits, and exact hidden-oracle bytes/commands,
immutable dependency bytes, committed base digest of every apply
destination, exact required arms, thresholds, and evidence expiry. Its default
deterministic gate is deliberately conservative:

Schema 6 binds a separate policy to each required candidate arm and records
whether the sweep completed. Apply validates the paired metrics and recomputes
each decision. Historical schema 5 reports remain readable; regenerate their
benchmark evidence before applying an overlay. Editing a schema number does
not supply the missing evidence.

Review candidates optimize weighted F1 with a minimum improvement of 0.01,
complete paired evidence on every selected task, and no per-task quality
regression. Complete misses score zero. Matching uses maximum cardinality
throughout the 100-finding limit. Downgraded findings receive at most their
reported severity's weight; only blocking-severity matches count toward blocker
recall. Every valid candidate repeat must have the correct verdict, and the
minimum blocker recall across repeats must not regress. Clean controls retain
their false-positive and verdict safeguards. Implementation candidates retain
the efficiency policy below:

- at least 3 paired VALID runs per task, zero excluded runs in either arm
  (session/infra-error rows therefore block promotion), and a named model;
- a fully measured task that neither arm ever resolves remains reported but is
  ungated from the quality comparison — only if its metric was measured in both
  arms and no run hit `skill-not-invoked` (a skill that never loaded is prompt
  evidence, not task health). An ungated task still ranks against a looser 100%
  failed-task regression cap on the promotion metric;
- at least half the paired tasks must stay gated, and `promotion.json` discloses
  the gated/ungated split per decision; a set with no gated task at all is
  `insufficient_evidence`;
- the candidate must pass the hidden oracle on every valid run of every gated
  task the incumbent resolves at least once — on a task the incumbent never
  resolves, partial candidate progress counts as improvement instead of failing
  the floor, so making some progress is never scored worse than making none;
- no per-task resolution-rate regression (quality is lexicographically first);
- promotion by resolution needs a margin of at least 2 resolved runs —
  a 1-run difference is noise at this run count and falls through to the
  efficiency comparison;
- with equal quality, at least 5% median improvement on the promotion metric
  (default `cost_usd` — the only CLI-reported number that includes subagent
  spend; token metrics count only the main-loop session and flatter
  subagent-heavy candidates, so selecting one stamps a warning into
  `promotion.json`);
- no individual task may regress the selected efficiency metric by more than
  20%.

Tune the efficiency signal with `--promotion-metric` and the three
`--promotion-*` thresholds. Applying requires one unique `promote` decision
for every bound candidate arm. The driver then stages every canonical and
shipped mirror, verifies that all destination bytes still match the bound
bases, replaces them as one compare-and-swap set, verifies byte parity, and
rolls every landed replacement back on failure or interruption.
`keep_incumbent` and
`insufficient_evidence` become the next learning queue; their raw
`results.jsonl` rows carry the `session_ids` of the trajectories to inspect.

Re-run the paired suite whenever the named model or tool harness changes, and
at least every 90 days otherwise. This is prompt-policy optimization using
verified agent trajectories as reward evidence; it is intentionally not
online model-weight RL. The same records can feed a later offline RL pipeline
without weakening today's deterministic promotion boundary.

### Closing the loop automatically (`evolve.py`)

The evolution workflow runs an offline containment preflight with the pinned
Claude Code 2.1.214 binary before starting a paid proposer or benchmark. The
review canary seals the workspace read-only and writes nothing into it: the
artifact directory is bound at `/review-output` outside the workspace, and the
file itself is deliberately absent until the session creates it, so its absence
distinguishes "never written" from "written badly". Runtime mount placeholders
are prepared in the disposable clone before sealing it; existing config bytes
are preserved.
Any pre-existing result entry, including a symlink, is rejected. Required
canaries fail when their runtime or Bubblewrap is unavailable.

The default outage limit is five consecutive unusable results, across task
boundaries. Invalid review JSON advances this limit even when a skill or session
error was recorded first. A valid zero-quality review resets it. Concurrent
waves can exceed the limit by at most `workers - 1` completed cells; no further
wave starts after a trip. Completed rows and redacted diagnostics remain in the
partial report, the runner exits nonzero, and the evolution driver stops without
applying or starting another generation.

SIGINT and SIGTERM propagate one cancellation event through managed commands,
including clone, setup, Claude, and verification. Executor submissions copy
the run context so indirect subprocess helpers receive the same event. Active
process groups or Windows Job Objects are terminated and workers joined before
shared assets or the gateway are released. Controlled cancellation tests require
cleanup within 15 seconds. Cancellation remains distinct from timeout and
quality failure in recorded evidence.

The gateway runs under a private supervisor watching a pipe owned only by the
harness. Parent exit, including SIGKILL, closes that pipe and stops the proxy
group; Windows also retains kill-on-close Job Object ownership. Keep completed
JSONL rows, transcripts, the partial report, and gateway diagnostics when
investigating an interrupted run. A subsequent paid comparison needs fresh
evidence from all arms under the same dependency lock. LiteLLM pricing comes
from that locked release's local cost map; compare no old/new-lock costs as
quality evidence.

`workflow_bench.evolve` automates the three manual arrows — propose,
benchmark, apply — without moving the trust boundary:

```bash
cd eval
./workflow_bench/run-evolution.sh                  # local; no working-tree apply
./workflow_bench/run-evolution.sh --apply          # CI; same argv the workflow uses
./workflow_bench/run-evolution.sh --dry-run        # print the evolve command
```

The GitHub skill-evolution job calls this script. Do not invoke
`python -m workflow_bench.evolve` directly for a full loop. Environment knobs
match the workflow: `MODEL`, `PROPOSER_MODEL`, `GENERATIONS`, `RUNS`,
`WORKERS`, `PROVIDER`, `EFFORT`, `SEED_RESULTS`, `INCLUDE_EXPENSIVE`. The
checked-in production defaults are `PROVIDER=openai`, `MODEL=gpt-5.6-sol`,
`PROPOSER_MODEL=gpt-5.6-sol`, and `EFFORT=xhigh`.

The scheduled/default profile is read-only review evolution. Set
`EVOLUTION_PROFILE=implementation` explicitly to run the legacy plan/work
benchmark. Review mode requires `CE_PLUGIN_DIR` and `CE_PLUGIN_VERSION`.

Each review generation: a confined **proposer** session reads only the incumbent
`gitnexus-review` skill, normalized CE/incumbent/candidate result rows, bounded
review artifacts and session transcripts, and the rejected
`proposal.md` when available (including a workflow seed from a prior run), and
the learning queue,
then writes ONE bounded candidate overlay plus a reviewer-facing
`proposal.md`. The proposer's clone is sanitized exactly like an arm's before
its session starts: it authors the artifact the arms are scored with, so
letting it read `eval/workflow_bench` would hand it the task prompts and the
hidden oracles it is about to be graded against, and a proposal could win the
gate by encoding the expected behavior into a skill rather than by being a
better skill. The overlay is re-validated by `candidate_overlay_files`
(same boundary: Markdown under `gitnexus-review`, including exercised
`ci-personas/`, nothing else), frozen,
and exercised only by its exact required pairs. Task refs are resolved once
before generation zero and the immutable task bindings are forwarded to every
generated runner invocation, so a moving branch cannot change later evidence.
The deterministic quality-first gate rejects blocker-recall regressions,
new false positives on clean controls, and any weighted-score regression.
Repeated evidence (`RUNS>=3`) is required for promotion; `RUNS=1` is
diagnostic-only. CE is the external comparator. Cost and latency are
tiebreakers and never compensate for quality loss. `promote` stops the loop; with `--apply`
the authorized frozen bytes
are transactionally applied to the canonical
`.claude/skills/` trees and their shipped mirrors as an ordinary
working-tree diff — committing, CI (`shipped-skills-sync`,
`skills-steering`), and the PR merge stay human. `keep_incumbent` feeds that
generation's trajectories to the next proposer. `--initial-overlay` skips
the generation-0 proposer to benchmark a hand-written candidate;
`--proposer-model` upgrades only the diagnosis session.

**Learning queue.** Live skill runs never self-edit (see each
skill's "Skill feedback" section) — instead they may append one-line JSON notes to
`workflow_bench/learnings.jsonl` (gitignored, machine-local like the
transcripts they complement). The proposer reads the queue as hints, not
ground truth: a learning only reaches a shipped skill by surviving the same
paired benchmark as any other candidate.

For ad-hoc use, run the driver on the existing re-evaluation triggers
(model/harness change or 90-day staleness). The repository workflow runs a
deliberate weekly drift check: dispatch defaults to three concurrent cells
of one task; scheduled concurrency still requires
`GITNEXUS_EVOLUTION_WORKERS=3` after a clean proof. `--workers` is bounded
to 1–8 before paid work starts. `--generations` remains the only loop bound.

## Free-model setup (no paid tokens)

Headless Claude Code honors `ANTHROPIC_BASE_URL`, and litellm (already an
eval dependency) can proxy its Anthropic-compatible `/v1/messages` to a model
that costs nothing — a hosted OpenRouter `:free` variant or a fully local
Ollama model. Config template: `free-model.litellm.yaml`.

```bash
# 1. Choose a proxy master key and start the proxy
#    (pick/edit a model route in the yaml first; keep the proxy on loopback —
#    anyone who can reach the port with this key can spend the backend quota)
export LITELLM_MASTER_KEY="$(openssl rand -hex 16)"
uv run --locked --with 'litellm[proxy]' litellm --config workflow_bench/free-model.litellm.yaml --port 4000

# 2. Point the benchmark at it
uv run --locked --extra dev python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
  --base-url http://localhost:4000 --anthropic-api-key "$LITELLM_MASTER_KEY" --model free-coder
```

## OpenAI API keys

Claude Code still speaks Anthropic `/v1/messages`. For a paid OpenAI backend,
do not point `--anthropic-api-key` at an `sk-...` OpenAI key. Export the OpenAI key
and use OpenAI model ids; the driver starts the proxy itself:

```bash
export GITNEXUS_BENCH_OPENAI_API_KEY="$OPENAI_API_KEY"
PROVIDER=openai ./workflow_bench/run-evolution.sh
```

The GitHub skill-evolution workflow accepts `GITNEXUS_BENCH_OPENAI_API_KEY` on
the `gitnexus-evolution` environment. Dispatch with `provider=openai` to force
that backend even when an Anthropic token is also configured (otherwise `auto`
keeps using Anthropic whenever that secret exists). Claude default model
inputs are then rewritten to `gpt-5.6-sol`; every proposer and benchmark
session receives `--effort xhigh`.

Caveats, honestly:

- Both arms run on the same model, so the _comparison_ stays fair at any
  quality level — but small free models follow skills less reliably, so
  expect lower resolve rates and noisier savings than on frontier models.
  Treat free-model runs as directional; confirm headline numbers with a
  small paid run.
- Through a proxy `cost_usd` reads ~0, and the CLI's token counts are NOT a
  substitute "real metric": they cover only the main-loop session, so
  subagent spend is invisible to both. For efficiency ranking, prefer a paid
  run gated on `cost_usd`, or sum per-session usage from the transcripts
  (`~/.claude/projects/<cwd-slug>/<session_id>.jsonl`, deduplicating events
  that share one `message.id`).
- OpenRouter `:free` variants are rate-limited (~50 req/day on a fresh
  account); local Ollama has no limits.
- Codex users: `codex exec --oss` runs local models for free too, but this
  runner is Claude-Code-first; a codex engine is a straightforward extension
  (parse its `--json` usage events).

## Historical ground base (2026-07-11, Claude Code 2.1.207, unnamed model, n=1/cell)

These figures predate mandatory model provenance and are retained only as
historical calibration. They are not eligible promotion evidence and must not
be combined with current named-model runs.

Three task classes × three arms, single-repo (GitNexus itself). **Every arm
resolved every task** — at this difficulty, pass/fail quality is saturated
and the comparison is pure cost:

| task (class)                  | arm             | resolved | cost $ | wall | turns | vs baseline cost        |
| ----------------------------- | --------------- | -------- | ------ | ---- | ----- | ----------------------- |
| trivial-version-alias         | workflow        | 1/1      | 9.16   | 16m  | 63    | −333%                   |
| trivial-version-alias         | baseline        | 1/1      | 2.11   | 2.8m | 16    | —                       |
| inv-bug-pdg-note              | workflow        | 1/1      | 14.56  | 21m  | 83    | −331%                   |
| inv-bug-pdg-note              | workflow_direct | 1/1      | 5.23   | 7.5m | 32    | −55%                    |
| inv-bug-pdg-note              | baseline        | 1/1      | 3.38   | 4.7m | 22    | —                       |
| inv-feature-list-repos-filter | workflow        | 1/1      | 13.22  | 19m  | 84    | −211%                   |
| inv-feature-list-repos-filter | workflow_direct | 1/1      | 4.87   | 4.8m | 38    | −15% (wall +14% faster) |
| inv-feature-list-repos-filter | baseline        | 1/1      | 4.25   | 5.5m | 32    | —                       |

What the ground base says, honestly:

- **The full plan→work workflow never paid for itself at this task scale**
  (tasks a baseline agent finishes in ≤35 turns). Its fixed cost — freshness
  gate incl. analyzer rebuild + re-index, a full 13-section plan, work-phase
  re-anchoring — is ~$9–11 per task and needs much larger tasks, plan-reuse
  (one plan, several executors/sessions), or plan-as-deliverable flows to
  amortize.
- **workflow_direct is close to baseline** (−15% to −55% cost, once slightly
  faster wall) — the execution discipline (impact-before-edit,
  detect_changes-before-commit) is cheap. It produced noticeably more test
  coverage than baseline for near-equal cost on the feature task.
- **Quality didn't differentiate because nothing failed.** The regime where
  the workflow should win on _resolve rate_ — cross-module tasks where
  baselines flail — is the unmeasured cell (`cross-module-parse-retry`), and
  the next thing to measure, ideally with `--runs 3+` on a free backend.
- Caveats: n=1 per cell, one repo, one model; churn numbers from this run
  predate the intent-to-add/exclude-plans churn fix, so they are not
  comparable across arms and are omitted above.

These historical cells suggest measuring direct execution before adding a
planning session for small tasks. They do not establish an optimal routing
policy. A plan may be useful for multi-session execution or as a deliverable;
its extra cost must be included in the comparison.

### Cross-module cell (same day, optimized skills, n=1)

The hardest class — retry-with-backoff across the worker-pool/pipeline
seams, transient-vs-deterministic classification:

| arm                 | resolved | cost $   | wall    | turns  | churn       |
| ------------------- | -------- | -------- | ------- | ------ | ----------- |
| workflow            | 1/1      | 18.32    | 37m     | 107    | 4/+373/−17  |
| **workflow_direct** | 1/1      | **9.53** | **15m** | **52** | 11/+244/−66 |
| baseline            | 1/1      | 18.03    | 34m     | 98     | 6/+345/−69  |

(The workflow_direct row is the clean re-run under clone isolation — the
original was contaminated, see the integrity note below.)

**Historical observation only: unnamed model, n=1 per arm.** In this cell,
`workflow_direct` recorded **47% lower model cost and 56% less wall time**
than the **MCP-enabled `baseline`**. Both agents already had GitNexus; this
does not measure GitNexus versus no GitNexus. All three arms solved this one
task. The measurements cannot attribute the difference to workflow discipline
or predict savings for other users, tasks, or models. The full workflow cost
slightly more than baseline ($18.32 versus $18.03). A current named-model
comparison with repeated runs and `baseline_nomcp` is needed before making a
current savings claim.

**Benchmark integrity note (why churn earns its keep):** the original
`workflow_direct` cell reported an impossible 28-turn/$4.71 solve with churn
byte-identical to the workflow arm — because `git worktree add` shares the
ref namespace, the workflow arm's slug branch survived worktree removal, and
the direct arm found and adopted the finished work. Fixed by giving every
arm an isolated `git clone --no-local --no-hardlinks` with no object
alternates (agent-created refs and storage die with the clone);
the leaked branch was deleted and the cell re-measured. Treat identical
churn fingerprints across arms as a contamination alarm.

### Optimization re-measurement (same day, commit 830a0459)

After category-priced plan forms (compact ≤80 lines + mini-pack),
category-priced freshness (`accept` for compact classes), per-category turn
budgets, and the work-phase HEAD==pin fast path, the same
`inv-bug-pdg-note` workflow cell re-measured (n=1):

|               | ground base | optimized | delta    |
| ------------- | ----------- | --------- | -------- |
| resolved      | ✅          | ✅        | —        |
| cost $        | 14.56       | 11.70     | **−20%** |
| turns         | 83          | 72        | −13%     |
| output tokens | 59,789      | 53,345    | −11%     |
| cache_read    | 6.64M       | 5.07M     | −24%     |
| wall          | 21m         | 25m       | +15%     |

Verified in-transcript: the compact form fired (115-line plan vs 209 for a
simpler task pre-optimization), the plan session dropped 72→49 turns, and
NO analyzer rebuild/re-index executed. All savings came from the plan side;
this run's work session drew a long test-debugging tail (hence the wall
regression) — single-run variance cuts both ways. The optimizations narrow
the gap but do not flip the regime: the workflow remains ~3.5× baseline on
this task class, so the routing rule above stands unchanged.

## Writing good tasks

See `tasks.scenarios.yaml`. Small enough to finish headless, real enough to
require investigation — the workflow's savings come from _not re-reading and
not re-investigating_, which trivial tasks never exercise. Keep `verify` as a
model-visible authored-test quality signal, and add an independent `oracle`
whose source files live under `workflow_bench/oracles/`. Oracle commands must
run only files staged beneath `$GITNEXUS_BENCH_ORACLE_ROOT`; for Vitest, include
the shared `vitest.config.mts` as an oracle file and pass it explicitly with
`--config`. Prefer `verify` commands that use the repo's own npm scripts (they
carry build pre-hooks).

The C scenario is `inv-feature-c-include-provenance`. At its pinned task
commit, ingestion drops literal system includes before resolution. The task
requires retaining the header identity and enough provenance to prevent
unconfigured system includes from matching unrelated repository headers,
while keeping quoted local and relative includes resolvable. Computed macro
includes remain outside this task's scope. Its hidden oracle parses real C
source and passes the resulting import through the decomposer, interpreter,
and resolver; it does not require a particular metadata field or encoding.

Offline controls must show that the untouched task base fails the intended
behavioral assertion and that two independent, type-correct repairs pass both
the hidden oracle and the complete authored verification command. Negative
controls also reject dropped imports, lost header identity, and false system
header matches. These controls run with the pinned task dependencies through
`test_shipped_oracles_reject_task_base_and_accept_reference_fixes`.

This replaces `inv-bug-c-system-include`, whose oracle constructed an import
state the pinned parser did not produce and constrained the repair's internal
representation. Historical scores for that task are not valid evidence of C
ingestion quality and are not comparable with the replacement task. The new
task ID, prompt, verification command, and oracle bytes produce a new task
digest. Old agent patches are not available for rescoring; keep historical
measurements unchanged and compare only runs with matching task contracts.

## MCP response cost

### Session diagnostics

Every new headless session records `session_diagnostics` in `results.jsonl`.
The parent timestamps complete stdout event lines without changing the agent
prompt, tool responses, sandbox, or release criteria. No additional model calls
are made. Existing results without diagnostics remain valid and have unknown
timing, rather than measured zero time.

The release evaluation's GitHub Actions summary includes a **Detailed
measurements** section for each measured runtime or optional arm. It shows cost
and wall-time distributions, setup/cleanup phases, CLI token counters, tool
outcomes and outliers, context/cache signals, repeated verification, and provider
request sizes and usage. Matching `*-diagnostics.json` and `*-diagnostics.md`
files are included in the sanitized evaluation artifacts. PR comparison
summaries retain the candidate's safe diagnostics too.

Each sweep writes its own provider ledger. Only aggregate numeric provider
measurements reach the summary and artifacts; raw request identities and usage
ledgers remain on the runner. Missing or torn inputs are marked as partial,
and provider token totals are withheld when ledger records are unreadable.
Concurrent requests are not assigned to individual cells. Historical runs
without this instrumentation show missing telemetry; regenerating a report
cannot recover tool timings that were never recorded.

Each session contains:

- `calls`: tool name, event indexes, input/result JSON bytes, receipt offsets,
  elapsed time, repeated-argument references, result status, staleness,
  truncation, and the next assistant action's tool names. MCP errors, missing
  symbols, ambiguity, empty query results, UNKNOWN risk, and output-limit
  failures are counted separately. Standalone `gitnexus` shim commands are
  identified; compound shell commands remain `Bash` because their elapsed time
  includes other work.
- `assistant_usage`: the last available usage snapshot for each assistant
  message, keyed by event index. Missing fields stay missing. These are
  main-session CLI counters, not a complete provider or subagent ledger.
- `workload`: repeated reads, reads of files referenced by graph results,
  query/context/read sequences, graph calls before the first observed edit,
  verification commands and repeats, edits after verification, compactions,
  and input-context growth. Shell commands are classified conservatively;
  compound commands remain mixed. Unknown shell actions invalidate the
  assumption that the checkout stayed unchanged between verification calls.
  These are action counts, including failed edit attempts, not proven waste.
- `tools`: per-tool counts, elapsed sums, response bytes, and source-read
  follow-ups after problematic results. One source action can follow multiple
  problem results, so follow-ups are associations, not unique extra reads.
- `tool_wait_s`: the union of observed call intervals; parallel tools count
  once. `mcp_wait_s` is a subset. `other_wall_s` includes model requests,
  startup, transport, retries and scheduling; it is not a measurement of model
  reasoning time. Missing results, unmatched IDs, clock gaps or diagnostics
  limits make complete wait totals unavailable.
- `server_wall_s`: the sum of tool-reported `timing.wall` milliseconds, converted
  to seconds, with a separate coverage count. Missing server timing stays
  unknown. This does not equal the host's tool wait or model request time.

The normal release JSON and Markdown include numeric per-tool summaries. The
JSON also keeps each session's five largest results, five slowest calls, and
five problematic calls with the largest results,
with event indexes for locating the detail in local `results.jsonl`. Raw tool
arguments, result text, source, prompts, IDs and argument hashes are excluded
from these diagnostics. Call and assistant-usage details are bounded at 2,048
entries per session; `truncated` exposes that limit. Receipt timing is bounded
at 100,000 event lines. Diagnostics do not make incomplete task evidence valid.

Use the counters to investigate explanations separately: large successful
responses suggest payload overhead; missing/ambiguous targets followed by
source reads suggest a possible workaround; repeated calls suggest a possible
navigation loop. These are signals, not proof of poor resolution or causation.
An empty result is not proof that a symbol is absent. Repeated arguments can be
justified after edits, and smaller output can require more follow-up reads.
Graph precision/recall requires expected-symbol labels or source verification.
The reported session cost is the money measurement; diagnostics never invent
per-tool dollar costs from bytes or elapsed time.

### Cost investigations and controlled experiments

No paid rerun is needed to prepare experiments or summarize existing evidence.
The commands below only read local files and write diagnostic artifacts.
Run them from `eval/` with the project's locked environment.

For the first trial, prepare two cells for one task, with a $5 CLI-reported
budget stop per cell. This checks telemetry delivery before a larger comparison:

```bash
uv run --locked python -m workflow_bench.diagnostic_experiments \
  --tasks workflow_bench/tasks.scenarios.yaml \
  --repository /path/to/GitNexus --runtime /path/to/built/GitNexus \
  --harness-sha FULL_HARNESS_SHA --runtime-sha FULL_RUNTIME_SHA \
  --model gpt-5.6-sol --effort xhigh --seed 3762 --repeats 1 \
  --variants no_graph mcp_eager --task-ids trivial-status-json-alias \
  --max-budget-usd 5 --out /tmp/gitnexus-diagnostics-trial
```

The runner forwards `--max-budget-usd` to Claude Code and accepts it only for
single-session baseline arms. The default remains uncapped. Budget-stopped
sessions stay failed and retain reported spend; they cannot establish savings
or successful task completion. The $10 planned total uses CLI accounting, not
a provider invoice cap: an in-flight request or different provider accounting
can exceed it. Preparing the plan does not authorize or execute the trial.

After authorizing those two paid cells, dispatch the trusted main workflow with
`diagnostic_trial=true` and the full reviewed candidate SHA:

```bash
gh workflow run release-evaluation.yml --ref main \
  -f diagnostic_trial=true -f candidate_ref=FULL_CANDIDATE_SHA \
  -f model=gpt-5.6-sol -f effort=xhigh
```

This mode runs `trivial-status-json-alias` once per arm, serially, with a $5
CLI-reported budget stop and a 900-second session timeout. It rejects additional
CLI/deferred arms, other models/efforts, runner-only mode, and repeat attempts.
The full stable/candidate sweep is skipped. The existing EC2 lock, containment
preflight, stop deadline, evidence reserve, and verified shutdown still apply.

The Actions summary and `diagnostic-trial-*` artifact contain sanitized
measurements for both cells, including failures. Raw provider ledgers remain on
the runner. Trial artifacts cannot approve a release. Missing result rows,
session diagnostics, or provider ledgers fail the trial instead of producing a
green run without measurements. Review the recorded spend before authorizing a
new dispatch after failure; the executor never retries or resumes a used plan.

| Possible cause | Measurement | What still needs an experiment |
| --- | --- | --- |
| Missing, ambiguous or incomplete resolution | Tool outcomes, UNKNOWN risk, lower-bound/stale/truncated responses, next source actions | Verify the intended target exists at the indexed source revision |
| Successful but irrelevant retrieval | Fixed source anchors in `retrieval_cases.json`, anchor recall and first anchor position | Capture the same queries against the sanitized task graph; unjudged results are not false positives |
| Too little detail or repeated investigation | Query/context/read chains, repeated arguments/reads, reads after graph references with and without source | A follow-up read may be necessary; compare matched tasks before calling it waste |
| Large responses and context growth | Result bytes, complete input usage snapshots, first/last/peak context, cache reads/writes, compactions | Compare response-size treatments at equal quality; bytes are not tokens |
| Mandatory graph workflow | Graph calls before edits; eager MCP versus optional-use prompt arm | Prompt ablation measures behavior; it does not remove repository instruction bytes |
| Tool catalog and transport | Eager/deferred/CLI arms; proxy tools/messages bytes and counts | Request sizes are available only when the proxy callback receives those fields |
| Verification and scope growth | Test/typecheck/lint/build counts, repeated checks, edits after verification, diff insertions/deletions/files | Larger diffs and repeated tests are not inherently unnecessary |
| Task fit and quality ceiling | Per-task cost distribution, solved/failed/missing counts, cost per solved task | Add harder independently validated tasks before claiming a quality improvement at 100% success |
| Order, concurrency, warm caches | Seeded rotated order, one worker and separate ledger per cell | Run matched worker-count/cold-start studies separately; fresh processes do not guarantee cold provider/filesystem caches |
| Retries, provider translation and accounting | CLI retry events; deduplicated success/failure callbacks, native normalized usage, reasoning tokens, proxy durations and estimates | Reconcile with provider billing; do not join concurrent requests to cells by timestamp |
| Setup, indexing and infrastructure | Cell start/finish timestamps, total duration, clone/index-materialization/dependency/MCP-startup/sandbox/agent-and-verification/artifact/cleanup spans | Shared index-build preparation, CPU/RSS, isolated oracle spans and infrastructure prices need separate evidence; do not fold them into model dollars |

Summarize a runner result file (including failed cells) and optionally its proxy
ledger. Historical release reports with `per_run` rows are also accepted:

```bash
uv run --locked python -m workflow_bench.cost_diagnostics \
  --results /path/to/results.jsonl \
  --provider-usage /path/to/provider_usage.jsonl \
  --out /tmp/cost-diagnostics.json --markdown-out /tmp/cost-diagnostics.md
```

Unknown fields remain null. Distinct model/effort/source/prompt/runtime/loading
cohorts are kept separate. Duplicate exported cell identities are rejected.
Provider response-ID conflicts withhold token totals; missing IDs prevent a
deduplicated total. Failed requests remain in the accounting. Proxy cost is an
estimate, not a provider invoice. The report is descriptive and does not change
release gates. It cannot infer cells omitted from its input: compare every
expected cell in the experiment plan before computing a treatment effect.
`cell_duration_s` includes setup and cleanup; `duration_s` retains its existing
session meaning. Phase spans partition the cell, including a failed active
phase, and unvisited phases stay missing. Shared snapshot construction happens
before cells and is not included. Agent and harness verification share one
phase; it must not be presented as isolated LLM reasoning time. Raw rows retain
UTC start/finish timestamps for order analysis; public release JSON retains
only numeric durations and whitelisted phase names.

Prepare a pilot focused on the overhead floor and the expensive retry task:

```bash
uv run --locked python -m workflow_bench.diagnostic_experiments \
  --tasks workflow_bench/tasks.scenarios.yaml \
  --repository /path/to/GitNexus --runtime /path/to/built/GitNexus \
  --harness-sha FULL_HARNESS_SHA --runtime-sha FULL_RUNTIME_SHA \
  --model gpt-5.6-sol --effort xhigh --seed 3762 --repeats 5 \
  --task-ids trivial-status-json-alias cross-module-parse-retry \
  --out /tmp/gitnexus-cost-experiment
```

This creates `plan.json` and one task manifest per cell. It has **no execution
mode** and never starts an agent. Five arms × two tasks × five repeats prepares
50 cells; this is a design, not spend authorization. Use `--variants` to prepare
a narrower comparison. Position balance requires a repeat count divisible by
the number of arms. The plan records argv arrays, environment paths, task class,
block/position, source pins and prompt/manifest digests. It refuses to overwrite
an existing directory. Pin the final instrumentation commit before execution;
an uncommitted implementation is not reproduced by its parent SHA alone.

After separately authorizing spend, run cells serially in the listed sequence,
from the recorded `cwd`, with the recorded environment and a fresh exclusive
proxy ledger. Each subprocess runs one task/arm/repetition. Its raw `run` is
zero; retain the plan's cell ID and block when assembling comparisons. Do not
mix the optional-prompt arm with ordinary release evidence or reuse its results
for a required-guidance arm. Retain failures and missing cells in the denominator.
Record machine/container, dependency bindings, cache policy, start/finish times
and setup/oracle timing alongside the existing runner output. Reconcile the
ledger sum with CLI-reported session spend, rather than estimating dollars per
tool from duration or payload size.

The four source-verified retrieval cases cover the same pinned scenario source.
Capture each fixed query from the **sanitized** task index used by the runner,
with the same query limits and content setting. Save parsed response objects as:

```json
{
  "source_sha": "c4ecf398de637cf779ab2238e69958cfd5d601ce",
  "runtime_sha": "FULL_RUNTIME_SHA",
  "sanitized_graph": true,
  "index_complete": true,
  "index_staleness": "current",
  "query_options": {"limit": 5, "max_symbols": 10, "include_content": false},
  "cases": [{"id": "CASE_ID", "query": "EXACT_FIXTURE_QUERY", "response": {}}]
}
```

Verify those provenance fields against the index receipt; the offline scorer
checks declarations, not the database itself. Keep capture metadata and raw
responses private, since they contain repository source. Score without an LLM:

```bash
uv run --locked python -m workflow_bench.retrieval_diagnostics \
  --recordings /path/to/retrieval-recordings.json --out /tmp/retrieval-scores.json
```

Missing cases remain missing, errors are not successful empty queries, and stale
or mismatched source recordings are rejected. These are partial anchor labels;
there is no precision score or claim that every other result is irrelevant.
Anchor position follows flattened response order, not a global search rank.

With `include_content: true`, queries share a 16,000-character preview allowance
equally across unique symbols on the returned page. The database returns only
those prefixes, after ranking and pagination. `content_truncated: true` marks
incomplete source; every match remains present. Use `context` for a full symbol
or `read_file` for a bounded file range. This applies to CLI, HTTP, and MCP
queries; group queries already request no source content.

MCP query guidance lives in the JSON `next` field. Explicit `maxTokens` retains
its existing final text cap, which can truncate JSON; it does not change the
query preview allowance. Payload reductions alone do not establish agent cost
or completion-time improvements: previews can require follow-up reads.

MCP tool schemas expose the configured default repository name and path. The
sandbox already configures `/workspace` as its default, so the schema identifies
`benchmark-target` without adding benchmark-specific instructions to task prompts.
Compare stable and candidate runtimes using the same harness revision.

## Relation to the SWE-bench harness

The rest of `eval/` benchmarks GitNexus _tools_ inside a litellm agent loop
(baseline vs graph-enhanced). This module benchmarks the _skill workflow_
inside the real CLI harness those skills ship for. Different question, same
spirit: measure, don't assume.
