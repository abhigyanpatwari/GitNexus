"""Workspace, patch, and verifier evidence for workflow benchmark runs."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Sequence

from .evolution import skill_fingerprint
from .process_control import ManagedProcessError, ManagedProcessResult, run_checked, run_managed
from .proposer_sandbox import SANDBOX_WORKSPACE, SandboxSession, build_sandbox_environment

MAX_PATCH_BYTES = 300_000
MAX_WORKSPACE_SNAPSHOT_ENTRIES = 100_000
MAX_WORKSPACE_SNAPSHOT_PATH_BYTES = 16 * 1024 * 1024
MAX_WORKSPACE_SNAPSHOT_FILE_BYTES = 1024 * 1024 * 1024

IMPLEMENTATION_ARMS = frozenset(
    {
        "workflow",
        "workflow_direct",
        "ce_workflow",
        "ce_workflow_direct",
        "baseline",
        "baseline_nomcp",
    }
)


@dataclass(frozen=True)
class VerificationResult:
    """Verifier output that preserves infrastructure terminal state."""

    command: Sequence[str] | str
    process: ManagedProcessResult
    output: str

    @property
    def passed(self) -> bool:
        return self.process.ok

    def __iter__(self) -> Iterator[bool | str]:
        # Preserve the historical two-value unpacking API for standalone
        # callers while runner.py inspects ``process.state`` explicitly.
        yield self.passed
        yield self.output


def workspace_snapshot(worktree: Path) -> dict[str, str]:
    """Hash the workspace without following links, excluding Git internals."""

    root = worktree.expanduser().absolute()
    mode = root.lstat().st_mode
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or root.resolve(strict=True) != root:
        raise ValueError(f"workspace snapshot root must be a real directory: {root}")

    snapshot: dict[str, str] = {}
    pending: list[tuple[Path, PurePosixPath]] = [(root, PurePosixPath())]
    entry_count = 0
    path_bytes = 0
    file_bytes = 0
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    while pending:
        directory, relative_dir = pending.pop()
        try:
            children = sorted(os.scandir(directory), key=lambda entry: entry.name, reverse=True)
        except OSError as exc:
            raise ValueError(f"workspace snapshot directory is unreadable: {directory}: {exc}") from exc
        for entry in children:
            relative = relative_dir / entry.name
            if relative.parts[0] == ".git":
                continue
            entry_count += 1
            path_bytes += len(relative.as_posix().encode())
            if entry_count > MAX_WORKSPACE_SNAPSHOT_ENTRIES or path_bytes > MAX_WORKSPACE_SNAPSHOT_PATH_BYTES:
                raise ValueError("workspace snapshot exceeds its bounded entry or path limit")
            metadata = entry.stat(follow_symlinks=False)
            permissions = stat.S_IMODE(metadata.st_mode)
            if stat.S_ISDIR(metadata.st_mode):
                snapshot[relative.as_posix()] = f"d:{permissions:o}"
                pending.append((Path(entry.path), relative))
                continue
            if stat.S_ISLNK(metadata.st_mode):
                snapshot[relative.as_posix()] = f"l:{permissions:o}:{os.readlink(entry.path)}"
                continue
            if not stat.S_ISREG(metadata.st_mode):
                snapshot[relative.as_posix()] = f"s:{metadata.st_mode}"
                continue
            file_bytes += metadata.st_size
            if file_bytes > MAX_WORKSPACE_SNAPSHOT_FILE_BYTES:
                raise ValueError("workspace snapshot exceeds its bounded file-byte limit")
            descriptor = os.open(entry.path, os.O_RDONLY | nofollow)
            try:
                opened = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_dev != metadata.st_dev
                    or opened.st_ino != metadata.st_ino
                ):
                    raise ValueError(f"workspace file changed while opening: {entry.path}")
                digest = hashlib.sha256()
                while chunk := os.read(descriptor, 64 * 1024):
                    digest.update(chunk)
                after = os.fstat(descriptor)
                if (opened.st_size, opened.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ValueError(f"workspace file changed while hashing: {entry.path}")
            finally:
                os.close(descriptor)
            snapshot[relative.as_posix()] = f"f:{permissions:o}:{metadata.st_size}:{digest.hexdigest()}"
    return snapshot


def enforce_phase_workspace(
    worktree: Path,
    before: dict[str, str],
    *,
    allowed_artifact: Path,
) -> None:
    """Require a phase to change only its one explicit workspace artifact."""

    root = worktree.expanduser().absolute()
    artifact = allowed_artifact.expanduser().absolute()
    try:
        relative = PurePosixPath(artifact.relative_to(root).as_posix())
    except ValueError as exc:
        raise ValueError(f"phase artifact escapes the workspace: {allowed_artifact}") from exc
    after = workspace_snapshot(root)
    changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
    artifact_key = relative.as_posix()
    artifact_state = after.get(artifact_key)
    if before.get(artifact_key) == artifact_state:
        raise ValueError(f"phase did not create or change its required artifact: {relative}")
    if artifact_state is None or not artifact_state.startswith("f:"):
        raise ValueError(f"phase artifact must be a regular non-symlink file: {relative}")

    try:
        metadata = artifact.lstat()
        descriptor = os.open(artifact, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise ValueError(f"phase artifact must be a readable regular non-symlink file: {relative}") from exc
    try:
        opened = os.fstat(descriptor)
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or metadata.st_dev != opened.st_dev
            or metadata.st_ino != opened.st_ino
        ):
            raise ValueError(f"phase artifact must be a regular non-symlink file: {relative}")
    finally:
        os.close(descriptor)

    allowed = {artifact_key}
    parent = relative.parent
    while parent.parts:
        parent_key = parent.as_posix()
        if parent_key not in before and after.get(parent_key, "").startswith("d:"):
            allowed.add(parent_key)
        parent = parent.parent
    unauthorized = sorted(changed - allowed)
    if unauthorized:
        preview = ", ".join(unauthorized[:8])
        suffix = " …" if len(unauthorized) > 8 else ""
        raise ValueError(f"phase changed unauthorized workspace path(s): {preview}{suffix}")


def require_skill_fingerprint(worktree: Path, arm: str, expected: str | None, *, phase: str) -> None:
    """Fail closed when a bounded phase changes the evaluated prompt roots."""

    try:
        observed = skill_fingerprint(worktree, arm)
    except (OSError, ValueError) as exc:
        raise ValueError(f"{phase} changed the evaluated skill fingerprint") from exc
    if observed != expected:
        raise ValueError(f"{phase} changed the evaluated skill fingerprint")


def snapshot_plan_docs(worktree: Path) -> dict[Path, str]:
    """Hash direct, regular plan artifacts without following links."""

    plans = worktree / "docs" / "plans"
    if not plans.exists():
        return {}
    if plans.is_symlink() or not plans.is_dir():
        raise ValueError(f"plan directory must be a real directory: {plans}")

    snapshot: dict[Path, str] = {}
    for path in sorted(plans.iterdir()):
        if path.suffix.lower() not in {".md", ".html"}:
            continue
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"plan artifact cannot be a symlink: {path}")
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"plan artifact must be a regular file: {path}")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino:
                raise ValueError(f"plan artifact changed while opening: {path}")
            with os.fdopen(descriptor, "rb", closefd=False) as handle:
                snapshot[path] = hashlib.file_digest(handle, "sha256").hexdigest()
            after = os.fstat(descriptor)
            if (opened.st_size, opened.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError(f"plan artifact changed while hashing: {path}")
        finally:
            os.close(descriptor)
    return snapshot


def new_plan_doc(worktree: Path, before: dict[Path, str]) -> Path:
    """Return the sole new or modified plan, rejecting ambiguous evidence."""

    after = snapshot_plan_docs(worktree)
    deleted = sorted(path for path in before if path not in after)
    if deleted:
        raise ValueError("planning deleted existing plan artifact(s): " + ", ".join(str(path) for path in deleted))
    changed = sorted(path for path, digest in after.items() if before.get(path) != digest)
    if len(changed) != 1:
        raise ValueError(f"planning must create or modify exactly one plan artifact; observed {len(changed)}")
    return changed[0]


def make_worktree(repo: Path, ref: str, parent: Path) -> Path:
    """Create a self-contained clone per benchmark arm."""

    target = Path(tempfile.mkdtemp(prefix="wfbench-", dir=parent))
    target.rmdir()
    try:
        run_checked(
            [
                "git",
                "clone",
                "--no-local",
                "--no-hardlinks",
                "--no-tags",
                "--quiet",
                str(repo),
                str(target),
            ],
            timeout=600,
        )
        alternates = target / ".git" / "objects" / "info" / "alternates"
        if alternates.exists():
            raise RuntimeError(f"clone unexpectedly has an external object alternate: {alternates}")
        for obj in (target / ".git" / "objects").rglob("*"):
            if obj.is_file() and obj.stat().st_nlink > 1:
                raise RuntimeError(f"clone object is hardlinked to host storage: {obj}")
        for candidate in (ref, f"origin/{ref}"):
            proc = run_managed(
                ["git", "-C", str(target), "checkout", "--detach", "--quiet", candidate],
                timeout=60,
            )
            if proc.ok:
                return target
        raise RuntimeError(f"ref {ref!r} not found in clone of {repo}")
    except BaseException as primary:
        if target.exists():
            try:
                shutil.rmtree(target)
            except OSError as cleanup:
                primary.add_note(f"clone cleanup also failed: {type(cleanup).__name__}: {cleanup}")
        raise


def remove_clone(clone: Path) -> None:
    """Delete one throwaway arm clone (created by make_worktree)."""

    shutil.rmtree(clone)


def parse_shortstat(text: str) -> dict[str, int]:
    """Parse `git diff --shortstat` output into churn counters."""

    keys = {
        "file": "diff_files",
        "insertion": "diff_insertions",
        "deletion": "diff_deletions",
    }
    out = dict.fromkeys(keys.values(), 0)
    for count, word in re.findall(r"(\d+) (file|insertion|deletion)", text):
        out[keys[word]] = int(count)
    return out


def _sandbox_git(sandbox: SandboxSession, args: list[str], *, timeout: int = 60) -> str:
    command = ["/usr/bin/git", "-c", "core.fsmonitor=false", *args]
    result = sandbox.run(command, timeout=timeout, env=build_sandbox_environment())
    if not result.ok:
        raise ManagedProcessError(command, result)
    return result.stdout_tail


def _prepare_untracked_for_diff(sandbox: SandboxSession) -> None:
    _sandbox_git(sandbox, ["add", "--intent-to-add", "-A"])


def implementation_diff_digest(
    sandbox: SandboxSession,
    orig_sha: str,
    *,
    prepare_untracked: bool = True,
) -> str:
    """Digest non-plan final work entirely inside the containment boundary."""

    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", orig_sha):
        raise ValueError(f"unsafe git object id: {orig_sha!r}")
    if prepare_untracked:
        _prepare_untracked_for_diff(sandbox)
    command = (
        "/usr/bin/git -c core.fsmonitor=false diff --no-ext-diff --no-textconv --binary "
        f"{orig_sha} -- . ':(exclude)docs/plans' ':(exclude).claude/skills' "
        "| /usr/bin/sha256sum"
    )
    result = sandbox.run(
        ["/bin/sh", "-c", command],
        timeout=60,
        env=build_sandbox_environment(),
    )
    if not result.ok:
        raise ManagedProcessError(command, result)
    digest = result.stdout_tail.strip().split()[0] if result.stdout_tail.strip() else ""
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeError("sandboxed git diff did not produce a SHA-256 digest")
    return digest


def diff_churn(
    sandbox: SandboxSession,
    orig_sha: str,
    *,
    prepare_untracked: bool = True,
) -> dict[str, int]:
    """Return code churn versus the arm's starting SHA."""

    if prepare_untracked:
        _prepare_untracked_for_diff(sandbox)
    output = _sandbox_git(
        sandbox,
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--shortstat",
            orig_sha,
            "--",
            ".",
            ":(exclude)docs/plans",
            ":(exclude).claude/skills",
        ],
    )
    return parse_shortstat(output)


