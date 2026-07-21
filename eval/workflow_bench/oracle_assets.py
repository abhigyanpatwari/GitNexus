"""Immutable, harness-owned hidden behavioral oracles for workflow tasks."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import shutil
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from .process_control import run_checked, run_managed


ORACLE_ROOT = Path(__file__).resolve().parent / "oracles"
MAX_ORACLE_FILES = 8
MAX_ORACLE_FILE_BYTES = 512 * 1024
MAX_ORACLE_TOTAL_BYTES = 2 * 1024 * 1024
MAX_ORACLE_PATH_BYTES = 240
MAX_ORACLE_COMMAND_BYTES = 8 * 1024
ORACLE_ENV_VAR = "GITNEXUS_BENCH_ORACLE_ROOT"
HIDDEN_HARNESS_PATH = PurePosixPath("eval/workflow_bench")
MAX_CLONE_REFS = 1024
MAX_CLONE_REF_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class OracleFileSnapshot:
    """One bounded oracle file captured by the harness before any model run."""

    target: str
    payload: bytes
    sha256: str


@dataclass(frozen=True)
class TaskOracleSnapshot:
    """Immutable oracle bytes and command for one selected task."""

    command: str
    command_digest: str
    manifest_digest: str
    digest: str
    files: tuple[OracleFileSnapshot, ...]

    @property
    def binding(self) -> dict[str, Any]:
        return {
            "oracle_digest": self.digest,
            "oracle_command_digest": self.command_digest,
            "oracle_manifest_digest": self.manifest_digest,
            "oracle_files": [
                {"target": item.target, "sha256": item.sha256, "size": len(item.payload)} for item in self.files
            ],
        }


def _hash_frames(*frames: bytes) -> str:
    digest = hashlib.sha256()
    for frame in frames:
        digest.update(len(frame).to_bytes(8, "big"))
        digest.update(frame)
    return digest.hexdigest()


def _bounded_relative_path(value: Any, *, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a nonblank relative path")
    if "\\" in value or "\x00" in value or len(value.encode()) > MAX_ORACLE_PATH_BYTES:
        raise ValueError(f"{label} is not a bounded portable path: {value!r}")
    relative = PurePosixPath(value)
    if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError(f"{label} must not be absolute or traverse parents: {value!r}")
    if relative.parts[0] == ".git":
        raise ValueError(f"{label} cannot target git metadata: {value!r}")
    return relative


def validate_oracle_declaration(task: dict[str, Any]) -> None:
    """Validate the declarative shape without reading harness-owned files."""

    task_id = str(task.get("id", "<unknown>"))
    oracle = task.get("oracle")
    if not isinstance(oracle, dict) or set(oracle) != {"command", "files"}:
        raise ValueError(f"task {task_id} oracle requires exactly command and files")
    command = oracle.get("command")
    if (
        not isinstance(command, str)
        or not command.strip()
        or len(command.encode()) > MAX_ORACLE_COMMAND_BYTES
        or "\x00" in command
    ):
        raise ValueError(f"task {task_id} oracle command must be nonblank and bounded")
    files = oracle.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_ORACLE_FILES:
        raise ValueError(f"task {task_id} oracle files must contain 1..{MAX_ORACLE_FILES} entries")
    sources: set[str] = set()
    targets: set[str] = set()
    for index, declaration in enumerate(files):
        if not isinstance(declaration, dict) or set(declaration) != {"source", "target"}:
            raise ValueError(f"task {task_id} oracle file {index} requires exactly source and target")
        source = _bounded_relative_path(declaration.get("source"), label=f"task {task_id} oracle source")
        target = _bounded_relative_path(declaration.get("target"), label=f"task {task_id} oracle target")
        if source.as_posix() in sources:
            raise ValueError(f"task {task_id} oracle source is duplicated: {source}")
        if target.as_posix() in targets:
            raise ValueError(f"task {task_id} oracle target is duplicated: {target}")
        sources.add(source.as_posix())
        targets.add(target.as_posix())


def _real_oracle_root(root: Path) -> Path:
    lexical = root.expanduser().absolute()
    try:
        metadata = lexical.lstat()
        resolved = lexical.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"oracle root is unavailable: {lexical}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or resolved != lexical:
        raise ValueError(f"oracle root must be a real non-symlink directory: {lexical}")
    return lexical


def _read_oracle_file(root: Path, relative: PurePosixPath) -> bytes:
    current = root
    for part in relative.parts[:-1]:
        current /= part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise ValueError(f"oracle parent is unreadable: {relative}") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"oracle parents must be real directories: {relative}")

    path = root.joinpath(*relative.parts)
    try:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise ValueError(f"oracle source must be a bounded regular non-symlink file: {relative}")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError(f"oracle source is unreadable: {relative}") from exc
    try:
        opened = os.fstat(descriptor)
        if (
            stat.S_ISLNK(before.st_mode)
            or not stat.S_ISREG(before.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or before.st_dev != opened.st_dev
            or before.st_ino != opened.st_ino
            or opened.st_size > MAX_ORACLE_FILE_BYTES
        ):
            raise ValueError(f"oracle source must be a bounded regular non-symlink file: {relative}")
        chunks: list[bytes] = []
        remaining = MAX_ORACLE_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
        if len(payload) > MAX_ORACLE_FILE_BYTES or any(
            getattr(opened, field) != getattr(after, field) for field in stable_fields
        ):
            raise ValueError(f"oracle source changed while being captured: {relative}")
        return payload
    finally:
        os.close(descriptor)


def capture_task_oracle(task: dict[str, Any], *, root: Path = ORACLE_ROOT) -> TaskOracleSnapshot:
    """Capture and digest one task's hidden oracle before a model session."""

    validate_oracle_declaration(task)
    oracle_root = _real_oracle_root(root)
    oracle = task["oracle"]
    command = str(oracle["command"])
    snapshots: list[OracleFileSnapshot] = []
    total = 0
    for declaration in oracle["files"]:
        source = _bounded_relative_path(declaration["source"], label="oracle source")
        target = _bounded_relative_path(declaration["target"], label="oracle target").as_posix()
        payload = _read_oracle_file(oracle_root, source)
        total += len(payload)
        if total > MAX_ORACLE_TOTAL_BYTES:
            raise ValueError(f"task {task['id']} oracle exceeds the total byte limit")
        snapshots.append(
            OracleFileSnapshot(
                target=target,
                payload=payload,
                sha256=hashlib.sha256(payload).hexdigest(),
            )
        )
    snapshots.sort(key=lambda item: item.target)
    command_digest = hashlib.sha256(command.encode()).hexdigest()
    manifest_frames = [
        frame
        for item in snapshots
        for frame in (item.target.encode(), item.sha256.encode(), str(len(item.payload)).encode())
    ]
    manifest_digest = _hash_frames(*manifest_frames)
    digest_frames = [command.encode()]
    for item in snapshots:
        digest_frames.extend((item.target.encode(), item.payload))
    return TaskOracleSnapshot(
        command=command,
        command_digest=command_digest,
        manifest_digest=manifest_digest,
        digest=_hash_frames(*digest_frames),
        files=tuple(snapshots),
    )


