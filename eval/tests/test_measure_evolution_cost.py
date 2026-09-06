"""Cost model for the evolution wall clock: measured cells, real schedules."""

from __future__ import annotations

import pytest

from workflow_bench.measure_evolution_cost import (
    CANDIDATE_ARM,
    CELL_OVERHEAD_SECONDS,
    DURATIONS_BY_ARM,
    PROPOSER_SECONDS,
    REVIEW_ARMS,
    expected_task_seconds,
    fed_makespan,
    fed_pool_enabled,
    generation_seconds,
    graph_pipeline_enabled,
    paid_arms,
    task_cells,
    wave_makespan,
)


def test_every_arm_has_its_own_unsorted_sample():
    assert set(DURATIONS_BY_ARM) == set(REVIEW_ARMS)
    for arm, sample in DURATIONS_BY_ARM.items():
        assert len(sample) >= 10, arm
        # Sorting would hand each task a uniform block and hide the variance
        # the whole model exists to price.
        assert list(sample) != sorted(sample), arm
    assert PROPOSER_SECONDS > 0
    assert CELL_OVERHEAD_SECONDS > 0


def test_weekly_reuse_pays_the_candidate_arm_only():
    assert paid_arms(weekly=True, reuse_enabled=True) == (CANDIDATE_ARM,)
    assert paid_arms(weekly=False, reuse_enabled=True) == REVIEW_ARMS
    assert paid_arms(weekly=True, reuse_enabled=False) == REVIEW_ARMS


def test_cells_are_submitted_run_major_arm_minor():
    # runner.py: [(run_idx, arm) for run_idx in range(runs) for arm in arms].
    # At workers=3 that puts one cell of each arm in every wave.
    cells = task_cells(2, REVIEW_ARMS, 0)
    assert len(cells) == 6
    expected = [
        DURATIONS_BY_ARM[arm][run] + CELL_OVERHEAD_SECONDS
        for run in range(2)
        for arm in REVIEW_ARMS
    ]
    assert cells == expected


def test_every_cell_carries_the_measured_overhead():
    assert task_cells(1, (CANDIDATE_ARM,), 0) == [
        DURATIONS_BY_ARM[CANDIDATE_ARM][0] + CELL_OVERHEAD_SECONDS
    ]
    # Cycling wraps, so a task can ask for more runs than the sample holds.
    long_sample = task_cells(len(DURATIONS_BY_ARM[CANDIDATE_ARM]) + 2, (CANDIDATE_ARM,), 0)
    assert len(long_sample) == len(DURATIONS_BY_ARM[CANDIDATE_ARM]) + 2


def test_a_wave_costs_its_slowest_cell_and_a_fed_pool_does_not():
    slow = [10.0, 1.0, 1.0, 10.0, 1.0, 1.0]
    assert wave_makespan(slow, 3) == 20.0
    # Fed: one worker takes the first 10; the second 10 lands on a worker that
    # has already cleared a 1, and the remaining 1s fill the third.
    assert fed_makespan(slow, 3) == 11.0
    assert fed_makespan(slow, 1) == wave_makespan(slow, 1) == 24.0


def test_expected_task_seconds_is_alignment_averaged_and_deterministic():
    waved = expected_task_seconds(3, REVIEW_ARMS, 3, fed_pool=False)
    assert waved == expected_task_seconds(3, REVIEW_ARMS, 3, fed_pool=False)
    assert expected_task_seconds(0, REVIEW_ARMS, 3, fed_pool=False) == 0.0
    assert expected_task_seconds(3, (), 3, fed_pool=False) == 0.0
    # The barrier can only cost time, never save it.
    assert waved >= expected_task_seconds(3, REVIEW_ARMS, 3, fed_pool=True)


def test_a_generation_pays_one_proposer_session_on_top_of_its_tasks():
    one = generation_seconds(task_count=1, runs=3, arms=REVIEW_ARMS, workers=3, fed_pool=False)
    two = generation_seconds(task_count=2, runs=3, arms=REVIEW_ARMS, workers=3, fed_pool=False)
    # Each extra task adds exactly one task's makespan; the proposer is paid once.
    assert two - one == pytest.approx(one - PROPOSER_SECONDS, abs=1.0)


def test_feature_flags_read_the_runner_not_the_wish():
    assert graph_pipeline_enabled("def _run_sweep(): pass") == 0
    assert graph_pipeline_enabled("graph_prefetch = GraphPrefetch(...)") == 1
    assert fed_pool_enabled("def _run_wave(): pass") == 0
    assert fed_pool_enabled("def _run_fed_pool(): pass") == 1


@pytest.mark.parametrize("workers", [1, 3, 8])
def test_more_workers_never_lengthen_a_task(workers):
    serial = expected_task_seconds(3, REVIEW_ARMS, 1, fed_pool=True)
    assert expected_task_seconds(3, REVIEW_ARMS, workers, fed_pool=True) <= serial
