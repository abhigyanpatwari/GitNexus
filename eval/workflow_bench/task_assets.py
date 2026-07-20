"""Immutable, copy-on-write task assets for workflow benchmark clones.

``sandbox_copy`` inputs can include a several-hundred-megabyte GitNexus
index.  This module captures each declared input set once, freezes that
snapshot, and then reflinks it into every arm clone.  A clone therefore gets
an independent inode without paying for another full buffered copy or being
able to mutate the snapshot used by another arm.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import posixpath
import shutil
import stat
import tempfile
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .proposer_sandbox import (
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    _prepare_clone_target,
    _real_directory,
)

# The shipped index is roughly 428 MiB.  These are containment limits rather
# than expected-size assertions: they admit normal growth while preventing a
# task declaration from turning snapshot preparation into an unbounded walk.
MAX_TASK_ASSET_ENTRIES = 100_000
MAX_TASK_ASSET_PATH_BYTES = 4_096
MAX_TASK_ASSET_BYTES = 2 * 1024 * 1024 * 1024

# The largest known real sandbox_copy asset in this harness is the shipped
# index above (~428 MiB estimated, ~290 MiB measured); budget comfortably
# above that so it can still materialize via buffered copy on a filesystem
# that cannot reflink (ext4 CI runners, 9p-backed dev mounts), while staying
# well below MAX_TASK_ASSET_BYTES so a genuinely oversized or malformed
# declaration still fails closed instead of silently paying for a slow full
# copy.
MAX_BUFFERED_FALLBACK_BYTES = 512 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024

# linux/fs.h: #define FICLONE _IOW(0x94, 9, int)
FICLONE = 0x40049409
_REFLINK_UNAVAILABLE = {
    errno.EXDEV,
    errno.EINVAL,
    errno.ENOTTY,
    errno.EOPNOTSUPP,
    errno.ENOSYS,
}

DEPENDENCY_CONTENT_BINDING_FIELD = "sandbox_dependency_content_digest"
DEPENDENCY_MANIFEST_BINDING_FIELD = "sandbox_dependency_manifest_digest"


@dataclass(frozen=True)
class AssetManifestEntry:
    path: PurePosixPath
    kind: str
    size: int = 0
    sha256: str = ""
    mode: int = 0
    link_target: str = ""


@dataclass(frozen=True)
class DependencySnapshot:
    """One declared dependency captured below the immutable snapshot root."""

    source: str
    target: str
    snapshot_path: PurePosixPath
    kind: str
    entries: tuple[AssetManifestEntry, ...]
    total_bytes: int


@dataclass(frozen=True)
class TaskAssetSnapshot:
    """A frozen task-asset tree and its provenance identity."""

    root: Path
    digest: str
    manifest_digest: str
    repo_identity: Path
    resolved_sha: str
    declarations: tuple[str, ...]
    entries: tuple[AssetManifestEntry, ...]
    dependency_declarations: tuple[tuple[str, str], ...]
    dependencies: tuple[DependencySnapshot, ...]
    dependency_content_digest: str
    dependency_manifest_digest: str
    total_bytes: int

    @property
    def dependency_binding(self) -> dict[str, str]:
        """Canonical fields stored in and validated against task bindings."""

        return {
            DEPENDENCY_CONTENT_BINDING_FIELD: self.dependency_content_digest,
            DEPENDENCY_MANIFEST_BINDING_FIELD: self.dependency_manifest_digest,
        }

    def validate_dependency_binding(self, binding: Mapping[str, Any]) -> None:
        """Fail closed unless ``binding`` names this exact dependency snapshot."""

        _validate_dependency_binding_values(
            binding,
            content_digest=self.dependency_content_digest,
            manifest_digest=self.dependency_manifest_digest,
        )

    def materialize(self, clone: Path) -> None:
        """Replace every declared ``sandbox_copy`` root with its exact snapshot tree."""

        clone = _real_directory(clone, label="asset-staging clone")
        snapshot_root = _real_directory(self.root / "sandbox-copy", label="task asset snapshot")
        staging = Path(tempfile.mkdtemp(prefix=".wfbench-assets-", dir=clone.parent))
        fallback_bytes = 0
        try:
            for entry in self.entries:
                destination = staging / Path(*entry.path.parts)
                if entry.kind == "directory":
                    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                source = snapshot_root / Path(*entry.path.parts)
                fallback_bytes += _materialize_file(
                    source,
                    destination,
                    entry,
                    fallback_budget=MAX_BUFFERED_FALLBACK_BYTES - fallback_bytes,
                )

            roots = tuple(PurePosixPath(declaration) for declaration in self.declarations)
            for relative in roots:
                _preflight_exact_root(clone, relative)
            for relative in roots:
                _publish_exact_root(staging, clone, relative)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def dependency_mounts(self, clone: Path) -> list[ReadOnlyMount]:
        """Mount only immutable captured dependency roots into an arm clone."""

        clone = _real_directory(clone, label="dependency clone")
        snapshot_root = _real_directory(self.root, label="task asset snapshot")
        mounts: list[ReadOnlyMount] = []
        for dependency in self.dependencies:
            source = snapshot_root / Path(*dependency.snapshot_path.parts)
            metadata = source.lstat()
            expected_directory = dependency.kind == "directory"
            if stat.S_ISLNK(metadata.st_mode) or (
                expected_directory and not stat.S_ISDIR(metadata.st_mode)
            ) or (not expected_directory and not stat.S_ISREG(metadata.st_mode)):
                raise SandboxError(f"dependency snapshot changed: {dependency.source}")
            target = PurePosixPath(dependency.target)
            _prepare_clone_target(
                clone,
                target,
                directory=expected_directory,
                label="dependency",
            )
            mounts.append(
                ReadOnlyMount(
                    source=source,
                    target=f"{SANDBOX_WORKSPACE}/{target.as_posix()}",
                )
            )
        return mounts


class TaskAssetCache:
    """Own immutable snapshots for one benchmark invocation."""

    def __init__(self, root: Path):
        self.root = root.expanduser().absolute()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
        self._by_definition: dict[
            tuple[str, str, tuple[str, ...], tuple[tuple[str, str], ...]],
            TaskAssetSnapshot,
        ] = {}
        self._closed = False

    def __enter__(self) -> TaskAssetCache:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()

    def prepare(
        self,
        task: Mapping[str, Any],
        *,
        repo: Path,
        resolved_sha: str,
        expected_dependency_binding: Mapping[str, Any] | None = None,
    ) -> TaskAssetSnapshot:
        """Capture or reuse all copied and mounted task bytes in one snapshot."""

        if self._closed:
            raise SandboxError("task asset cache is already closed")
        repo_identity = _real_directory(repo, label="task asset repository")
        declarations, relative_paths = _sandbox_copy_declarations(task)
        dependency_declarations = _sandbox_dependency_declarations(task)
        dependency_identity = tuple(
            (declaration.source, declaration.target) for declaration in dependency_declarations
        )
        definition = (str(repo_identity), resolved_sha, declarations, dependency_identity)
        existing = self._by_definition.get(definition)
        if existing is not None:
            if expected_dependency_binding is not None:
                existing.validate_dependency_binding(expected_dependency_binding)
            return existing

        building = Path(tempfile.mkdtemp(prefix=".building-", dir=self.root))
        try:
            copy_root = building / "sandbox-copy"
            dependency_root = building / "dependencies"
            copy_root.mkdir(mode=0o700)
            dependency_root.mkdir(mode=0o700)
            budget = _SnapshotBudget()
            builder = _SnapshotBuilder(copy_root, budget=budget)
            dependency_snapshots: list[DependencySnapshot] = []
            repo_fd = os.open(
                repo_identity,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                for relative in relative_paths:
                    descriptor = _open_relative(repo_fd, relative)
                    try:
                        builder.copy_descriptor(descriptor, relative)
                    finally:
                        os.close(descriptor)
                for index, declaration in enumerate(dependency_declarations):
                    container_name = f"{index:05d}"
                    container = dependency_root / container_name
                    container.mkdir(mode=0o700)
                    dependency_builder = _SnapshotBuilder(
                        container,
                        budget=budget,
                        allow_symlinks=True,
                        preserve_modes=True,
                    )
                    descriptor = _open_relative(repo_fd, declaration.source_path)
                    try:
                        dependency_builder.copy_descriptor(descriptor, PurePosixPath("payload"))
                    finally:
                        os.close(descriptor)
                    dependency_entries = dependency_builder.finished_entries()
                    _validate_dependency_symlinks(
                        container,
                        dependency_entries,
                        mount_target=declaration.target_path,
                    )
                    payload = next(
                        (entry for entry in dependency_entries if entry.path == PurePosixPath("payload")),
                        None,
                    )
                    if payload is None:
                        raise SandboxError(f"dependency snapshot is empty: {declaration.source}")
                    dependency_snapshots.append(
                        DependencySnapshot(
                            source=declaration.source,
                            target=declaration.target,
                            snapshot_path=PurePosixPath("dependencies", container_name, "payload"),
                            kind=payload.kind,
                            entries=dependency_entries,
                            total_bytes=dependency_builder.total_bytes,
                        )
                    )
            finally:
                os.close(repo_fd)

            entries = builder.finished_entries()
            manifest_digest = _manifest_digest(entries)
            dependencies = tuple(dependency_snapshots)
            dependency_content_digest, dependency_manifest_digest = _dependency_digests(dependencies)
            if expected_dependency_binding is not None:
                _validate_dependency_binding_values(
                    expected_dependency_binding,
                    content_digest=dependency_content_digest,
                    manifest_digest=dependency_manifest_digest,
                )
            digest = _snapshot_digest(
                repo_identity=repo_identity,
                resolved_sha=resolved_sha,
                declarations=declarations,
                manifest_digest=manifest_digest,
                dependency_content_digest=dependency_content_digest,
                dependency_manifest_digest=dependency_manifest_digest,
            )
            destination = self.root / digest
            if destination.exists():
                raise SandboxError(f"task asset snapshot key collision: {digest}")
            os.replace(building, destination)
            _freeze_snapshot(destination)
            snapshot = TaskAssetSnapshot(
                root=destination,
                digest=digest,
                manifest_digest=manifest_digest,
                repo_identity=repo_identity,
                resolved_sha=resolved_sha,
                declarations=declarations,
                entries=entries,
                dependency_declarations=dependency_identity,
                dependencies=dependencies,
                dependency_content_digest=dependency_content_digest,
                dependency_manifest_digest=dependency_manifest_digest,
                total_bytes=budget.total_bytes,
            )
            self._by_definition[definition] = snapshot
            return snapshot
        except BaseException:
            if building.exists():
                shutil.rmtree(building, ignore_errors=True)
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if not self.root.exists():
            return
        _thaw_tree(self.root)
        shutil.rmtree(self.root)


@dataclass(frozen=True)
class _DependencyDeclaration:
    source: str
    target: str
    source_path: PurePosixPath
    target_path: PurePosixPath


@dataclass
class _SnapshotBudget:
    entries: int = 0
    total_bytes: int = 0


class _SnapshotBuilder:
    def __init__(
        self,
        destination: Path,
        *,
        budget: _SnapshotBudget | None = None,
        allow_symlinks: bool = False,
        preserve_modes: bool = False,
    ):
        self.destination = destination
        self.entries: dict[PurePosixPath, AssetManifestEntry] = {}
        self.total_bytes = 0
        self.budget = budget if budget is not None else _SnapshotBudget()
        self.allow_symlinks = allow_symlinks
        self.preserve_modes = preserve_modes

    def copy_descriptor(self, descriptor: int, relative: PurePosixPath) -> None:
        before = os.fstat(descriptor)
        if stat.S_ISDIR(before.st_mode):
            self._record_directory(relative)
            try:
                names = sorted(os.listdir(descriptor))
            except OSError as exc:
                raise SandboxError(f"sandbox_copy directory is unreadable: {relative}: {exc}") from exc
            for name in names:
                child_relative = relative / name
                child_metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISLNK(child_metadata.st_mode):
                    if not self.allow_symlinks:
                        raise SandboxError(f"sandbox_copy must not traverse a symlink: {child_relative}")
                    self._copy_symlink(descriptor, name, child_relative, child_metadata)
                    continue
                child = _open_child(descriptor, name, child_relative)
                try:
                    self.copy_descriptor(child, child_relative)
                finally:
                    os.close(child)
            after = os.fstat(descriptor)
            if _mutation_identity(before) != _mutation_identity(after):
                raise SandboxError(f"sandbox_copy directory changed while snapshotting: {relative}")
            return
        if not stat.S_ISREG(before.st_mode):
            raise SandboxError(f"sandbox_copy accepts only regular files and directories: {relative}")
        self._copy_file(descriptor, relative, before)

    def _record_directory(self, relative: PurePosixPath) -> None:
        self._ensure_parents(relative.parent)
        self._record(AssetManifestEntry(path=relative, kind="directory"))
        destination = self.destination / Path(*relative.parts)
        destination.mkdir(mode=0o700, exist_ok=True)

    def _copy_file(self, descriptor: int, relative: PurePosixPath, before: os.stat_result) -> None:
        self._ensure_parents(relative.parent)
        if self.budget.total_bytes + before.st_size > MAX_TASK_ASSET_BYTES:
            raise SandboxError("sandbox_copy exceeds the total byte limit")
        destination = self.destination / Path(*relative.parts)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        output = os.open(destination, flags, 0o600)
        digest = hashlib.sha256()
        copied = 0
        try:
            while True:
                chunk = _read_source_chunk(descriptor, COPY_CHUNK_BYTES)
                if not chunk:
                    break
                copied += len(chunk)
                if self.budget.total_bytes + copied > MAX_TASK_ASSET_BYTES:
                    raise SandboxError("sandbox_copy exceeds the total byte limit")
                digest.update(chunk)
                _write_all(output, chunk)
            captured_mode = stat.S_IMODE(before.st_mode) if self.preserve_modes else 0
            frozen_mode = 0o400 | (0o100 if self.preserve_modes and captured_mode & 0o111 else 0)
            os.fchmod(output, frozen_mode)
        finally:
            os.close(output)
        after = os.fstat(descriptor)
        if copied != before.st_size or _mutation_identity(before) != _mutation_identity(after):
            raise SandboxError(f"sandbox_copy file changed while snapshotting: {relative}")
        self.total_bytes += copied
        self.budget.total_bytes += copied
        self._record(
            AssetManifestEntry(
                path=relative,
                kind="file",
                size=copied,
                sha256=digest.hexdigest(),
                mode=captured_mode,
            )
        )

    def _copy_symlink(
        self,
        parent_descriptor: int,
        name: str,
        relative: PurePosixPath,
        before: os.stat_result,
    ) -> None:
        try:
            target = os.readlink(name, dir_fd=parent_descriptor)
            target_bytes = target.encode("utf-8")
        except (OSError, UnicodeEncodeError) as exc:
            raise SandboxError(f"dependency symlink is unreadable or not UTF-8: {relative}") from exc
        if not target or PurePosixPath(target).is_absolute() or "\x00" in target:
            raise SandboxError(f"dependency symlink must be a bounded relative link: {relative}")
        if len(target_bytes) > MAX_TASK_ASSET_PATH_BYTES:
            raise SandboxError(f"dependency symlink target exceeds the path limit: {relative}")
        if self.budget.total_bytes + len(target_bytes) > MAX_TASK_ASSET_BYTES:
            raise SandboxError("sandbox_copy exceeds the total byte limit")
        destination = self.destination / Path(*relative.parts)
        os.symlink(target, destination)
        after = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if _mutation_identity(before) != _mutation_identity(after) or os.readlink(
            name,
            dir_fd=parent_descriptor,
        ) != target:
            raise SandboxError(f"dependency symlink changed while snapshotting: {relative}")
        self.total_bytes += len(target_bytes)
        self.budget.total_bytes += len(target_bytes)
        self._record(
            AssetManifestEntry(
                path=relative,
                kind="symlink",
                size=len(target_bytes),
                sha256=hashlib.sha256(target_bytes).hexdigest(),
                link_target=target,
            )
        )

    def _ensure_parents(self, relative: PurePosixPath) -> None:
        current = PurePosixPath()
        for part in relative.parts:
            current /= part
            existing = self.entries.get(current)
            if existing is not None:
                if existing.kind != "directory":
                    raise SandboxError(f"sandbox_copy paths collide at {current}")
                continue
            self._record(AssetManifestEntry(path=current, kind="directory"))
            (self.destination / Path(*current.parts)).mkdir(mode=0o700, exist_ok=True)

    def _record(self, entry: AssetManifestEntry) -> None:
        _validate_manifest_path(entry.path)
        existing = self.entries.get(entry.path)
        if existing is not None:
            if existing != entry:
                raise SandboxError(f"sandbox_copy paths collide at {entry.path}")
            return
        if self.budget.entries >= MAX_TASK_ASSET_ENTRIES:
            raise SandboxError("sandbox_copy exceeds the entry limit")
        self.entries[entry.path] = entry
        self.budget.entries += 1

    def finished_entries(self) -> tuple[AssetManifestEntry, ...]:
        return tuple(sorted(self.entries.values(), key=lambda entry: entry.path.as_posix()))


def _sandbox_copy_declarations(
    task: Mapping[str, Any],
) -> tuple[tuple[str, ...], tuple[PurePosixPath, ...]]:
    raw_declarations = task.get("sandbox_copy", [])
    if not isinstance(raw_declarations, list) or not all(isinstance(item, str) and item for item in raw_declarations):
        raise SandboxError("sandbox_copy must be a list of nonblank repository-relative paths")
    declarations = tuple(raw_declarations)
    paths: list[PurePosixPath] = []
    for raw in declarations:
        relative = PurePosixPath(raw)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts:
            raise SandboxError(f"sandbox_copy must be a repository-relative path: {raw!r}")
        _validate_manifest_path(relative)
        paths.append(relative)
    for index, path in enumerate(paths):
        for other in paths[index + 1 :]:
            if path == other or path in other.parents or other in path.parents:
                raise SandboxError(f"sandbox_copy declarations overlap: {path} and {other}")
    return declarations, tuple(paths)


def _sandbox_dependency_declarations(
    task: Mapping[str, Any],
) -> tuple[_DependencyDeclaration, ...]:
    raw_declarations = task.get("sandbox_dependencies", [])
    if not isinstance(raw_declarations, list):
        raise SandboxError("sandbox_dependencies must be a list")
    declarations: list[_DependencyDeclaration] = []
    for item in raw_declarations:
        if (
            not isinstance(item, Mapping)
            or set(item) != {"source", "target"}
            or not all(isinstance(item[field], str) and item[field] for field in ("source", "target"))
        ):
            raise SandboxError("sandbox_dependencies entries require only nonblank source and target")
        source = str(item["source"])
        target = str(item["target"])
        source_path = PurePosixPath(source)
        target_path = PurePosixPath(target)
        if source_path.is_absolute() or ".." in source_path.parts or not source_path.parts:
            raise SandboxError(f"dependency source must stay inside the repository: {source_path}")
        if target_path.is_absolute() or ".." in target_path.parts or not target_path.parts:
            raise SandboxError(f"dependency target must stay inside the clone: {target_path}")
        _validate_manifest_path(source_path)
        _validate_manifest_path(target_path)
        declarations.append(
            _DependencyDeclaration(
                source=source,
                target=target,
                source_path=source_path,
                target_path=target_path,
            )
        )
    for index, declaration in enumerate(declarations):
        for other in declarations[index + 1 :]:
            if (
                declaration.target_path == other.target_path
                or declaration.target_path in other.target_path.parents
                or other.target_path in declaration.target_path.parents
            ):
                raise SandboxError(
                    f"sandbox dependency targets overlap: {declaration.target} and {other.target}"
                )
    return tuple(declarations)


def _open_relative(repo_descriptor: int, relative: PurePosixPath) -> int:
    current = os.dup(repo_descriptor)
    try:
        for index, part in enumerate(relative.parts):
            last = index == len(relative.parts) - 1
            child = _open_child(current, part, PurePosixPath(*relative.parts[: index + 1]), require_directory=not last)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def _open_child(
    parent_descriptor: int,
    name: str,
    relative: PurePosixPath,
    *,
    require_directory: bool = False,
) -> int:
    try:
        metadata = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except OSError as exc:
        raise SandboxError(f"sandbox_copy path is unavailable: {relative}: {exc}") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise SandboxError(f"sandbox_copy must not traverse a symlink: {relative}")
    if require_directory and not stat.S_ISDIR(metadata.st_mode):
        raise SandboxError(f"sandbox_copy parent must be a directory: {relative}")
    if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
        raise SandboxError(f"sandbox_copy accepts only regular files and directories: {relative}")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if stat.S_ISDIR(metadata.st_mode):
        flags |= os.O_DIRECTORY
    else:
        flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=parent_descriptor)
    except OSError as exc:
        raise SandboxError(f"sandbox_copy path changed or is unreadable: {relative}: {exc}") from exc
    opened = os.fstat(descriptor)
    if not (stat.S_ISDIR(opened.st_mode) or stat.S_ISREG(opened.st_mode)):
        os.close(descriptor)
        raise SandboxError(f"sandbox_copy accepts only regular files and directories: {relative}")
    if (
        opened.st_dev,
        opened.st_ino,
        stat.S_IFMT(opened.st_mode),
    ) != (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
    ):
        os.close(descriptor)
        raise SandboxError(f"sandbox_copy path changed while opening: {relative}")
    return descriptor


def _validate_dependency_symlinks(
    container: Path,
    entries: tuple[AssetManifestEntry, ...],
    *,
    mount_target: PurePosixPath,
) -> None:
    snapshot_boundary = (container / "payload").resolve(strict=True)
    manifest_boundary = PurePosixPath("payload")
    sandbox_boundary = PurePosixPath(SANDBOX_WORKSPACE)
    sandbox_mount = sandbox_boundary / mount_target
    for entry in entries:
        if entry.kind != "symlink":
            continue
        target = PurePosixPath(entry.link_target)
        relative_to_payload = entry.path.relative_to(manifest_boundary)
        sandbox_resolved = PurePosixPath(
            posixpath.normpath((sandbox_mount / relative_to_payload.parent / target).as_posix())
        )
        if sandbox_resolved != sandbox_boundary and sandbox_boundary not in sandbox_resolved.parents:
            raise SandboxError(f"dependency symlink escapes the sandbox workspace: {entry.path}")
        manifest_resolved = PurePosixPath(
            posixpath.normpath((entry.path.parent / target).as_posix())
        )
        if manifest_resolved != manifest_boundary and manifest_boundary not in manifest_resolved.parents:
            continue
        link = container / Path(*entry.path.parts)
        try:
            resolved = link.resolve(strict=True)
            resolved.relative_to(snapshot_boundary)
        except (OSError, RuntimeError, ValueError) as exc:
            raise SandboxError(f"dependency symlink is dangling or escapes its snapshot: {entry.path}") from exc


def _preflight_exact_root(clone: Path, relative: PurePosixPath) -> None:
    """Reject symlink/special hazards while permitting replaceable type conflicts."""

    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    current = os.open(clone, flags)
    try:
        for index, part in enumerate(relative.parts):
            try:
                mode = os.stat(part, dir_fd=current, follow_symlinks=False).st_mode
            except FileNotFoundError:
                return
            last = index == len(relative.parts) - 1
            if stat.S_ISLNK(mode):
                role = "target cannot be a symlink" if last else "target has a symlink parent"
                raise SandboxError(f"sandbox_copy {role}: {relative}")
            if last:
                if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    raise SandboxError(f"sandbox_copy target has an unsupported type: {relative}")
                return
            if stat.S_ISREG(mode):
                return
            if not stat.S_ISDIR(mode):
                raise SandboxError(f"sandbox_copy target parent has an unsupported type: {relative}")
            next_descriptor = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = next_descriptor
    finally:
        os.close(current)


def _open_publish_parent(clone: Path, parent: PurePosixPath) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    current = os.open(clone, flags)
    try:
        for part in parent.parts:
            try:
                mode = os.stat(part, dir_fd=current, follow_symlinks=False).st_mode
            except FileNotFoundError:
                mode = None
            if mode is not None and stat.S_ISLNK(mode):
                raise SandboxError(f"sandbox_copy target cannot traverse a symlink: {parent}")
            if mode is not None and not stat.S_ISDIR(mode):
                if not stat.S_ISREG(mode):
                    raise SandboxError(f"sandbox_copy target parent has an unsupported type: {parent}")
                os.unlink(part, dir_fd=current)
                mode = None
            if mode is None:
                os.mkdir(part, mode=0o700, dir_fd=current)
            next_descriptor = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = next_descriptor
        return current
    except BaseException:
        os.close(current)
        raise


def _open_existing_parent(root: Path, parent: PurePosixPath) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    current = os.open(root, flags)
    try:
        for part in parent.parts:
            next_descriptor = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = next_descriptor
        return current
    except BaseException:
        os.close(current)
        raise


def _remove_entry_at(parent: int, name: str, relative: PurePosixPath) -> None:
    try:
        mode = os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
        os.unlink(name, dir_fd=parent)
        return
    if not stat.S_ISDIR(mode):
        raise SandboxError(f"sandbox_copy target has an unsupported type: {relative}")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory = os.open(name, flags, dir_fd=parent)
    try:
        for child in os.listdir(directory):
            _remove_entry_at(directory, child, relative / child)
    finally:
        os.close(directory)
    os.rmdir(name, dir_fd=parent)


def _publish_exact_root(staging: Path, clone: Path, relative: PurePosixPath) -> None:
    source_parent = _open_existing_parent(staging, relative.parent)
    destination_parent = _open_publish_parent(clone, relative.parent)
    try:
        _remove_entry_at(destination_parent, relative.name, relative)
        os.rename(
            relative.name,
            relative.name,
            src_dir_fd=source_parent,
            dst_dir_fd=destination_parent,
        )
    finally:
        os.close(destination_parent)
        os.close(source_parent)


def _materialize_file(
    source: Path,
    destination: Path,
    entry: AssetManifestEntry,
    *,
    fallback_budget: int,
) -> int:
    metadata = source.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size != entry.size:
        raise SandboxError(f"task asset snapshot file changed: {entry.path}")
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    source_descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    destination_descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    fallback_bytes = 0
    try:
        opened = os.fstat(source_descriptor)
        if _mutation_identity(opened) != _mutation_identity(metadata):
            raise SandboxError(f"task asset snapshot file changed: {entry.path}")
        if _try_reflink(source_descriptor, destination_descriptor):
            if os.fstat(destination_descriptor).st_size != entry.size:
                raise SandboxError(f"task asset reflink produced an invalid file: {entry.path}")
        else:
            if entry.size > fallback_budget:
                raise SandboxError(
                    "task asset filesystem cannot reflink the snapshot and the buffered fallback limit would be exceeded"
                )
            os.ftruncate(destination_descriptor, 0)
            os.lseek(source_descriptor, 0, os.SEEK_SET)
            while True:
                chunk = os.read(source_descriptor, COPY_CHUNK_BYTES)
                if not chunk:
                    break
                _write_all(destination_descriptor, chunk)
                fallback_bytes += len(chunk)
            if fallback_bytes != entry.size:
                raise SandboxError(f"task asset snapshot file changed while materializing: {entry.path}")
        if _mutation_identity(opened) != _mutation_identity(os.fstat(source_descriptor)):
            raise SandboxError(f"task asset snapshot file changed while materializing: {entry.path}")
        os.fchmod(destination_descriptor, 0o600)
    finally:
        os.close(destination_descriptor)
        os.close(source_descriptor)
    try:
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return fallback_bytes


def _try_reflink(source_descriptor: int, destination_descriptor: int) -> bool:
    try:
        fcntl.ioctl(destination_descriptor, FICLONE, source_descriptor)
        return True
    except OSError as exc:
        if exc.errno in _REFLINK_UNAVAILABLE:
            return False
        raise


def _read_source_chunk(descriptor: int, size: int) -> bytes:
    return os.read(descriptor, size)


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("short write while copying task assets")
        view = view[written:]


def _mutation_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _validate_manifest_path(relative: PurePosixPath) -> None:
    try:
        path_bytes = len(relative.as_posix().encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise SandboxError(f"sandbox_copy path is not valid UTF-8: {relative!s}") from exc
    if path_bytes > MAX_TASK_ASSET_PATH_BYTES:
        raise SandboxError("sandbox_copy exceeds the path byte limit")


def _manifest_digest(entries: tuple[AssetManifestEntry, ...]) -> str:
    payload = [
        {
            "kind": entry.kind,
            "link_target": entry.link_target,
            "mode": entry.mode,
            "path": entry.path.as_posix(),
            "sha256": entry.sha256,
            "size": entry.size,
        }
        for entry in entries
    ]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _dependency_digests(dependencies: tuple[DependencySnapshot, ...]) -> tuple[str, str]:
    content_payload = [
        {
            "entries": [
                {
                    "kind": entry.kind,
                    "link_target": entry.link_target,
                    "mode": entry.mode,
                    "path": entry.path.as_posix(),
                    "sha256": entry.sha256,
                    "size": entry.size,
                }
                for entry in dependency.entries
            ]
        }
        for dependency in dependencies
    ]
    content_digest = hashlib.sha256(
        json.dumps(content_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    manifest_payload = {
        "dependencies": [
            {
                "content": content,
                "source": dependency.source,
                "target": dependency.target,
            }
            for dependency, content in zip(dependencies, content_payload, strict=True)
        ],
        "schema_version": 1,
    }
    manifest_digest = hashlib.sha256(
        json.dumps(manifest_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return content_digest, manifest_digest


def _validate_dependency_binding_values(
    binding: Mapping[str, Any],
    *,
    content_digest: str,
    manifest_digest: str,
) -> None:
    expected = {
        DEPENDENCY_CONTENT_BINDING_FIELD: content_digest,
        DEPENDENCY_MANIFEST_BINDING_FIELD: manifest_digest,
    }
    supplied = {field: binding.get(field) for field in expected}
    if supplied != expected:
        raise SandboxError("sandbox dependency content changed after task binding")


def _snapshot_digest(
    *,
    repo_identity: Path,
    resolved_sha: str,
    declarations: tuple[str, ...],
    manifest_digest: str,
    dependency_content_digest: str,
    dependency_manifest_digest: str,
) -> str:
    payload = {
        "declarations": declarations,
        "dependency_content_digest": dependency_content_digest,
        "dependency_manifest_digest": dependency_manifest_digest,
        "manifest_digest": manifest_digest,
        "repo_identity": str(repo_identity),
        "resolved_sha": resolved_sha,
        "schema_version": 2,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _freeze_snapshot(root: Path) -> None:
    for current, directories, files in os.walk(root, topdown=False, followlinks=False):
        for name in files:
            path = Path(current) / name
            mode = path.lstat().st_mode
            relative = path.relative_to(root)
            if stat.S_ISLNK(mode):
                if not relative.parts or relative.parts[0] != "dependencies":
                    raise SandboxError(f"task asset snapshot contains an unexpected symlink: {path}")
                continue
            if not stat.S_ISREG(mode):
                raise SandboxError(f"task asset snapshot contains a special file: {path}")
            path.chmod(0o400 | (0o100 if stat.S_IMODE(mode) & 0o111 else 0))
        for name in directories:
            path = Path(current) / name
            mode = path.lstat().st_mode
            relative = path.relative_to(root)
            if stat.S_ISLNK(mode):
                if not relative.parts or relative.parts[0] != "dependencies":
                    raise SandboxError(f"task asset snapshot contains an unexpected symlink: {path}")
                continue
            if not stat.S_ISDIR(mode):
                raise SandboxError(f"task asset snapshot contains a special directory: {path}")
            path.chmod(0o500)
        Path(current).chmod(0o500)


def _thaw_tree(root: Path) -> None:
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        Path(current).chmod(0o700)
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink():
                path.chmod(0o700)
        for name in files:
            path = Path(current) / name
            if not path.is_symlink():
                path.chmod(0o600)


def capture_task_dependency_binding(
    task: Mapping[str, Any],
    *,
    repo: Path,
    resolved_sha: str,
) -> dict[str, str]:
    """Capture dependency bytes long enough to produce their canonical binding."""

    dependency_task = {
        "sandbox_copy": [],
        "sandbox_dependencies": task.get("sandbox_dependencies", []),
    }
    with tempfile.TemporaryDirectory(prefix="wfbench-dependency-binding-") as temporary:
        with TaskAssetCache(Path(temporary) / "cache") as cache:
            snapshot = cache.prepare(dependency_task, repo=repo, resolved_sha=resolved_sha)
            return snapshot.dependency_binding


def _dependency_mounts(
    task: Mapping[str, Any],
    *,
    clone: Path,
    snapshot: TaskAssetSnapshot,
) -> list[ReadOnlyMount]:
    declarations = tuple(
        (declaration.source, declaration.target)
        for declaration in _sandbox_dependency_declarations(task)
    )
    if snapshot.dependency_declarations != declarations:
        raise SandboxError("task asset snapshot does not match this dependency declaration")
    return snapshot.dependency_mounts(clone)


def stage_task_assets(
    task: Mapping[str, Any],
    *,
    repo: Path,
    clone: Path,
    snapshot: TaskAssetSnapshot | None = None,
) -> list[ReadOnlyMount]:
    """Materialize copied assets and validate read-only dependency mounts.

    ``snapshot`` is supplied by the benchmark runner so every arm reuses one
    capture.  The optional path preserves the historic standalone helper API
    for containment tests and external callers.
    """

    repo_identity = _real_directory(repo, label="task asset repository")
    declarations, _ = _sandbox_copy_declarations(task)
    if snapshot is not None:
        if snapshot.repo_identity != repo_identity or snapshot.declarations != declarations:
            raise SandboxError("task asset snapshot does not match this task declaration")
        snapshot.materialize(clone)
        return _dependency_mounts(task, clone=clone, snapshot=snapshot)

    if _sandbox_dependency_declarations(task):
        raise SandboxError("sandbox_dependencies require a caller-owned immutable task asset snapshot")

    with tempfile.TemporaryDirectory(prefix="wfbench-asset-snapshot-") as temporary:
        with TaskAssetCache(Path(temporary) / "cache") as cache:
            ephemeral = cache.prepare(task, repo=repo_identity, resolved_sha="unbound")
            ephemeral.materialize(clone)
    return []
