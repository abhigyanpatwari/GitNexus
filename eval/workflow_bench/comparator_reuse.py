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
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from .evolution import CANDIDATE_ARMS, EVIDENCE_MAX_AGE_DAYS
from .proposer_sandbox import SandboxError
from .runner_sessions import MAX_TRANSCRIPT_BYTES, PARENT_EVENT_STREAM_SOURCE
from .runtime_mounts import CE_ARMS
from .task_assets import COPY_CHUNK_BYTES, _write_all

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
    # The cell's environment is part of its identity: a comparator measured
    # against different task assets or different sandbox dependencies is a
    # measurement of a different machine, not a baseline for this sweep.
    task_asset_manifest_digest: str | None = None
    sandbox_dependency_manifest_digest: str | None = None


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
    # Fail closed on both sides, as the runtime digest does: an unbound
    # expectation means this sweep could not determine its own environment, and
    # a row without the field was measured before it was recorded.
    for field, bound in (
        ("task_asset_manifest_digest", binding.task_asset_manifest_digest),
        ("sandbox_dependency_manifest_digest", binding.sandbox_dependency_manifest_digest),
    ):
        prior = row.get(field)
        if not isinstance(prior, str) or not prior or not bound or prior != bound:
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
        # The artifact, not just the score derived from it. materialize_reused_row
        # copies it only when the name is present, so without this a row whose
        # artifact copy never happened could be carried forward as a scored
        # review that a proposer then cannot read - evidence by assertion.
        review_artifact = row.get("review_artifact")
        if not isinstance(review_artifact, str) or not review_artifact:
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

    source, _ = _resolved_directory(source_dir, label="reuse source")
    dest, _ = _resolved_directory(dest_dir, label="reuse destination")
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

    # Every path below is resolved against a held descriptor, never re-walked
    # from a name. Both roots are already symlink-free (_resolved_directory
    # resolved them), and pinning them here means the components under them
    # cannot be swapped out from under a check that already passed.
    with (
        _open_pinned_root(source_dir, label="reuse source") as source_fd,
        _open_pinned_root(dest_dir, label="reuse destination") as dest_fd,
    ):
        copied_artifacts: list[dict[str, Any]] = []
        for artifact in artifacts:
            copied_artifacts.append(_copy_transcript_artifact(source_fd, dest_fd, artifact))
        materialized["transcript_artifacts"] = copied_artifacts

        review_name = row.get("review_artifact")
        if isinstance(review_name, str) and review_name:
            _copy_named_artifact(source_fd, dest_fd, review_name, label="review artifact")

        task = row.get("task")
        arm = row.get("arm")
        run = row.get("run")
        if isinstance(task, str) and isinstance(arm, str) and isinstance(run, int) and not isinstance(run, bool):
            patch_name = f"{task}-{arm}-run{run}.patch"
            if _is_regular_at(patch_name, dir_fd=source_fd):
                _copy_named_artifact(source_fd, dest_fd, patch_name, label="patch artifact")
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


