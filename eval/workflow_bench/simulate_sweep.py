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

Schedulers, all consuming one identical seeded plan:

``wave``    the shipped ``sweep_task_cells`` - fixed waves of ``workers``, a
            barrier between them, one task at a time.
``fed``     a continuously fed pool per task (H1). Naive: no breaker, no graph
            gating. Present to price the barrier alone.
``packed``  one pool across every task (H2). Naive, same caveat.
``faithful``H2 carrying the invariants the shipped scheduler actually holds:
            a global submission order, in-order folding, the outage breaker, and
            per-task graph readiness gating. This is the one to believe.

    python3 -m workflow_bench.simulate_sweep --compare --repeat 5
    python3 -m workflow_bench.simulate_sweep --breaker-fidelity
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from . import runner
from .measure_evolution_cost import (
    CANDIDATE_ARM,
    DURATIONS_BY_ARM,
    REVIEW_ARMS,
    REVIEW_TASKS,
    SHA_OVERHEAD_SECONDS,
    _read,
    expected_task_seconds,
    review_tasks,
)

DEFAULT_SCALE = 5000.0
# --contention-sweep measures both of these regardless of --workers, so the
# window has to be valid for the LARGEST of them, not for the parsed value.
CONTENTION_WORKERS = (3, 6)
SYSTEMIC_KIND = "session-error"

# A cell is mostly a model session waiting on the network, but its tool calls -
# git, vitest, analyze - burn real CPU in real subprocesses. Sleeping threads
# model the wait and nothing else, so every speedup measured that way is an
# upper bound. This burns WORK, not wall clock: a fixed number of sha256 rounds
# in a subprocess, which takes longer when cores are contended. That is the
# effect under test, and it has to be a subprocess - Python threads burning
# Python would measure the GIL rather than the machine.
_BURN_SRC = (
    "import hashlib,sys\n"
    "n=int(sys.argv[1]); b=b'x'*4096; h=hashlib.sha256()\n"
    "for _ in range(n): h.update(b)\n"
    "sys.stdout.write(h.hexdigest()[:8])\n"
)


def calibrate_burn(probe_rounds: int = 400_000) -> float:
    """sha256 rounds per second, one uncontended subprocess. Measured, not assumed."""

    started = time.monotonic()
    subprocess.run(
        [sys.executable, "-c", _BURN_SRC, str(probe_rounds)],
        check=True,
        capture_output=True,
    )
    return probe_rounds / (time.monotonic() - started)


def _execute_cell(cell: Cell, cpu_fraction: float, burn_rate: float) -> None:
    """The stub session: wait for the API, then do the tool-call work."""

    if cpu_fraction <= 0:
        time.sleep(cell.seconds)
        return
    time.sleep(cell.seconds * (1.0 - cpu_fraction))
    rounds = int(cell.seconds * cpu_fraction * burn_rate)
    if rounds > 0:
        subprocess.run(
            [sys.executable, "-c", _BURN_SRC, str(rounds)], check=True, capture_output=True
        )


@dataclass(frozen=True)
class Cell:
    task: int
    run: int
    arm: str
    seconds: float
    systemic: bool = False


@dataclass
class Outcome:
    wall_s: float
    executed: int
    tripped_at: int | None = None
    folded: list[int] = field(default_factory=list)


def build_plan(
    *,
    task_count: int,
    runs: int,
    arms: tuple[str, ...],
    scale: float,
    seed: int,
    fail_from: int | None = None,
) -> list[list[Cell]]:
    """Per-task cells in submission order, with durations drawn once.

    Shared by every scheduler so a comparison cannot be an artifact of one of
    them drawing luckier cells. ``fail_from`` marks every cell at or after that
    global index systemic, which is what the breaker-fidelity mode needs.
    """

    rng = random.Random(seed)
    plan: list[list[Cell]] = []
    index = 0
    for task in range(task_count):
        cells: list[Cell] = []
        for run_idx in range(runs):
            for arm in arms:
                sample = DURATIONS_BY_ARM[arm]
                cells.append(
                    Cell(
                        task=task,
                        run=run_idx,
                        arm=arm,
                        seconds=sample[rng.randrange(len(sample))] / scale,
                        systemic=fail_from is not None and index >= fail_from,
                    )
                )
                index += 1
        plan.append(cells)
    return plan


