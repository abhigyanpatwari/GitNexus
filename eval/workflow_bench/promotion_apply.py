"""Evidence-bound, transactional application of promoted skill overlays."""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import secrets
import shutil
import stat
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .evolution import MAX_CANDIDATE_OVERLAY_BYTES, candidate_overlay_payload
from .process_control import run_managed

# Shipped byte-identical mirrors of .claude/skills/<name> (see
# gitnexus/test/unit/shipped-skills-sync.test.ts — the drift guard).
MIRROR_SKILL_ROOTS = ("gitnexus/skills", "gitnexus-claude-plugin/skills")
REPO_ROOT = Path(__file__).resolve().parents[2]


class _StagingCleanupError(RuntimeError):
    """A staged name still needs transaction-owned cleanup/recovery."""

    def __init__(self, name: str, failure: BaseException, cleanup: BaseException) -> None:
        self.name = name
        super().__init__(
            f"staging failed ({type(failure).__name__}: {failure}) and cleanup failed "
            f"({type(cleanup).__name__}: {cleanup})"
        )


def mirror_targets(relative: PurePosixPath) -> list[PurePosixPath]:
    """Every repo path one overlay file lands on: canonical + shipped mirrors."""
    skill = relative.parts[2]
    rest = PurePosixPath(*relative.parts[3:])
    targets = [relative]
    targets += [PurePosixPath(root, skill, rest) for root in MIRROR_SKILL_ROOTS]
    return targets


def freeze_overlay(overlay: Path, destination: Path) -> str:
    """Copy authorized bytes into a private, read-only benchmark snapshot."""
    digest, payload = candidate_overlay_payload(overlay)
    destination = destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"overlay snapshot destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".overlay-snapshot-", dir=destination.parent))
    try:
        for relative, content in payload:
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
            try:
                with os.fdopen(descriptor, "wb", closefd=False) as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
            finally:
                os.close(descriptor)
        for directory in sorted(
            (path for path in staging.rglob("*") if path.is_dir()),
            key=lambda path: len(path.parts),
            reverse=True,
        ):
            directory.chmod(0o500)
        staging.chmod(0o500)
        os.replace(staging, destination)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    frozen_digest, _ = candidate_overlay_payload(destination)
    if frozen_digest != digest:
        raise RuntimeError("frozen overlay bytes do not match the authorized input")
    return digest


def _stage_replacement(path: Path, content: bytes, mode: int) -> Path:
    descriptor, raw_path = tempfile.mkstemp(prefix=".wfevolve-", dir=path.parent)
    staged = Path(raw_path)
    try:
        os.fchmod(descriptor, stat.S_IMODE(mode))
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        # A partially written candidate/backup is never eligible for later
        # cleanup through the replacements list, so remove it here before the
        # staging exception escapes.
        os.close(descriptor)
        staged.unlink(missing_ok=True)
        raise
    else:
        os.close(descriptor)
    return staged


def _read_destination(path: Path, *, target: PurePosixPath) -> tuple[bytes, int]:
    """Read one mirror without following links and reject concurrent mutation."""

    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"overlay destination must already be a regular file: {target}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError(f"overlay destination must already be a regular file: {target}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"overlay destination must already be a regular file: {target}")
        chunks: list[bytes] = []
        while chunk := os.read(descriptor, 64 * 1024):
            chunks.append(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        final = path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"overlay destination changed while being read: {target}") from exc

    def identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
        return (
            value.st_dev,
            value.st_ino,
            value.st_size,
            value.st_mtime_ns,
            stat.S_IMODE(value.st_mode),
        )

    if (
        stat.S_ISLNK(final.st_mode)
        or not stat.S_ISREG(final.st_mode)
        or not (identity(before) == identity(opened) == identity(after) == identity(final))
    ):
        raise ValueError(f"overlay destination changed while being read: {target}")
    return b"".join(chunks), opened.st_mode


