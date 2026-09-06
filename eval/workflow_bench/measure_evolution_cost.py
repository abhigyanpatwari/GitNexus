#!/usr/bin/env python3
"""Cheap cost model for the skill-evolution review generation.

This is the ce-optimize measurement harness. It does not start Claude and it
does not replay a run. It reads the review corpus, the evolve defaults and the
workflow's workers default, then schedules the measured cell durations in
``session_durations.json`` the way ``sweep_task_cells`` schedules real cells.

Everything priced here is measured. Cell durations and the proposer session
come from a real artifact, and the work outside the agent sessions comes from
that run's own step wall minus the time its sessions and proposer account for.

Weekly assumes a matching seed, so every reusable comparator cell is skipped
and only the candidate arm is paid. Cold assumes an empty seed.
"""

from __future__ import annotations

import json
import math
import re
import statistics as st
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_ROOT = REPO_ROOT / "eval"
REVIEW_TASKS = EVAL_ROOT / "workflow_bench" / "tasks.review.scenarios.yaml"
EVOLVE_PY = EVAL_ROOT / "workflow_bench" / "evolve.py"
RUNNER_PY = EVAL_ROOT / "workflow_bench" / "runner.py"
ARTIFACTS_PY = EVAL_ROOT / "workflow_bench" / "runner_artifacts.py"
REUSE_PY = EVAL_ROOT / "workflow_bench" / "comparator_reuse.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "gitnexus-skill-evolution.yml"

MEASURED = json.loads(
    (Path(__file__).resolve().parent / "session_durations.json").read_text(encoding="utf-8")
)
# Per arm, because the arms are not interchangeable and the weekly lane pays
# only the candidate one. Cells are submitted run-major and arm-minor
# (runner.py ``planned``), so at workers=3 every wave holds one cell of each
# arm and the slowest arm sets the wave.
DURATIONS_BY_ARM: dict[str, tuple[float, ...]] = {
    arm: tuple(values) for arm, values in MEASURED["cell_duration_s_by_arm"].items()
}
PROPOSER_SECONDS: float = MEASURED["proposer_duration_s"]
_RESIDUAL = MEASURED["residual"]
# Clone, graph build, sandbox, teardown: the sweep's own time, taken as that
# run's step wall minus what its sessions and proposer account for. Charged
# SERIALLY, outside the pool. The residual mixes per-cell work the pool really
# does divide with per-SHA graph setup it cannot, and the artifact cannot
# separate them; serial is the pessimistic reading of an already-small term.
CELL_OVERHEAD_SECONDS: float = _RESIDUAL["unaccounted_s"] / _RESIDUAL["cells"]

# runner.py CANDIDATE_ARMS derives the candidate arm from its incumbent, and
# only an incumbent row can be reused from a prior generation.
CANDIDATE_ARM = "candidate_review"
REVIEW_ARMS = ("ce_review", "review", CANDIDATE_ARM)