def capture_task_oracles(tasks: list[dict[str, Any]], *, root: Path = ORACLE_ROOT) -> list[TaskOracleSnapshot]:
    return [capture_task_oracle(task, root=root) for task in tasks]


def _git_checked(
    clone: Path,
    args: list[str],
    *,
    timeout: float = 600,
    env: dict[str, str] | None = None,
) -> str:
    result = run_checked(
        ["git", "-C", str(clone), *args],
        timeout=timeout,
        tail_bytes=MAX_CLONE_REF_BYTES,
        env=env,
    )
    return result.stdout_tail.strip()


def sanitize_clone_for_hidden_oracles(clone: Path) -> str:
    """Remove the harness and its recoverable Git history from a disposable clone.

    A read-only mount over the checked-out harness is insufficient: a model
    could recover committed oracle bytes with ``git show``. Build a parentless
    commit from the clone's existing index after removing the complete harness,
    discard every other reference/reflog, and prune unreachable objects before
    any task asset, setup command, or model session is allowed to run.
    """

    root = clone.expanduser().absolute()
    try:
        root_metadata = root.lstat()
        git_metadata = (root / ".git").lstat()
    except OSError as exc:
        raise ValueError(f"oracle sanitization requires a self-contained clone: {root}") from exc
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or not stat.S_ISDIR(root_metadata.st_mode)
        or root.resolve(strict=True) != root
        or stat.S_ISLNK(git_metadata.st_mode)
        or not stat.S_ISDIR(git_metadata.st_mode)
    ):
        raise ValueError(f"oracle sanitization requires a real self-contained clone: {root}")

    original_head = _git_checked(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    if len(original_head) not in {40, 64} or any(
        character not in "0123456789abcdefABCDEF" for character in original_head
    ):
        raise ValueError("clone HEAD is not an immutable commit")

    hidden_tree_result = run_managed(
        [
            "git",
            "-C",
            str(root),
            "ls-tree",
            "-d",
            "--format=%(objectname)",
            "HEAD",
            "--",
            HIDDEN_HARNESS_PATH.as_posix(),
        ],
        timeout=60,
        tail_bytes=1024,
    )
    if not hidden_tree_result.ok:
        raise ValueError("cannot inspect the clone for committed benchmark harness data")
    hidden_tree = hidden_tree_result.stdout_tail.strip()
    if hidden_tree and (
        len(hidden_tree) not in {40, 64} or any(character not in "0123456789abcdefABCDEF" for character in hidden_tree)
    ):
        raise ValueError("committed benchmark harness is not a single bounded tree")

    current = root.joinpath(*HIDDEN_HARNESS_PATH.parts)
    if hidden_tree:
        parent = root
        for part in HIDDEN_HARNESS_PATH.parts:
            parent /= part
            try:
                metadata = parent.lstat()
            except OSError as exc:
                raise ValueError("committed benchmark harness is missing from the clone checkout") from exc
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("benchmark harness checkout must contain only real directories")
    elif current.exists() or current.is_symlink():
        raise ValueError("untracked benchmark harness data blocks oracle sanitization")

    _git_checked(
        root,
        [
            "rm",
            "-r",
            "--force",
            "--quiet",
            "--ignore-unmatch",
            "--",
            HIDDEN_HARNESS_PATH.as_posix(),
        ],
        timeout=120,
    )
    sanitized_tree = _git_checked(root, ["write-tree"], timeout=60)
    deterministic_git_env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
        "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
    }
    sanitized_head = _git_checked(
        root,
        [
            "-c",
            "user.name=GitNexus Workflow Benchmark",
            "-c",
            "user.email=workflow-bench.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            sanitized_tree,
            "-m",
            "Sanitized benchmark task snapshot",
        ],
        timeout=60,
        env=deterministic_git_env,
    )
    _git_checked(
        root,
        ["update-ref", "--no-deref", "HEAD", sanitized_head, original_head],
        timeout=60,
    )

    refs_output = _git_checked(
        root,
        ["for-each-ref", f"--count={MAX_CLONE_REFS + 1}", "--format=%(refname)"],
        timeout=60,
    )
    refs = refs_output.splitlines() if refs_output else []
    if len(refs) > MAX_CLONE_REFS:
        raise ValueError(f"clone has more than {MAX_CLONE_REFS} references; refusing incomplete sanitization")
    if any(not ref.startswith("refs/") or any(character.isspace() for character in ref) for ref in refs):
        raise ValueError("clone contains an unsafe reference name")
    for ref in refs:
        _git_checked(root, ["update-ref", "--no-deref", "-d", ref], timeout=60)

    remote_output = _git_checked(root, ["remote"], timeout=60)
    remotes = remote_output.splitlines() if remote_output else []
    if len(remotes) > MAX_CLONE_REFS or any(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,255}", remote) is None or ".." in remote for remote in remotes
    ):
        raise ValueError("clone contains unsafe or unbounded remote metadata")
    for remote in remotes:
        _git_checked(root, ["remote", "remove", remote], timeout=60)

    _git_checked(
        root,
        ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"],
        timeout=60,
    )
    git_dir = root / ".git"
    for pseudo_ref in (
        "AUTO_MERGE",
        "BISECT_START",
        "CHERRY_PICK_HEAD",
        "FETCH_HEAD",
        "MERGE_HEAD",
        "ORIG_HEAD",
        "REBASE_HEAD",
        "REVERT_HEAD",
        "shallow",
    ):
        path = git_dir / pseudo_ref
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"unsafe Git metadata blocks oracle sanitization: {pseudo_ref}")
        path.unlink()

    logs = git_dir / "logs"
    if logs.exists() or logs.is_symlink():
        logs_metadata = logs.lstat()
        if stat.S_ISLNK(logs_metadata.st_mode) or not stat.S_ISDIR(logs_metadata.st_mode):
            raise ValueError("unsafe Git reflog metadata blocks oracle sanitization")
        shutil.rmtree(logs)

    _git_checked(root, ["repack", "-A", "-d"], timeout=600)
    _git_checked(root, ["prune", "--expire=now"], timeout=600)
    _git_checked(root, ["prune-packed"], timeout=600)

    remaining_refs = _git_checked(root, ["for-each-ref", "--format=%(refname)"], timeout=60)
    if remaining_refs:
        raise ValueError("oracle sanitization left clone references recoverable")
    fsck = run_checked(
        ["git", "-C", str(root), "fsck", "--full", "--no-progress", "--no-reflogs", "--unreachable"],
        timeout=600,
        tail_bytes=MAX_CLONE_REF_BYTES,
    )
    if fsck.stdout_tail.strip() or fsck.stderr_tail.strip():
        raise ValueError("oracle sanitization left unreachable Git objects recoverable")

    forbidden_objects: list[tuple[str, str]] = []
    if original_head != sanitized_head:
        forbidden_objects.append((original_head, "original commit"))
    if hidden_tree:
        forbidden_objects.append((hidden_tree, "hidden harness tree"))
    for forbidden_object, label in forbidden_objects:
        probe = run_managed(
            ["git", "-C", str(root), "cat-file", "-e", forbidden_object],
            timeout=60,
        )
        if probe.ok:
            raise ValueError(f"oracle sanitization left the {label} recoverable")
        if probe.state != "exited" or probe.returncode not in {1, 128}:
            raise ValueError(f"oracle sanitization could not verify removal of the {label}")

    hidden_listing = _git_checked(
        root,
        ["ls-tree", "-r", "--name-only", "HEAD", "--", HIDDEN_HARNESS_PATH.as_posix()],
        timeout=60,
    )
    if hidden_listing or current.exists() or current.is_symlink():
        raise ValueError("oracle sanitization left the benchmark harness visible")
    if _git_checked(root, ["status", "--porcelain=v1", "--untracked-files=all"], timeout=60):
        raise ValueError("oracle sanitization did not produce a clean task snapshot")
    if _git_checked(root, ["rev-parse", "--verify", "HEAD^{commit}"], timeout=60) != sanitized_head:
        raise ValueError("oracle sanitization did not retain its parentless task snapshot")
    parents = _git_checked(root, ["show", "-s", "--format=%P", "HEAD"], timeout=60)
    if parents:
        raise ValueError("oracle sanitization snapshot unexpectedly retained parent history")
    if _git_checked(root, ["remote"], timeout=60):
        raise ValueError("oracle sanitization retained a repository remote")
    if logs.exists() or logs.is_symlink():
        raise ValueError("oracle sanitization retained reflog metadata")
    return sanitized_head


