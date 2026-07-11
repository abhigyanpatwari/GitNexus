"""Benchmark the gitnexus-plan/work workflow against a baseline agent.

Usage:
    uv run python -m workflow_bench.runner --tasks workflow_bench/tasks.example.yaml --runs 3

Each task runs in a fresh detached git worktree of the target repo, once per
arm per run:

* ``workflow`` — two headless Claude Code sessions: gitnexus-plan, then
  gitnexus-work on the produced plan.
* ``baseline`` — one headless session with the same task text and the Skill
  tool disallowed (so it cannot borrow the workflow), everything else equal.

Token usage, cost, duration, and turn counts come from the CLI's own
``--output-format json`` report — nothing is estimated. A task-specific
``verify`` command decides ``resolved``; token savings on unresolved runs are
reported but flagged, because saving tokens by failing is not a saving.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import yaml

USAGE_FIELDS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)

PLAN_PROMPT = (
    "Use the gitnexus-plan skill for: {task}\n"
    "Headless run: make reasonable choices without asking; the plan document "
    "is the deliverable."
)
WORK_PROMPT = (
    "Use the gitnexus-work skill to execute the plan at {plan}.\n"
    "Headless run: proceed without asking; report Definition of Done status "
    "at the end."
)
WORK_DIRECT_PROMPT = (
    "Use the gitnexus-work skill for: {task}\n"
    "Headless run: proceed without asking. The user explicitly declines a "
    "separate planning pass — execute in direct mode with the skill's "
    "execution discipline."
)
BASELINE_PROMPT = (
    "{task}\n\n"
    "Implement the change in this repository and verify it by running the "
    "relevant tests. Work autonomously without asking questions."
)


def run_claude(
    prompt: str,
    cwd: Path,
    *,
    claude_bin: str,
    timeout: int,
    disallowed_tools: list[str] | None = None,
    model: str | None = None,
    env: dict[str, str] | None = None,
    permission_mode: str | None = None,
) -> dict[str, Any]:
    """Run one headless session and return its usage record."""
    cmd = [claude_bin, "-p", prompt, "--output-format", "json"]
    if permission_mode:
        cmd += ["--permission-mode", permission_mode]
    if model:
        cmd += ["--model", model]
    for tool in disallowed_tools or []:
        cmd += ["--disallowedTools", tool]
    started = time.monotonic()
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )
    wall_s = time.monotonic() - started
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "{}"
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        data = {}
    usage = data.get("usage") or {}
    return {
        "ok": proc.returncode == 0 and not data.get("is_error", False),
        "session_id": data.get("session_id"),
        "num_turns": data.get("num_turns", 0),
        "cost_usd": data.get("total_cost_usd", 0.0),
        "duration_s": round(data.get("duration_ms", wall_s * 1000) / 1000, 1),
        **{f: usage.get(f, 0) for f in USAGE_FIELDS},
    }


def sum_sessions(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    total: dict[str, Any] = {f: sum(s[f] for s in sessions) for f in USAGE_FIELDS}
    total["cost_usd"] = round(sum(s["cost_usd"] for s in sessions), 4)
    total["duration_s"] = round(sum(s["duration_s"] for s in sessions), 1)
    total["num_turns"] = sum(s["num_turns"] for s in sessions)
    total["ok"] = all(s["ok"] for s in sessions)
    total["session_ids"] = [s["session_id"] for s in sessions]
    return total


def newest_plan(worktree: Path) -> Path | None:
    plans = sorted(
        worktree.glob("docs/plans/*gitnexus-plan*.md"), key=lambda p: p.stat().st_mtime
    )
    return plans[-1] if plans else None


def make_worktree(repo: Path, ref: str, parent: Path) -> Path:
    target = Path(tempfile.mkdtemp(prefix="wfbench-", dir=parent))
    subprocess.run(
        ["git", "-C", str(repo), "worktree", "add", "--detach", str(target), ref],
        check=True,
        capture_output=True,
    )
    return target


def remove_worktree(repo: Path, worktree: Path) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "worktree", "remove", "--force", str(worktree)],
        check=False,
        capture_output=True,
    )


def parse_shortstat(text: str) -> dict[str, int]:
    """Parse `git diff --shortstat` output into churn counters."""
    keys = {
        "file": "diff_files",
        "insertion": "diff_insertions",
        "deletion": "diff_deletions",
    }
    out = dict.fromkeys(keys.values(), 0)
    for count, word in re.findall(r"(\d+) (file|insertion|deletion)", text):
        out[keys[word]] = int(count)
    return out


def diff_churn(worktree: Path, orig_sha: str) -> dict[str, int]:
    """Code churn (committed + uncommitted + new files) vs the worktree's
    starting sha — a cheap over-engineering proxy alongside pass/fail quality.

    intent-to-add makes untracked new files visible to `git diff` (arms that
    never commit would otherwise undercount); docs/plans is excluded so the
    workflow arm's committed plan document doesn't inflate its code churn.
    """
    subprocess.run(
        ["git", "-C", str(worktree), "add", "--intent-to-add", "-A"],
        capture_output=True,
        check=False,
    )
    proc = subprocess.run(
        [
            "git",
            "-C",
            str(worktree),
            "diff",
            "--shortstat",
            orig_sha,
            "--",
            ".",
            ":(exclude)docs/plans",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return parse_shortstat(proc.stdout)


def run_verify(command: str, cwd: Path, timeout: int) -> bool:
    proc = subprocess.run(
        command, shell=True, cwd=cwd, capture_output=True, timeout=timeout, check=False
    )
    return proc.returncode == 0


def claude_env(args: argparse.Namespace) -> dict[str, str]:
    """Environment for the headless sessions — free/alt-model routing hook.

    --base-url points Claude Code at any Anthropic-compatible endpoint (e.g. a
    local `litellm --config free-model.litellm.yaml` proxy fronting a free
    OpenRouter model or local Ollama); --auth-token supplies its key.
    """
    env = os.environ.copy()
    if args.base_url:
        env["ANTHROPIC_BASE_URL"] = args.base_url
    if args.auth_token:
        env["ANTHROPIC_AUTH_TOKEN"] = args.auth_token
    return env


def run_arm(
    arm: str, task: dict[str, Any], worktree: Path, args: argparse.Namespace
) -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    env = claude_env(args)
    common = {
        "claude_bin": args.claude_bin,
        "timeout": args.timeout,
        "model": args.model,
        "env": env,
        "permission_mode": args.permission_mode,
    }
    if arm == "workflow":
        sessions.append(
            run_claude(PLAN_PROMPT.format(task=task["prompt"]), worktree, **common)
        )
        plan = newest_plan(worktree)
        if plan is not None:
            sessions.append(
                run_claude(
                    WORK_PROMPT.format(plan=plan.relative_to(worktree)),
                    worktree,
                    **common,
                )
            )
    elif arm == "workflow_direct":
        sessions.append(
            run_claude(
                WORK_DIRECT_PROMPT.format(task=task["prompt"]), worktree, **common
            )
        )
    elif arm == "baseline_nomcp":
        # Isolates the workflow-discipline question from the GitNexus-tools
        # question: no skills AND no graph tools.
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill", "mcp__gitnexus"],
                **common,
            )
        )
    else:
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill"],
                **common,
            )
        )
    record = sum_sessions(sessions)
    record["arm"] = arm
    record["plan_produced"] = arm != "workflow" or newest_plan(worktree) is not None
    record["resolved"] = record["ok"] and run_verify(
        task["verify"], worktree, args.timeout
    )
    return record


# ─── Pure aggregation/report helpers (unit-tested) ──────────────────────────


CHURN_FIELDS = ("diff_files", "diff_insertions", "diff_deletions")


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Median metrics + resolve rate across repeated runs of one task+arm."""
    metrics = (*USAGE_FIELDS, "cost_usd", "duration_s", "num_turns", *CHURN_FIELDS)
    out: dict[str, Any] = {
        m: statistics.median(r.get(m, 0) for r in records) for m in metrics
    }
    out["resolved"] = sum(1 for r in records if r["resolved"])
    out["runs"] = len(records)
    out["class"] = records[0].get("class", "")
    return out


