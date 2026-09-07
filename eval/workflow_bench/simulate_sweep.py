#!/usr/bin/env python3
"""Run the real sweep scheduler against stub sessions and time it.

``measure_evolution_cost`` is arithmetic: it predicts wall clock from a model of
what ``sweep_task_cells`` does. This runs the actual function - real threads,
the real wave barrier, the real outage breaker - and replaces only the paid
agent session with a sleep. If the two disagree, the model is wrong.

Durations are the measured per-arm samples from ``session_durations.json``
divided by ``--scale``, so a cell that really took 1416s takes ~0.28s here. The
shape is preserved deliberately: the median cell is 826s against a 5400s
ceiling, and that spread is the whole reason a barrier costs anything. Uniform
random sleeps would erase the effect under test.

Three schedulers run against an IDENTICAL seeded duration sequence:

``wave``    the shipped ``sweep_task_cells`` - fixed waves of ``workers``, a
            barrier between them, one task at a time.
``fed``     a continuously fed pool per task: a free worker takes the next cell
            immediately instead of waiting for its wave to drain (H1).
``packed``  one pool across every task, so a task's leftover capacity is filled
            by the next task's cells (H2).

``fed`` and ``packed`` are measured here as prototypes, deliberately, before any
production code is written - the point is to find out whether the idea is worth
the invariants it would cost.

    python3 -m workflow_bench.simulate_sweep --workers 3
    python3 -m workflow_bench.simulate_sweep --compare --repeat 5
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from . import runner
from .measure_evolution_cost import (
    CANDIDATE_ARM,
    DURATIONS_BY_ARM,
    REVIEW_ARMS,
    REVIEW_TASKS,
    _read,
    expected_task_seconds,
    review_tasks,
)

DEFAULT_SCALE = 5000.0
Cell = tuple[int, str, float]


def build_plan(
    *, task_count: int, runs: int, arms: tuple[str, ...], scale: float, seed: int
) -> list[list[Cell]]:
    """Per-task cells in submission order (run-major, arm-minor) with durations.

    Generated once and shared by every scheduler so a comparison cannot be an
    artifact of one of them drawing luckier cells.
    """

    rng = random.Random(seed)
    plan: list[list[Cell]] = []
    for _task in range(task_count):
        cells: list[Cell] = []
        for run_idx in range(runs):
            for arm in arms:
                sample = DURATIONS_BY_ARM[arm]
                cells.append((run_idx, arm, sample[rng.randrange(len(sample))] / scale))
        plan.append(cells)
    return plan


def _record(run_idx: int, arm: str) -> dict[str, Any]:
    return {
        "run": run_idx,
        "arm": arm,
        "ok": True,
        "resolved": True,
        "error_kind": None,
        "review_evidence_valid": True,
    }


def run_wave(plan: list[list[Cell]], workers: int) -> float:
    """The shipped scheduler, driven for real."""

    started = time.monotonic()
    for cells in plan:
        by_key = {(run_idx, arm): seconds for run_idx, arm, seconds in cells}

        def fake_run(run_idx: int, arm: str) -> dict[str, Any]:
            time.sleep(by_key[(run_idx, arm)])
            return _record(run_idx, arm)

        _streak, tripped = runner.sweep_task_cells(
            [(run_idx, arm) for run_idx, arm, _ in cells],
            workers=workers,
            run=fake_run,
            on_start=lambda *_: None,
            on_record=lambda *_: None,
            outage_streak=0,
            outage_limit=0,
        )
        assert not tripped
    return time.monotonic() - started


def _drain(cells: list[Cell], workers: int) -> None:
    lock = threading.Lock()
    order: list[tuple[int, str]] = []

    def work(cell: Cell) -> None:
        run_idx, arm, seconds = cell
        time.sleep(seconds)
        with lock:
            order.append((run_idx, arm))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, cells))


def run_fed(plan: list[list[Cell]], workers: int) -> float:
    """H1: continuously fed pool, still one task at a time."""

    started = time.monotonic()
    for cells in plan:
        _drain(cells, workers)
    return time.monotonic() - started


def run_packed(plan: list[list[Cell]], workers: int) -> float:
    """H2: one pool across every task."""

    started = time.monotonic()
    _drain([cell for cells in plan for cell in cells], workers)
    return time.monotonic() - started


SCHEDULERS = {"wave": run_wave, "fed": run_fed, "packed": run_packed}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--scale", type=float, default=DEFAULT_SCALE)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--scheduler", choices=sorted(SCHEDULERS), default="wave")
    parser.add_argument("--compare", action="store_true", help="all schedulers, both profiles")
    args = parser.parse_args()

    task_count = len(review_tasks(_read(REVIEW_TASKS)))
    names = sorted(SCHEDULERS) if args.compare else [args.scheduler]
    rows: list[dict[str, Any]] = []
    for label, weekly in (("weekly", True), ("cold", False)):
        arms = (CANDIDATE_ARM,) if weekly else REVIEW_ARMS
        plans = [
            build_plan(
                task_count=task_count, runs=args.runs, arms=arms, scale=args.scale, seed=args.seed + i
            )
            for i in range(args.repeat)
        ]
        serial = statistics.median(sum(c[2] for cells in p for c in cells) for p in plans)
        predicted = task_count * expected_task_seconds(
            args.runs, arms, args.workers, fed_pool=False
        ) / args.scale
        for name in names:
            observed = statistics.median(SCHEDULERS[name](p, args.workers) for p in plans)
            rows.append(
                {
                    "profile": label,
                    "scheduler": name,
                    "workers": args.workers,
                    "observed_s": round(observed, 3),
                    "wave_model_s": round(predicted, 3),
                    "serial_s": round(serial, 3),
                    "speedup_vs_serial": round(serial / observed, 3) if observed else None,
                    "cells": sum(len(cells) for cells in plans[0]),
                }
            )
    print(json.dumps({"scale": args.scale, "repeat": args.repeat, "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