def _flatten(plan: list[list[Cell]]) -> list[Cell]:
    return [cell for cells in plan for cell in cells]


def _record(cell: Cell) -> dict[str, Any]:
    kind = SYSTEMIC_KIND if cell.systemic else None
    return {
        "run": cell.run,
        "arm": cell.arm,
        "ok": not cell.systemic,
        "resolved": not cell.systemic,
        "error_kind": kind,
        "review_evidence_valid": not cell.systemic,
    }


def _graph_builder(
    ready: list[threading.Event], graph_seconds: float, stop: threading.Event
) -> threading.Thread:
    """One graph at a time, in task order - they are CPU and IO heavy."""

    def build() -> None:
        for event in ready:
            if stop.is_set():
                return
            time.sleep(graph_seconds)
            event.set()

    thread = threading.Thread(target=build, name="graph-builder", daemon=True)
    thread.start()
    return thread


def run_wave(
    plan: list[list[Cell]],
    workers: int,
    *,
    outage_limit: int,
    graph_seconds: float,
    cpu_fraction: float = 0.0,
    burn_rate: float = 0.0,
) -> Outcome:
    """The shipped scheduler, driven for real, task after task."""

    ready = [threading.Event() for _ in plan]
    stop = threading.Event()
    _graph_builder(ready, graph_seconds, stop)
    executed = 0
    lock = threading.Lock()
    streak = 0
    tripped_at: int | None = None
    folded: list[int] = []
    base = 0

    started = time.monotonic()
    for task, cells in enumerate(plan):
        ready[task].wait()
        by_key = {(c.run, c.arm): c for c in cells}

        def fake_run(run_idx: int, arm: str) -> dict[str, Any]:
            nonlocal executed
            cell = by_key[(run_idx, arm)]
            _execute_cell(cell, cpu_fraction, burn_rate)
            with lock:
                executed += 1
            return _record(cell)

        order = {(c.run, c.arm): base + i for i, c in enumerate(cells)}

        def on_record(run_idx: int, arm: str, rec: dict[str, Any]) -> None:
            # Mirror the breaker's own evaluation so the reported trip point is
            # the cell that crossed the limit, not merely the last one folded -
            # sweep_task_cells folds a whole wave before it evaluates.
            nonlocal streak, tripped_at
            index = order[(run_idx, arm)]
            folded.append(index)
            streak = runner.systemic_outage_streak(rec["error_kind"], streak)
            if outage_limit and streak >= outage_limit and tripped_at is None:
                tripped_at = index

        streak, tripped = runner.sweep_task_cells(
            [(c.run, c.arm) for c in cells],
            workers=workers,
            run=fake_run,
            on_start=lambda *_: None,
            on_record=on_record,
            outage_streak=streak,
            outage_limit=outage_limit,
        )
        base += len(cells)
        if tripped:
            break
    stop.set()
    return Outcome(wall_s=time.monotonic() - started, executed=executed, tripped_at=tripped_at, folded=folded)


def _drain_naive(cells: list[Cell], workers: int) -> int:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda c: time.sleep(c.seconds), cells))
    return len(cells)


def run_fed(plan: list[list[Cell]], workers: int, *, outage_limit: int, graph_seconds: float) -> Outcome:
    """H1 without invariants: fed pool per task. Prices the barrier alone.

    Graph building is deliberately identical to ``run_wave`` - the same
    background builder, started before the clock - because that is what makes
    the claim in the first line true. Sleeping ``graph_seconds`` serially before
    each task instead, as this did, charged fed for overlap that wave gets for
    free: the wave builder prepares task N+1 while task N's cells run. The
    fed-versus-wave delta then mixed the loss of that overlap into what was
    reported as the price of the barrier.
    """

    ready = [threading.Event() for _ in plan]
    stop = threading.Event()
    _graph_builder(ready, graph_seconds, stop)
    executed = 0
    started = time.monotonic()
    for task, cells in enumerate(plan):
        ready[task].wait()
        executed += _drain_naive(cells, workers)
    return Outcome(wall_s=time.monotonic() - started, executed=executed)


