"""Build one reusable GitNexus graph from a history-pruned task snapshot."""

from __future__ import annotations

import json
import os
import shutil
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .oracle_assets import HIDDEN_HARNESS_PATH, sanitize_clone_for_hidden_oracles
from .process_control import ManagedProcessError, run_managed
from .proposer_sandbox import (
    SANDBOX_GITNEXUS,
    SANDBOX_HOME,
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    build_sandbox_environment,
    prepare_sandbox,
)
from .runner_artifacts import make_worktree, remove_clone
from .task_assets import TaskAssetCache, TaskAssetSnapshot

GRAPH_ASSET_PATHS = (
    ".gitnexus/gitnexus.json",
    ".gitnexus/meta.json",
    ".gitnexus/lbug",
)
GRAPH_MARKERS = (
    "eval/workflow_bench",
    "workflow_bench/oracles",
    "GITNEXUS_BENCH_ORACLE_ROOT",
    "tasks.scenarios.yaml",
    ".oracle.test.",
    "wfbench-oracle",
)
GRAPH_BUILD_TIMEOUT_SECONDS = 3600
GRAPH_QUERY_TIMEOUT_SECONDS = 300
MAX_GRAPH_SCRUB_ENTRIES = 250_000
MAX_GRAPH_SCRUB_FILE_BYTES = 512 * 1024
MAX_GRAPH_SCRUB_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
SANDBOX_GITNEXUS_ENTRYPOINT = f"{SANDBOX_GITNEXUS}/dist/cli/index.js"
SANDBOX_INDEX_REGISTRY = f"{SANDBOX_HOME}/.gitnexus-index"


@dataclass(frozen=True)
class SanitizedGraphSnapshot:
    """A graph whose only source was one deterministic parentless commit."""

    assets: TaskAssetSnapshot
    sanitized_head: str

    @property
    def digest(self) -> str:
        return self.assets.digest

    @property
    def manifest_digest(self) -> str:
        return self.assets.manifest_digest

    def materialize(self, clone: Path, *, sanitized_head: str) -> None:
        if sanitized_head != self.sanitized_head:
            raise SandboxError(
                "sanitized task identity drifted between graph preparation and arm clone "
                f"({self.sanitized_head} != {sanitized_head})"
            )
        self.assets.materialize(clone)


def _is_restricted_path(value: str) -> bool:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        return False
    return (
        relative.parts[0] == ".gitnexus" or relative == HIDDEN_HARNESS_PATH or HIDDEN_HARNESS_PATH in relative.parents
    )


def validate_no_prebuilt_graph_assets(task: Mapping[str, Any]) -> None:
    """Reject declarations that could reintroduce an unsanitized graph/oracle."""

    sandbox_copy = task.get("sandbox_copy", [])
    if not isinstance(sandbox_copy, list):
        raise SandboxError("sandbox_copy must be a list")
    for value in sandbox_copy:
        if isinstance(value, str) and _is_restricted_path(value):
            raise SandboxError(f"sandbox_copy cannot import prebuilt graph or harness data: {value}")

    dependencies = task.get("sandbox_dependencies", [])
    if not isinstance(dependencies, list):
        raise SandboxError("sandbox_dependencies must be a list")
    for item in dependencies:
        if not isinstance(item, Mapping):
            continue
        for field in ("source", "target"):
            value = item.get(field)
            if isinstance(value, str) and _is_restricted_path(value):
                raise SandboxError(f"sandbox dependency cannot expose prebuilt graph or harness data: {value}")


def _replace_control_file(root: Path, name: str, payload: bytes) -> None:
    path = root / name
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None:
        if stat.S_ISDIR(metadata.st_mode):
            raise SandboxError(f"target-controlled {name} must not be a directory")
        path.unlink()
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError(f"short write while neutralizing {name}")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _neutralize_target_index_inputs(root: Path) -> None:
    index = root / ".gitnexus"
    try:
        metadata = index.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise SandboxError("target .gitnexus path must be a real directory before graph preparation")
        shutil.rmtree(index)
    _replace_control_file(root, ".gitnexusrc", b"{}\n")
    _replace_control_file(root, ".gitnexusignore", b"")


