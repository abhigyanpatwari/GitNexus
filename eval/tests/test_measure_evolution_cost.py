"""Cost model for the evolution wall clock: waves, not cells; overlap, not wishes."""

from __future__ import annotations

from workflow_bench.measure_evolution_cost import (
    CELL_COPY_SECONDS,
    GRAPH_ANALYZE_SECONDS,
    MEAN_SESSION_SECONDS,
    TEMPLATE_SANITIZE_SECONDS,
    cell_setup_seconds,
    graph_pipeline_enabled,
    paid_cells_per_task,
    pipelined_wall_seconds,
    session_wall_seconds,
    setup_wall_seconds,
    unique_paid_shas,
)

TASKS = [
    {"id": "a", "ref": "sha-1"},
    {"id": "b", "ref": "sha-2"},
    {"id": "c", "ref": "sha-1"},
]


def test_weekly_reuse_pays_only_candidate_cells():
    assert paid_cells_per_task(TASKS, runs=3, weekly=True, reuse_enabled=True) == [3, 3, 3]
    assert paid_cells_per_task(TASKS, runs=3, weekly=False, reuse_enabled=True) == [9, 9, 9]
    assert paid_cells_per_task(TASKS, runs=3, weekly=True, reuse_enabled=False) == [9, 9, 9]


def test_cell_clones_are_charged_once_per_wave():
    # run_cell clones inside its own pool worker: three siblings clone at once.
    assert cell_setup_seconds(9, 3, True) == 3 * CELL_COPY_SECONDS
    assert cell_setup_seconds(9, 1, True) == 9 * CELL_COPY_SECONDS
    assert cell_setup_seconds(0, 3, True) == 0
    # Without templates the cell pays a full clone+sanitize, still per wave.
    assert cell_setup_seconds(9, 3, False) == 3 * TEMPLATE_SANITIZE_SECONDS


def test_setup_counts_each_sha_once_and_each_task_wave_once():
    assert unique_paid_shas(TASKS, [9, 9, 9]) == 2
    assert unique_paid_shas(TASKS, [9, 0, 0]) == 1
    assert setup_wall_seconds(
        unique_shas=2,
        paid_per_task=[9, 9, 9],
        workers=3,
        clone_templates_enabled=True,
    ) == 2 * (TEMPLATE_SANITIZE_SECONDS + GRAPH_ANALYZE_SECONDS) + 9 * CELL_COPY_SECONDS


def test_pipelining_hides_every_sha_but_the_first():
    paid = [9, 9, 9]
    waves = [3 * MEAN_SESSION_SECONDS] * 3
    serial = session_wall_seconds(paid, 3) + setup_wall_seconds(
        unique_shas=2,
        paid_per_task=paid,
        workers=3,
        clone_templates_enabled=True,
    )
    pipelined = pipelined_wall_seconds(
        TASKS, paid, waves, workers=3, clone_templates_enabled=True
    )
    # sha-2's setup fits inside task a's session wave; sha-1 is already ready.
    assert serial - pipelined == TEMPLATE_SANITIZE_SECONDS + GRAPH_ANALYZE_SECONDS


def test_pipeline_flag_reads_the_runner_not_the_wish():
    assert graph_pipeline_enabled("def _run_sweep(): pass") == 0
    assert graph_pipeline_enabled("graph_prefetch = GraphPrefetch(...)") == 1