def run_packed(plan: list[list[Cell]], workers: int, *, outage_limit: int, graph_seconds: float) -> Outcome:
    """H2 without invariants. Upper bound, not a design."""

    started = time.monotonic()
    time.sleep(graph_seconds)
    executed = _drain_naive(_flatten(plan), workers)
    return Outcome(wall_s=time.monotonic() - started, executed=executed)


def run_faithful(
    plan: list[list[Cell]],
    workers: int,
    *,
    outage_limit: int,
    graph_seconds: float,
    window: int | None = None,
    cpu_fraction: float = 0.0,
    burn_rate: float = 0.0,
) -> Outcome:
    """H2 carrying the invariants the shipped scheduler holds.

    Global submission order is task-major, run-major, arm-minor - the same total
    order the wave scheduler folds in, just continued across task boundaries. A
    folder walks results in exactly that order, so "consecutive systemic
    failures" keeps its meaning; the breaker trips on the same logical cell it
    would have in waves. Cells already in flight when it trips are the overrun,
    bounded by ``workers - 1`` exactly as the wave docstring promises.

    A task's cells are not submitted until its graph is ready, which is what
    makes this a schedule rather than a wish: the graph builder is serial, so
    packing cannot outrun it.

    ``window`` is the design question. Queue every cell at once and workers race
    far ahead of the fold pointer, so a breaker trip has already paid for cells
    nobody has looked at - measured at 5 against a bound of 2. Holding
    submission to ``window`` cells beyond the fold point caps the overrun at
    ``window - 1``, which is the wave's own ``workers - 1`` bound when the two
    are equal, while still packing across task boundaries. Defaults to whatever
    ``runner.sweep_packed_cells`` defaults to, so a run that names no window
    compares the shipped policy rather than a more tightly queued prototype.
    """

    if window is None:
        window = max(workers * runner.PACKED_WINDOW_MULTIPLIER, workers)
    if window < workers:
        # Same rule sweep_packed_cells enforces. Without it a window below 1
        # never lets the producer past its own gate and the run hangs.
        raise ValueError("window must be at least workers, or the pool starves")

    cells = _flatten(plan)
    ready = [threading.Event() for _ in plan]
    stop = threading.Event()
    _graph_builder(ready, graph_seconds, stop)

    results: list[dict[str, Any] | None] = [None] * len(cells)
    executed = 0
    lock = threading.Lock()
    halt = threading.Event()

    def work(index: int) -> None:
        nonlocal executed
        if halt.is_set():
            return
        cell = cells[index]
        _execute_cell(cell, cpu_fraction, burn_rate)
        with lock:
            executed += 1
            results[index] = _record(cell)

    gate = threading.Condition()
    fold_pointer = 0
    futures: list[Any] = []
    producer_done = threading.Event()

    started = time.monotonic()
    pool = ThreadPoolExecutor(max_workers=workers)

    def produce() -> None:
        submitted = 0
        for task, task_cells in enumerate(plan):
            ready[task].wait()
            for _ in task_cells:
                with gate:
                    while submitted - fold_pointer >= window and not halt.is_set():
                        gate.wait(timeout=0.5)
                    if halt.is_set():
                        producer_done.set()
                        return
                    futures.append(pool.submit(work, submitted))
                    submitted += 1
                    gate.notify_all()
        producer_done.set()

    producer = threading.Thread(target=produce, name="cell-producer", daemon=True)
    producer.start()

    streak = 0
    tripped_at: int | None = None
    folded: list[int] = []
    try:
        index = 0
        while True:
            with gate:
                while index >= len(futures) and not producer_done.is_set():
                    gate.wait(timeout=0.5)
                if index >= len(futures):
                    break
                future = futures[index]
            future.result()
            record = results[index]
            if record is not None:
                folded.append(index)
                streak = runner.systemic_outage_streak(record["error_kind"], streak)
                if outage_limit and streak >= outage_limit:
                    tripped_at = index
                    halt.set()
                    with gate:
                        gate.notify_all()
                    for pending in futures[index + 1 :]:
                        pending.cancel()
                    break
            index += 1
            with gate:
                fold_pointer = index
                gate.notify_all()
    finally:
        halt.set()
        with gate:
            gate.notify_all()
        stop.set()
        producer.join(timeout=5)
        pool.shutdown(wait=True)
    return Outcome(
        wall_s=time.monotonic() - started, executed=executed, tripped_at=tripped_at, folded=folded
    )


