"""Benchmark the gitnexus-plan/work workflow against a baseline agent.

Usage:
    uv run python -m workflow_bench.runner --tasks workflow_bench/tasks.example.yaml --runs 3

Each task runs in a fresh detached git worktree of the target repo, once per
arm per run:

* ``workflow`` — two headless Claude Code sessions: gitnexus-plan, then
  gitnexus-work on the produced plan.
* ``candidate_workflow`` / ``candidate_workflow_direct`` — the matching
  workflow arm with a prompt-only candidate overlay committed in its clone.
* ``baseline`` — one headless session with the same task text and the Skill
  tool disallowed (so it cannot borrow the workflow), everything else equal.

Token usage, cost, duration, and turn counts come from the CLI's own
``--output-format json`` report — nothing is estimated. A task-specific
``verify`` command decides ``resolved``; token savings on unresolved runs are
reported but flagged, because saving tokens by failing is not a saving.

Trust model: task files are EXECUTABLE INPUT — ``setup``/``verify`` run
through the shell and sessions default to ``--permission-mode
bypassPermissions`` with the parent environment. Only run task files, repos,
and candidate overlays you trust (see README § Trust model).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .evolution import (
    CANDIDATE_ARMS,
    EVIDENCE_MAX_AGE_DAYS,
    PROMOTION_METRICS,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    skill_fingerprint,
)

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
# External-comparator arms: the compound-engineering plugin's plan/work family,
# prompted with the same structure as the gitnexus arms so only the skill
# family differs. The plugin ships user-level, so clones need no repo files.
CE_PLAN_PROMPT = (
    "Use the ce-plan skill (compound-engineering plugin) for: {task}\n"
    "Headless run: make reasonable choices without asking; the plan document "
    "is the deliverable."
)
CE_WORK_PROMPT = (
    "Use the ce-work skill (compound-engineering plugin) to execute the plan "
    "at {plan}.\n"
    "Headless run: proceed without asking; report completion status at the "
    "end."
)
CE_WORK_DIRECT_PROMPT = (
    "Use the ce-work skill (compound-engineering plugin) for: {task}\n"
    "Headless run: proceed without asking. The user explicitly declines a "
    "separate planning pass — execute directly with the skill's execution "
    "discipline."
)
# Review cell: the task's `setup` applies the diff under review as local
# changes; both arms review the same working tree and write to the same file
# so `verify` can gate on a produced review.
REVIEW_PROMPT = (
    "Use the gitnexus-review skill to review the local uncommitted changes "
    "in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external; write the complete review to review-output.md in the "
    "repository root."
)
CE_REVIEW_PROMPT = (
    "Use the ce-code-review skill (compound-engineering plugin) to review "
    "the local uncommitted changes in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external; write the complete review to review-output.md in the "
    "repository root."
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
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        data = json.loads(line) if line else {}
    except json.JSONDecodeError:
        data = {}
    usage = data.get("usage") or {}
    # Fail closed: an exit-0 session whose report is empty/malformed or lacks
    # usage fields must not count as measured evidence (it would otherwise
    # record a "resolved" run with zero usage and corrupt promotion decisions).
    well_formed = all(f in usage for f in USAGE_FIELDS)
    return {
        "ok": proc.returncode == 0 and not data.get("is_error", False) and well_formed,
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


def new_plan_doc(worktree: Path, before: set[Path]) -> Path | None:
    """The plan document a session just wrote: any new file under docs/plans.

    A name glob is unreliable — the repo ships committed example plans whose
    clone-time mtimes tie, and sessions don't always follow the skill's naming
    convention — so plan discovery diffs against a pre-session snapshot.
    """
    fresh = [
        p
        for p in worktree.glob("docs/plans/*")
        if p not in before and p.suffix in (".md", ".html")
    ]
    return max(fresh, key=lambda p: p.stat().st_mtime, default=None)


def make_worktree(repo: Path, ref: str, parent: Path) -> Path:
    """Isolated CLONE per arm — refs (branches, stash) stay arm-local.

    `git worktree add` shares the ref namespace: an agent-created slug branch
    survived its worktree's removal and a later arm found and ADOPTED the
    previous arm's completed work (caught by identical churn fingerprints).
    `--shared` keeps the clone cheap (object store via alternates); every ref
    an agent creates dies with the clone directory.
    """
    target = Path(tempfile.mkdtemp(prefix="wfbench-", dir=parent))
    target.rmdir()  # git clone creates it
    subprocess.run(
        ["git", "clone", "--shared", "--quiet", str(repo), str(target)],
        check=True,
        capture_output=True,
    )
    # Non-default branches exist only as origin/<ref> in a fresh clone.
    for candidate in (ref, f"origin/{ref}"):
        proc = subprocess.run(
            ["git", "-C", str(target), "checkout", "--detach", "--quiet", candidate],
            capture_output=True,
        )
        if proc.returncode == 0:
            return target
    raise RuntimeError(f"ref {ref!r} not found in clone of {repo}")


def remove_worktree(repo: Path, worktree: Path) -> None:
    shutil.rmtree(worktree, ignore_errors=True)


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


def run_verify(command: str, cwd: Path, timeout: int) -> tuple[bool, str]:
    """Run the task's verify command; keep its output tail for diagnosis."""
    proc = subprocess.run(
        command, shell=True, cwd=cwd, capture_output=True, timeout=timeout, check=False
    )
    output = (proc.stdout + b"\n" + proc.stderr).decode(errors="replace")
    return proc.returncode == 0, output[-4000:]


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
    plan_doc: Path | None = None
    if arm in ("workflow", "ce_workflow"):
        plan_prompt = PLAN_PROMPT if arm == "workflow" else CE_PLAN_PROMPT
        work_prompt = WORK_PROMPT if arm == "workflow" else CE_WORK_PROMPT
        pre = set(worktree.glob("docs/plans/*"))
        sessions.append(
            run_claude(plan_prompt.format(task=task["prompt"]), worktree, **common)
        )
        plan_doc = new_plan_doc(worktree, pre)
        if plan_doc is not None:
            sessions.append(
                run_claude(
                    work_prompt.format(plan=plan_doc.relative_to(worktree)),
                    worktree,
                    **common,
                )
            )
    elif arm == "ce_workflow_direct":
        sessions.append(
            run_claude(
                CE_WORK_DIRECT_PROMPT.format(task=task["prompt"]), worktree, **common
            )
        )
    elif arm == "review":
        sessions.append(
            run_claude(REVIEW_PROMPT.format(task=task["prompt"]), worktree, **common)
        )
    elif arm == "ce_review":
        sessions.append(
            run_claude(CE_REVIEW_PROMPT.format(task=task["prompt"]), worktree, **common)
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
    record["plan_produced"] = (
        arm not in ("workflow", "ce_workflow") or plan_doc is not None
    )
    verified, verify_output = run_verify(task["verify"], worktree, args.timeout)
    record["resolved"] = record["ok"] and verified
    record["verify_output"] = verify_output
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
        choices=[
            "workflow",
            "candidate_workflow",
            "workflow_direct",
            "candidate_workflow_direct",
            "ce_workflow",
            "ce_workflow_direct",
            "review",
            "ce_review",
            "baseline",
            "baseline_nomcp",
        ],
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
    parser.add_argument(
        "--candidate-overlay",
        type=Path,
        default=None,
        help="directory mirroring .claude/skills/gitnexus-{plan,work,lfg}; applied only to candidate_* arms",
    )
    parser.add_argument(
        "--promotion-metric",
        choices=PROMOTION_METRICS,
        default="output_tokens",
        help="efficiency metric used by the deterministic candidate gate",
    )
    parser.add_argument("--promotion-min-runs", type=int, default=3)
    parser.add_argument("--promotion-min-improvement", type=float, default=5.0)
    parser.add_argument("--promotion-max-task-regression", type=float, default=20.0)
    args = parser.parse_args()

    candidate_arms = [arm for arm in args.arms if arm in CANDIDATE_ARMS]
    if candidate_arms and args.candidate_overlay is None:
        parser.error("candidate_* arms require --candidate-overlay")
    if args.candidate_overlay is not None and not candidate_arms:
        parser.error("--candidate-overlay requires at least one candidate_* arm")
    for candidate_arm in candidate_arms:
        incumbent_arm = CANDIDATE_ARMS[candidate_arm]
        if incumbent_arm not in args.arms:
            parser.error(f"{candidate_arm} must be paired with {incumbent_arm}")
    if args.runs < 1 or args.promotion_min_runs < 1:
        parser.error("--runs and --promotion-min-runs must be positive")

    candidate_overlay = args.candidate_overlay.expanduser().resolve() if args.candidate_overlay is not None else None
    overlay_digest = candidate_overlay_digest(candidate_overlay) if candidate_overlay is not None else None

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
                        task_base_sha = subprocess.run(
                            ["git", "-C", str(worktree), "rev-parse", "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        ).stdout.strip()
                        execution_arm = CANDIDATE_ARMS.get(arm, arm)
                        if arm in CANDIDATE_ARMS:
                            assert candidate_overlay is not None
                            applied_digest = apply_candidate_overlay(candidate_overlay, worktree)
                            if applied_digest != overlay_digest:
                                raise RuntimeError("candidate overlay changed during the benchmark run")
                        orig_sha = subprocess.run(
                            ["git", "-C", str(worktree), "rev-parse", "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        ).stdout.strip()
                        record = run_arm(execution_arm, task, worktree, args)
                        record["arm"] = arm
                        record.update(
                            {
                                "model": args.model,
                                "task_ref": task.get("ref", "HEAD"),
                                "task_base_sha": task_base_sha,
                                "variant_head_sha": orig_sha,
                                "task_prompt_digest": hashlib.sha256(task["prompt"].encode()).hexdigest(),
                                "skill_digest": skill_fingerprint(worktree, execution_arm),
                                "candidate_overlay_digest": (overlay_digest if arm in CANDIDATE_ARMS else None),
                                "recorded_at": datetime.now(UTC).isoformat(),
                            }
                        )
                        record.update(diff_churn(worktree, orig_sha))
                        # Final working-tree patch — the clone is destroyed, so
                        # this is the only artifact for diagnosing verify fails.
                        patch = subprocess.run(
                            ["git", "-C", str(worktree), "diff", orig_sha],
                            capture_output=True,
                            text=True,
                            check=False,
                        ).stdout
                        (
                            out_dir / f"{task['id']}-{arm}-run{run_idx}.patch"
                        ).write_text(patch[:300_000])
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
    if candidate_arms:
        promotion_generated_at = datetime.now(UTC)
        promotion = {
            "schema_version": 1,
            "generated_at": promotion_generated_at.isoformat(),
            "evidence_expires_at": (promotion_generated_at + timedelta(days=EVIDENCE_MAX_AGE_DAYS)).isoformat(),
            "model": args.model,
            "candidate_overlay": str(candidate_overlay),
            "candidate_overlay_digest": overlay_digest,
            "policy": {
                "metric": args.promotion_metric,
                "min_runs": args.promotion_min_runs,
                "min_improvement_pct": args.promotion_min_improvement,
                "max_task_regression_pct": args.promotion_max_task_regression,
                "quality_rule": "no per-task resolution-rate regression",
                "max_age_days": EVIDENCE_MAX_AGE_DAYS,
            },
            "decisions": [
                evaluate_candidate(
                    results,
                    incumbent_arm=CANDIDATE_ARMS[candidate_arm],
                    candidate_arm=candidate_arm,
                    model=args.model,
                    metric=args.promotion_metric,
                    min_runs=args.promotion_min_runs,
                    min_improvement_pct=args.promotion_min_improvement,
                    max_task_regression_pct=args.promotion_max_task_regression,
                )
                for candidate_arm in candidate_arms
            ],
        }
        (out_dir / "promotion.json").write_text(json.dumps(promotion, indent=2) + "\n")
    print(f"\n{report}\n\nWritten to {out_dir}/")


if __name__ == "__main__":
    main()
