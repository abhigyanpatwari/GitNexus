"""The real sweep must reach the right finalization decision.

`enforce_measurement_health` is unit-tested and the call site is pinned
structurally, but neither shows the guard running inside a sweep. These drive
the real `_run_sweep` with cell execution scripted and everything downstream of
it left alone: folding, aggregation, the artifact writers, the health guard and
the exit selection.

The below-breaker case is the decisive one. A fixture of many unusable cells
aborts through the pre-existing outage breaker instead - `review-evidence-invalid`
is systemic with a limit of 5 - and would pass whether or not the finalization
guard exists. One fresh unusable cell stays under that threshold, so only the
guard can catch it.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from tests.bench_fixtures import scored_review_row, unusable_review_row
from workflow_bench import runner

TASK = {
    "id": "review-pr-2718-defect",
    "repo": "~/GitNexus",
    "ref": "a" * 40,
    "prompt": "review it",
    "verify": "true",
    "class": "review-defect",
}


def _args(out: Path, **overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = dict(
        arms=["review"], claude_bin="claude", effort="xhigh", model="gpt-5.6-sol",
        out=out, outage_streak=runner.DEFAULT_OUTAGE_STREAK, promotion_max_task_regression=10.0,
        promotion_metric="review_weighted_f1", promotion_min_improvement=1.0,
        promotion_min_runs=1, proposer_model=None, reuse_results=None, runs=1, workers=1,
        timeout=60, base_url=None, auth_token=None, permission_mode=None,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def _snapshot(prefix: str) -> SimpleNamespace:
    return SimpleNamespace(
        digest=f"{prefix}-content", manifest_digest=f"{prefix}-manifest",
        dependency_content_digest=f"{prefix}-dep", dependency_manifest_digest=f"{prefix}-depman",
        command_digest=f"{prefix}-command", materialize=lambda *a, **k: None,
    )


def _sweep(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    record: dict[str, Any] | Callable[[int], dict[str, Any]],
    *,
    runs: int = 1,
    cancel_event: threading.Event | None = None,
    candidate_arms: list[str] | None = None,
    arms: list[str] | None = None,
    after_cell: Callable[[int, str], None] | None = None,
):
    """Drive the real _run_sweep; only cell execution and setup are scripted.

    ``after_cell`` runs once a cell's record exists, which is how a test sets
    cancellation deterministically at a known point instead of racing a sleep.
    """

    out = tmp_path / "out"

    def scripted_cell(_ctx: Any, run_idx: int, arm: str) -> dict[str, Any]:
        row = dict(record(run_idx) if callable(record) else record)
        row.update({"task": TASK["id"], "arm": arm, "run": run_idx, "class": TASK["class"]})
        if after_cell is not None:
            after_cell(run_idx, arm)
        return row

    monkeypatch.setattr(runner, "run_cell", scripted_cell)
    monkeypatch.setattr(runner, "ensure_task_graph", lambda **k: k["env"].graph_snapshots.__setitem__(
        k["graph_key"], _snapshot("graph")))
    monkeypatch.setattr(runner.TaskAssetCache, "prepare", lambda self, *a, **k: _snapshot("asset"))
    # Binding resolution clones the repo and verifies the ref; that is expensive
    # setup, and the bindings it would return are supplied directly instead.
    monkeypatch.setattr(
        runner, "resolve_task_bindings",
        lambda tasks, expected, **k: list(expected),
    )

    return runner._run_sweep(
        _args(out, runs=runs, arms=arms or ["review"]),
        parser=SimpleNamespace(error=lambda m: (_ for _ in ()).throw(SystemExit(2))),
        tasks=[TASK],
        skipped_expensive=[],
        oracle_snapshots=[_snapshot("oracle")],
        expected_task_bindings=[{"repo_identity": str(tmp_path / "repo"), "resolved_sha": "a" * 40}],
        ce_plugin_config=None,
        bwrap_bin=Path("/bin/true"),
        sandbox_backend="test-double",
        runtime_mounts=(),
        candidate_arms=candidate_arms or [],
        candidate_overlay=None,
        overlay_digest=None,
        promotion_target_bases={},
        cancel_event=cancel_event,
    ), out


def test_one_unusable_cell_below_the_breaker_reaches_the_finalization_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The decisive case: too few failures to trip the breaker, so only the guard can catch it."""

    streak = runner.systemic_outage_streak("review-evidence-invalid", 0)
    assert streak < runner.DEFAULT_OUTAGE_STREAK, "fixture must stay under the breaker"

    unusable = unusable_review_row()
    with pytest.raises(SystemExit) as exc:
        _sweep(tmp_path, monkeypatch, unusable)
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "review: UNUSABLE" in out, "the guard must name the arm and its status"
    assert "systemic-outage" not in out, "the breaker must not have tripped"


def test_a_zero_score_stays_a_valid_negative_measurement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """0.0 is a present measurement, not missing evidence.

    A truthiness check on the score would misread it as absent and turn a
    quality result into an execution-health failure.
    """

    zeroed = scored_review_row(
        resolved=False, error_kind="oracle-failed",
        review_score={"weighted_f1": 0.0}, review_weighted_f1=0.0,
    )
    _sweep(tmp_path, monkeypatch, zeroed)
    out = capsys.readouterr().out
    assert "review: OBSERVED_OK" in out
    assert "UNUSABLE" not in out