def run_production_packed(
    plan: list[list[Cell]],
    workers: int,
    *,
    outage_limit: int,
    graph_seconds: float,
    cpu_fraction: float = 0.0,
    burn_rate: float = 0.0,
    window: int | None = None,
) -> Outcome:
    """Drive the REAL runner.sweep_packed_cells, not a prototype of it.

    Same relationship run_wave has to sweep_task_cells: only the paid session is
    stubbed. If this disagrees with the faithful prototype, the shipped function
    is what is wrong.
    """

    cells = _flatten(plan)
    by_key = {(f"t{c.task}", c.run, c.arm): c for c in cells}
    order = {(f"t{c.task}", c.run, c.arm): i for i, c in enumerate(cells)}
    ready = [threading.Event() for _ in plan]
    stop = threading.Event()
    _graph_builder(ready, graph_seconds, stop)

    executed = 0
    lock = threading.Lock()
    folded: list[int] = []
    tripped_at: int | None = None
    streak_seen = {"streak": 0}

    def run_cell(task_id: str, run_idx: int, arm: str) -> dict[str, Any]:
        nonlocal executed
        cell = by_key[(task_id, run_idx, arm)]
        _execute_cell(cell, cpu_fraction, burn_rate)
        with lock:
            executed += 1
        return _record(cell)

    def on_record(task_id: str, run_idx: int, arm: str, rec: dict[str, Any]) -> None:
        nonlocal tripped_at
        index = order[(task_id, run_idx, arm)]
        folded.append(index)
        streak_seen["streak"] = runner.systemic_outage_streak(rec["error_kind"], streak_seen["streak"])
        if outage_limit and streak_seen["streak"] >= outage_limit and tripped_at is None:
            tripped_at = index

    def await_ready(task_id: str) -> bool:
        ready[int(task_id[1:])].wait()
        return True

    started = time.monotonic()
    runner.sweep_packed_cells(
        [(f"t{c.task}", c.run, c.arm) for c in cells],
        workers=workers,
        run=run_cell,
        on_start=lambda *_: None,
        on_record=on_record,
        outage_streak=0,
        outage_limit=outage_limit,
        window=window,
        await_ready=await_ready,
    )
    wall = time.monotonic() - started
    stop.set()
    return Outcome(wall_s=wall, executed=executed, tripped_at=tripped_at, folded=folded)


SCHEDULERS = {
    "wave": run_wave,
    "fed": run_fed,
    "packed": run_packed,
    "faithful": run_faithful,
    "production": run_production_packed,
}


def _window_kwargs(name: str, window: int | None) -> dict[str, int]:
    """``--window`` only means anything to the two schedulers that hold one."""

    return {"window": window} if window is not None and name in ("faithful", "production") else {}


def _plan_args(args: argparse.Namespace, weekly: bool, seed: int, fail_from: int | None = None):
    arms = (CANDIDATE_ARM,) if weekly else REVIEW_ARMS
    return {
        "task_count": len(review_tasks(_read(REVIEW_TASKS))),
        "runs": args.runs,
        "arms": arms,
        "scale": args.scale,
        "seed": seed,
        "fail_from": fail_from,
    }, arms


