"""Copy-on-write task-asset snapshot contracts."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

from workflow_bench.proposer_sandbox import VITE_TEMP_DIR, SandboxError
from workflow_bench.oracle_assets import TaskOracleSnapshot
from workflow_bench.runner_tasks import resolve_task_bindings
from workflow_bench.task_assets import TaskAssetCache, stage_task_assets
from workflow_bench import task_assets


SHA = "a" * 40


def _repo_and_task(tmp_path: Path, files: dict[str, bytes]) -> tuple[Path, dict[str, object]]:
    repo = tmp_path / "repo"
    repo.mkdir()
    for relative, payload in files.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    return repo, {"sandbox_copy": sorted(files), "sandbox_dependencies": []}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def test_snapshot_is_reused_frozen_and_isolates_arm_writes(monkeypatch, tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"assets/index": b"original"})
    clone_a = tmp_path / "clone-a"
    clone_b = tmp_path / "clone-b"
    clone_a.mkdir()
    clone_b.mkdir()
    reflink_calls: list[tuple[int, int]] = []

    def fake_reflink(source: int, destination: int) -> bool:
        reflink_calls.append((source, destination))
        while chunk := os.read(source, 1024):
            os.write(destination, chunk)
        return True

    monkeypatch.setattr(task_assets, "_try_reflink", fake_reflink)
    monkeypatch.setattr(task_assets, "MAX_BUFFERED_FALLBACK_BYTES", 0)

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        assert cache.prepare(task, repo=repo, resolved_sha=SHA) is snapshot
        snapshot_file = snapshot.root / "sandbox-copy" / "assets" / "index"
        assert stat.S_IMODE(snapshot.root.stat().st_mode) == 0o500
        assert stat.S_IMODE(snapshot_file.stat().st_mode) == 0o400

        stage_task_assets(task, repo=repo, clone=clone_a, snapshot=snapshot)
        stage_task_assets(task, repo=repo, clone=clone_b, snapshot=snapshot)
        (clone_a / "assets" / "index").write_bytes(b"arm-a")

        assert snapshot_file.read_bytes() == b"original"
        assert (clone_b / "assets" / "index").read_bytes() == b"original"
        assert (clone_a / "assets" / "index").stat().st_ino != snapshot_file.stat().st_ino
        assert (clone_b / "assets" / "index").stat().st_ino != snapshot_file.stat().st_ino
        assert len(reflink_calls) == 2


def test_snapshot_digest_binds_content_declaration_repo_and_sha(tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"one": b"1", "two": b"2"})
    with TaskAssetCache(tmp_path / "cache-a") as cache:
        original = cache.prepare(task, repo=repo, resolved_sha=SHA)
        other_sha = cache.prepare(task, repo=repo, resolved_sha="b" * 40)
        reordered = cache.prepare(
            {"sandbox_copy": ["two", "one"]},
            repo=repo,
            resolved_sha=SHA,
        )
    with TaskAssetCache(tmp_path / "cache-b") as cache:
        identical = cache.prepare(task, repo=repo, resolved_sha=SHA)
    (repo / "one").write_bytes(b"changed")
    with TaskAssetCache(tmp_path / "cache-c") as cache:
        changed = cache.prepare(task, repo=repo, resolved_sha=SHA)

    assert identical.digest == original.digest
    assert identical.manifest_digest == original.manifest_digest
    assert other_sha.digest != original.digest
    assert other_sha.manifest_digest == original.manifest_digest
    assert reordered.digest != original.digest
    assert changed.digest != original.digest
    assert changed.manifest_digest != original.manifest_digest


def test_small_assets_use_a_bounded_buffered_fallback(monkeypatch, tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"first": b"abc", "second": b"def"})
    clone = tmp_path / "clone"
    clone.mkdir()
    monkeypatch.setattr(task_assets, "_try_reflink", lambda *_args: False)
    monkeypatch.setattr(task_assets, "MAX_BUFFERED_FALLBACK_BYTES", 6)

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        snapshot.materialize(clone)

    assert (clone / "first").read_bytes() == b"abc"
    assert (clone / "second").read_bytes() == b"def"


def test_default_buffered_fallback_budget_covers_a_realistic_large_asset(
    monkeypatch,
    tmp_path: Path,
) -> None:
    # 20 MiB exceeds the old 16 MiB default but must fit comfortably under
    # the current default, proving the real (non-monkeypatched) budget
    # constant is sized for a realistic large sandbox_copy asset such as the
    # harness's own pre-built graph index, not just tiny fixtures.
    payload = os.urandom(20 * 1024 * 1024)
    repo, task = _repo_and_task(tmp_path, {"large": payload})
    clone = tmp_path / "clone"
    clone.mkdir()
    monkeypatch.setattr(task_assets, "_try_reflink", lambda *_args: False)

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        snapshot.materialize(clone)

    assert (clone / "large").read_bytes() == payload


def test_large_asset_without_reflink_fails_before_publish_and_cleans_staging(
    monkeypatch,
    tmp_path: Path,
) -> None:
    repo, task = _repo_and_task(tmp_path, {"large": b"12345"})
    clone = tmp_path / "clone"
    clone.mkdir()
    monkeypatch.setattr(task_assets, "_try_reflink", lambda *_args: False)
    monkeypatch.setattr(task_assets, "MAX_BUFFERED_FALLBACK_BYTES", 4)

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        with pytest.raises(SandboxError, match="cannot reflink"):
            snapshot.materialize(clone)

    assert not (clone / "large").exists()
    assert not list(tmp_path.glob(".wfbench-assets-*"))


@pytest.mark.skipif(os.name == "nt", reason="symlink and FIFO contracts are POSIX-only")
@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_snapshot_rejects_links_and_special_files(tmp_path: Path, kind: str) -> None:
    repo = tmp_path / "repo"
    assets = repo / "assets"
    assets.mkdir(parents=True)
    if kind == "symlink":
        (repo / "outside").write_text("secret")
        (assets / "bad").symlink_to(repo / "outside")
    else:
        os.mkfifo(assets / "bad")

    with TaskAssetCache(tmp_path / "cache") as cache:
        with pytest.raises(SandboxError, match="regular files and directories|symlink"):
            cache.prepare({"sandbox_copy": ["assets"]}, repo=repo, resolved_sha=SHA)


def test_snapshot_rejects_a_file_mutated_during_capture(monkeypatch, tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"asset": b"original"})
    original_read = task_assets._read_source_chunk
    changed = False

    def mutate_after_first_read(descriptor: int, size: int) -> bytes:
        nonlocal changed
        chunk = original_read(descriptor, size)
        if chunk and not changed:
            changed = True
            with (repo / "asset").open("ab") as source:
                source.write(b"!")
        return chunk

    monkeypatch.setattr(task_assets, "_read_source_chunk", mutate_after_first_read)
    with TaskAssetCache(tmp_path / "cache") as cache:
        with pytest.raises(SandboxError, match="changed while snapshotting"):
            cache.prepare(task, repo=repo, resolved_sha=SHA)


@pytest.mark.parametrize(
    ("limit", "value", "task_files", "message"),
    [
        ("MAX_TASK_ASSET_ENTRIES", 1, {"nested/file": b"x"}, "entry limit"),
        ("MAX_TASK_ASSET_PATH_BYTES", 4, {"long-name": b"x"}, "path byte limit"),
        ("MAX_TASK_ASSET_BYTES", 4, {"asset": b"12345"}, "total byte limit"),
    ],
)
def test_snapshot_enforces_hard_walk_limits(
    monkeypatch,
    tmp_path: Path,
    limit: str,
    value: int,
    task_files: dict[str, bytes],
    message: str,
) -> None:
    repo, task = _repo_and_task(tmp_path, task_files)
    monkeypatch.setattr(task_assets, limit, value)
    with TaskAssetCache(tmp_path / "cache") as cache:
        with pytest.raises(SandboxError, match=message):
            cache.prepare(task, repo=repo, resolved_sha=SHA)


def test_snapshot_rejects_overlapping_declarations(tmp_path: Path) -> None:
    repo, _task = _repo_and_task(tmp_path, {"assets/index": b"index"})
    with TaskAssetCache(tmp_path / "cache") as cache:
        with pytest.raises(SandboxError, match="overlap"):
            cache.prepare(
                {"sandbox_copy": ["assets", "assets/index"]},
                repo=repo,
                resolved_sha=SHA,
            )


def test_directory_materialization_removes_stale_children_exactly(tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"assets/current": b"captured"})
    task["sandbox_copy"] = ["assets"]
    clone = tmp_path / "clone"
    (clone / "assets" / "nested").mkdir(parents=True)
    (clone / "assets" / "current").write_bytes(b"old")
    (clone / "assets" / "stale").write_bytes(b"stale")
    (clone / "assets" / "nested" / "stale").write_bytes(b"stale")

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        snapshot.materialize(clone)

    assert sorted(path.relative_to(clone).as_posix() for path in clone.rglob("*")) == [
        "assets",
        "assets/current",
    ]
    assert (clone / "assets" / "current").read_bytes() == b"captured"


@pytest.mark.parametrize("source_kind", ["file", "directory"])
def test_materialization_replaces_file_directory_type_conflicts(
    tmp_path: Path,
    source_kind: str,
) -> None:
    if source_kind == "file":
        repo, task = _repo_and_task(tmp_path, {"asset": b"file"})
    else:
        repo, task = _repo_and_task(tmp_path, {"asset/child": b"directory"})
        task["sandbox_copy"] = ["asset"]
    clone = tmp_path / "clone"
    clone.mkdir()
    if source_kind == "file":
        (clone / "asset").mkdir()
        (clone / "asset" / "stale").write_bytes(b"stale")
    else:
        (clone / "asset").write_bytes(b"stale file")

    with TaskAssetCache(tmp_path / "cache") as cache:
        cache.prepare(task, repo=repo, resolved_sha=SHA).materialize(clone)

    if source_kind == "file":
        assert (clone / "asset").is_file()
        assert (clone / "asset").read_bytes() == b"file"
    else:
        assert (clone / "asset").is_dir()
        assert (clone / "asset" / "child").read_bytes() == b"directory"


@pytest.mark.skipif(os.name == "nt", reason="symlink containment is POSIX-only")
def test_exact_tree_removal_does_not_follow_stale_child_symlinks(tmp_path: Path) -> None:
    repo, task = _repo_and_task(tmp_path, {"assets/current": b"captured"})
    task["sandbox_copy"] = ["assets"]
    clone = tmp_path / "clone"
    outside = tmp_path / "outside"
    (clone / "assets").mkdir(parents=True)
    outside.mkdir()
    (outside / "canary").write_bytes(b"outside")
    (clone / "assets" / "stale-link").symlink_to(outside, target_is_directory=True)

    with TaskAssetCache(tmp_path / "cache") as cache:
        cache.prepare(task, repo=repo, resolved_sha=SHA).materialize(clone)

    assert (outside / "canary").read_bytes() == b"outside"
    assert not (clone / "assets" / "stale-link").exists()


def test_dependency_snapshot_mounts_bound_bytes_and_rejects_later_live_drift(tmp_path: Path) -> None:
    repo, _ = _repo_and_task(tmp_path, {"dependency/package.json": b'{"version":1}'})
    task = {
        "sandbox_copy": [],
        "sandbox_dependencies": [{"source": "dependency", "target": "node_modules/dependency"}],
    }
    clone = tmp_path / "clone"
    clone.mkdir()

    with TaskAssetCache(tmp_path / "cache-a") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        binding = snapshot.dependency_binding
        mounts = stage_task_assets(task, repo=repo, clone=clone, snapshot=snapshot)
        assert mounts[0].source != (repo / "dependency").resolve()
        assert (mounts[0].source / "package.json").read_bytes() == b'{"version":1}'

    (repo / "dependency" / "package.json").write_bytes(b'{"version":2}')
    with TaskAssetCache(tmp_path / "cache-b") as cache:
        with pytest.raises(SandboxError, match="changed after task binding"):
            cache.prepare(
                task,
                repo=repo,
                resolved_sha=SHA,
                expected_dependency_binding=binding,
            )


def test_dependency_content_and_manifest_digests_bind_distinct_contracts(tmp_path: Path) -> None:
    repo, _ = _repo_and_task(tmp_path, {"dependency/file": b"one"})
    task = {
        "sandbox_dependencies": [{"source": "dependency", "target": "dependency"}],
    }
    retargeted = {
        "sandbox_dependencies": [{"source": "dependency", "target": "vendor/dependency"}],
    }
    with TaskAssetCache(tmp_path / "cache-a") as cache:
        original = cache.prepare(task, repo=repo, resolved_sha=SHA)
        changed_target = cache.prepare(retargeted, repo=repo, resolved_sha=SHA)

    assert changed_target.dependency_content_digest == original.dependency_content_digest
    assert changed_target.dependency_manifest_digest != original.dependency_manifest_digest
    (repo / "dependency" / "file").write_bytes(b"two")
    with TaskAssetCache(tmp_path / "cache-b") as cache:
        changed_content = cache.prepare(task, repo=repo, resolved_sha=SHA)
    assert changed_content.dependency_content_digest != original.dependency_content_digest
    assert changed_content.dependency_manifest_digest != original.dependency_manifest_digest


@pytest.mark.skipif(os.name == "nt", reason="dependency symlink fixtures are POSIX-only")
def test_dependency_snapshot_preserves_internal_symlinks_and_executable_files(tmp_path: Path) -> None:
    repo, _ = _repo_and_task(tmp_path, {"dependency/package/bin": b"#!/bin/sh\nexit 0\n"})
    executable = repo / "dependency" / "package" / "bin"
    executable.chmod(0o755)
    (repo / "dependency" / ".bin").mkdir()
    (repo / "dependency" / ".bin" / "tool").symlink_to("../package/bin")
    task = {
        "sandbox_dependencies": [{"source": "dependency", "target": "dependency"}],
    }
    clone = tmp_path / "clone"
    clone.mkdir()

    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        mount = stage_task_assets(task, repo=repo, clone=clone, snapshot=snapshot)[0]
        link = mount.source / ".bin" / "tool"
        captured_executable = mount.source / "package" / "bin"
        assert link.is_symlink()
        assert os.readlink(link) == "../package/bin"
        assert stat.S_IMODE(captured_executable.stat().st_mode) == 0o500


@pytest.mark.skipif(os.name == "nt", reason="dependency symlink fixtures are POSIX-only")
def test_dependency_snapshot_rejects_links_that_escape_the_sandbox_workspace(tmp_path: Path) -> None:
    repo, _ = _repo_and_task(tmp_path, {"dependency/kept": b"payload"})
    (repo / "dependency" / "escape").symlink_to("../../../../outside")
    task = {
        "sandbox_dependencies": [{"source": "dependency", "target": "dependency"}],
    }

    with TaskAssetCache(tmp_path / "cache") as cache:
        with pytest.raises(SandboxError, match="escapes the sandbox workspace"):
            cache.prepare(task, repo=repo, resolved_sha=SHA)


def test_resolved_task_binding_carries_dependency_digests_and_rejects_live_drift(tmp_path: Path) -> None:
    repo, _ = _repo_and_task(tmp_path, {"dependency/package.json": b'{"version":1}'})
    _git(repo, "init", "--quiet")
    _git(repo, "config", "user.name", "Workflow Bench Test")
    _git(repo, "config", "user.email", "workflow-bench@example.invalid")
    _git(repo, "add", ".")
    _git(repo, "commit", "--quiet", "-m", "fixture")
    task = {
        "id": "dependency-binding",
        "class": "test",
        "repo": str(repo),
        "prompt": "inspect dependency",
        "verify": "true",
        "sandbox_copy": [],
        "sandbox_dependencies": [{"source": "dependency", "target": "dependency"}],
    }
    oracle = TaskOracleSnapshot(
        command="true",
        command_digest="1" * 64,
        manifest_digest="2" * 64,
        digest="3" * 64,
        files=(),
    )
    with TaskAssetCache(tmp_path / "binding-cache") as cache:
        binding = resolve_task_bindings(
            [task],
            oracle_snapshots=[oracle],
            task_asset_cache=cache,
        )[0]

    assert len(binding["sandbox_dependency_content_digest"]) == 64
    assert len(binding["sandbox_dependency_manifest_digest"]) == 64
    (repo / "dependency" / "package.json").write_bytes(b'{"version":2}')
    with pytest.raises(ValueError, match="definition drifted"):
        resolve_task_bindings([task], [binding], oracle_snapshots=[oracle])


def test_node_modules_dependency_snapshot_captures_the_vite_temp_mount_point(tmp_path: Path) -> None:
    # bwrap cannot mkdir a mount point inside an already-read-only bind, so the
    # directory vite needs must exist in the captured dependency bytes. It is
    # recorded during capture, which puts it inside the manifest and both
    # dependency digests rather than leaving it an untracked mutation of a
    # digest-bound snapshot.
    repo, _ = _repo_and_task(tmp_path, {"dependency/package.json": b'{"version":1}'})
    task = {
        "sandbox_copy": [],
        "sandbox_dependencies": [{"source": "dependency", "target": "gitnexus/node_modules"}],
    }
    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        captured = {entry.path.as_posix() for entry in snapshot.dependencies[0].entries}
        assert f"payload/{VITE_TEMP_DIR}" in captured
        vite_temp = next((snapshot.root / "dependencies").glob(f"*/payload/{VITE_TEMP_DIR}"))
        assert vite_temp.is_dir()


def test_non_node_modules_dependency_snapshot_has_no_vite_temp(tmp_path: Path) -> None:
    # The capture is scoped to dependency mounts whose target is node_modules;
    # an unrelated vendored dependency is captured byte-for-byte as declared.
    repo, _ = _repo_and_task(tmp_path, {"dependency/package.json": b'{"version":1}'})
    task = {
        "sandbox_copy": [],
        "sandbox_dependencies": [{"source": "dependency", "target": "vendor/dependency"}],
    }
    with TaskAssetCache(tmp_path / "cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=SHA)
        captured = {entry.path.as_posix() for entry in snapshot.dependencies[0].entries}
        assert not any(path.endswith(VITE_TEMP_DIR) for path in captured)