def _bounded_regular_bytes(path: Path, *, limit: int) -> bytes:
    """Read at most ``limit`` bytes without following a generated link."""

    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"generated artifact is not a regular non-symlink file: {path}")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, os.O_RDONLY | nofollow)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"generated artifact changed type while opening: {path}")
        chunks: list[bytes] = []
        remaining = limit
        while remaining > 0:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def capture_patch(sandbox: SandboxSession, worktree: Path, orig_sha: str) -> bytes:
    """Stream a final patch inside the sandbox while retaining a bounded prefix."""

    artifact_dir = Path(tempfile.mkdtemp(prefix=".wfbench-artifact-", dir=worktree))
    artifact_dir.chmod(0o700)
    patch = artifact_dir / "final.patch"
    sandbox_path = f"{SANDBOX_WORKSPACE}/{artifact_dir.relative_to(worktree).as_posix()}/final.patch"
    sink = """\
import subprocess
import sys

limit = int(sys.argv[1])
output = sys.argv[2]
command = sys.argv[3:]
with open(output, "xb") as handle:
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    assert process.stdout is not None
    remaining = limit
    for chunk in iter(lambda: process.stdout.read(65536), b""):
        if remaining:
            retained = chunk[:remaining]
            handle.write(retained)
            remaining -= len(retained)
    process.stdout.close()
    returncode = process.wait()
if returncode:
    raise SystemExit(returncode)
"""
    command = [
        "/usr/bin/python3",
        "-I",
        "-c",
        sink,
        str(MAX_PATCH_BYTES),
        sandbox_path,
        "/usr/bin/git",
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        orig_sha,
        "--",
        ".",
        ":(exclude).wfbench-artifact-*",
    ]
    result = sandbox.run(command, timeout=60, env=build_sandbox_environment())
    if not result.ok:
        raise ManagedProcessError(command, result)
    return _bounded_regular_bytes(patch, limit=MAX_PATCH_BYTES)


