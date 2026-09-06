"""Comparator-row reuse: skip unchanged incumbent/CE cells, never candidates."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from workflow_bench.comparator_reuse import (
    ComparatorReuseExpectation,
    TaskReuseBinding,
    materialize_reused_row,
    row_is_reusable_comparator,
    select_reusable_comparator_rows,
)
from workflow_bench.proposer_sandbox import SandboxError
from workflow_bench.runner_sessions import PARENT_EVENT_STREAM_SOURCE


def _digest(text: str = "blob") -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _artifact(name: str = "session-1.jsonl", payload: bytes = b'{"type":"ok"}\n') -> dict:
    return {
        "path": f"transcripts/{name}",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "source": PARENT_EVENT_STREAM_SOURCE,
    }


def _row(**overrides) -> dict:
    base = {
        "task": "review-pr-2718-defect",
        "arm": "review",
        "run": 0,
        "ok": True,
        "error_kind": None,
        "model": "gpt-5.6-sol",
        "benchmark_model": "gpt-5.6-sol",
        "effort": "xhigh",
        "sandbox_backend": "bwrap",
        "task_base_sha": "a" * 40,
        "task_prompt_digest": _digest("prompt"),
        "oracle_digest": _digest("oracle"),
        "oracle_command_digest": _digest("oracle-cmd"),
        "oracle_manifest_digest": _digest("oracle-man"),
        "skill_digest": _digest("skill"),
        "candidate_overlay_digest": None,
        "review_evidence_valid": True,
        "review_score": {"weighted_f1": 0.4},
        "review_weighted_f1": 0.4,
        "transcript_missing": False,
        "transcript_artifacts": [_artifact()],
        "recorded_at": datetime.now(UTC).isoformat(),
        "runtime_digest": _digest("cli"),
        "task_asset_manifest_digest": _digest("assets"),
        "sandbox_dependency_manifest_digest": _digest("deps"),
    }
    base.update(overrides)
    return base


def _expected(**overrides) -> ComparatorReuseExpectation:
    now = datetime.now(UTC)
    values = dict(
        model="gpt-5.6-sol",
        effort="xhigh",
        sandbox_backend="bwrap",
        runtime_digest=_digest("cli"),
        now=now,
        max_age=timedelta(days=90),
        tasks={
            "review-pr-2718-defect": TaskReuseBinding(
                task_base_sha="a" * 40,
                task_prompt_digest=_digest("prompt"),
                oracle_digest=_digest("oracle"),
                oracle_command_digest=_digest("oracle-cmd"),
                oracle_manifest_digest=_digest("oracle-man"),
                task_asset_manifest_digest=_digest("assets"),
                sandbox_dependency_manifest_digest=_digest("deps"),
            )
        },
        skill_digests={"review": _digest("skill"), "ce_review": None},
        ce_plugin_version="3.24.0",
        ce_plugin_manifest_digest=_digest("ce"),
    )
    values.update(overrides)
    return ComparatorReuseExpectation(**values)


def test_matching_incumbent_review_row_is_reusable() -> None:
    assert row_is_reusable_comparator(_row(), _expected()) is True


def test_candidate_rows_are_never_reusable() -> None:
    assert row_is_reusable_comparator(_row(arm="candidate_review"), _expected()) is False


def test_skill_digest_drift_rejects_reuse() -> None:
    assert row_is_reusable_comparator(_row(), _expected(skill_digests={"review": _digest("other")})) is False


def test_excluded_or_failed_rows_are_not_reusable() -> None:
    expected = _expected()
    assert row_is_reusable_comparator(_row(error_kind="session-error", ok=False), expected) is False
    assert row_is_reusable_comparator(_row(ok=False), expected) is False
    assert row_is_reusable_comparator(_row(review_evidence_valid=False), expected) is False
    assert row_is_reusable_comparator(_row(recorded_at=(datetime.now(UTC) - timedelta(days=91)).isoformat()), expected) is False


def test_runtime_digest_mismatch_rejects_when_both_sides_are_bound() -> None:
    row = _row(runtime_digest=_digest("old-cli"))
    assert row_is_reusable_comparator(row, _expected(runtime_digest=_digest("new-cli"))) is False
    assert row_is_reusable_comparator(row, _expected(runtime_digest=_digest("old-cli"))) is True
    # A row with no runtime_digest was measured by a harness that recorded none,
    # which is the drift this lock exists to catch - not evidence of agreement.
    assert row_is_reusable_comparator(_row(runtime_digest=None), _expected()) is False
    # And a sweep that cannot determine its own digest must not reuse either.
    assert row_is_reusable_comparator(_row(), _expected(runtime_digest=None)) is False


def test_ce_review_matches_plugin_digest_not_repo_skill() -> None:
    row = _row(
        arm="ce_review",
        skill_digest=None,
        ce_plugin_version="3.24.0",
        ce_plugin_manifest_digest=_digest("ce"),
    )
    assert row_is_reusable_comparator(row, _expected()) is True
    assert (
        row_is_reusable_comparator(row, _expected(ce_plugin_manifest_digest=_digest("other")))
        is False
    )


def test_select_drops_conflicting_duplicates() -> None:
    first = _row(review_weighted_f1=0.4)
    second = _row(review_weighted_f1=0.9, recorded_at=datetime.now(UTC).isoformat())
    selected = select_reusable_comparator_rows([first, second], expected=_expected())
    assert selected == {}
    same = select_reusable_comparator_rows([first, dict(first)], expected=_expected())
    assert ("review-pr-2718-defect", "review", 0) in same


def test_materialize_copies_transcript_and_review_artifacts(tmp_path: Path) -> None:
    payload = b'{"type":"result"}\n'
    source = tmp_path / "prior"
    dest = tmp_path / "fresh"
    (source / "transcripts").mkdir(parents=True)
    dest.mkdir()
    transcript = source / "transcripts" / "session-1.jsonl"
    transcript.write_bytes(payload)
    transcript.chmod(0o600)
    review = source / "review-pr-2718-defect-review-run0.review.json"
    review.write_text('{"verdict":"comment"}\n')
    patch = source / "review-pr-2718-defect-review-run0.patch"
    patch.write_text("diff\n")
    row = _row(
        review_artifact=review.name,
        transcript_artifacts=[_artifact(payload=payload)],
    )

    copied = materialize_reused_row(row, source_dir=source, dest_dir=dest)

    assert copied["reused"] is True
    assert copied["reused_from_recorded_at"] == row["recorded_at"]
    assert (dest / "transcripts" / "session-1.jsonl").read_bytes() == payload
    assert (dest / review.name).read_text() == review.read_text()
    assert (dest / patch.name).read_text() == "diff\n"
    assert copied["transcript_artifacts"][0]["sha256"] == hashlib.sha256(payload).hexdigest()


def test_materialize_rejects_same_directory_and_missing_transcript(tmp_path: Path) -> None:
    source = tmp_path / "prior"
    source.mkdir()
    row = _row()
    with pytest.raises(SandboxError, match="same results directory"):
        materialize_reused_row(row, source_dir=source, dest_dir=source)
    dest = tmp_path / "fresh"
    dest.mkdir()
    with pytest.raises(SandboxError, match="missing"):
        materialize_reused_row(row, source_dir=source, dest_dir=dest)


def test_a_reused_row_ages_from_its_first_measurement_not_the_copy(tmp_path: Path):
    """Reuse chains must not refresh the clock.

    materialize_reused_row restamps recorded_at with the copy time, so aging
    against that field let a row be copied forward every generation and outlive
    max_age forever. The original measurement time is the one that counts.
    """

    original = (datetime.now(UTC) - timedelta(days=91)).isoformat()
    chained = _row(recorded_at=datetime.now(UTC).isoformat(), reused_from_recorded_at=original)
    assert row_is_reusable_comparator(chained, _expected()) is False
    # The same row inside the window is still reusable.
    fresh = _row(
        recorded_at=datetime.now(UTC).isoformat(),
        reused_from_recorded_at=(datetime.now(UTC) - timedelta(days=1)).isoformat(),
    )
    assert row_is_reusable_comparator(fresh, _expected()) is True


def test_a_future_dated_row_is_corrupt_not_fresh():
    ahead = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    assert row_is_reusable_comparator(_row(recorded_at=ahead), _expected()) is False


def test_a_changed_sandbox_dependency_is_not_the_same_baseline():
    """The environment is part of the measurement.

    This branch itself changes `sandbox_dependencies` in the review corpus, so a
    prior row measured against the old set is a measurement of a different
    machine. Reusing it would compare a fresh candidate to a baseline built
    somewhere else and hand the promotion gate a false comparison.
    """

    assert row_is_reusable_comparator(
        _row(sandbox_dependency_manifest_digest=_digest("other-deps")), _expected()
    ) is False
    assert row_is_reusable_comparator(
        _row(task_asset_manifest_digest=_digest("other-assets")), _expected()
    ) is False
    # A row that predates the field is not evidence of agreement either.
    assert row_is_reusable_comparator(_row(sandbox_dependency_manifest_digest=None), _expected()) is False
