"""Trusted runtime views for isolated workflow-benchmark sessions.

The benchmark never mounts an operator checkout wholesale. GitNexus is
exposed as a minimal, harness-owned runtime, while the optional Compound
Engineering comparator is copied into a bounded immutable snapshot containing
only Claude plugin inputs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .proposer_sandbox import (
    SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_SHARED,
    ReadOnlyMount,
    SandboxError,
)

PINNED_GITNEXUS_VERSION = "1.6.9"
HARNESS_ROOT = Path(__file__).resolve().parents[2]

CE_ARMS = frozenset({"ce_workflow", "ce_workflow_direct", "ce_review"})
SANDBOX_CE_PLUGIN = "/opt/compound-engineering-plugin"
CE_PLUGIN_MANIFEST_SCHEMA_VERSION = 1
MAX_CE_PLUGIN_FILES = 2_048
MAX_CE_PLUGIN_FILE_BYTES = 2 * 1024 * 1024
MAX_CE_PLUGIN_TOTAL_BYTES = 16 * 1024 * 1024
MAX_CE_PLUGIN_PATH_BYTES = 1_024

_EXACT_VERSION = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
_ALLOWED_PLUGIN_DIRS = ("skills", "scripts", "assets")
_ALLOWED_PLUGIN_MANIFESTS = (
    PurePosixPath(".claude-plugin/plugin.json"),
    PurePosixPath(".claude-plugin/marketplace.json"),
)
_FORBIDDEN_PATH_PARTS = frozenset(
    {
        ".git",
        ".github",
        ".ssh",
        ".aws",
        "test",
        "tests",
        "doc",
        "docs",
        "node_modules",
        "__pycache__",
    }
)
_SECRET_EXACT_NAMES = frozenset(
    {
        ".env",
        ".npmrc",
        ".netrc",
        ".pypirc",
        "credentials",
        "credentials.json",
        "secrets",
        "secrets.json",
    }
)
_SECRET_NAME_MARKERS = ("secret", "credential", "private-key", "private_key", "token")
_SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".kdbx")


@dataclass(frozen=True)
class CePluginConfig:
    """Explicit operator input for one pinned CE plugin release."""

    source: Path
    version: str


@dataclass(frozen=True)
class CePluginSnapshot:
    """A bounded read-only plugin tree and its content identity."""

    root: Path
    version: str
    manifest_digest: str
    file_count: int
    total_bytes: int

    @property
    def mount(self) -> ReadOnlyMount:
        return ReadOnlyMount(source=self.root, target=SANDBOX_CE_PLUGIN)

    @property
    def provenance(self) -> dict[str, Any]:
        return {
            "name": "compound-engineering",
            "version": self.version,
            "manifest_schema_version": CE_PLUGIN_MANIFEST_SCHEMA_VERSION,
            "manifest_digest": self.manifest_digest,
            "file_count": self.file_count,
            "total_bytes": self.total_bytes,
        }


def ce_plugin_mounts_for_arm(
    arm: str,
    snapshot: CePluginSnapshot | None,
) -> tuple[ReadOnlyMount, ...]:
    """Expose the staged comparator only to CE arms."""

    if arm not in CE_ARMS:
        return ()
    if snapshot is None:
        raise SandboxError("ce_* arm has no staged Compound Engineering plugin")
    return (snapshot.mount,)


def ce_plugin_dir_for_arm(arm: str, snapshot: CePluginSnapshot | None) -> str | None:
    """Return Claude's fixed in-sandbox plugin path only for CE arms."""

    ce_plugin_mounts_for_arm(arm, snapshot)
    return SANDBOX_CE_PLUGIN if arm in CE_ARMS else None