def _open_repository_root(repo_root: Path) -> tuple[Path, int]:
    root = repo_root.expanduser().absolute()
    try:
        metadata = root.lstat()
        resolved = root.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"repository root is unavailable: {root}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"repository root must be a real directory: {root}")
    if resolved != root:
        raise ValueError(f"repository root must not traverse symlinks: {root}")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(root, flags)
    except OSError as exc:
        raise ValueError(f"repository root changed while opening: {root}") from exc
    try:
        opened = os.fstat(descriptor)
        final = root.lstat()
        final_resolved = root.resolve(strict=True)

        def identity(value: os.stat_result) -> tuple[int, int, int]:
            return value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode)

        if (
            stat.S_ISLNK(final.st_mode)
            or not stat.S_ISDIR(opened.st_mode)
            or not stat.S_ISDIR(final.st_mode)
            or final_resolved != root
            or not (identity(metadata) == identity(opened) == identity(final))
        ):
            raise ValueError(f"repository root changed while opening: {root}")
    except OSError as exc:
        os.close(descriptor)
        raise ValueError(f"repository root changed while opening: {root}") from exc
    except BaseException:
        os.close(descriptor)
        raise
    return root, descriptor


def _open_target_parent(root_descriptor: int, target: PurePosixPath) -> int:
    if target.is_absolute() or not target.parts or ".." in target.parts:
        raise ValueError(f"overlay destination escapes repository: {target}")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    current = os.dup(root_descriptor)
    try:
        for part in target.parts[:-1]:
            try:
                metadata = os.stat(part, dir_fd=current, follow_symlinks=False)
            except OSError as exc:
                raise ValueError(f"overlay destination parent is unavailable: {target}") from exc
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise ValueError(f"overlay destination parent must not be a symlink: {target}")
            try:
                child = os.open(part, flags, dir_fd=current)
            except OSError as exc:
                raise ValueError(f"overlay destination parent changed while opening: {target}") from exc
            opened = os.fstat(child)
            if (
                opened.st_dev,
                opened.st_ino,
                stat.S_IFMT(opened.st_mode),
            ) != (
                metadata.st_dev,
                metadata.st_ino,
                stat.S_IFMT(metadata.st_mode),
            ):
                os.close(child)
                raise ValueError(f"overlay destination parent changed while opening: {target}")
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def _directory_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode)


def _validate_repository_root_binding(root: Path, root_descriptor: int, *, phase: str) -> None:
    """Prove the held root still names the repository's lexical directory."""

    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        lexical = root.lstat()
        resolved = root.resolve(strict=True)
        reopened = os.open(root, flags)
    except OSError as exc:
        raise ValueError(f"repository root changed during overlay {phase}: {root}") from exc
    try:
        opened = os.fstat(reopened)
        held = os.fstat(root_descriptor)
        if (
            stat.S_ISLNK(lexical.st_mode)
            or not stat.S_ISDIR(lexical.st_mode)
            or resolved != root
            or not stat.S_ISDIR(opened.st_mode)
            or not stat.S_ISDIR(held.st_mode)
            or _directory_identity(lexical) != _directory_identity(opened)
            or _directory_identity(opened) != _directory_identity(held)
        ):
            raise ValueError(f"repository root changed during overlay {phase}: {root}")
    finally:
        os.close(reopened)


def _validate_prepared_paths(
    root: Path,
    root_descriptor: int,
    prepared: list[dict[str, Any]],
    *,
    phase: str,
) -> None:
    """Rebind every held parent descriptor to its current lexical repo path."""

    _validate_repository_root_binding(root, root_descriptor, phase=phase)
    for item in prepared:
        reopened = _open_target_parent(root_descriptor, item["target"])
        try:
            if _directory_identity(os.fstat(reopened)) != _directory_identity(os.fstat(item["parent_descriptor"])):
                raise ValueError(f"overlay destination parent changed during {phase}: {item['target']}")
        finally:
            os.close(reopened)
    # Catch a repository-root replacement that raced the parent walk itself.
    _validate_repository_root_binding(root, root_descriptor, phase=phase)


