# Workflow benchmark — observe the token savings

Measures whether the `gitnexus-plan` → `gitnexus-work` engineering workflow
actually saves tokens versus a baseline agent on the same tasks, using real
headless Claude Code sessions. Nothing is estimated: every number comes from
the CLI's own `--output-format json` usage report.

## What it compares

| Arm | Sessions | Notes |
| --- | --- | --- |
| `workflow` | `gitnexus-plan` on the task, then `gitnexus-work` on the produced plan | The skills must be installed (`gitnexus setup`, or repo-local `.claude/skills/`) |
| `candidate_workflow` | same sessions as `workflow`, with a candidate skill overlay | Paired with `workflow` on the same task/ref/model |
| `workflow_direct` | one `gitnexus-work` direct-mode session | The middle option — execution discipline without a planning pass |
| `candidate_workflow_direct` | same session as `workflow_direct`, with a candidate skill overlay | Paired with `workflow_direct` on the same task/ref/model |
| `ce_workflow` | `ce-plan` on the task, then `ce-work` on the produced plan | External comparator: the compound-engineering plugin's plan→work family, prompted like `workflow` (plugin ships user-level) |
| `ce_workflow_direct` | one `ce-work` direct-mode session | External comparator paired with `workflow_direct` |
| `review` | one `gitnexus-review` session over local uncommitted changes | The task's `setup` applies the diff under review; the review is written to `review-output.md` so `verify` can gate on it |
| `ce_review` | one `ce-code-review` session over the same changes | External comparator paired with `review` |
| `baseline` | one session with the identical task text | `--disallowedTools Skill` so it cannot borrow the workflow; same repo, same MCP tools |
| `baseline_nomcp` | like baseline, graph tools also disallowed | Separates the workflow-discipline question from the GitNexus-tools question (off by default) |

Every arm runs in a fresh detached git worktree of the task's `ref`, once per
`--runs`. A per-task `verify` command decides `resolved` — token savings on a
failed task are flagged, not celebrated — and diff churn
(files/+insertions/−deletions vs the starting commit) is recorded as a cheap
over-engineering proxy. Task `class` labels (trivial → investigation →
cross-module) make the report readable as a routing table: the boundary where
`workflow` starts beating `workflow_direct` and `baseline` is the boundary
lfg's gate and work's direct-mode triage should encode.

## Quick start

```bash
cd eval
uv run python -m workflow_bench.runner --tasks workflow_bench/tasks.scenarios.yaml --runs 3
```

Output: `results/wfbench-<timestamp>/results.jsonl` (every run, with session
ids for transcript drill-down) and `report.md` (medians per task per arm,
plus a savings row: input / cache / output tokens, cost, wall time).

## Trust model — task files are executable input

**Only run task files, repos, and candidate overlays you trust.** This is a
local benchmarking tool, not a sandbox:

- Each task's `setup` and `verify` strings run through the shell
  (`shell=True`) on your machine, with your environment.
- The benchmarked sessions default to `--permission-mode bypassPermissions`
  (they must edit and run tests unattended) and inherit the parent process
  environment — including any credentials in it. Clones are throwaway, your
  environment is not: scrub secrets from the shell you launch from, or pass a
  stricter `--permission-mode`.
- Candidate overlays are skill *prompts* injected into those sessions; a
  malicious overlay can instruct an agent that has shell access. The runner
  restricts overlay paths and file types, not their prose.

Treat a tasks YAML from someone else like a shell script from someone else:
read it before running it.

## Prompt and skill evolution loop

Prompts age as models and tool harnesses change. Treat the current skills and
router thresholds as an incumbent policy, not permanent truth. Candidate
changes run offline in the same throwaway clones as the incumbent; production
skills never rewrite themselves from a live task.

Build an overlay that mirrors only the canonical repo-local skill paths:

```text
/tmp/gn-skill-candidate/
└── .claude/skills/
    ├── gitnexus-plan/SKILL.md
    ├── gitnexus-work/SKILL.md
    ├── gitnexus-lfg/SKILL.md
    └── gitnexus-review/SKILL.md
```

The overlay may contain Markdown files from any subset of those four skill
trees. The runner rejects every other path, including source, test, and MCP
configuration files, so a candidate cannot improve its score by changing the
task or verifier. Run candidate and incumbent arms together on a pinned model:

```bash
cd eval
uv run python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml \
  --runs 3 --model <pinned-model-id> \
  --arms workflow candidate_workflow \
         workflow_direct candidate_workflow_direct baseline \
  --candidate-overlay /tmp/gn-skill-candidate
```

