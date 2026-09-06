#!/usr/bin/env python3
"""Cheap cost model for the skill-evolution review generation.

This is the ce-optimize measurement harness. It does not start Claude or
replay Actions run 33962002890. Wall clock is session waves plus the
pre-sweep setup the runner still pays before ``sweep_task_cells``:
``make_worktree`` + ``sanitize_clone_for_hidden_oracles`` and
``analyze --pdg --index-only``.

Weekly assumes a matching seed so every reusable comparator cell is skipped.
Cold assumes an empty seed. Candidate cells are never treated as reusable.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
from pathlib import Path

# Agent-session mean from Actions run 33962002890 (review profile). The
# runner builds graphs before cells start, so setup is added separately.
MEAN_SESSION_SECONDS = 1140
# Conservative mean for `analyze --pdg --index-only` of a sanitized
# GitNexus snapshot on the evolution box. The hard timeout is 3600s.
GRAPH_ANALYZE_SECONDS = 600
# `git clone --no-local` plus sanitize_clone_for_hidden_oracles (repack /
# prune / fsck). README called this "minutes" per cell before templates.
TEMPLATE_SANITIZE_SECONDS = 180
# copy_isolated_tree of an already-sanitized template (reflink or copy).
# run_cell does this inside its pool worker, so it is a per-wave cost.
CELL_COPY_SECONDS = 15

REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_ROOT = REPO_ROOT / "eval"
REVIEW_TASKS = EVAL_ROOT / "workflow_bench" / "tasks.review.scenarios.yaml"
EVOLVE_PY = EVAL_ROOT / "workflow_bench" / "evolve.py"
RUNNER_PY = EVAL_ROOT / "workflow_bench" / "runner.py"
ARTIFACTS_PY = EVAL_ROOT / "workflow_bench" / "runner_artifacts.py"
REUSE_PY = EVAL_ROOT / "workflow_bench" / "comparator_reuse.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "gitnexus-skill-evolution.yml"

REVIEW_ARMS = ("ce_review", "review", "candidate_review")
CANDIDATE_ARM = "candidate_review"
REUSABLE_ARMS = frozenset({"review", "ce_review"})

SUITE_FILES = (
    "tests/test_comparator_reuse.py",
    "tests/test_evolve.py",
    "tests/test_sanitized_graph.py",
    "tests/test_workflow_bench_sessions.py",
    "tests/test_session_progress.py",
    "tests/test_measure_evolution_cost.py",
    "tests/test_workflow_bench.py",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def review_tasks(text: str) -> list[dict[str, str]]:
    tasks: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("id:"):
            if current is not None:
                tasks.append(current)
            current = {"id": line.split(":", 1)[1].strip()}
        elif line.startswith("ref:") and current is not None:
            current["ref"] = line.split(":", 1)[1].strip()
    if current is not None:
        tasks.append(current)
    return tasks


def evolve_default(name: str, text: str) -> int:
    match = re.search(
        rf'add_argument\("--{re.escape(name)}".*?default=(\d+)',
        text,
        flags=re.S,
    )
    if match is None:
        raise ValueError(f"evolve.py is missing --{name} default")
    return int(match.group(1))


def workflow_dispatch_workers(text: str) -> int:
    match = re.search(
        r"^\s+workers:\n(?:.*\n)*?^\s+default: '(\d+)'",
        text,
        flags=re.M,
    )
    if match is None:
        raise ValueError("workflow_dispatch workers default is missing")
    return int(match.group(1))


def feature_enabled() -> tuple[int, int]:
    evolve = _read(EVOLVE_PY)
    runner = _read(RUNNER_PY)
    artifacts = _read(ARTIFACTS_PY)
    reuse = int(
        REUSE_PY.is_file()
        and "--reuse-results" in evolve
        and "select_reusable_comparator_rows" in runner
        and "CANDIDATE" in _read(REUSE_PY)
    )
    templates = int(
        "def copy_isolated_tree" in artifacts
        and "clone_templates" in runner
        and "clone_template" in runner
    )
    return reuse, templates


def paid_cells_per_task(
    tasks: list[dict[str, str]],
    *,
    runs: int,
    weekly: bool,
    reuse_enabled: bool,
) -> list[int]:
    per_task: list[int] = []
    for _task in tasks:
        paid = 0
        for _run in range(runs):
            for arm in REVIEW_ARMS:
                if weekly and reuse_enabled and arm in REUSABLE_ARMS:
                    continue
                paid += 1
        per_task.append(paid)
    return per_task


def unique_paid_shas(tasks: list[dict[str, str]], paid_per_task: list[int]) -> int:
    seen: set[str] = set()
    for task, paid in zip(tasks, paid_per_task, strict=True):
        ref = task.get("ref", "")
        if paid > 0 and ref:
            seen.add(ref)
    return len(seen)


def sha_setup_seconds(clone_templates_enabled: bool) -> int:
    if clone_templates_enabled:
        return TEMPLATE_SANITIZE_SECONDS + GRAPH_ANALYZE_SECONDS
    return GRAPH_ANALYZE_SECONDS


def cell_setup_seconds(paid_cells: int, workers: int, clone_templates_enabled: bool) -> int:
    """Per-cell clone cost, charged once per wave rather than once per cell.

    ``run_cell`` clones inside its own pool worker, so the siblings in a wave
    clone concurrently and only one clone sits on the critical path per wave.
    """

    if paid_cells < 1:
        return 0
    waves = math.ceil(paid_cells / workers)
    if clone_templates_enabled:
        return waves * CELL_COPY_SECONDS
    return waves * TEMPLATE_SANITIZE_SECONDS


def setup_wall_seconds(
    *,
    unique_shas: int,
    paid_per_task: list[int],
    workers: int,
    clone_templates_enabled: bool,
) -> int:
    """Fully serial SHA setup plus per-wave clone work, task by task."""

    if unique_shas < 1 or sum(paid_per_task) < 1:
        return 0
    cells = sum(
        cell_setup_seconds(paid, workers, clone_templates_enabled) for paid in paid_per_task
    )
    return unique_shas * sha_setup_seconds(clone_templates_enabled) + cells


def graph_pipeline_enabled(runner_text: str) -> int:
    """True only when the runner prefetches the next SHA during paid sessions."""

    return int(
        bool(
            re.search(
                r"(graph_prefetch|prefetch_next_graph|pipeline_next_sha|prefetch_clone_template)",
                runner_text,
            )
        )
    )


def pipelined_wall_seconds(
    tasks: list[dict[str, str]],
    paid_per_task: list[int],
    session_per_task: list[int],
    *,
    workers: int,
    clone_templates_enabled: bool,
) -> int:
    """Overlap the next unseen SHA's setup with the current task's session wave.

    The first SHA still pays setup up front. Later SHAs hide behind the
    previous task's paid sessions when that wave is longer than SHA setup.
    Per-cell copies stay on the task's critical path.
    """

    setup = sha_setup_seconds(clone_templates_enabled)
    elapsed = 0
    ready: set[str] = set()
    in_flight: tuple[str, int] | None = None
    for index, (task, paid, session) in enumerate(zip(tasks, paid_per_task, session_per_task, strict=True)):
        if paid <= 0:
            continue
        sha = task.get("ref", "")
        if sha not in ready:
            if in_flight is not None and in_flight[0] == sha:
                elapsed = max(elapsed, in_flight[1])
                ready.add(sha)
                in_flight = None
            else:
                elapsed += setup
                if sha:
                    ready.add(sha)
        session_start = elapsed
        elapsed += session + cell_setup_seconds(paid, workers, clone_templates_enabled)
        if in_flight is None:
            for later_task, later_paid in zip(tasks[index + 1 :], paid_per_task[index + 1 :], strict=True):
                later_sha = later_task.get("ref", "")
                if later_paid > 0 and later_sha and later_sha not in ready:
                    in_flight = (later_sha, session_start + setup)
                    break
        elif in_flight[1] <= elapsed:
            ready.add(in_flight[0])
            in_flight = None
    return elapsed


def session_wall_seconds(paid_per_task: list[int], workers: int) -> int:
    if workers < 1:
        raise ValueError("workers must be at least 1")
    total = 0
    for paid in paid_per_task:
        if paid <= 0:
            continue
        total += math.ceil(paid / workers) * MEAN_SESSION_SECONDS
    return total


def _pytest_python() -> list[str]:
    venv_python = EVAL_ROOT / ".venv" / "bin" / "python"
    if venv_python.is_file():
        return [str(venv_python)]
    if (EVAL_ROOT / "uv.lock").is_file():
        return ["uv", "run", "--locked", "--extra", "dev", "python"]
    return [sys.executable]


def suite_passed() -> int:
    files = [name for name in SUITE_FILES if (EVAL_ROOT / name).is_file()]
    if not files:
        return 0
    cmd = [
        *_pytest_python(),
        "-m",
        "pytest",
        *files,
        "-q",
        "--tb=no",
        "--no-header",
    ]
    try:
        completed = subprocess.run(
            cmd,
            cwd=EVAL_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=240,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return int(completed.returncode == 0)


def main() -> int:
    tasks = review_tasks(_read(REVIEW_TASKS))
    evolve = _read(EVOLVE_PY)
    runs = evolve_default("runs", evolve)
    promotion_min_runs = evolve_default("promotion-min-runs", evolve)
    workers = workflow_dispatch_workers(_read(WORKFLOW))
    reuse_enabled, clone_templates_enabled = feature_enabled()
    pipeline_enabled = graph_pipeline_enabled(_read(RUNNER_PY))
    weekly_paid = paid_cells_per_task(
        tasks,
        runs=runs,
        weekly=True,
        reuse_enabled=bool(reuse_enabled),
    )
    cold_paid = paid_cells_per_task(
        tasks,
        runs=runs,
        weekly=False,
        reuse_enabled=bool(reuse_enabled),
    )
    weekly_sessions = session_wall_seconds(weekly_paid, workers)
    cold_sessions = session_wall_seconds(cold_paid, workers)
    weekly_session_waves = [
        0 if paid <= 0 else math.ceil(paid / workers) * MEAN_SESSION_SECONDS for paid in weekly_paid
    ]
    cold_session_waves = [
        0 if paid <= 0 else math.ceil(paid / workers) * MEAN_SESSION_SECONDS for paid in cold_paid
    ]
    weekly_setup = setup_wall_seconds(
        unique_shas=unique_paid_shas(tasks, weekly_paid),
        paid_per_task=weekly_paid,
        workers=workers,
        clone_templates_enabled=bool(clone_templates_enabled),
    )
    cold_setup = setup_wall_seconds(
        unique_shas=unique_paid_shas(tasks, cold_paid),
        paid_per_task=cold_paid,
        workers=workers,
        clone_templates_enabled=bool(clone_templates_enabled),
    )
    if pipeline_enabled:
        weekly_wall = pipelined_wall_seconds(
            tasks,
            weekly_paid,
            weekly_session_waves,
            workers=workers,
            clone_templates_enabled=bool(clone_templates_enabled),
        )
        cold_wall = pipelined_wall_seconds(
            tasks,
            cold_paid,
            cold_session_waves,
            workers=workers,
            clone_templates_enabled=bool(clone_templates_enabled),
        )
        weekly_setup = weekly_wall - weekly_sessions
        cold_setup = cold_wall - cold_sessions
    else:
        weekly_wall = weekly_sessions + weekly_setup
        cold_wall = cold_sessions + cold_setup
    payload = {
        "estimated_weekly_wall_seconds": weekly_wall,
        "estimated_cold_wall_seconds": cold_wall,
        "suite_passed": suite_passed(),
        "promotion_min_runs": promotion_min_runs,
        "review_task_count": len(tasks),
        "candidate_cells": len(tasks) * runs,
        "paid_weekly_cells": sum(weekly_paid),
        "paid_cold_cells": sum(cold_paid),
        "workers": workers,
        "unique_task_shas": len({task.get("ref", "") for task in tasks if task.get("ref")}),
        "reuse_enabled": reuse_enabled,
        "clone_templates_enabled": clone_templates_enabled,
        "graph_pipeline_enabled": pipeline_enabled,
        "mean_session_seconds": MEAN_SESSION_SECONDS,
        "session_weekly_seconds": weekly_sessions,
        "session_cold_seconds": cold_sessions,
        "setup_weekly_seconds": weekly_setup,
        "setup_cold_seconds": cold_setup,
        "graph_analyze_seconds": GRAPH_ANALYZE_SECONDS,
        "template_sanitize_seconds": TEMPLATE_SANITIZE_SECONDS,
    }
    json.dump(payload, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