def _read_destination_at(
    parent_descriptor: int,
    name: str,
    *,
    target: PurePosixPath,
) -> tuple[bytes, int]:
    try:
        before = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError as exc:
        raise ValueError(f"overlay destination must already be a regular file: {target}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError(f"overlay destination must already be a regular file: {target}")
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent_descriptor,
    )
    try:
        opened = os.fstat(descriptor)
        chunks: list[bytes] = []
        while chunk := os.read(descriptor, 64 * 1024):
            chunks.append(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        final = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError as exc:
        raise ValueError(f"overlay destination changed while being read: {target}") from exc

    def identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
        return (
            value.st_dev,
            value.st_ino,
            value.st_size,
            value.st_mtime_ns,
            stat.S_IMODE(value.st_mode),
        )

    if (
        not stat.S_ISREG(opened.st_mode)
        or stat.S_ISLNK(final.st_mode)
        or not stat.S_ISREG(final.st_mode)
        or not (identity(before) == identity(opened) == identity(after) == identity(final))
    ):
        raise ValueError(f"overlay destination changed while being read: {target}")
    return b"".join(chunks), opened.st_mode


def _stage_replacement_at(parent_descriptor: int, content: bytes, mode: int) -> str:
    for _ in range(100):
        name = f".wfevolve-{secrets.token_hex(16)}"
        try:
            descriptor = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                stat.S_IMODE(mode),
                dir_fd=parent_descriptor,
            )
        except FileExistsError:
            continue
        try:
            os.fchmod(descriptor, stat.S_IMODE(mode))
            view = memoryview(content)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short write while staging overlay replacement")
                view = view[written:]
            os.fsync(descriptor)
        except BaseException as exc:
            os.close(descriptor)
            try:
                os.unlink(name, dir_fd=parent_descriptor)
                os.fsync(parent_descriptor)
            except OSError as cleanup_exc:
                raise _StagingCleanupError(name, exc, cleanup_exc) from exc
            raise
        else:
            os.close(descriptor)
            try:
                os.fsync(parent_descriptor)
            except OSError as exc:
                try:
                    os.unlink(name, dir_fd=parent_descriptor)
                    os.fsync(parent_descriptor)
                except OSError as cleanup_exc:
                    raise _StagingCleanupError(name, exc, cleanup_exc) from exc
                raise
            return name
    raise FileExistsError("could not allocate a unique overlay staging file")


def _temporary_exists(parent_descriptor: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _unlink_temporary(parent_descriptor: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=parent_descriptor)
    except FileNotFoundError:
        return
    os.fsync(parent_descriptor)


def _entry_identity_at(parent_descriptor: int, name: str) -> tuple[int, int, int, int, int, int]:
    metadata = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        metadata.st_size,
        metadata.st_mtime_ns,
        stat.S_IMODE(metadata.st_mode),
    )


def _same_entry(
    left: tuple[int, int, int, int, int, int],
    right: tuple[int, int, int, int, int, int],
) -> bool:
    return left[:2] == right[:2]


_RENAME_EXCHANGE = 2


def _exchange_at(parent_descriptor: int, left: str, right: str) -> None:
    """Atomically exchange two existing names in one held directory."""

    try:
        renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    except AttributeError as exc:
        raise RuntimeError("atomic overlay exchange is unavailable on this platform") from exc
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if (
        renameat2(
            parent_descriptor,
            os.fsencode(left),
            parent_descriptor,
            os.fsencode(right),
            _RENAME_EXCHANGE,
        )
        == 0
    ):
        os.fsync(parent_descriptor)
        return
    error = ctypes.get_errno()
    if error in {errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP}:
        raise RuntimeError("atomic overlay exchange is unavailable on this filesystem")
    raise OSError(error, os.strerror(error), f"{left} <-> {right}")