Candidate runs start from the same task commit, then receive a clean ephemeral
commit containing the overlay. `results.jsonl` records the named model, task
commit, task-prompt digest, skill digest, overlay digest, timestamp, and local
session ids. Those session transcripts are the trajectory evidence: cluster
failures and expensive detours, propose one bounded prompt change, and feed it
back as the next overlay.

When candidate arms are present the runner also writes `promotion.json`. Its
default deterministic gate is deliberately conservative:

- at least 3 paired VALID runs per task (session/infra-error runs don't
  count) and a named model;
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
`--promotion-*` thresholds. A `promote` decision is evidence for a normal,
human-reviewed change to the canonical `.claude/skills/` files and their
shipped mirrors; it does not edit them automatically. `keep_incumbent` and
`insufficient_evidence` become the next learning queue; their raw
`results.jsonl` rows carry the `session_ids` of the trajectories to inspect.

Re-run the paired suite whenever the named model or tool harness changes, and
at least every 90 days otherwise. This is prompt-policy optimization using
verified agent trajectories as reward evidence; it is intentionally not
online model-weight RL. The same records can feed a later offline RL pipeline
without weakening today's deterministic promotion boundary.

### Closing the loop automatically (`evolve.py`)

`workflow_bench.evolve` automates the three manual arrows — propose,
benchmark, apply — without moving the trust boundary:

```bash
cd eval
uv run python -m workflow_bench.evolve \
  --tasks workflow_bench/tasks.scenarios.yaml \
  --model <pinned-model-id> --generations 2 \
  --seed-results results/wfbench-<prior-run>   # optional gen-0 evidence
```

Each generation: a **proposer** session (headless Claude in a throwaway
clone) reads the incumbent skills, the prior generation's `results.jsonl`
loser rows, their session transcripts and patches, and the learning queue,
then writes ONE bounded candidate overlay plus a reviewer-facing
`proposal.md`. The overlay is re-validated by `candidate_overlay_files`
(same boundary: Markdown under the four skill trees, nothing else), the
paired benchmark runs, and the deterministic gate decides. `promote` stops
the loop; with `--apply` the overlay is copied onto the canonical
`.claude/skills/` trees and their shipped mirrors as an ordinary
working-tree diff — committing, CI (`shipped-skills-sync`,
`skills-steering`), and the PR merge stay human. `keep_incumbent` feeds that
generation's trajectories to the next proposer. `--initial-overlay` skips
the generation-0 proposer to benchmark a hand-written candidate;
`--proposer-model` upgrades only the diagnosis session.

**Learning queue.** Live skill runs never self-edit (see each skill's
"Skill feedback" section) — instead they may append one-line JSON notes to
`workflow_bench/learnings.jsonl` (gitignored, machine-local like the
transcripts they complement). The proposer reads the queue as hints, not
ground truth: a learning only reaches a shipped skill by surviving the same
paired benchmark as any other candidate.

Run the driver on the existing re-evaluation triggers (model/harness change,
90-day staleness), not on a tight schedule — every generation costs ≥3 paired
runs per task, and `--generations` is the only loop bound.

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
uv run --with 'litellm[proxy]' litellm --config workflow_bench/free-model.litellm.yaml --port 4000

# 2. Point the benchmark at it
uv run python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
  --base-url http://localhost:4000 --auth-token "$LITELLM_MASTER_KEY" --model free-coder