def test_finalization_persists_results_and_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Evidence must survive the sweep, and say the same thing the exit does."""

    scored = scored_review_row(resolved=False, error_kind="oracle-failed", review_weighted_f1=0.2)
    _result, out = _sweep(tmp_path, monkeypatch, scored)
    rows = [json.loads(line) for line in (out / "results.jsonl").read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["review_weighted_f1"] == 0.2
    assert (out / "report.md").is_file()


def test_cancellation_without_an_outage_exits_130(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """An interrupted sweep is interrupted, not aborted.

    One admissible cell lands first so the measurement-health guard classifies
    the arm DEGRADED rather than UNUSABLE - otherwise the guard would supply
    exit 1 and this test would pass without ever exercising exit selection.
    """

    cancel_event = threading.Event()
    with pytest.raises(SystemExit) as exc:
        _sweep(
            tmp_path, monkeypatch, lambda _run: scored_review_row(),
            runs=3, cancel_event=cancel_event,
            after_cell=lambda run_idx, _arm: cancel_event.set() if run_idx == 0 else None,
        )
    stdout = capsys.readouterr().out
    report = (tmp_path / "out" / "report.md").read_text()
    assert "Sweep cancelled" in report, "an interruption must be reported as one"
    assert "systemic-outage" not in stdout, "no breaker trip in this scenario"
    assert exc.value.code == 130


def test_an_outage_keeps_exit_1_even_though_the_breaker_cancels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Precedence: the breaker sets cancel_event, so order decides the exit.

    Testing cancellation first would relabel every outage a Ctrl-C. The first
    cell is admissible for the same reason as above, and the failures after it
    are consecutive and systemic, which is what the breaker actually counts.
    """

    def cell(run_idx: int) -> dict[str, Any]:
        return scored_review_row() if run_idx == 0 else unusable_review_row()

    cancel_event = threading.Event()
    with pytest.raises(SystemExit) as exc:
        _sweep(tmp_path, monkeypatch, cell,
               runs=1 + runner.DEFAULT_OUTAGE_STREAK, cancel_event=cancel_event)
    stdout = capsys.readouterr().out
    report = (tmp_path / "out" / "report.md").read_text()
    assert "systemic-outage" in stdout, "the real breaker must have tripped"
    assert cancel_event.is_set(), "the breaker cancels in-flight work"
    assert "Sweep aborted" in report
    assert exc.value.code == 1, "an outage must not become the 130 of a Ctrl-C"


def test_an_interrupted_sweep_keeps_the_evidence_it_already_paid_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation must not discard rows that already cost money.

    The completed-run persistence test cannot show this: it never interrupts, so
    it would pass even if the writer only ran on the clean path.
    """

    cancel_event = threading.Event()
    with pytest.raises(SystemExit):
        _sweep(
            tmp_path, monkeypatch, lambda _run: scored_review_row(review_weighted_f1=0.42),
            runs=3, cancel_event=cancel_event,
            after_cell=lambda run_idx, _arm: cancel_event.set() if run_idx == 0 else None,
        )
    rows = [
        json.loads(line)
        for line in (tmp_path / "out" / "results.jsonl").read_text().splitlines()
    ]
    assert len(rows) == 1, "the cell that completed before cancellation must survive"
    assert rows[0]["review_weighted_f1"] == 0.42, "its measurement must survive intact"
    assert (tmp_path / "out" / "report.md").is_file()


def test_an_interrupted_sweep_emits_nothing_that_authorizes_promotion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The semantic condition, not the absence of a file.

    promotion.json is still written for an aborted run - it is the record of why
    nothing was promoted. What must hold is that nothing in it authorizes a
    promotion from partial evidence.
    """

    cancel_event = threading.Event()
    with pytest.raises(SystemExit):
        _sweep(
            tmp_path, monkeypatch, lambda _run: scored_review_row(),
            runs=3, cancel_event=cancel_event,
            # The candidate arm has to RUN, not merely appear in promotion
            # metadata: _run_sweep builds cells only from args.arms, so naming it
            # in candidate_arms alone left the candidate with no results at all -
            # and then "insufficient_evidence" would hold because nothing ran,
            # not because partial evidence is barred from promoting.
            arms=["review", "candidate_review"],
            candidate_arms=["candidate_review"],
            after_cell=(
                lambda run_idx, arm: cancel_event.set()
                if run_idx == 0 and arm == "candidate_review"
                else None
            ),
        )
    rows = [
        json.loads(line)
        for line in (tmp_path / "out" / "results.jsonl").read_text().splitlines()
    ]
    assert any(r["arm"] == "candidate_review" for r in rows), (
        "the candidate must have produced evidence, or insufficient_evidence "
        "would hold merely because nothing ran"
    )
    promotion = json.loads((tmp_path / "out" / "promotion.json").read_text())
    assert promotion["run_status"] == "aborted"
    assert promotion["decisions"], "an aborted run still has to say what it decided"
    for decision in promotion["decisions"]:
        assert decision["decision"] == "insufficient_evidence"
        assert any("partial evidence" in reason for reason in decision["reasons"])