def _scrub_source_references(root: Path) -> tuple[str, ...]:
    """Remove graph inputs whose path or stored content references the harness.

    The disposable graph seed may contain docs or shipped skill copies outside
    the removed harness that name its paths. They are harmless implementation
    context in an arm checkout, but indexing them would let graph/MCP queries
    recover benchmark-specific hints. Scan the exact <=512 KiB file universe
    admitted by the pinned analyzer and remove contaminated inputs before the
    graph is built. Target-controlled ignore/config files are not consulted.
    """

    marker_bytes = tuple(marker.encode() for marker in GRAPH_MARKERS)
    pending: list[tuple[Path, PurePosixPath]] = [(root, PurePosixPath())]
    removed: list[str] = []
    entries = 0
    scanned_bytes = 0
    while pending:
        directory, relative_directory = pending.pop()
        try:
            children = sorted(os.scandir(directory), key=lambda item: item.name, reverse=True)
        except OSError as exc:
            raise SandboxError(f"cannot scan sanitized graph source: {directory}: {exc}") from exc
        for entry in children:
            relative = relative_directory / entry.name
            if relative.parts[0] in {".git", ".gitnexus"}:
                continue
            entries += 1
            if entries > MAX_GRAPH_SCRUB_ENTRIES:
                raise SandboxError("sanitized graph source exceeds the scrub entry limit")
            relative_text = relative.as_posix()
            metadata = entry.stat(follow_symlinks=False)
            path_matches = any(marker in relative_text for marker in GRAPH_MARKERS)
            if path_matches:
                path = Path(entry.path)
                if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                    shutil.rmtree(path)
                else:
                    path.unlink()
                removed.append(relative_text)
                continue
            if stat.S_ISDIR(metadata.st_mode):
                pending.append((Path(entry.path), relative))
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                continue
            if metadata.st_size > MAX_GRAPH_SCRUB_FILE_BYTES:
                continue
            scanned_bytes += metadata.st_size
            if scanned_bytes > MAX_GRAPH_SCRUB_TOTAL_BYTES:
                raise SandboxError("sanitized graph source exceeds the scrub byte limit")
            descriptor = os.open(entry.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino, opened.st_size) != (
                    metadata.st_dev,
                    metadata.st_ino,
                    metadata.st_size,
                ):
                    raise SandboxError(f"sanitized graph source changed while opening: {relative}")
                chunks: list[bytes] = []
                remaining = MAX_GRAPH_SCRUB_FILE_BYTES + 1
                while remaining > 0:
                    chunk = os.read(descriptor, min(64 * 1024, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                payload = b"".join(chunks)
                after = os.fstat(descriptor)
                if len(payload) != opened.st_size or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
                    after.st_size,
                    after.st_mtime_ns,
                    after.st_ctime_ns,
                ):
                    raise SandboxError(f"sanitized graph source changed while scanning: {relative}")
            finally:
                os.close(descriptor)
            if any(marker in payload for marker in marker_bytes):
                Path(entry.path).unlink()
                removed.append(relative_text)
    return tuple(sorted(removed))


def _graph_environment() -> dict[str, str]:
    env = build_sandbox_environment()
    env.update(
        {
            "GITNEXUS_HOME": SANDBOX_INDEX_REGISTRY,
            "GITNEXUS_NO_GITIGNORE": "1",
            "GITNEXUS_WORKER_POOL_SIZE": "1",
            "GITNEXUS_PARSE_CHUNK_CONCURRENCY": "1",
        }
    )
    return env


def _run_graph_cli(
    prefix: Sequence[str],
    arguments: Sequence[str],
    *,
    timeout: int,
    capture_stdout: bool = False,
) -> bytes | None:
    command = [
        *prefix,
        "/usr/local/bin/node",
        SANDBOX_GITNEXUS_ENTRYPOINT,
        *arguments,
    ]
    result = run_managed(
        command,
        timeout=timeout,
        env=_graph_environment(),
        require_pid_namespace=True,
        capture_stdout_bytes=(2 * 1024 * 1024 if capture_stdout else None),
    )
    if not result.ok:
        raise ManagedProcessError(command, result)
    if not capture_stdout:
        return None
    if result.stdout_capture is None or result.stdout_capture_overflow:
        raise SandboxError("bounded graph-query output was unavailable")
    return result.stdout_capture


def _marker_predicate(variable: str) -> str:
    literals = ("'" + marker.replace("\\", "\\\\").replace("'", "\\'") + "'" for marker in GRAPH_MARKERS)
    return " OR ".join(f"CAST({variable} AS STRING) CONTAINS {literal}" for literal in literals)


def _parse_empty_query(raw: bytes, *, label: str) -> None:
    try:
        payload = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise SandboxError(f"{label} did not return strict JSON") from exc
    if payload == []:
        return
    if isinstance(payload, dict) and payload.get("row_count") == 0:
        return
    raise SandboxError(f"{label} found recoverable benchmark harness references")


def _scrub_and_verify_graph(prefix: Sequence[str]) -> None:
    node_predicate = _marker_predicate("n")
    relation_predicate = _marker_predicate("r")
    node_result = _run_graph_cli(
        prefix,
        ("cypher", f"MATCH (n) WHERE {node_predicate} RETURN n LIMIT 1", "-r", "benchmark-target", "--limit", "1"),
        timeout=GRAPH_QUERY_TIMEOUT_SECONDS,
        capture_stdout=True,
    )
    relation_result = _run_graph_cli(
        prefix,
        (
            "cypher",
            f"MATCH ()-[r]->() WHERE {relation_predicate} RETURN r LIMIT 1",
            "-r",
            "benchmark-target",
            "--limit",
            "1",
        ),
        timeout=GRAPH_QUERY_TIMEOUT_SECONDS,
        capture_stdout=True,
    )
    assert node_result is not None and relation_result is not None
    _parse_empty_query(node_result, label="sanitized graph node proof")
    _parse_empty_query(relation_result, label="sanitized graph relation proof")


def _validate_graph_metadata(root: Path, sanitized_head: str) -> None:
    for name in ("gitnexus.json", "meta.json", "lbug"):
        path = root / ".gitnexus" / name
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise SandboxError(f"sanitized graph asset must be regular and non-symlink: {path}")
    try:
        metadata_payload = json.loads((root / ".gitnexus" / "gitnexus.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SandboxError("sanitized graph metadata is malformed") from exc
    if metadata_payload.get("lastCommit") != sanitized_head:
        raise SandboxError("sanitized graph metadata is not bound to the parentless task commit")
    if not isinstance(metadata_payload.get("pdg"), dict) or not metadata_payload["pdg"]:
        raise SandboxError("sanitized graph metadata does not prove a --pdg build")


def prepare_sanitized_graph(
    task: Mapping[str, Any],
    *,
    repo: Path,
    resolved_sha: str,
    parent: Path,
    cache: TaskAssetCache,
    claude_bin: Path | str,
    bwrap_bin: Path | str,
    runtime_mounts: Sequence[ReadOnlyMount],
) -> SanitizedGraphSnapshot:
    """Sanitize, index offline once, scrub, and freeze graph assets for all arms."""

    validate_no_prebuilt_graph_assets(task)
    seed = make_worktree(repo, resolved_sha, parent)
    primary: BaseException | None = None
    try:
        sanitized_head = sanitize_clone_for_hidden_oracles(seed)
        _scrub_source_references(seed)
        _neutralize_target_index_inputs(seed)
        with prepare_sandbox(
            clone=seed,
            claude_bin=claude_bin,
            bwrap_bin=bwrap_bin,
            read_only_mounts=runtime_mounts,
            preflight=False,
        ) as sandbox:
            prefix = sandbox.command_prefix_for(unshare_network=True)
            _run_graph_cli(
                prefix,
                (
                    "analyze",
                    SANDBOX_WORKSPACE,
                    "--force",
                    "--pdg",
                    "--index-only",
                    "--no-stats",
                    "--name",
                    "benchmark-target",
                    "--default-branch",
                    "main",
                    "--max-file-size",
                    "512",
                    "--workers",
                    "1",
                ),
                timeout=GRAPH_BUILD_TIMEOUT_SECONDS,
            )
            _scrub_and_verify_graph(prefix)
        _validate_graph_metadata(seed, sanitized_head)
        assets = cache.prepare(
            {"sandbox_copy": list(GRAPH_ASSET_PATHS)},
            repo=seed,
            resolved_sha=sanitized_head,
        )
        return SanitizedGraphSnapshot(assets=assets, sanitized_head=sanitized_head)
    except BaseException as exc:
        primary = exc
        raise
    finally:
        try:
            remove_clone(seed)
        except OSError as cleanup:
            if primary is None:
                raise
            primary.add_note(f"sanitized graph seed cleanup also failed: {cleanup}")