def _validated_runtime_root(path: Path, *, label: str) -> Path:
    """Return one real directory without accepting any symlink hop."""

    root = path.expanduser().absolute()
    try:
        mode = root.lstat().st_mode
        resolved = root.resolve(strict=True)
    except OSError as exc:
        raise SandboxError(f"{label} is unavailable: {root}: {exc}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or resolved != root:
        raise SandboxError(f"{label} must be a real directory: {root}")
    return root


def _validated_runtime_component(
    root: Path,
    relative: str,
    target: str,
    *,
    directory: bool,
) -> ReadOnlyMount:
    """Validate one direct runtime component before exposing only that path."""

    source = root / relative
    try:
        mode = source.lstat().st_mode
        resolved = source.resolve(strict=True)
    except OSError as exc:
        raise SandboxError(f"pinned GitNexus runtime component is unavailable: {source}: {exc}") from exc
    expected_type = stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)
    if stat.S_ISLNK(mode) or not expected_type or resolved != source:
        kind = "directory" if directory else "file"
        raise SandboxError(f"pinned GitNexus runtime component must be a real {kind}: {source}")
    return ReadOnlyMount(source=source, target=target)


def trusted_gitnexus_runtime_mounts() -> tuple[ReadOnlyMount, ...]:
    """Expose only the files needed by the pinned CLI and linked shared package."""

    runtime = _validated_runtime_root(
        HARNESS_ROOT / "gitnexus",
        label="pinned GitNexus runtime",
    )
    shared = _validated_runtime_root(
        HARNESS_ROOT / "gitnexus-shared",
        label="pinned GitNexus shared runtime",
    )
    mounts = (
        _validated_runtime_component(
            runtime,
            "dist",
            f"{SANDBOX_GITNEXUS}/dist",
            directory=True,
        ),
        _validated_runtime_component(
            runtime,
            "package.json",
            f"{SANDBOX_GITNEXUS}/package.json",
            directory=False,
        ),
        _validated_runtime_component(
            runtime,
            "node_modules",
            f"{SANDBOX_GITNEXUS}/node_modules",
            directory=True,
        ),
        _validated_runtime_component(
            runtime,
            "vendor",
            f"{SANDBOX_GITNEXUS}/vendor",
            directory=True,
        ),
        _validated_runtime_component(
            shared,
            "dist",
            f"{SANDBOX_GITNEXUS_SHARED}/dist",
            directory=True,
        ),
        _validated_runtime_component(
            shared,
            "package.json",
            f"{SANDBOX_GITNEXUS_SHARED}/package.json",
            directory=False,
        ),
        _validated_runtime_component(
            runtime,
            "hooks/claude",
            f"{SANDBOX_GITNEXUS}/hooks/claude",
            directory=True,
        ),
    )

    entrypoint = mounts[0].source / "cli" / "index.js"
    try:
        entrypoint_mode = entrypoint.lstat().st_mode
        package = json.loads(mounts[1].source.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SandboxError(f"pinned GitNexus runtime metadata is invalid: {exc}") from exc
    if stat.S_ISLNK(entrypoint_mode) or not stat.S_ISREG(entrypoint_mode):
        raise SandboxError(f"pinned GitNexus runtime entrypoint must be regular and non-symlink: {entrypoint}")
    if package.get("version") != PINNED_GITNEXUS_VERSION:
        raise SandboxError(
            "pinned GitNexus runtime version drifted: "
            f"expected {PINNED_GITNEXUS_VERSION}, got {package.get('version')!r}"
        )

    linked_shared = mounts[2].source / "gitnexus-shared"
    if not linked_shared.is_symlink() or linked_shared.resolve(strict=True) != shared:
        raise SandboxError("pinned GitNexus runtime has an unexpected gitnexus-shared dependency")
    try:
        shared_package = json.loads(mounts[5].source.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SandboxError(f"pinned GitNexus shared runtime metadata is invalid: {exc}") from exc
    if shared_package.get("name") != "gitnexus-shared":
        raise SandboxError("pinned GitNexus shared runtime has an unexpected package identity")
    return mounts


def validate_ce_plugin_inputs(
    arms: Sequence[str],
    plugin_dir: Path | None,
    plugin_version: str | None,
) -> CePluginConfig | None:
    """Require an explicit directory and exact version iff a CE arm is selected."""

    has_ce_arm = any(arm in CE_ARMS for arm in arms)
    supplied = plugin_dir is not None or plugin_version is not None
    if not has_ce_arm:
        if supplied:
            raise ValueError("--ce-plugin-dir and --ce-plugin-version require at least one ce_* arm")
        return None
    if plugin_dir is None or plugin_version is None:
        raise ValueError("ce_* arms require both --ce-plugin-dir and --ce-plugin-version")
    if _EXACT_VERSION.fullmatch(plugin_version) is None:
        raise ValueError("--ce-plugin-version must be an exact semantic version (aliases and ranges are forbidden)")
    source = _validated_runtime_root(plugin_dir, label="Compound Engineering plugin source")
    return CePluginConfig(source=source, version=plugin_version)


def _is_forbidden_plugin_path(relative: PurePosixPath) -> bool:
    for part in relative.parts:
        lowered = part.lower()
        if lowered in _FORBIDDEN_PATH_PARTS or lowered in _SECRET_EXACT_NAMES:
            return True
        if lowered.startswith(".env.") or lowered.startswith(".npmrc."):
            return True
        if lowered.endswith(_SECRET_SUFFIXES) or any(marker in lowered for marker in _SECRET_NAME_MARKERS):
            return True
    return False


def _plugin_files(source: Path) -> Iterator[tuple[PurePosixPath, Path]]:
    """Yield only allowlisted plugin files in stable order."""

    manifest_root = source / ".claude-plugin"
    try:
        manifest_root_metadata = manifest_root.lstat()
    except OSError as exc:
        raise SandboxError(
            f"Compound Engineering plugin manifest directory is unavailable: {manifest_root}: {exc}"
        ) from exc
    if stat.S_ISLNK(manifest_root_metadata.st_mode) or not stat.S_ISDIR(manifest_root_metadata.st_mode):
        raise SandboxError(f"Compound Engineering plugin manifest directory must be real: {manifest_root}")
    required_manifest = _ALLOWED_PLUGIN_MANIFESTS[0]
    manifest_path = source / Path(*required_manifest.parts)
    if not manifest_path.exists():
        raise SandboxError(f"Compound Engineering plugin manifest is missing: {manifest_path}")
    for relative in _ALLOWED_PLUGIN_MANIFESTS:
        candidate = source / Path(*relative.parts)
        if candidate.exists():
            yield relative, candidate

    skills = source / "skills"
    if not skills.exists():
        raise SandboxError(f"Compound Engineering plugin skills directory is missing: {skills}")

    def walk(directory: Path, relative_dir: PurePosixPath) -> Iterator[tuple[PurePosixPath, Path]]:
        try:
            with os.scandir(directory) as scanned:
                entries = sorted(scanned, key=lambda entry: entry.name)
        except OSError as exc:
            raise SandboxError(f"Compound Engineering plugin directory is unreadable: {directory}: {exc}") from exc
        for entry in entries:
            relative = relative_dir / entry.name
            if _is_forbidden_plugin_path(relative):
                continue
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise SandboxError(f"Compound Engineering plugin entry is unreadable: {entry.path}: {exc}") from exc
            if stat.S_ISLNK(metadata.st_mode):
                raise SandboxError(f"Compound Engineering plugin entries must not be symlinks: {entry.path}")
            if stat.S_ISDIR(metadata.st_mode):
                yield from walk(Path(entry.path), relative)
            elif stat.S_ISREG(metadata.st_mode):
                yield relative, Path(entry.path)
            else:
                raise SandboxError(f"Compound Engineering plugin entries must be regular files: {entry.path}")

    for name in _ALLOWED_PLUGIN_DIRS:
        directory = source / name
        if not directory.exists():
            continue
        try:
            metadata = directory.lstat()
        except OSError as exc:
            raise SandboxError(f"Compound Engineering plugin component is unreadable: {directory}: {exc}") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise SandboxError(f"Compound Engineering plugin component must be a real directory: {directory}")
        yield from walk(directory, PurePosixPath(name))


def _bounded_plugin_bytes(path: Path) -> tuple[bytes, bool]:
    """Read one stable regular file without following a last-component symlink."""

    try:
        before = path.lstat()
    except OSError as exc:
        raise SandboxError(f"Compound Engineering plugin file is unreadable: {path}: {exc}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise SandboxError(f"Compound Engineering plugin file must be regular and non-symlink: {path}")
    if before.st_size > MAX_CE_PLUGIN_FILE_BYTES:
        raise SandboxError(f"Compound Engineering plugin file exceeds the per-file limit: {path}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(opened.st_mode):
            raise SandboxError(f"Compound Engineering plugin file changed during validation: {path}")
        chunks: list[bytes] = []
        remaining = MAX_CE_PLUGIN_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if len(payload) > MAX_CE_PLUGIN_FILE_BYTES:
        raise SandboxError(f"Compound Engineering plugin file exceeds the per-file limit: {path}")
    identity_before = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_after != identity_before or len(payload) != after.st_size:
        raise SandboxError(f"Compound Engineering plugin file changed while being copied: {path}")
    return payload, bool(before.st_mode & 0o111)


def _write_snapshot_file(path: Path, payload: bytes, *, executable: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o500 if executable else 0o400,
    )
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fchmod(descriptor, 0o555 if executable else 0o444)
    finally:
        os.close(descriptor)


def _freeze_snapshot(root: Path) -> None:
    for directory, _, _ in os.walk(root, topdown=False):
        Path(directory).chmod(0o555)
    root.chmod(0o555)


def _remove_snapshot(root: Path) -> None:
    if not root.exists():
        return
    for directory, _, files in os.walk(root):
        for name in files:
            (Path(directory) / name).chmod(0o600)
        Path(directory).chmod(0o700)
    shutil.rmtree(root)


def _build_ce_plugin_snapshot(config: CePluginConfig, destination_parent: Path) -> CePluginSnapshot:
    parent = _validated_runtime_root(destination_parent, label="CE plugin snapshot parent")
    root = Path(tempfile.mkdtemp(prefix="wfbench-ce-plugin-", dir=parent))
    root.chmod(0o700)
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    try:
        for relative, source in _plugin_files(config.source):
            relative_text = relative.as_posix()
            if len(relative_text.encode()) > MAX_CE_PLUGIN_PATH_BYTES:
                raise SandboxError(f"Compound Engineering plugin path exceeds the byte limit: {relative_text}")
            if len(entries) >= MAX_CE_PLUGIN_FILES:
                raise SandboxError("Compound Engineering plugin exceeds the file-count limit")
            payload, executable = _bounded_plugin_bytes(source)
            total_bytes += len(payload)
            if total_bytes > MAX_CE_PLUGIN_TOTAL_BYTES:
                raise SandboxError("Compound Engineering plugin exceeds the total byte limit")
            _write_snapshot_file(
                root / Path(*relative.parts),
                payload,
                executable=executable,
            )
            entries.append(
                {
                    "path": relative_text,
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "size": len(payload),
                    "executable": executable,
                }
            )

        manifest_path = root / ".claude-plugin" / "plugin.json"
        try:
            plugin_manifest = json.loads(manifest_path.read_text())
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise SandboxError(f"Compound Engineering plugin manifest is invalid: {exc}") from exc
        if not isinstance(plugin_manifest, dict) or plugin_manifest.get("name") != "compound-engineering":
            raise SandboxError("CE comparator requires the compound-engineering plugin manifest")
        if plugin_manifest.get("version") != config.version:
            raise SandboxError(
                "Compound Engineering plugin version mismatch: "
                f"expected {config.version}, got {plugin_manifest.get('version')!r}"
            )
        for skill in ("ce-plan", "ce-work", "ce-code-review"):
            if not (root / "skills" / skill / "SKILL.md").is_file():
                raise SandboxError(f"Compound Engineering plugin is missing required skill: {skill}")

        canonical_manifest = json.dumps(
            {
                "schema_version": CE_PLUGIN_MANIFEST_SCHEMA_VERSION,
                "files": entries,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        snapshot = CePluginSnapshot(
            root=root,
            version=config.version,
            manifest_digest=hashlib.sha256(canonical_manifest).hexdigest(),
            file_count=len(entries),
            total_bytes=total_bytes,
        )
        _freeze_snapshot(root)
        return snapshot
    except BaseException:
        _remove_snapshot(root)
        raise


@contextmanager
def staged_ce_plugin_snapshot(
    config: CePluginConfig | None,
    *,
    destination_parent: Path,
) -> Iterator[CePluginSnapshot | None]:
    """Yield one bounded immutable CE plugin view and remove it afterward."""

    if config is None:
        yield None
        return
    snapshot = _build_ce_plugin_snapshot(config, destination_parent)
    try:
        yield snapshot
    finally:
        _remove_snapshot(snapshot.root)