def breaker_fidelity(args: argparse.Namespace) -> list[dict[str, Any]]:
    """Does packing still trip where waves trip, and overrun no further?"""

    rows: list[dict[str, Any]] = []
    limit = runner.DEFAULT_OUTAGE_STREAK
    window = args.window if args.window is not None else max(
        args.workers * runner.PACKED_WINDOW_MULTIPLIER, args.workers
    )
    for fail_from in (0, 4, 12):
        kwargs, _arms = _plan_args(args, weekly=False, seed=args.seed, fail_from=fail_from)
        plan = build_plan(**kwargs)
        total = sum(len(c) for c in plan)
        row: dict[str, Any] = {
            "fail_from": fail_from, "limit": limit, "total_cells": total, "window": window
        }
        for name in ("wave", "faithful", "production"):
            out = SCHEDULERS[name](
                plan, args.workers, outage_limit=limit, graph_seconds=args.graph_seconds,
                **_window_kwargs(name, window),
            )
            row[name] = {
                "tripped_at": out.tripped_at,
                "executed": out.executed,
                "overrun": out.executed - (out.tripped_at + 1) if out.tripped_at is not None else None,
            }
        row["same_trip_point"] = (
            row["wave"]["tripped_at"] == row["faithful"]["tripped_at"] == row["production"]["tripped_at"]
        )
        # The producer holds submission to ``window`` cells beyond the fold
        # pointer, so at most ``window - 1`` cells past the tripping one can
        # already be in flight. At ``window == workers`` that is exactly the
        # wave scheduler's own ``workers - 1`` bound.
        row["overrun_within_bound"] = (
            row["production"]["overrun"] is not None
            and row["production"]["overrun"] <= window - 1
        )
        rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--scale", type=float, default=DEFAULT_SCALE)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--scheduler", choices=sorted(SCHEDULERS), default="wave")
    parser.add_argument("--compare", action="store_true")
    parser.add_argument("--breaker-fidelity", action="store_true")
    parser.add_argument("--window-sweep", action="store_true", help="wall clock vs breaker overrun")
    parser.add_argument("--contention-sweep", action="store_true", help="does the gain survive real CPU?")
    parser.add_argument(
        "--window",
        type=int,
        default=None,
        help="submission window for the packed schedulers; defaults to the shipped policy",
    )
    parser.add_argument(
        "--graph-seconds",
        type=float,
        default=None,
        help="per-task graph build; defaults to the measured per-SHA overhead, scaled",
    )
    args = parser.parse_args()
    # Both are checked here rather than where they are used: a bad --scale
    # divides by zero before anything runs, and a negative --graph-seconds
    # kills the graph-builder thread, after which every scheduler waits on a
    # readiness event nobody will ever set.
    # NaN defeats every comparison it appears in, so "> 0" and ">= 0" both admit
    # it and the failure surfaces far from the flag: NaN durations reach
    # time.sleep in a worker or the graph thread and raise there, after which the
    # schedulers wait forever on a readiness event nobody will set. Infinity is
    # worse than a crash - it silently scales every duration to zero and the run
    # reports a sweep that took no time.
    if not math.isfinite(args.scale) or args.scale <= 0:
        parser.error("--scale must be a finite positive number")
    if args.graph_seconds is not None and (not math.isfinite(args.graph_seconds) or args.graph_seconds < 0):
        parser.error("--graph-seconds must be a finite non-negative number")
    # Counts are indexed or handed to a thread pool without further checking, so
    # a zero turns into an IndexError on plans[0], a median over an empty
    # sequence, or ThreadPoolExecutor's own error - none of which name the flag
    # that caused them.
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    # run_faithful and sweep_packed_cells both refuse a window below the worker
    # count - a smaller one starves the pool, because the producer waits for a
    # fold pointer to pass a cell it was never allowed to submit. Enforcing it
    # here turns an uncaught ValueError partway through a measurement into an
    # argument error before anything runs. Checked against the largest worker
    # count this invocation will actually use: --contention-sweep runs its own
    # counts irrespective of --workers, so validating against --workers alone
    # let the 3-worker measurements finish and then raised on the 6-worker one.
    window_workers = args.workers
    if args.contention_sweep:
        window_workers = max(window_workers, max(CONTENTION_WORKERS))
    if args.window is not None and args.window < window_workers:
        parser.error(f"--window must be at least the worker count ({window_workers}); a smaller window starves the pool")
    if args.graph_seconds is None:
        args.graph_seconds = SHA_OVERHEAD_SECONDS / args.scale

    if args.contention_sweep:
        burn_rate = statistics.median(calibrate_burn() for _ in range(3))
        rows = []
        for cpu_fraction in (0.0, 0.25, 0.5):
            for workers in CONTENTION_WORKERS:
                plans = [
                    build_plan(**_plan_args(args, False, args.seed + i)[0])
                    for i in range(args.repeat)
                ]
                measured = {}
                for name in ("wave", "faithful", "production"):
                    fn = SCHEDULERS[name]
                    measured[name] = statistics.median(
                        fn(
                            plan,
                            workers,
                            outage_limit=0,
                            graph_seconds=args.graph_seconds,
                            cpu_fraction=cpu_fraction,
                            burn_rate=burn_rate,
                            **_window_kwargs(name, args.window),
                        ).wall_s
                        for plan in plans
                    )
                serial = statistics.median(
                    sum(c.seconds for c in _flatten(plan)) for plan in plans
                )
                rows.append(
                    {
                        "cpu_fraction": cpu_fraction,
                        "workers": workers,
                        "wave_s": round(measured["wave"], 2),
                        "faithful_s": round(measured["faithful"], 2),
                        "production_s": round(measured["production"], 2),
                        "packing_gain_pct": round(
                            (measured["faithful"] - measured["wave"]) / measured["wave"] * 100, 1
                        ),
                        "wave_speedup": round(serial / measured["wave"], 2),
                        "faithful_speedup": round(serial / measured["faithful"], 2),
                    }
                )
        print(json.dumps({"burn_rate": round(burn_rate), "nproc": __import__("os").cpu_count(), "rows": rows}, indent=2))
        return 0

    if args.window_sweep:
        total = len(review_tasks(_read(REVIEW_TASKS))) * args.runs * len(REVIEW_ARMS)
        rows = []
        for window in (args.workers, args.workers * 2, args.workers * 4, total):
            clean = [build_plan(**_plan_args(args, False, args.seed + i)[0]) for i in range(args.repeat)]
            wall = statistics.median(
                run_faithful(
                    p, args.workers, outage_limit=0, graph_seconds=args.graph_seconds, window=window
                ).wall_s
                for p in clean
            )
            failing = build_plan(**_plan_args(args, weekly=False, seed=args.seed, fail_from=12)[0])
            trip = run_faithful(
                failing,
                args.workers,
                outage_limit=runner.DEFAULT_OUTAGE_STREAK,
                graph_seconds=args.graph_seconds,
                window=window,
            )
            rows.append(
                {
                    "window": window,
                    "cold_wall_s": round(wall, 3),
                    "tripped_at": trip.tripped_at,
                    "executed": trip.executed,
                    "overrun_cells": trip.executed - (trip.tripped_at + 1)
                    if trip.tripped_at is not None
                    else None,
                }
            )
        print(json.dumps({"workers": args.workers, "rows": rows}, indent=2))
        return 0

    if args.breaker_fidelity:
        print(
            json.dumps(
                {"workers": args.workers, "graph_seconds": round(args.graph_seconds, 4),
                 "rows": breaker_fidelity(args)},
                indent=2,
            )
        )
        return 0

    names = sorted(SCHEDULERS) if args.compare else [args.scheduler]
    rows: list[dict[str, Any]] = []
    for label, weekly in (("weekly", True), ("cold", False)):
        plans = []
        for i in range(args.repeat):
            kwargs, arms = _plan_args(args, weekly, args.seed + i)
            plans.append(build_plan(**kwargs))
        serial = statistics.median(sum(c.seconds for c in _flatten(p)) for p in plans)
        predicted = (
            len(plans[0])
            * expected_task_seconds(args.runs, arms, args.workers, fed_pool=False)
            / args.scale
        )
        for name in names:
            observed = statistics.median(
                SCHEDULERS[name](
                    p,
                    args.workers,
                    outage_limit=0,
                    graph_seconds=args.graph_seconds,
                    **_window_kwargs(name, args.window),
                ).wall_s
                for p in plans
            )
            rows.append(
                {
                    "profile": label,
                    "scheduler": name,
                    "workers": args.workers,
                    "observed_s": round(observed, 3),
                    "wave_model_s": round(predicted, 3),
                    "serial_s": round(serial, 3),
                    "speedup_vs_serial": round(serial / observed, 3) if observed else None,
                }
            )
    print(json.dumps({"scale": args.scale, "repeat": args.repeat, "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
