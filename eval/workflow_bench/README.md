# Workflow benchmark — observe the token savings

Measures whether the `gitnexus-plan` → `gitnexus-work` engineering workflow
actually saves tokens versus a baseline agent on the same tasks, using real
headless Claude Code sessions. Nothing is estimated: every number comes from
the CLI's own `--output-format json` usage report.

## What it compares

| Arm | Sessions | Notes |
| --- | --- | --- |
| `workflow` | `gitnexus-plan` on the task, then `gitnexus-work` on the produced plan | The skills must be installed (`gitnexus setup`, or repo-local `.claude/skills/`) |
| `workflow_direct` | one `gitnexus-work` direct-mode session | The middle option — execution discipline without a planning pass |
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

## Free-model setup (no paid tokens)

Headless Claude Code honors `ANTHROPIC_BASE_URL`, and litellm (already an
eval dependency) can proxy its Anthropic-compatible `/v1/messages` to a model
that costs nothing — a hosted OpenRouter `:free` variant or a fully local
Ollama model. Config template: `free-model.litellm.yaml`.

```bash
# 1. Start the proxy (pick/edit a model route in the yaml first)
uv run --with 'litellm[proxy]' litellm --config workflow_bench/free-model.litellm.yaml --port 4000

# 2. Point the benchmark at it
uv run python -m workflow_bench.runner \
  --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
  --base-url http://localhost:4000 --auth-token sk-wfbench --model free-coder
```

Caveats, honestly:

- Both arms run on the same model, so the *comparison* stays fair at any
  quality level — but small free models follow skills less reliably, so
  expect lower resolve rates and noisier savings than on frontier models.
  Treat free-model runs as directional; confirm headline numbers with a
  small paid run.
- `cost_usd` reads ~0 through a proxy; token counts remain the real metric.
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
| baseline | 1/1 | 18.03 | 34m | 98 | 6/+345/−69 |
| workflow_direct | *invalidated* — see below | | | | |

**The workflow's cost premium vanished at this scale** (−1.6% vs the −211%
to −333% of smaller classes): its fixed costs amortized, it produced a plan
document as a bonus artifact, and its diff was less destructive (−17
deletions vs baseline's −69 across more files). Resolve rate still didn't
differentiate — both passed — so the workflow's case at this scale is
equal-cost + better-shaped work + a durable plan, not savings yet.

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
