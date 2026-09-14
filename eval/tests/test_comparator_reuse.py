"""Comparator-row reuse: skip unchanged incumbent/CE cells, never candidates."""

from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from workflow_bench import comparator_reuse
from workflow_bench.comparator_reuse import (
    ComparatorReuseExpectation,
    TaskReuseBinding,
    materialize_reused_row,
    row_is_reusable_comparator,
    select_reusable_comparator_rows,
)
from workflow_bench.proposer_sandbox import SandboxError
from workflow_bench.runner_sessions import PARENT_EVENT_STREAM_SOURCE


requires_openat = pytest.mark.skipif(
    os.open not in os.supports_dir_fd,
    reason="comparator reuse resolves every artifact against a pinned directory descriptor",
)


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
        # Production sets this whenever the review source exists, which is the
        # normal path for a valid review; the fixture predated the requirement.
        "review_artifact": "review-pr-2718-defect-review-run0.review.json",
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


@requires_openat
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


@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevated Windows privileges")
@requires_openat
def test_a_reused_artifact_is_copied_from_the_inode_that_was_checked(tmp_path: Path) -> None:
    """The reuse source is a directory another sweep wrote and may still write.

    Validating a path and then re-opening it hands a concurrent writer the gap:
    replace the checked file with a symlink and the copy follows it out of the
    results directory. Swapping the path while the descriptor is held is that
    same substitution, made deterministic.
    """

    (tmp_path / "transcript.jsonl").write_bytes(b"verified\n")
    decoy = tmp_path / "decoy.jsonl"
    decoy.write_bytes(b"substituted\n")

    with comparator_reuse._open_real_directory(tmp_path, label="reuse source") as dir_fd:
        with comparator_reuse._open_regular("transcript.jsonl", dir_fd=dir_fd, label="transcript") as descriptor:
            (tmp_path / "transcript.jsonl").unlink()
            (tmp_path / "transcript.jsonl").symlink_to(decoy)
            comparator_reuse._copy_owner_only(descriptor, "copy.jsonl", dir_fd=dir_fd)

        assert (tmp_path / "copy.jsonl").read_bytes() == b"verified\n"
        with pytest.raises(SandboxError, match="regular non-symlink"):
            with comparator_reuse._open_regular("transcript.jsonl", dir_fd=dir_fd, label="transcript"):
                pass


@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevated Windows privileges")
@requires_openat
def test_a_symlinked_transcripts_directory_is_refused_on_both_sides(tmp_path: Path) -> None:
    """`O_NOFOLLOW` refuses the leaf, not the directory above it.

    A `transcripts` symlink on the source side makes reuse read a file outside
    the results directory; one on the destination side writes the copy outside
    this sweep's evidence. Neither is covered by the per-file guards that let
    _resolved_directory tolerate a symlinked root.
    """

    payload = b'{"type":"result"}\n'
    outside = tmp_path / "outside"
    (outside / "transcripts").mkdir(parents=True)
    (outside / "transcripts" / "session-1.jsonl").write_bytes(payload)
    row = _row(transcript_artifacts=[_artifact(payload=payload)])

    linked_source = tmp_path / "linked-source"
    linked_source.mkdir()
    (linked_source / "transcripts").symlink_to(outside / "transcripts", target_is_directory=True)
    dest = tmp_path / "fresh"
    dest.mkdir()
    with pytest.raises(SandboxError, match="transcript source must be a real directory"):
        materialize_reused_row(row, source_dir=linked_source, dest_dir=dest)

    source = tmp_path / "prior"
    (source / "transcripts").mkdir(parents=True)
    (source / "transcripts" / "session-1.jsonl").write_bytes(payload)
    linked_dest = tmp_path / "linked-dest"
    linked_dest.mkdir()
    (linked_dest / "transcripts").symlink_to(outside / "transcripts", target_is_directory=True)
    with pytest.raises(SandboxError, match="transcript destination must be a real directory"):
        materialize_reused_row(row, source_dir=source, dest_dir=linked_dest)


@requires_openat
@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevated Windows privileges")
def test_a_renamed_transcripts_directory_cannot_redirect_a_copy(tmp_path: Path) -> None:
    """The directory is pinned, not re-walked from its name.

    An lstat that passed and a pathname used afterwards are two different
    directories the moment a concurrent writer renames the first one away. This
    performs exactly that substitution — rename, then leave a symlink in its
    place — while the descriptor is held, which is what makes the race testable
    without timing.
    """

    payload = b'{"type":"result"}\n'
    results = tmp_path / "results"
    transcripts = results / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / "session-1.jsonl").write_bytes(payload)
    outside = tmp_path / "outside"
    outside.mkdir()

    with comparator_reuse._open_real_directory(results, label="reuse source") as root_fd:
        with comparator_reuse._open_real_directory(
            "transcripts", dir_fd=root_fd, label="transcript source"
        ) as dir_fd:
            transcripts.rename(results / "moved")
            (results / "transcripts").symlink_to(outside, target_is_directory=True)
            with comparator_reuse._open_regular(
                "session-1.jsonl", dir_fd=dir_fd, label="transcript"
            ) as artifact_fd:
                comparator_reuse._copy_owner_only(artifact_fd, "copy.jsonl", dir_fd=dir_fd)

    assert (results / "moved" / "copy.jsonl").read_bytes() == payload
    assert not (outside / "copy.jsonl").exists()