SUITE_FILES = (
    "tests/test_measure_evolution_cost.py",
    "tests/test_comparator_reuse.py",
    "tests/test_evolve.py",
    "tests/test_sanitized_graph.py",
    "tests/test_workflow_bench.py",
    "tests/test_workflow_bench_sessions.py",
    "tests/test_session_progress.py",
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
    match = re.search(rf'add_argument\("--{re.escape(name)}".*?default=(\d+)', text, flags=re.S)
    if match is None:
        raise ValueError(f"evolve.py is missing --{name} default")
    return int(match.group(1))


def workflow_dispatch_workers(text: str) -> int:
    match = re.search(r"^\s+workers:\n(?:.*\n)*?^\s+default: '(\d+)'", text, flags=re.M)
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
    templates = int("def copy_isolated_tree" in artifacts and "clone_templates" in runner)
    return reuse, templates


def graph_pipeline_enabled(runner_text: str) -> int:
    """True when the runner prefetches the next SHA during paid sessions."""

    return int("prefetch_next_graph" in runner_text or "GraphPrefetch" in runner_text)


def fed_pool_enabled(runner_text: str) -> int:
    """True when the sweep feeds a live pool instead of waiting on waves."""

    return int("def _run_fed_pool" in runner_text)


def paid_arms(weekly: bool, reuse_enabled: bool) -> tuple[str, ...]:
    """Arms a generation actually pays for."""

    if weekly and reuse_enabled:
        return (CANDIDATE_ARM,)
    return REVIEW_ARMS


def task_cells(runs: int, arms: tuple[str, ...], offset: int) -> list[float]:
    """One task's cell durations in submission order: run-major, arm-minor.

    Each arm draws from its own measured sample, cycled from ``offset`` so the
    caller can average over every alignment instead of trusting one.
    """

    cells: list[float] = []
    for run_idx in range(runs):
        for arm in arms:
            sample = DURATIONS_BY_ARM[arm]
            cells.append(sample[(offset + run_idx) % len(sample)])
    return cells


def wave_makespan(durations: list[float], workers: int) -> float:
    """Today's scheduler: fixed waves of ``workers``, with a barrier between."""

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


def expected_task_seconds(
    runs: int, arms: tuple[str, ...], workers: int, *, fed_pool: bool
) -> float:
    """Mean makespan of one task over every alignment of the measured samples.

    One fixed alignment would let an accident of the source run - its slowest
    cells happen to come first - decide the answer. Averaging keeps the real
    multiset and the real ordering effects without that artifact, and stays
    deterministic.
    """

    if runs < 1 or not arms:
        return 0.0
    makespan = fed_makespan if fed_pool else wave_makespan
    # lcm, not max: with samples of 13 and 14, max would wrap the shorter one
    # and count its first entry twice.
    alignments = math.lcm(*(len(DURATIONS_BY_ARM[arm]) for arm in arms))
    return (
        sum(makespan(task_cells(runs, arms, offset), workers) for offset in range(alignments))
        / alignments
    )


def generation_seconds(
    *, task_count: int, runs: int, arms: tuple[str, ...], workers: int, fed_pool: bool
) -> int:
    """Whole generation: proposer, then the tasks back to back, plus overhead.

    Prices a HEALTHY sweep. A run whose cells return unusable evidence does not
    reach this wall at all: the outage breaker aborts after
    ``DEFAULT_OUTAGE_STREAK`` consecutive systemic failures, which for the
    sample's own error sequence is cell 5 of 41.
    """

    return round(
        PROPOSER_SECONDS
        + task_count * expected_task_seconds(runs, arms, workers, fed_pool=fed_pool)
        + task_count * runs * len(arms) * CELL_OVERHEAD_SECONDS
    )


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
    cmd = [*_pytest_python(), "-m", "pytest", *files, "-q", "--tb=no", "--no-header"]
    try:
        completed = subprocess.run(
            cmd, cwd=EVAL_ROOT, check=False, capture_output=True, text=True, timeout=240
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return int(completed.returncode == 0)


def main() -> int:
    tasks = review_tasks(_read(REVIEW_TASKS))
    evolve = _read(EVOLVE_PY)
    runner = _read(RUNNER_PY)
    runs = evolve_default("runs", evolve)
    workers = workflow_dispatch_workers(_read(WORKFLOW))
    reuse_enabled, clone_templates_enabled = feature_enabled()
    fed_pool = fed_pool_enabled(runner)

    payload: dict[str, object] = {}
    for label, weekly in (("weekly", True), ("cold", False)):
        arms = paid_arms(weekly, bool(reuse_enabled))
        payload[f"estimated_{label}_wall_seconds"] = generation_seconds(
            task_count=len(tasks), runs=runs, arms=arms, workers=workers, fed_pool=bool(fed_pool)
        )
        payload[f"paid_{label}_cells"] = len(tasks) * runs * len(arms)
        # What the wave barrier costs: the same cells, continuously fed.
        payload[f"fed_pool_{label}_wall_seconds"] = generation_seconds(
            task_count=len(tasks), runs=runs, arms=arms, workers=workers, fed_pool=True
        )

    all_durations = [d for sample in DURATIONS_BY_ARM.values() for d in sample]
    payload.update(
        {
            "suite_passed": suite_passed(),
            "promotion_min_runs": evolve_default("promotion-min-runs", evolve),
            "review_task_count": len(tasks),
            "candidate_cells": len(tasks) * runs,
            "workers": workers,
            "unique_task_shas": len({t.get("ref", "") for t in tasks if t.get("ref")}),
            "reuse_enabled": reuse_enabled,
            "clone_templates_enabled": clone_templates_enabled,
            "graph_pipeline_enabled": graph_pipeline_enabled(runner),
            "fed_pool_enabled": fed_pool,
            "measured_cell_count": len(all_durations),
            "median_cell_seconds": round(st.median(all_durations)),
            "mean_cell_seconds": round(st.mean(all_durations)),
            "max_cell_seconds": round(max(all_durations)),
            "median_candidate_cell_seconds": round(st.median(DURATIONS_BY_ARM[CANDIDATE_ARM])),
            "mean_candidate_cell_seconds": round(st.mean(DURATIONS_BY_ARM[CANDIDATE_ARM])),
            "proposer_seconds": round(PROPOSER_SECONDS),
            "cell_overhead_seconds": round(CELL_OVERHEAD_SECONDS, 1),
        }
    )
    json.dump(payload, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
