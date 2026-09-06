"""Cost model for the evolution wall clock: measured cells, real schedules."""

from __future__ import annotations

import pytest

from workflow_bench.measure_evolution_cost import (
    CELL_COPY_SECONDS,
    CELL_DURATIONS,
    GRAPH_ANALYZE_SECONDS,
    PROPOSER_SECONDS,
    TEMPLATE_SANITIZE_SECONDS,
    cell_durations,
    expected_makespan,
    fed_makespan,
    fed_pool_enabled,
    graph_pipeline_enabled,
    paid_cells_per_task,
    setup_wall_seconds,
    unique_paid_shas,
    wave_makespan,
)

TASKS = [
    {"id": "a", "ref": "sha-1"},
    {"id": "b", "ref": "sha-2"},
    {"id": "c", "ref": "sha-1"},
]


def test_measured_sample_is_present_and_unsorted():
    # Sorting would hand each task a uniform block and hide the variance the
    # whole model exists to price.
    assert len(CELL_DURATIONS) >= 20
    assert list(CELL_DURATIONS) != sorted(CELL_DURATIONS)
    assert PROPOSER_SECONDS > 0


def test_weekly_reuse_pays_only_candidate_cells():
    assert paid_cells_per_task(TASKS, runs=3, weekly=True, reuse_enabled=True) == [3, 3, 3]
    assert paid_cells_per_task(TASKS, runs=3, weekly=False, reuse_enabled=True) == [9, 9, 9]
    assert paid_cells_per_task(TASKS, runs=3, weekly=True, reuse_enabled=False) == [9, 9, 9]


def test_every_cell_carries_its_own_clone():
    durations = cell_durations(3, True)
    assert durations == [d + CELL_COPY_SECONDS for d in CELL_DURATIONS[:3]]
    assert cell_durations(2, False) == [d + TEMPLATE_SANITIZE_SECONDS for d in CELL_DURATIONS[:2]]
    # Cycling wraps, so a task can be longer than the sample.
    assert len(cell_durations(len(CELL_DURATIONS) + 5, True)) == len(CELL_DURATIONS) + 5


def test_a_wave_costs_its_slowest_cell_and_a_fed_pool_does_not():
    slow = [10.0, 1.0, 1.0, 10.0, 1.0, 1.0]
    assert wave_makespan(slow, 3) == 20.0
    # Fed: one worker takes the first 10; the second 10 lands on a worker that
    # has already cleared a 1, and the remaining 1s fill the third.
    assert fed_makespan(slow, 3) == 11.0
    assert fed_makespan(slow, 1) == wave_makespan(slow, 1) == 24.0


def test_expected_makespan_is_rotation_averaged_and_deterministic():
    first = expected_makespan(9, 3, fed_pool=False, clone_templates_enabled=True)
    assert first == expected_makespan(9, 3, fed_pool=False, clone_templates_enabled=True)
    assert expected_makespan(0, 3, fed_pool=False, clone_templates_enabled=True) == 0.0
    # The barrier can only cost time, never save it.
    assert first >= expected_makespan(9, 3, fed_pool=True, clone_templates_enabled=True)


def test_setup_counts_each_sha_once_and_no_longer_charges_cells():
    assert unique_paid_shas(TASKS, [9, 9, 9]) == 2
    assert unique_paid_shas(TASKS, [9, 0, 0]) == 1
    assert setup_wall_seconds(
        unique_shas=2, paid_per_task=[9, 9, 9], clone_templates_enabled=True
    ) == 2 * (TEMPLATE_SANITIZE_SECONDS + GRAPH_ANALYZE_SECONDS)
    assert setup_wall_seconds(unique_shas=2, paid_per_task=[0], clone_templates_enabled=True) == 0


def test_feature_flags_read_the_runner_not_the_wish():
    assert graph_pipeline_enabled("def _run_sweep(): pass") == 0
    assert graph_pipeline_enabled("graph_prefetch = GraphPrefetch(...)") == 1
    assert fed_pool_enabled("def _run_wave(): pass") == 0
    assert fed_pool_enabled("def _run_fed_pool(): pass") == 1


@pytest.mark.parametrize("workers", [1, 3, 8])
def test_more_workers_never_lengthen_a_task(workers):
    serial = expected_makespan(9, 1, fed_pool=True, clone_templates_enabled=True)
    assert expected_makespan(9, workers, fed_pool=True, clone_templates_enabled=True) <= serial