def _prepare_targets(
    payload: list[tuple[PurePosixPath, bytes]],
    repo_root: Path,
) -> tuple[Path, int, list[dict[str, Any]]]:
    """Resolve and snapshot every canonical/shipped destination exactly once."""

    root, root_descriptor = _open_repository_root(repo_root)
    prepared: list[dict[str, Any]] = []
    seen: set[PurePosixPath] = set()
    try:
        for relative, content in payload:
            for target in mirror_targets(relative):
                if target in seen:
                    raise ValueError(f"duplicate overlay destination: {target}")
                seen.add(target)
                parent_descriptor = _open_target_parent(root_descriptor, target)
                try:
                    original, mode = _read_destination_at(
                        parent_descriptor,
                        target.name,
                        target=target,
                    )
                except BaseException:
                    os.close(parent_descriptor)
                    raise
                prepared.append(
                    {
                        "target": target,
                        "destination": root / target,
                        "parent_path": root / target.parent,
                        "parent_descriptor": parent_descriptor,
                        "name": target.name,
                        "content": content,
                        "original": original,
                        "base_digest": hashlib.sha256(original).hexdigest(),
                        "mode": mode,
                    }
                )
        _validate_prepared_paths(
            root,
            root_descriptor,
            prepared,
            phase="preparation",
        )
        return root, root_descriptor, prepared
    except BaseException:
        for item in prepared:
            os.close(item["parent_descriptor"])
        os.close(root_descriptor)
        raise


def _close_prepared(root_descriptor: int, prepared: list[dict[str, Any]]) -> None:
    try:
        for item in prepared:
            os.close(item["parent_descriptor"])
    finally:
        os.close(root_descriptor)


def destination_base_digests(
    overlay: Path,
    repo_root: Path = REPO_ROOT,
) -> dict[str, str]:
    """Bind promotion evidence to the current bytes of every apply target."""

    _, payload = candidate_overlay_payload(overlay)
    root, root_descriptor, prepared = _prepare_targets(payload, repo_root)
    try:
        _validate_prepared_paths(
            root,
            root_descriptor,
            prepared,
            phase="base-digest capture",
        )
        return {item["target"].as_posix(): item["base_digest"] for item in prepared}
    finally:
        _close_prepared(root_descriptor, prepared)


def committed_destination_base_digests(
    overlay: Path,
    repo_root: Path = REPO_ROOT,
    *,
    ref: str = "HEAD",
) -> dict[str, str]:
    """Bind targets to one immutable committed incumbent, never live edits."""

    _, payload = candidate_overlay_payload(overlay)
    root, root_descriptor = _open_repository_root(repo_root)
    os.close(root_descriptor)
    rev = run_managed(
        ["git", "-C", str(root), "rev-parse", f"{ref}^{{commit}}"],
        timeout=60,
        capture_stdout_bytes=256,
    )
    if not rev.ok or rev.stdout_capture_overflow or rev.stdout_capture is None:
        raise ValueError("could not resolve the committed promotion base")
    commit = rev.stdout_capture.decode("ascii", errors="strict").strip()
    if not commit or any(character not in "0123456789abcdefABCDEF" for character in commit):
        raise ValueError("committed promotion base is not an immutable object id")
    bindings: dict[str, str] = {}
    for relative, _content in payload:
        for target in mirror_targets(relative):
            key = target.as_posix()
            if key in bindings:
                raise ValueError(f"duplicate overlay destination: {target}")
            result = run_managed(
                ["git", "-C", str(root), "show", f"{commit}:{key}"],
                timeout=60,
                capture_stdout_bytes=MAX_CANDIDATE_OVERLAY_BYTES + 1,
            )
            if not result.ok or result.stdout_capture_overflow or result.stdout_capture is None:
                raise ValueError(f"committed overlay destination is unavailable: {target}")
            bindings[key] = hashlib.sha256(result.stdout_capture).hexdigest()
    return bindings