@requires_openat
def test_a_transcript_rewritten_mid_copy_is_refused_not_recorded(tmp_path: Path, monkeypatch) -> None:
    """The digest has to describe the bytes that were written.

    A held descriptor stops the pathname being substituted; it does not stop the
    inode being rewritten, and the prior sweep's directory is one this sweep
    treats as concurrently writable. Hashing the source and then reading it
    again to copy let the row keep the expected digest while the destination
    held different bytes.
    """

    payload = b'{"type":"result"}\n'
    source = tmp_path / "prior"
    (source / "transcripts").mkdir(parents=True)
    transcript = source / "transcripts" / "session-1.jsonl"
    transcript.write_bytes(payload)
    dest = tmp_path / "fresh"
    dest.mkdir()
    row = _row(transcript_artifacts=[_artifact(payload=payload)])

    # Rewrite the inode in the window the copy reads through — same length, so
    # only the digest can tell, which is the point.
    real_read = comparator_reuse.os.read
    rewritten = {"done": False}

    def rewrite_then_read(fd: int, size: int) -> bytes:
        if not rewritten["done"]:
            rewritten["done"] = True
            with open(transcript, "r+b") as handle:
                handle.write(b'{"type":"TAMPER"}')
        return real_read(fd, size)

    monkeypatch.setattr(comparator_reuse.os, "read", rewrite_then_read)
    with pytest.raises(SandboxError, match="drifted"):
        materialize_reused_row(row, source_dir=source, dest_dir=dest)
    monkeypatch.undo()

    # And nothing unvouched-for is left behind for the proposer to read.
    assert not (dest / "transcripts" / "session-1.jsonl").exists()


@requires_openat
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


@requires_openat
def test_a_reused_row_ages_from_its_first_measurement_not_the_copy():
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


@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevated Windows privileges")
def test_reuse_directories_allow_a_symlinked_parent_but_not_a_symlinked_leaf(tmp_path: Path):
    """Pins a deliberate difference from the sandbox's mount-root check.

    proposer_sandbox refuses every symlink hop because a hop changes what an
    untrusted session is handed. A reuse directory is data, and every file
    inside it is validated on its own, so a symlinked parent is allowed -
    rejecting it would break a symlinked artifacts directory or macOS's /var
    for no gain. The leaf itself must still be a real directory.
    """

    real = tmp_path / "real"
    real.mkdir()
    (real / "inner").mkdir()
    linked_parent = tmp_path / "linked"
    linked_parent.symlink_to(real, target_is_directory=True)

    # Reached through a symlinked parent: allowed, and resolved to the real path.
    # The identity returned alongside it is what pins the root against a swap
    # between the check and the open; the symlink policy itself is unchanged.
    resolved, identity = comparator_reuse._resolved_directory(linked_parent / "inner", label="probe")
    assert resolved == (real / "inner").resolve()
    inner_stat = (real / "inner").stat()
    assert identity == (inner_stat.st_dev, inner_stat.st_ino)

    # The leaf itself being a symlink is still refused.
    with pytest.raises(SandboxError, match="must be a real directory"):
        comparator_reuse._resolved_directory(linked_parent, label="probe")


def test_a_review_row_without_its_artifact_is_not_reusable() -> None:
    """A score is a claim about evidence, not the evidence itself.

    materialize_reused_row copies the review artifact only when the row names
    one, so accepting a row without it would carry a scored review forward with
    nothing for a proposer to read.
    """

    row = _row()
    assert row_is_reusable_comparator(row, _expected()) is True
    without = {**row, "review_artifact": ""}
    assert row_is_reusable_comparator(without, _expected()) is False
    missing = {k: v for k, v in row.items() if k != "review_artifact"}
    assert row_is_reusable_comparator(missing, _expected()) is False


@requires_openat
def test_a_reuse_root_replaced_after_the_check_is_refused(tmp_path: Path, monkeypatch) -> None:
    """Check and use must name the same directory, not the same string.

    _resolved_directory lstats a name and the open re-walks that same name, so
    a prior sweep that swaps its results root in between is opened somewhere
    else. The leaf-symlink rule does not cover it - a replacement that is
    itself a real directory passes every check the policy makes - and the
    failure is silent, folding another directory's rows into this sweep's
    comparator baseline.
    """

    original = tmp_path / "results"
    original.mkdir()
    resolved, stale_identity = comparator_reuse._resolved_directory(original, label="probe")

    # Replaced by a different REAL directory: the name still resolves and still
    # passes the symlink policy, but it is not the inode that was checked.
    original.rename(tmp_path / "moved")
    original.mkdir()
    assert comparator_reuse._resolved_directory(original, label="probe")[1] != stale_identity

    monkeypatch.setattr(
        comparator_reuse, "_resolved_directory", lambda *_a, **_k: (resolved, stale_identity)
    )
    with pytest.raises(SandboxError, match="replaced between the check and the open"):
        with comparator_reuse._open_pinned_root(original, label="probe"):
            pass


@requires_openat
def test_a_stable_reuse_root_opens_normally(tmp_path: Path) -> None:
    """The guard rejects nothing that holds still - a directory matches itself."""

    root = tmp_path / "results"
    root.mkdir()
    with comparator_reuse._open_pinned_root(root, label="probe") as fd:
        assert os.fstat(fd).st_ino == root.stat().st_ino
