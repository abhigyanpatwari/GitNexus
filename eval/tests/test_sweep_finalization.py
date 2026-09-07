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
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

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


def _sweep(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, record: dict[str, Any]):
    """Drive the real _run_sweep; only cell execution and setup are scripted."""

    out = tmp_path / "out"

    def scripted_cell(_ctx: Any, run_idx: int, arm: str) -> dict[str, Any]:
        row = dict(record)
        row.update({"task": TASK["id"], "arm": arm, "run": run_idx, "class": TASK["class"]})
        return row

    monkeypatch.setattr(runner, "run_cell", scripted_cell)
    monkeypatch.setattr(runner, "ensure_task_graph", lambda **k: k["env"].graph_snapshots.__setitem__(
        k["graph_key"], _snapshot("graph")))
    monkeypatch.setattr(runner.TaskAssetCache, "prepare", lambda self, *a, **k: _snapshot("asset"))
    monkeypatch.setattr(runner, "prepare_ce_plugin_snapshot", lambda *a, **k: None, raising=False)
    # Binding resolution clones the repo and verifies the ref; that is expensive
    # setup, and the bindings it would return are supplied directly instead.
    monkeypatch.setattr(
        runner, "resolve_task_bindings",
        lambda tasks, expected, **k: list(expected),
    )

    return runner._run_sweep(
        _args(out),
        parser=SimpleNamespace(error=lambda m: (_ for _ in ()).throw(SystemExit(2))),
        tasks=[TASK],
        skipped_expensive=[],
        oracle_snapshots=[_snapshot("oracle")],
        expected_task_bindings=[{"repo_identity": str(tmp_path / "repo"), "resolved_sha": "a" * 40}],
        ce_plugin_config=None,
        bwrap_bin=Path("/bin/true"),
        sandbox_backend="test-double",
        runtime_mounts=(),
        candidate_arms=[],
        candidate_overlay=None,
        overlay_digest=None,
        promotion_target_bases={},
        cancel_event=None,
    ), out


_CLEAN = {
    "ok": True, "error_kind": None, "error_detail": None, "resolved": True,
    "review_evidence_valid": True, "review_score": {"weighted_f1": 0.5}, "review_weighted_f1": 0.5,
    # The report renders the whole review metric set; a real scored row carries
    # all of it, so an incomplete fixture fails in formatting rather than logic.
    "review_true_positives": 1, "review_false_positives": 0, "review_false_negatives": 0,
    "review_precision": 0.5, "review_recall": 0.5, "review_weighted_precision": 0.5,
    "review_weighted_recall": 0.5, "review_blocker_recall": 1.0, "review_severity_accuracy": 1.0,
    "review_category_accuracy": 1.0, "review_grounded_evidence": 1.0,
    "review_verdict_correct": True, "review_clean_control": True, "review_clean_pass": True,
    "transcript_missing": False, "transcript_artifacts": [], "num_turns": 3, "duration_s": 1.0,
    "cost_usd": 0.5, "input_tokens": 1, "output_tokens": 1,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "diff_files": 0, "diff_insertions": 0, "diff_deletions": 0,
}


def test_one_unusable_cell_below_the_breaker_reaches_the_finalization_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The decisive case: too few failures to trip the breaker, so only the guard can catch it."""

    streak = runner.systemic_outage_streak("review-evidence-invalid", 0)
    assert streak < runner.DEFAULT_OUTAGE_STREAK, "fixture must stay under the breaker"

    unusable = {**_CLEAN, "ok": False, "resolved": False, "review_evidence_valid": False,
                "error_kind": "review-evidence-invalid", "review_score": None, "review_weighted_f1": None}
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

    zeroed = {**_CLEAN, "resolved": False, "error_kind": "oracle-failed",
              "review_score": {"weighted_f1": 0.0}, "review_weighted_f1": 0.0}
    _sweep(tmp_path, monkeypatch, zeroed)
    out = capsys.readouterr().out
    assert "review: OBSERVED_OK" in out
    assert "UNUSABLE" not in out


def test_finalization_persists_results_and_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Evidence must survive the sweep, and say the same thing the exit does."""

    scored = {**_CLEAN, "resolved": False, "error_kind": "oracle-failed", "review_weighted_f1": 0.2}
    _result, out = _sweep(tmp_path, monkeypatch, scored)
    rows = [json.loads(line) for line in (out / "results.jsonl").read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["review_weighted_f1"] == 0.2
    assert (out / "report.md").is_file()