def _resolved_directory(path: Path, *, label: str) -> tuple[Path, tuple[int, int]]:
    """An existing, non-symlink directory, resolved through its parents.

    Deliberately weaker than proposer_sandbox's same-shaped helper, which
    refuses every symlink hop in the path. That one guards a MOUNT ROOT, where
    a hop changes what an untrusted session is handed. This one guards a DATA
    directory whose contents are validated individually anyway - every file
    read goes through ``_regular_file`` (lstat, symlinks rejected) and every
    write through ``O_NOFOLLOW`` - so a symlinked parent grants nothing those
    guards do not already cover, while refusing one would reject ordinary
    setups such as a symlinked artifacts directory or macOS's /var.

    Separately named because they make different promises. Do not merge them
    without first deciding which promise the reuse path should make.
    """

    resolved = path.expanduser()
    try:
        metadata = resolved.lstat()
    except OSError as exc:
        raise SandboxError(f"{label} is unavailable: {resolved}: {exc}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise SandboxError(f"{label} must be a real directory: {resolved}")
    return resolved.resolve(), (metadata.st_dev, metadata.st_ino)


@contextmanager
def _open_pinned_root(path: Path, *, label: str) -> Iterator[int]:
    """Open a checked root and prove it is still the directory that was checked.

    The symlink POLICY above is deliberate and unchanged: parent hops stay
    allowed, so a symlinked artifacts directory or macOS's /var still works.
    What is closed here is separate from that policy - the gap between checking
    a name and using it. lstat names one directory and resolve() re-walks the
    same name afterwards, so a prior sweep that renames its results root and
    drops a symlink in its place is resolved to somewhere else entirely, and
    O_NOFOLLOW on the open cannot see a link that resolve() already followed.

    Comparing the opened descriptor's identity to the checked one costs an
    fstat and rejects nothing that holds still: a stable directory always
    matches itself. It matters for reuse specifically because the failure is
    silent - rows would be copied out of the wrong directory and folded into a
    comparator baseline as though they were this sweep's own evidence.
    """

    resolved, expected = _resolved_directory(path, label=label)
    with _open_real_directory(resolved, label=label) as fd:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != expected:
            raise SandboxError(f"{label} was replaced between the check and the open: {resolved}")
        yield fd


def _copy_transcript_artifact(source_fd: int, dest_fd: int, metadata: Mapping[str, Any]) -> dict[str, Any]:
    relative, expected_digest, expected_size = _transcript_metadata(metadata)
    name = PurePosixPath(relative).name
    # Both `transcripts` components are opened as descriptors, not checked as
    # names. An lstat that passes and a pathname that is used afterwards are two
    # different directories whenever a concurrent writer renames the first one
    # away — which the reuse directory, written by a prior sweep, invites.
    with (
        _open_real_directory("transcripts", dir_fd=dest_fd, label="transcript destination", create=True) as dest_dir_fd,
        _open_real_directory("transcripts", dir_fd=source_fd, label="transcript source") as source_dir_fd,
    ):
        os.fchmod(dest_dir_fd, 0o700)
        # One descriptor for the whole transfer, and ONE read of it. Hashing the
        # source and then reading it again to copy leaves the recorded digest
        # describing bytes that are not the bytes written: the descriptor stops
        # the pathname being substituted, not the inode being rewritten, and
        # this directory belongs to a sweep that may still be writing. Digest
        # what is copied, then judge it.
        with _open_regular(name, dir_fd=source_dir_fd, label="transcript") as artifact_fd:
            digest, copied_bytes = _copy_owner_only(
                artifact_fd, name, dir_fd=dest_dir_fd, max_bytes=expected_size
            )
            if copied_bytes != expected_size or digest != expected_digest:
                # The destination now holds bytes no expectation vouches for.
                os.unlink(name, dir_fd=dest_dir_fd)
                drift = "size" if copied_bytes != expected_size else "digest"
                raise SandboxError(f"reused transcript {drift} drifted: {relative}")
    return {"path": relative, "sha256": digest, "bytes": expected_size, "source": PARENT_EVENT_STREAM_SOURCE}


def _copy_named_artifact(source_fd: int, dest_fd: int, name: str, *, label: str) -> None:
    relative = PurePosixPath(name)
    if relative.is_absolute() or len(relative.parts) != 1 or relative.parts[0] in {"", ".", ".."}:
        raise SandboxError(f"unsafe {label} path: {name!r}")
    with _open_regular(name, dir_fd=source_fd, label=label) as artifact_fd:
        # No expectation is recorded for these, so the digest is discarded - but
        # "no recorded size" is not "no limit". The source is a prior sweep
        # directory that can change between sweeps, so a replaced artifact could
        # be arbitrarily large; MAX_TRANSCRIPT_BYTES is the ceiling the capture
        # path already enforces on evidence of this kind.
        _, copied = _copy_owner_only(artifact_fd, name, dir_fd=dest_fd, max_bytes=MAX_TRANSCRIPT_BYTES)
        if copied > MAX_TRANSCRIPT_BYTES:
            os.unlink(name, dir_fd=dest_fd)
            raise SandboxError(f"reused {label} exceeds {MAX_TRANSCRIPT_BYTES} bytes: {name}")


def _require_openat() -> None:
    """openat is what makes a checked directory and a used directory the same one.

    Without it the only alternative is to re-walk the name after the check,
    which is exactly the race this module is guarding. Refusing is safe: the
    caller in runner treats a SandboxError from reuse as "run a paid cell", so
    a platform without openat pays for the cells rather than copying through a
    directory nobody verified. The sweep itself is Linux-only anyway (bwrap,
    /proc/uptime); this is about the unit tests and about failing loudly.
    """

    if os.open not in os.supports_dir_fd or os.lstat not in os.supports_dir_fd:
        raise SandboxError("comparator reuse requires POSIX openat support (os.supports_dir_fd)")


def _is_regular_at(name: str, *, dir_fd: int) -> bool:
    """True when `name` under the pinned directory is a regular non-symlink file."""

    try:
        metadata = os.lstat(name, dir_fd=dir_fd)
    except OSError:
        return False
    return stat.S_ISREG(metadata.st_mode)


@contextmanager
def _open_real_directory(
    path: Path | str,
    *,
    dir_fd: int | None = None,
    label: str,
    create: bool = False,
) -> Iterator[int]:
    """Open one directory that is not a symlink, and hold it for every use below.

    ``O_DIRECTORY | O_NOFOLLOW`` makes the check and the open a single syscall,
    so unlike an ``lstat`` followed by a path, there is no window in which the
    directory can be replaced. ``_resolved_directory`` still tolerates a
    symlinked reuse ROOT — it hands this function the already-resolved path —
    but every component below it is pinned.
    """

    _require_openat()
    if create:
        try:
            os.mkdir(path, 0o700, dir_fd=dir_fd)
        except FileExistsError:
            # Already there is the ordinary case — a second artifact from the
            # same row. What it already IS still has to be proven, and the
            # O_DIRECTORY|O_NOFOLLOW open below is what proves it, so there is
            # nothing to do here.
            pass
        except OSError as exc:
            raise SandboxError(f"{label} cannot be created: {path}: {exc}") from exc
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=dir_fd,
        )
    except FileNotFoundError as exc:
        # Absent is a different fact from present-but-not-a-real-directory, and
        # the caller falls through to a paid cell on either.
        raise SandboxError(f"{label} is missing: {path}") from exc
    except OSError as exc:
        raise SandboxError(f"{label} must be a real directory: {path}: {exc}") from exc
    try:
        # O_DIRECTORY is the check on Linux; the fstat covers a platform whose
        # os module does not define it, where the flag degrades to 0.
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise SandboxError(f"{label} must be a real directory: {path}")
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _open_regular(name: str, *, dir_fd: int, label: str) -> Iterator[int]:
    """Open a regular non-symlink file under a pinned directory, and hold it.

    Checking a name and then re-opening it is a race the reuse directory is
    exposed to: it is written by a previous sweep and read by this one, so a
    concurrent writer can replace a validated file with a symlink in between.
    Resolving against ``dir_fd`` removes the directory half, ``O_NOFOLLOW``
    refuses the leaf link, and the fstat comparison proves the open descriptor
    is the inode that was checked — the same guarantee
    evolution._bounded_regular_bytes makes for evidence files.
    """

    _require_openat()
    try:
        before = os.lstat(name, dir_fd=dir_fd)
    except OSError as exc:
        raise SandboxError(f"{label} is missing: {name}: {exc}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise SandboxError(f"{label} must be a regular non-symlink file: {name}")
    try:
        descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=dir_fd)
    except OSError as exc:
        raise SandboxError(f"{label} is unreadable: {name}: {exc}") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise SandboxError(f"{label} changed while opening: {name}")
        yield descriptor
    finally:
        os.close(descriptor)


