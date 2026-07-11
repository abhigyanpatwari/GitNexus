# Workflow benchmark — observe the token savings

Measures whether the `gitnexus-plan` → `gitnexus-work` engineering workflow
actually saves tokens versus a baseline agent on the same tasks, using real
headless Claude Code sessions. Nothing is estimated: every number comes from
the CLI's own `--output-format json` usage report.

## What it compares

| Arm | Sessions | Notes |
| --- | --- | --- |
| `workflow` | `gitnexus-plan` on the task, then `gitnexus-work` on the produced plan | The skills must be installed (`gitnexus setup`, or repo-local `.claude/skills/`) |
| `baseline` | one session with the identical task text | `--disallowedTools Skill` so it cannot borrow the workflow; same repo, same MCP tools |

Both arms run in fresh detached git worktrees of the task's `ref`, once per
`--runs`. A per-task `verify` command decides `resolved` — token savings on a
failed task are flagged, not celebrated. The benchmark isolates the
*workflow discipline* (graph-first navigation, context ledger, plan→pack
handoff); both arms may use the GitNexus MCP tools.

## Quick start

```bash
cd eval
uv run python -m workflow_bench.runner --tasks workflow_bench/tasks.example.yaml --runs 3
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
  --tasks workflow_bench/tasks.example.yaml --runs 3 \
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

## Calibration data point (2026-07-11, Claude Code 2.1.207)

First live run, deliberately on a *trivial* task ("add `-V` as a `--version`
alias + unit test", 1 run, default model), to calibrate the overhead floor:

| arm | resolved | cache_create | cache_read | output | cost $ | wall s | turns |
| --- | --- | --- | --- | --- | --- | --- | --- |
| workflow | 1/1 | 184,603 | 3,980,936 | 29,668 | 9.16 | 955 | 63 |
| baseline | 1/1 | 57,113 | 711,184 | 5,222 | 2.11 | 167 | 16 |

Both arms solved it; the workflow cost ~4.3× more. That is the expected
result for this task class — a two-line alias needs no investigation, so the
workflow's fixed costs (freshness gate incl. analyzer rebuild + re-index, a
209-line plan, context pack, work-phase re-anchoring) are pure overhead.
The savings hypothesis applies to investigation-heavy, multi-file tasks
(see the example tasks) and to plan-once/execute-later flows where the
context pack amortizes. If the benchmark had flattered the workflow on this
task, distrust the benchmark.

## Writing good tasks

See `tasks.example.yaml`. Small enough to finish headless, real enough to
require investigation — the workflow's savings come from *not re-reading and
not re-investigating*, which trivial tasks never exercise. Prefer `verify`
commands that use the repo's own npm scripts (they carry build pre-hooks).

## Relation to the SWE-bench harness

The rest of `eval/` benchmarks GitNexus *tools* inside a litellm agent loop
(baseline vs graph-enhanced). This module benchmarks the *skill workflow*
inside the real CLI harness those skills ship for. Different question, same
spirit: measure, don't assume.