def _write_recovery_artifact(
    root_descriptor: int,
    repo_root: Path,
    *,
    failure: BaseException,
    rollback_failures: list[str],
    replacements: list[dict[str, Any]],
    transaction_state: str,
) -> Path:
    recovery_name = ".wfbench-overlay-recovery-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ") + ".json"

    def descriptor_path(descriptor: int, fallback: Path) -> Path:
        try:
            return Path(os.readlink(f"/proc/self/fd/{descriptor}"))
        except OSError:
            return fallback

    root_path = descriptor_path(root_descriptor, repo_root)
    records = []
    for replacement in replacements:
        parent = descriptor_path(replacement["parent_descriptor"], replacement["parent_path"])
        candidate_exists = _temporary_exists(replacement["parent_descriptor"], replacement["candidate"])
        backup = replacement.get("backup")
        backup_exists = backup is not None and _temporary_exists(replacement["parent_descriptor"], backup)
        if candidate_exists or backup_exists:
            records.append(
                {
                    "target": replacement["target"].as_posix(),
                    "destination": str(parent / replacement["name"]),
                    "candidate": str(parent / replacement["candidate"]),
                    "candidate_exists": candidate_exists,
                    "backup": str(parent / backup) if backup is not None else None,
                    "backup_exists": backup_exists,
                }
            )

    descriptor = os.open(
        recovery_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
        dir_fd=root_descriptor,
    )
    payload = {
        "failure": f"{type(failure).__name__}: {failure}",
        "transaction_state": transaction_state,
        "rollback_failures": rollback_failures,
        "backups": records,
    }
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    os.fsync(root_descriptor)
    return root_path / recovery_name


