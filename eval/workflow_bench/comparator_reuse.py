"""Reuse frozen comparator cells when the current sweep is still the same experiment.

Weekly skill evolution re-runs incumbent ``review`` / ``ce_review`` (and the
implementation incumbents) even when the model, effort, tasks, oracles,
incumbent skill bytes, and CE plugin have not changed. Those arms are the
baseline the gate compares a *new* candidate against — they are not the
thing being evolved. Replaying them burns two-thirds of a generation.

This module selects prior ``results.jsonl`` rows that are safe to carry
forward. Candidate arms are never reused. A mismatch on any bound field
falls through to a paid cell. Missing artifacts also fall through: a reused
row that the proposer cannot read is worse than spending the tokens again.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from .evolution import CANDIDATE_ARMS, EVIDENCE_MAX_AGE_DAYS
from .proposer_sandbox import SandboxError
from .runner_sessions import MAX_TRANSCRIPT_BYTES, PARENT_EVENT_STREAM_SOURCE
from .runtime_mounts import CE_ARMS

REUSABLE_COMPARATOR_ARMS = frozenset(
    {
        "review",
        "ce_review",
        "workflow",
        "workflow_direct",
        "ce_workflow",
        "ce_workflow_direct",
        "baseline",
        "baseline_nomcp",
    }
)
# Must stay aligned with runner.EXCLUDED_ERROR_KINDS plus review-invalid.
# A reused row becomes promotion evidence; excluded kinds cannot enter that set.
REUSE_EXCLUDED_ERROR_KINDS = frozenset(
    {
        "session-error",
        "infra-error",
        "evidence-unverified",
        "cleanup-failure",
        "review-evidence-invalid",
        "cancelled",
    }
)
_TRANSCRIPT_NAME = re.compile(r"[A-Za-z0-9._-]{1,200}")
CellKey = tuple[str, str, int]


@dataclass(frozen=True)
class TaskReuseBinding:
    """Per-task identity the prior row must still match."""

    task_base_sha: str
    task_prompt_digest: str
    oracle_digest: str
    oracle_command_digest: str
    oracle_manifest_digest: str


@dataclass(frozen=True)
class ComparatorReuseExpectation:
    """Sweep-wide lock for comparator reuse. Any drift pays for a fresh cell."""

    model: str
    effort: str
    sandbox_backend: str
    runtime_digest: str | None
    now: datetime
    max_age: timedelta
    tasks: Mapping[str, TaskReuseBinding]
    skill_digests: Mapping[str, str | None]
    ce_plugin_version: str | None
    ce_plugin_manifest_digest: str | None


def load_result_rows(path: Path) -> list[dict[str, Any]]:
    """Load ``results.jsonl``; skip malformed lines the same way evolve does."""

    rows: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def current_runtime_digest() -> str | None:
    """Harness lockfile digest exported by ``run-evolution.sh``, if present."""

    value = os.environ.get("RUNTIME_DIGEST", "").strip()
    return value or None


def row_is_reusable_comparator(row: Mapping[str, Any], expected: ComparatorReuseExpectation) -> bool:
    """True when ``row`` is a complete, still-valid comparator measurement."""

    arm = row.get("arm")
    if not isinstance(arm, str) or arm in CANDIDATE_ARMS or arm not in REUSABLE_COMPARATOR_ARMS:
        return False
    if row.get("error_kind") in REUSE_EXCLUDED_ERROR_KINDS:
        return False
    if row.get("error_kind") not in (None, ""):
        return False
    if row.get("ok") is not True:
        return False
    if row.get("transcript_missing") is True:
        return False
    if row.get("candidate_overlay_digest") not in (None, ""):
        return False
    # Age against the ORIGINAL measurement, not the copy time: materialize_reused_row
    # restamps recorded_at, so a chained row would otherwise refresh its own clock
    # and never expire. Bound both directions - a future stamp is corrupt, not fresh.
    recorded = _parse_recorded_at(row.get("reused_from_recorded_at") or row.get("recorded_at"))
    if recorded is None:
        return False
    age = expected.now - recorded
    if age > expected.max_age or age < timedelta(0):
        return False
    if row.get("model") != expected.model and row.get("benchmark_model") != expected.model:
        return False
    if row.get("effort") != expected.effort:
        return False
    if row.get("sandbox_backend") != expected.sandbox_backend:
        return False
    # Fail closed. A row with no runtime_digest was measured by a harness that
    # did not record one, which is exactly the drift this lock exists to catch;
    # treating the absence as agreement made every legacy row reusable forever.
    prior_runtime = row.get("runtime_digest")
    if not isinstance(prior_runtime, str) or not prior_runtime:
        return False
    if not expected.runtime_digest or prior_runtime != expected.runtime_digest:
        return False

    task_id = row.get("task")
    binding = expected.tasks.get(task_id) if isinstance(task_id, str) else None
    if binding is None:
        return False
    if row.get("task_base_sha") != binding.task_base_sha:
        return False
    if row.get("task_prompt_digest") != binding.task_prompt_digest:
        return False
    if row.get("oracle_digest") != binding.oracle_digest:
        return False
    if row.get("oracle_command_digest") != binding.oracle_command_digest:
        return False
    if row.get("oracle_manifest_digest") != binding.oracle_manifest_digest:
        return False

    if arm in CE_ARMS:
        if row.get("ce_plugin_version") != expected.ce_plugin_version:
            return False
        if row.get("ce_plugin_manifest_digest") != expected.ce_plugin_manifest_digest:
            return False
    else:
        expected_skill = expected.skill_digests.get(arm)
        if not expected_skill or row.get("skill_digest") != expected_skill:
            return False

    if arm in {"review", "ce_review"}:
        if row.get("review_evidence_valid") is not True:
            return False
        if not isinstance(row.get("review_score"), dict):
            return False
        if row.get("review_weighted_f1") is None:
            return False

    artifacts = row.get("transcript_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return False
    try:
        for artifact in artifacts:
            _transcript_metadata(artifact)
    except SandboxError:
        return False
    return True


def select_reusable_comparator_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    expected: ComparatorReuseExpectation,
) -> dict[CellKey, dict[str, Any]]:
    """Index reusable rows by ``(task, arm, run)``. Conflicting duplicates drop the key."""

    chosen: dict[CellKey, dict[str, Any]] = {}
    blocked: set[CellKey] = set()
    for row in rows:
        if not row_is_reusable_comparator(row, expected):
            continue
        task_id = row["task"]
        arm = row["arm"]
        run = row.get("run")
        if not isinstance(run, int) or isinstance(run, bool) or run < 0:
            continue
        key = (str(task_id), str(arm), run)
        if key in blocked:
            continue
        previous = chosen.get(key)
        if previous is None:
            chosen[key] = dict(row)
            continue
        if _row_identity(previous) != _row_identity(row):
            blocked.add(key)
            chosen.pop(key, None)
    return chosen


def materialize_reused_row(
    row: Mapping[str, Any],
    *,
    source_dir: Path,
    dest_dir: Path,
) -> dict[str, Any]:
    """Copy digest-bound artifacts into this sweep's evidence dir and stamp reuse."""

    source = _real_directory(source_dir, label="reuse source")
    dest = _real_directory(dest_dir, label="reuse destination")
    if source == dest:
        raise SandboxError("comparator reuse cannot read and write the same results directory")

    materialized = dict(row)
    materialized["reused"] = True
    # Keep the FIRST measurement time across a chain. Overwriting it with the
    # previous copy's stamp let a row refresh its own clock every generation and
    # outlive the max_age bound entirely.
    materialized["reused_from_recorded_at"] = row.get("reused_from_recorded_at") or row.get("recorded_at")
    materialized["recorded_at"] = datetime.now(UTC).isoformat()

    artifacts = row.get("transcript_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise SandboxError("reused row is missing transcript_artifacts")
    copied_artifacts: list[dict[str, Any]] = []
    for artifact in artifacts:
        copied_artifacts.append(_copy_transcript_artifact(source, dest, artifact))
    materialized["transcript_artifacts"] = copied_artifacts

    review_name = row.get("review_artifact")
    if isinstance(review_name, str) and review_name:
        _copy_named_artifact(source, dest, review_name, label="review artifact")

    task = row.get("task")
    arm = row.get("arm")
    run = row.get("run")
    if isinstance(task, str) and isinstance(arm, str) and isinstance(run, int) and not isinstance(run, bool):
        patch_name = f"{task}-{arm}-run{run}.patch"
        patch = source / patch_name
        if patch.is_file() and not patch.is_symlink():
            _copy_named_artifact(source, dest, patch_name, label="patch artifact")
    return materialized


def default_reuse_max_age() -> timedelta:
    return timedelta(days=EVIDENCE_MAX_AGE_DAYS)


def _row_identity(row: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        row.get("skill_digest"),
        row.get("oracle_digest"),
        row.get("review_weighted_f1"),
        row.get("ce_plugin_manifest_digest"),
        row.get("recorded_at"),
    )


def _parse_recorded_at(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _transcript_metadata(metadata: Any) -> tuple[str, str, int]:
    if not isinstance(metadata, dict) or set(metadata) != {"path", "sha256", "bytes", "source"}:
        raise SandboxError("transcript artifact metadata must contain only path, sha256, bytes, and source")
    relative = metadata["path"]
    digest = metadata["sha256"]
    size = metadata["bytes"]
    if metadata["source"] != PARENT_EVENT_STREAM_SOURCE:
        raise SandboxError("transcript artifact source is not the parent event stream")
    if not isinstance(relative, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise SandboxError("transcript artifact metadata is malformed")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > MAX_TRANSCRIPT_BYTES:
        raise SandboxError("transcript artifact byte count is out of range")
    relative_path = PurePosixPath(relative)
    if (
        relative_path.is_absolute()
        or len(relative_path.parts) != 2
        or relative_path.parts[0] != "transcripts"
        or any(part in {"", ".", ".."} for part in relative_path.parts)
        or _TRANSCRIPT_NAME.fullmatch(relative_path.parts[1]) is None
    ):
        raise SandboxError(f"unsafe transcript artifact path: {relative!r}")
    return relative, digest, size


def _real_directory(path: Path, *, label: str) -> Path:
    resolved = path.expanduser()
    try:
        metadata = resolved.lstat()
    except OSError as exc:
        raise SandboxError(f"{label} is unavailable: {resolved}: {exc}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise SandboxError(f"{label} must be a real directory: {resolved}")
    return resolved.resolve()


def _copy_transcript_artifact(source: Path, dest: Path, metadata: Mapping[str, Any]) -> dict[str, Any]:
    relative, expected_digest, expected_size = _transcript_metadata(metadata)
    source_file = _regular_file(source / Path(*PurePosixPath(relative).parts), label="transcript")
    actual_size = source_file.stat().st_size
    if actual_size != expected_size:
        raise SandboxError(f"reused transcript size drifted: {relative}")
    digest = _sha256_file(source_file)
    if digest != expected_digest:
        raise SandboxError(f"reused transcript digest drifted: {relative}")
    dest_dir = dest / "transcripts"
    dest_dir.mkdir(mode=0o700, exist_ok=True)
    dest_dir.chmod(0o700)
    destination = dest_dir / PurePosixPath(relative).name
    _copy_owner_only(source_file, destination)
    return {"path": relative, "sha256": digest, "bytes": expected_size, "source": PARENT_EVENT_STREAM_SOURCE}


def _copy_named_artifact(source: Path, dest: Path, name: str, *, label: str) -> None:
    relative = PurePosixPath(name)
    if relative.is_absolute() or len(relative.parts) != 1 or relative.parts[0] in {"", ".", ".."}:
        raise SandboxError(f"unsafe {label} path: {name!r}")
    source_file = _regular_file(source / name, label=label)
    _copy_owner_only(source_file, dest / name)


def _regular_file(path: Path, *, label: str) -> Path:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise SandboxError(f"{label} is missing: {path}: {exc}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SandboxError(f"{label} must be a regular non-symlink file: {path}")
    return path


def _copy_owner_only(source: Path, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise SandboxError(f"reuse destination already exists: {destination}")
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        with open(source, "rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise OSError(f"short write while copying {source}")
                    view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