```

Caveats, honestly:

- Both arms run on the same model, so the *comparison* stays fair at any
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

## Ground base (2026-07-11, Claude Code 2.1.207, default model, n=1/cell)

Three task classes × three arms, single-repo (GitNexus itself). **Every arm
resolved every task** — at this difficulty, pass/fail quality is saturated
and the comparison is pure cost:

| task (class) | arm | resolved | cost $ | wall | turns | vs baseline cost |
| --- | --- | --- | --- | --- | --- | --- |
| trivial-version-alias | workflow | 1/1 | 9.16 | 16m | 63 | −333% |
| trivial-version-alias | baseline | 1/1 | 2.11 | 2.8m | 16 | — |
| inv-bug-pdg-note | workflow | 1/1 | 14.56 | 21m | 83 | −331% |
| inv-bug-pdg-note | workflow_direct | 1/1 | 5.23 | 7.5m | 32 | −55% |
| inv-bug-pdg-note | baseline | 1/1 | 3.38 | 4.7m | 22 | — |
| inv-feature-list-repos-filter | workflow | 1/1 | 13.22 | 19m | 84 | −211% |
| inv-feature-list-repos-filter | workflow_direct | 1/1 | 4.87 | 4.8m | 38 | −15% (wall +14% faster) |
| inv-feature-list-repos-filter | baseline | 1/1 | 4.25 | 5.5m | 32 | — |

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
  the workflow should win on *resolve rate* — cross-module tasks where
  baselines flail — is the unmeasured cell (`cross-module-parse-retry`), and
  the next thing to measure, ideally with `--runs 3+` on a free backend.
- Caveats: n=1 per cell, one repo, one model; churn numbers from this run
  predate the intent-to-add/exclude-plans churn fix, so they are not
  comparable across arms and are omitted above.

Routing implication (to revisit as cells fill in): for tasks up to this
size, `gitnexus-work` direct mode or a plain agent is the cost-optimal
route; reserve full `gitnexus-plan` → `gitnexus-work` for cross-module work,
multi-session execution, or when the plan document itself is a deliverable.
If a future run shows the workflow flattering itself here, distrust the run.

### Cross-module cell (same day, optimized skills, n=1)

The hardest class — retry-with-backoff across the worker-pool/pipeline
seams, transient-vs-deterministic classification:

| arm | resolved | cost $ | wall | turns | churn |
| --- | --- | --- | --- | --- | --- |
| workflow | 1/1 | 18.32 | 37m | 107 | 4/+373/−17 |
| **workflow_direct** | 1/1 | **9.53** | **15m** | **52** | 11/+244/−66 |
| baseline | 1/1 | 18.03 | 34m | 98 | 6/+345/−69 |

(The workflow_direct row is the clean re-run under clone isolation — the
original was contaminated, see the integrity note below.)

**This is the cell where the discipline pays.** `workflow_direct` — the
execution skill without a planning pass — beat a plain agent by **47% cost
and 56% wall time** on the hardest class while resolving: impact-first
navigation and gated commits prevented the flailing that baseline's 98
turns represent. The full workflow's premium vanished (−1.6% vs baseline;
−211%..−333% on smaller classes) — fixed costs amortize here, with a less
destructive diff and a durable plan artifact — but it didn't beat direct
mode on any measured axis with the plan consumed only once. Resolve rate
stayed tied across all cells; the savings story belongs to the execution
discipline, and the planning pass is bought for its artifact (multi-session
reuse, review, handoff), not for same-session token savings.

**Benchmark integrity note (why churn earns its keep):** the original
`workflow_direct` cell reported an impossible 28-turn/$4.71 solve with churn
byte-identical to the workflow arm — because `git worktree add` shares the
ref namespace, the workflow arm's slug branch survived worktree removal, and
the direct arm found and adopted the finished work. Fixed by giving every
arm an isolated `git clone --shared` (agent-created refs die with the clone);
the leaked branch was deleted and the cell re-measured. Treat identical
churn fingerprints across arms as a contamination alarm.

### Optimization re-measurement (same day, commit 830a0459)

After category-priced plan forms (compact ≤80 lines + mini-pack),
category-priced freshness (`accept` for compact classes), per-category turn
budgets, and the work-phase HEAD==pin fast path, the same
`inv-bug-pdg-note` workflow cell re-measured (n=1):

| | ground base | optimized | delta |
| --- | --- | --- | --- |
| resolved | ✅ | ✅ | — |
| cost $ | 14.56 | 11.70 | **−20%** |
| turns | 83 | 72 | −13% |
| output tokens | 59,789 | 53,345 | −11% |
| cache_read | 6.64M | 5.07M | −24% |
| wall | 21m | 25m | +15% |

Verified in-transcript: the compact form fired (115-line plan vs 209 for a
simpler task pre-optimization), the plan session dropped 72→49 turns, and
NO analyzer rebuild/re-index executed. All savings came from the plan side;
this run's work session drew a long test-debugging tail (hence the wall
regression) — single-run variance cuts both ways. The optimizations narrow
the gap but do not flip the regime: the workflow remains ~3.5× baseline on
this task class, so the routing rule above stands unchanged.

## Writing good tasks

See `tasks.scenarios.yaml`. Small enough to finish headless, real enough to
require investigation — the workflow's savings come from *not re-reading and
not re-investigating*, which trivial tasks never exercise. Prefer `verify`
commands that use the repo's own npm scripts (they carry build pre-hooks).

## Relation to the SWE-bench harness

The rest of `eval/` benchmarks GitNexus *tools* inside a litellm agent loop
(baseline vs graph-enhanced). This module benchmarks the *skill workflow*
inside the real CLI harness those skills ship for. Different question, same
spirit: measure, don't assume.