def enforce_work_evidence(
    record: dict[str, Any],
    *,
    arm: str,
    before_digest: str,
    after_digest: str,
) -> None:
    if arm not in IMPLEMENTATION_ARMS or not record.get("resolved"):
        return
    if before_digest != after_digest:
        return
    record["resolved"] = False
    record["error_kind"] = "no-work-produced"
    record["error_detail"] = "verifier passed but the implementation arm produced no non-plan repository change"


def run_verify(
    command: str,
    cwd: Path,
    timeout: int,
    *,
    command_prefix: list[str] | None = None,
    env: dict[str, str] | None = None,
    require_pid_namespace: bool = False,
) -> VerificationResult:
    """Run the task's verify command; keep its output tail for diagnosis."""

    if command_prefix:
        # HOME is writable during model execution. A non-login shell prevents
        # candidate-created profile files from running inside trusted evidence
        # collection or either verifier.
        managed_command: list[str] | str = [*command_prefix, "/bin/sh", "-c", command]
        shell = False
        managed_cwd: Path | None = None
    else:
        managed_command = command
        shell = True
        managed_cwd = cwd
    proc = run_managed(
        managed_command,
        shell=shell,
        cwd=managed_cwd,
        env=env,
        timeout=timeout,
        require_pid_namespace=require_pid_namespace,
    )
    output = proc.stdout_tail + "\n" + proc.stderr_tail
    if proc.detail:
        output += f"\n[{proc.state}] {proc.detail}"
    return VerificationResult(
        command=managed_command,
        process=proc,
        output=output[-4000:],
    )
