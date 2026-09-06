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
import statistics as st
import subprocess
import sys
from pathlib import Path

# Measured cell durations, not a mean: a wave waits for its SLOWEST cell, and
# these run 826s at the median against a 5400s session ceiling, so a model
# built on an average understates every concurrent schedule. See
# session_durations.json for provenance and its sampling caveat.
DURATIONS = json.loads(
    (Path(__file__).resolve().parent / "session_durations.json").read_text(encoding="utf-8")
)
CELL_DURATIONS = tuple(DURATIONS["cell_duration_s"])
# One proposer session per generation, ahead of the benchmark and unavoidably
# on the critical path.
PROPOSER_SECONDS = DURATIONS["proposer_duration_s"]
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


def setup_wall_seconds(
    *,
    unique_shas: int,
    paid_per_task: list[int],
    clone_templates_enabled: bool,
) -> int:
    """Serial per-SHA graph setup. Per-cell clones ride inside the cell."""

    if unique_shas < 1 or sum(paid_per_task) < 1:
        return 0
    return unique_shas * sha_setup_seconds(clone_templates_enabled)


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
    session_per_task: list[float],
    *,
    clone_templates_enabled: bool,
) -> int:
    """Overlap the next unseen SHA's setup with the current task's session wave.

    The first SHA still pays setup up front. Later SHAs hide behind the
    previous task's paid sessions when that wave is longer than SHA setup.
    Per-cell copies stay on the task's critical path.
    """

    setup = sha_setup_seconds(clone_templates_enabled)
    elapsed = PROPOSER_SECONDS
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
        elapsed += session
        if in_flight is None:
            for later_task, later_paid in zip(tasks[index + 1 :], paid_per_task[index + 1 :], strict=True):
                later_sha = later_task.get("ref", "")
                if later_paid > 0 and later_sha and later_sha not in ready:
                    in_flight = (later_sha, session_start + setup)
                    break
        elif in_flight[1] <= elapsed:
            ready.add(in_flight[0])
            in_flight = None
    return round(elapsed)


def cell_durations(count: int, clone_templates_enabled: bool, offset: int = 0) -> list[float]:
    """Deterministic per-cell durations: the measured sample, cycled from ``offset``.

    Cycled rather than sampled so every scheduler is scored against the same
    cells and the harness stays reproducible. Each cell carries its own clone,
    which ``run_cell`` pays inside its worker.
    """

    clone = CELL_COPY_SECONDS if clone_templates_enabled else TEMPLATE_SANITIZE_SECONDS
    size = len(CELL_DURATIONS)
    return [CELL_DURATIONS[(offset + i) % size] + clone for i in range(count)]


def expected_makespan(
    count: int,
    workers: int,
    *,
    fed_pool: bool,
    clone_templates_enabled: bool,
) -> float:
    """Mean makespan over every rotation of the measured sample.

    One fixed alignment would let an accident of the source run — its slowest
    cells happen to come first — decide the answer. Averaging all rotations
    keeps the real multiset and the real ordering effects while removing that
    alignment artifact, and stays deterministic.
    """

    if count <= 0:
        return 0.0
    makespan = fed_makespan if fed_pool else wave_makespan
    totals = [
        makespan(cell_durations(count, clone_templates_enabled, offset), workers)
        for offset in range(len(CELL_DURATIONS))
    ]
    return sum(totals) / len(totals)


def wave_makespan(durations: list[float], workers: int) -> float:
    """Current scheduler: fixed waves of ``workers``, barrier between them."""

    return sum(
        max(durations[start : start + workers]) for start in range(0, len(durations), workers)
    )


def fed_makespan(durations: list[float], workers: int) -> float:
    """Continuously fed pool: a free worker takes the next cell immediately."""

    busy_until = [0.0] * workers
    for duration in durations:
        first = min(range(workers), key=busy_until.__getitem__)
        busy_until[first] += duration
    return max(busy_until)


def session_wall_seconds(
    paid_per_task: list[int],
    workers: int,
    *,
    fed_pool: bool,
    clone_templates_enabled: bool,
) -> int:
    if workers < 1:
        raise ValueError("workers must be at least 1")
    makespan = fed_makespan if fed_pool else wave_makespan
    total = 0.0
    for paid in paid_per_task:
        if paid <= 0:
            continue
        total += makespan(cell_durations(paid, clone_templates_enabled), workers)
    return round(total)


def fed_pool_enabled(runner_text: str) -> int:
    """True only when the sweep feeds a live pool instead of waiting on waves."""

    return int("def _run_fed_pool" in runner_text)


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
    runner = _read(RUNNER_PY)
    runs = evolve_default("runs", evolve)
    promotion_min_runs = evolve_default("promotion-min-runs", evolve)
    workers = workflow_dispatch_workers(_read(WORKFLOW))
    reuse_enabled, clone_templates_enabled = feature_enabled()
    pipeline_enabled = graph_pipeline_enabled(runner)
    fed_pool = fed_pool_enabled(runner)
    templates = bool(clone_templates_enabled)

    payload: dict[str, object] = {}
    for label, weekly in (("weekly", True), ("cold", False)):
        paid = paid_cells_per_task(
            tasks, runs=runs, weekly=weekly, reuse_enabled=bool(reuse_enabled)
        )
        per_task = [
            expected_makespan(
                count, workers, fed_pool=bool(fed_pool), clone_templates_enabled=templates
            )
            for count in paid
        ]
        sessions = round(sum(per_task))
        setup = setup_wall_seconds(
            unique_shas=unique_paid_shas(tasks, paid),
            paid_per_task=paid,
            clone_templates_enabled=templates,
        )
        if pipeline_enabled:
            wall = pipelined_wall_seconds(
                tasks, paid, per_task, clone_templates_enabled=templates
            )
            setup = wall - sessions
        else:
            wall = round(sessions + setup + PROPOSER_SECONDS)
        payload[f"estimated_{label}_wall_seconds"] = wall
        payload[f"paid_{label}_cells"] = sum(paid)
        payload[f"session_{label}_seconds"] = sessions
        payload[f"setup_{label}_seconds"] = setup
        # What the barrier costs: the same cells under a continuously fed pool.
        payload[f"fed_pool_{label}_session_seconds"] = round(
            sum(
                expected_makespan(
                    count, workers, fed_pool=True, clone_templates_enabled=templates
                )
                for count in paid
            )
        )

    payload.update(
        {
            "suite_passed": suite_passed(),
            "promotion_min_runs": promotion_min_runs,
            "review_task_count": len(tasks),
            "candidate_cells": len(tasks) * runs,
            "workers": workers,
            "unique_task_shas": len({t.get("ref", "") for t in tasks if t.get("ref")}),
            "reuse_enabled": reuse_enabled,
            "clone_templates_enabled": clone_templates_enabled,
            "graph_pipeline_enabled": pipeline_enabled,
            "fed_pool_enabled": fed_pool,
            "measured_cell_count": len(CELL_DURATIONS),
            "median_cell_seconds": round(st.median(CELL_DURATIONS)),
            "mean_cell_seconds": round(st.mean(CELL_DURATIONS)),
            "max_cell_seconds": round(max(CELL_DURATIONS)),
            "proposer_seconds": round(PROPOSER_SECONDS),
            "graph_analyze_seconds": GRAPH_ANALYZE_SECONDS,
            "template_sanitize_seconds": TEMPLATE_SANITIZE_SECONDS,
        }
    )
    json.dump(payload, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