def savings(baseline: dict[str, Any], workflow: dict[str, Any]) -> dict[str, Any]:
    """Percent saved by the workflow arm per metric (positive = cheaper)."""
    out: dict[str, Any] = {}
    for metric in (*USAGE_FIELDS, "cost_usd", "duration_s"):
        base = baseline[metric]
        out[metric] = round(100 * (base - workflow[metric]) / base, 1) if base else 0.0
    return out


def render_report(results: dict[str, dict[str, dict[str, Any]]]) -> str:
    """results: {task_id: {arm: aggregate}} → markdown report."""
    lines = [
        "# gitnexus workflow benchmark",
        "",
        "Medians across runs; savings rows = (baseline − arm) / baseline per arm.",
        "A negative saving means that arm spent more than baseline. churn =",
        "files/+insertions/−deletions vs the worktree's starting commit.",
        "",
        "| task | class | arm | resolved | input | cache_create | cache_read | output | cost $ | wall s | turns | churn |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for task_id, arms in results.items():
        for arm, agg in arms.items():
            lines.append(
                f"| {task_id} | {agg['class']} | {arm} | {agg['resolved']}/{agg['runs']} "
                f"| {agg['input_tokens']:.0f} | {agg['cache_creation_input_tokens']:.0f} "
                f"| {agg['cache_read_input_tokens']:.0f} | {agg['output_tokens']:.0f} "
                f"| {agg['cost_usd']:.4f} | {agg['duration_s']:.0f} | {agg['num_turns']:.0f} "
                f"| {agg['diff_files']:.0f}/+{agg['diff_insertions']:.0f}/−{agg['diff_deletions']:.0f} |"
            )
        for arm in arms:
            if arm != "baseline" and "baseline" in arms:
                s = savings(arms["baseline"], arms[arm])
                lines.append(
                    f"| {task_id} | {arms[arm]['class']} | **{arm} savings %** | — "
                    f"| {s['input_tokens']} | {s['cache_creation_input_tokens']} "
                    f"| {s['cache_read_input_tokens']} | {s['output_tokens']} "
                    f"| {s['cost_usd']} | {s['duration_s']} | — | — |"
                )
    lines.append("")
    lines.append(
        "Session ids for every run are in results.jsonl — open the matching "
        "transcript to see where each arm spent its tokens."
    )
    return "\n".join(lines)


# ─── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument(
        "--arms",
        nargs="+",
        default=["workflow", "workflow_direct", "baseline"],
        choices=["workflow", "workflow_direct", "baseline", "baseline_nomcp"],
    )
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--timeout", type=int, default=3600, help="per session, seconds")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--model", default=None, help="model override passed to `claude --model`"
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="ANTHROPIC_BASE_URL override — point at an Anthropic-compatible "
        "proxy (see free-model.litellm.yaml) to run on a free model",
    )
    parser.add_argument(
        "--auth-token",
        default=None,
        help="ANTHROPIC_AUTH_TOKEN for the --base-url endpoint",
    )
    parser.add_argument(
        "--permission-mode",
        default="bypassPermissions",
        help="passed to `claude --permission-mode`; the default lets headless "
        "sessions edit/run unattended — arms run in throwaway worktrees",
    )
    args = parser.parse_args()

    tasks = yaml.safe_load(args.tasks.read_text())["tasks"]
    out_dir = args.out or Path("results") / time.strftime("wfbench-%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"

    results: dict[str, dict[str, dict[str, Any]]] = {}
    with tempfile.TemporaryDirectory(prefix="wfbench-trees-") as trees:
        for task in tasks:
            repo = Path(task["repo"]).expanduser().resolve()
            per_arm: dict[str, list[dict[str, Any]]] = {a: [] for a in args.arms}
            for run_idx in range(args.runs):
                for arm in args.arms:
                    worktree = make_worktree(repo, task.get("ref", "HEAD"), Path(trees))
                    try:
                        if task.get("setup"):
                            subprocess.run(
                                task["setup"],
                                shell=True,
                                cwd=worktree,
                                check=True,
                                capture_output=True,
                                timeout=600,
                            )
                        orig_sha = subprocess.run(
                            ["git", "-C", str(worktree), "rev-parse", "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        ).stdout.strip()
                        record = run_arm(arm, task, worktree, args)
                        record.update(diff_churn(worktree, orig_sha))
                    finally:
                        remove_worktree(repo, worktree)
                    record.update(
                        {
                            "task": task["id"],
                            "class": task.get("class", ""),
                            "run": run_idx,
                        }
                    )
                    per_arm[arm].append(record)
                    with results_path.open("a") as fh:
                        fh.write(json.dumps(record) + "\n")
                    print(
                        f"[{task['id']}][{arm}][run {run_idx}] resolved={record['resolved']} "
                        f"in={record['input_tokens']} out={record['output_tokens']} "
                        f"cost=${record['cost_usd']}"
                    )
            results[task["id"]] = {a: aggregate(rs) for a, rs in per_arm.items() if rs}

    report = render_report(results)
    (out_dir / "report.md").write_text(report)
    print(f"\n{report}\n\nWritten to {out_dir}/")


if __name__ == "__main__":
    main()