def apply_promoted_overlay(
    overlay: Path,
    repo_root: Path = REPO_ROOT,
    *,
    expected_digest: str | None = None,
    expected_target_bases: dict[str, str] | None = None,
) -> list[str]:
    """Compare-and-swap one evidence-bound overlay across every mirror."""
    digest, payload = candidate_overlay_payload(overlay)
    if expected_digest is not None and digest != expected_digest:
        raise ValueError("candidate overlay digest no longer matches promotion evidence")

    repo_root, root_descriptor, prepared = _prepare_targets(payload, repo_root)
    current_bases = {item["target"].as_posix(): item["base_digest"] for item in prepared}
    if expected_target_bases is not None and expected_target_bases != current_bases:
        expected_paths = set(expected_target_bases)
        current_paths = set(current_bases)
        missing = sorted(current_paths - expected_paths)
        unexpected = sorted(expected_paths - current_paths)
        drifted = sorted(
            path for path in current_paths & expected_paths if current_bases[path] != expected_target_bases[path]
        )
        details = []
        if missing:
            details.append("missing=" + ",".join(missing))
        if unexpected:
            details.append("unexpected=" + ",".join(unexpected))
        if drifted:
            details.append("drifted=" + ",".join(drifted))
        _close_prepared(root_descriptor, prepared)
        raise ValueError("overlay destination base binding mismatch: " + "; ".join(details))

    replacements: list[dict[str, Any]] = []
    completed: list[dict[str, Any]] = []
    preserve_backups = False
    published_all = False
    rollback_complete = False

    def entry_state(replacement: dict[str, Any], name: str) -> tuple[str, int]:
        current, mode = _read_destination_at(
            replacement["parent_descriptor"],
            name,
            target=replacement["target"],
        )
        return hashlib.sha256(current).hexdigest(), stat.S_IMODE(mode)

    def current_state(replacement: dict[str, Any]) -> tuple[str, int]:
        return entry_state(replacement, replacement["name"])

    def candidate_is_intact(replacement: dict[str, Any], name: str) -> bool:
        try:
            identity = _entry_identity_at(replacement["parent_descriptor"], name)
            state = entry_state(replacement, name)
        except (OSError, ValueError):
            return False
        return identity == replacement["candidate_identity"] and state == replacement["candidate_state"]

    def rollback_exchange_is_valid(
        replacement: dict[str, Any],
        displaced_identity: tuple[int, int, int, int, int, int],
        displaced_state: tuple[str, int] | None,
    ) -> bool:
        try:
            destination_identity = _entry_identity_at(
                replacement["parent_descriptor"],
                replacement["name"],
            )
            if destination_identity != displaced_identity:
                return False
            if displaced_state is not None and current_state(replacement) != displaced_state:
                return False
            return candidate_is_intact(replacement, replacement["candidate"])
        except (OSError, ValueError):
            return False

    try:
        for item in prepared:
            try:
                candidate = _stage_replacement_at(item["parent_descriptor"], item["content"], item["mode"])
            except _StagingCleanupError as stage_exc:
                replacements.append(
                    {
                        **item,
                        "candidate": stage_exc.name,
                        "backup": None,
                        "candidate_identity": None,
                    }
                )
                raise
            replacement = {
                **item,
                "candidate": candidate,
                "backup": None,
                "candidate_digest": hashlib.sha256(item["content"]).hexdigest(),
                "base_state": (item["base_digest"], stat.S_IMODE(item["mode"])),
                "candidate_state": (
                    hashlib.sha256(item["content"]).hexdigest(),
                    stat.S_IMODE(item["mode"]),
                ),
                "candidate_identity": None,
            }
            replacements.append(replacement)
            replacement["candidate_identity"] = _entry_identity_at(item["parent_descriptor"], candidate)
            try:
                replacement["backup"] = _stage_replacement_at(
                    item["parent_descriptor"],
                    item["original"],
                    item["mode"],
                )
            except _StagingCleanupError as stage_exc:
                replacement["backup"] = stage_exc.name
                raise
        # Recheck the entire compare set after staging and before the first
        # replacement, then check each member immediately before its swap.
        _validate_prepared_paths(
            repo_root,
            root_descriptor,
            replacements,
            phase="pre-publication",
        )
        for replacement in replacements:
            if current_state(replacement) != replacement["base_state"]:
                raise ValueError(f"overlay destination drifted before apply: {replacement['target']}")
        for replacement in replacements:
            _validate_prepared_paths(
                repo_root,
                root_descriptor,
                [replacement],
                phase="publication",
            )
            if current_state(replacement) != replacement["base_state"]:
                raise ValueError(f"overlay destination drifted during apply: {replacement['target']}")
            previous_identity = _entry_identity_at(
                replacement["parent_descriptor"],
                replacement["name"],
            )
            replacement["publication_previous_identity"] = previous_identity
            try:
                _exchange_at(
                    replacement["parent_descriptor"],
                    replacement["candidate"],
                    replacement["name"],
                )
            except BaseException:
                # A wrapper/interruption can raise after the atomic exchange.
                # Classify by inode movement so a raced edit in the displaced
                # slot cannot be mistaken for an exchange that never landed.
                try:
                    destination_identity = _entry_identity_at(
                        replacement["parent_descriptor"],
                        replacement["name"],
                    )
                    temporary_identity = _entry_identity_at(
                        replacement["parent_descriptor"],
                        replacement["candidate"],
                    )
                except OSError:
                    completed.append(replacement)
                else:
                    if _same_entry(destination_identity, replacement["candidate_identity"]) or not _same_entry(
                        temporary_identity,
                        replacement["candidate_identity"],
                    ):
                        completed.append(replacement)
                raise
            else:
                completed.append(replacement)
            observed_destination = current_state(replacement)
            observed_previous = entry_state(replacement, replacement["candidate"])
            destination_identity = _entry_identity_at(
                replacement["parent_descriptor"],
                replacement["name"],
            )
            displaced_identity = _entry_identity_at(
                replacement["parent_descriptor"],
                replacement["candidate"],
            )
            if (
                observed_destination == replacement["candidate_state"]
                and observed_previous == replacement["base_state"]
                and destination_identity == replacement["candidate_identity"]
                and displaced_identity == previous_identity
            ):
                continue
            raise RuntimeError(f"atomic overlay exchange parity check failed: {replacement['target']}")
        for replacement in replacements:
            if (
                current_state(replacement) != replacement["candidate_state"]
                or entry_state(replacement, replacement["candidate"]) != replacement["base_state"]
                or _entry_identity_at(replacement["parent_descriptor"], replacement["name"])
                != replacement["candidate_identity"]
                or _entry_identity_at(replacement["parent_descriptor"], replacement["candidate"])
                != replacement["publication_previous_identity"]
            ):
                raise RuntimeError(f"post-apply parity check failed: {replacement['target']}")
        _validate_prepared_paths(
            repo_root,
            root_descriptor,
            replacements,
            phase="post-apply validation",
        )
        published_all = True
    except BaseException as exc:
        rollback_failures: list[str] = []
        for replacement in reversed(completed):
            try:
                destination_identity = _entry_identity_at(
                    replacement["parent_descriptor"],
                    replacement["name"],
                )
                temporary_identity = _entry_identity_at(
                    replacement["parent_descriptor"],
                    replacement["candidate"],
                )
            except BaseException as rollback_exc:
                rollback_failures.append(
                    f"{replacement['target']}: cannot inspect exchange state: "
                    f"{type(rollback_exc).__name__}: {rollback_exc}"
                )
                continue
            candidate_at_temporary = candidate_is_intact(replacement, replacement["candidate"])
            candidate_at_destination = candidate_is_intact(replacement, replacement["name"])
            if candidate_at_temporary and candidate_at_destination:
                rollback_failures.append(
                    f"{replacement['target']}: candidate inode is linked at both destination and temporary name"
                )
                continue
            if candidate_at_temporary:
                continue
            if not candidate_at_destination:
                rollback_failures.append(f"{replacement['target']}: destination changed after apply")
                continue
            try:
                displaced_state: tuple[str, int] | None = entry_state(replacement, replacement["candidate"])
            except (OSError, ValueError):
                displaced_state = None
            try:
                _exchange_at(
                    replacement["parent_descriptor"],
                    replacement["candidate"],
                    replacement["name"],
                )
            except BaseException as rollback_exc:
                if not rollback_exchange_is_valid(replacement, temporary_identity, displaced_state):
                    rollback_failures.append(f"{replacement['target']}: {type(rollback_exc).__name__}: {rollback_exc}")
            else:
                if not rollback_exchange_is_valid(replacement, temporary_identity, displaced_state):
                    rollback_failures.append(f"{replacement['target']}: rollback parity check failed")
        if rollback_failures:
            preserve_backups = True
            recovery = _write_recovery_artifact(
                root_descriptor,
                repo_root,
                failure=exc,
                rollback_failures=rollback_failures,
                replacements=replacements,
                transaction_state="rollback-incomplete",
            )
            raise RuntimeError(f"overlay apply failed and rollback was incomplete; recovery: {recovery}") from exc
        rollback_complete = True
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        raise RuntimeError("overlay apply failed and all replacements were rolled back") from exc
    finally:
        active_failure = sys.exc_info()[1]
        try:
            if not preserve_backups:
                cleanup_failures: list[str] = []
                cleanup_exception: BaseException | None = None
                for replacement in replacements:
                    for temporary in (replacement["candidate"], replacement["backup"]):
                        if temporary is None:
                            continue
                        try:
                            _unlink_temporary(replacement["parent_descriptor"], temporary)
                        except BaseException as cleanup_exc:
                            cleanup_exception = cleanup_exc
                            cleanup_failures.append(
                                f"{replacement['target']}:{temporary}: {type(cleanup_exc).__name__}: {cleanup_exc}"
                            )
                            break
                    if cleanup_failures:
                        break
                if cleanup_failures:
                    preserve_backups = True
                    transaction_state = (
                        "published" if published_all else "rolled-back" if rollback_complete else "not-fully-published"
                    )
                    cleanup_failure = RuntimeError(
                        f"overlay transaction is {transaction_state}, but temporary cleanup was incomplete"
                    )
                    try:
                        recovery = _write_recovery_artifact(
                            root_descriptor,
                            repo_root,
                            failure=active_failure or cleanup_failure,
                            rollback_failures=cleanup_failures,
                            replacements=replacements,
                            transaction_state=transaction_state,
                        )
                    except BaseException as recovery_exc:
                        cleanup_failure.add_note(
                            f"recovery artifact creation also failed: {type(recovery_exc).__name__}: {recovery_exc}"
                        )
                    else:
                        cleanup_failure = RuntimeError(f"{cleanup_failure}; recovery: {recovery}")
                    interrupt = active_failure if isinstance(active_failure, (KeyboardInterrupt, SystemExit)) else None
                    if interrupt is None and isinstance(cleanup_exception, (KeyboardInterrupt, SystemExit)):
                        interrupt = cleanup_exception
                    if interrupt is not None:
                        interrupt.add_note(str(cleanup_failure))
                        raise interrupt
                    raise cleanup_failure from active_failure
        finally:
            _close_prepared(root_descriptor, prepared)
    return [replacement["target"].as_posix() for replacement in replacements]