def _write_stage_file(stage_root: Path, item: OracleFileSnapshot) -> None:
    destination = stage_root.joinpath(*PurePosixPath(item.target).parts)
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    current = stage_root
    for part in PurePosixPath(item.target).parts[:-1]:
        current /= part
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"oracle stage parent must be a real directory: {item.target}")
        current.chmod(0o700)
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o400,
    )
    try:
        view = memoryview(item.payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write while staging oracle")
            view = view[written:]
        os.fchmod(descriptor, 0o400)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _verify_staged_oracle(stage_root: Path, snapshot: TaskOracleSnapshot) -> None:
    root_metadata = stage_root.lstat()
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ValueError("oracle stage root changed during verification")
    for item in snapshot.files:
        relative = PurePosixPath(item.target)
        current = stage_root
        for part in relative.parts[:-1]:
            current /= part
            metadata = current.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise ValueError(f"oracle stage parent changed during verification: {item.target}")
        observed = _read_oracle_file(stage_root, relative)
        if observed != item.payload:
            raise ValueError(f"oracle file changed during verification: {item.target}")


@contextmanager
def staged_task_oracle(worktree: Path, snapshot: TaskOracleSnapshot) -> Iterator[Path]:
    """Materialize a private random oracle root only after the model exits."""

    root = worktree.expanduser().absolute()
    metadata = root.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode) or root.resolve(strict=True) != root:
        raise ValueError(f"oracle worktree must be a real non-symlink directory: {root}")
    stage_root = root / f".wfbench-oracle-{secrets.token_hex(16)}"
    stage_root.mkdir(mode=0o700)
    stage_root.chmod(0o700)
    primary: BaseException | None = None
    try:
        for item in snapshot.files:
            _write_stage_file(stage_root, item)
        yield stage_root
        _verify_staged_oracle(stage_root, snapshot)
    except BaseException as exc:
        primary = exc
        raise
    finally:
        try:
            mode = stage_root.lstat().st_mode
            if stat.S_ISLNK(mode):
                stage_root.unlink()
            elif stat.S_ISDIR(mode):
                shutil.rmtree(stage_root)
            else:
                stage_root.unlink()
        except FileNotFoundError:
            cleanup = ValueError("oracle stage root was removed during verification")
            if primary is None:
                raise cleanup
            primary.add_note(str(cleanup))
        except OSError as cleanup:
            if primary is None:
                raise
            primary.add_note(f"oracle stage cleanup also failed: {cleanup}")