def _copy_owner_only(source: int, name: str, *, dir_fd: int, max_bytes: int | None = None) -> tuple[str, int]:
    """Copy one open file into the pinned directory; return what was written.

    The digest is taken from the same buffers that are written, so it describes
    the copy rather than a state the source was in at some earlier read.

    ``max_bytes`` bounds the copy itself. The source is a prior sweep directory
    this module already treats as concurrently writable, so a transcript
    appended to after its metadata was recorded would otherwise be streamed to
    EOF and only then compared against its declared size - filling the
    destination, or never reaching EOF at all, long before the drift check could
    reject it. Stopping one byte past the ceiling keeps that comparison
    meaningful while bounding the work.
    """

    # O_CREAT|O_EXCL is the existence check, and unlike a stat beforehand it is
    # atomic: a file appearing between check and open cannot slip through.
    try:
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=dir_fd,
        )
    except FileExistsError as exc:
        raise SandboxError(f"reuse destination already exists: {name}") from exc
    try:
        os.fchmod(descriptor, 0o600)
        os.lseek(source, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        written = 0
        limit = None if max_bytes is None else max_bytes + 1
        while True:
            want = COPY_CHUNK_BYTES if limit is None else min(COPY_CHUNK_BYTES, limit - written)
            if want <= 0:
                break
            chunk = os.read(source, want)
            if not chunk:
                break
            digest.update(chunk)
            written += len(chunk)
            _write_all(descriptor, chunk)
        os.fsync(descriptor)
        return digest.hexdigest(), written
    finally:
        os.close(descriptor)
