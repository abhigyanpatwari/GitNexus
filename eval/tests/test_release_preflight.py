"""Release preflight must exercise actual materialization without paid sessions."""

import json
import subprocess
import sys
from functools import partial
from pathlib import Path

import pytest
import yaml

from workflow_bench import oracle_assets, release_preflight, runner_tasks, task_assets
from workflow_bench.proposer_sandbox import SandboxError
from workflow_bench.sanitized_graph import SanitizedGraphSnapshot


@pytest.fixture
def prepared(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "source").write_text("source")
    for args in (
        ["init", "-q"], ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"],
    ):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
    sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    task = dict(id="release-probe", repo=str(repo), ref=sha, prompt="test", verify="true", **{"class": "test"})
    hidden = tmp_path / "hidden"
    hidden.mkdir()
    (hidden / "check.py").write_text("assert True\n")
    task["oracle"] = {
        "command": 'python "$GITNEXUS_BENCH_ORACLE_ROOT/check.py"',
        "files": [{"source": "check.py", "target": "check.py"}],
    }
    monkeypatch.setattr(runner_tasks, "capture_task_oracles", partial(oracle_assets.capture_task_oracles, root=hidden))
    builds = []
    probes = []
    monkeypatch.setattr(release_preflight, "preflight_bubblewrap", lambda: Path("/fake/bwrap"))
    monkeypatch.setattr(release_preflight, "require_claude_sandbox_helpers", lambda: None)
    monkeypatch.setattr(release_preflight, "trusted_gitnexus_runtime_mounts", lambda **_: ())
    monkeypatch.setattr(task_assets, "_try_reflink", lambda *_: False)

    # Only graph construction/containment are substituted. Binding resolution,
    # capture, graph materialization, staging, and cleanup are production code.
    def build(task, *, repo, resolved_sha, parent, cache, **kwargs):
        builds.append(resolved_sha)
        seed = parent / f"graph-{len(builds)}"
        seed.mkdir()
        (seed / "index").write_bytes(b"graph")
        assets = cache.prepare({"sandbox_copy": ["index"]}, repo=seed, resolved_sha=resolved_sha)
        return SanitizedGraphSnapshot(assets=assets, sanitized_head=resolved_sha)

    stage = release_preflight.stage_task_assets

    def checked_stage(task, *, repo, clone, snapshot):
        assert (clone / "index").read_bytes() == b"graph"
        probes.append(clone)
        return stage(task, repo=repo, clone=clone, snapshot=snapshot)

    monkeypatch.setattr(release_preflight, "prepare_sanitized_graph", build)
    monkeypatch.setattr(release_preflight, "stage_task_assets", checked_stage)
    return task, builds, probes


def test_preflight_materializes_every_task_but_builds_shared_graph_once(prepared, capsys, tmp_path):
    task, builds, probes = prepared
    release_preflight.preflight_release(
        [task, {**task, "id": "second-task"}], gitnexus_root=tmp_path, claude_bin=Path("claude"),
    )
    assert builds == [task["ref"]]
    assert len(probes) == 2
    assert all(not probe.parent.exists() for probe in probes)
    assert "graph snapshot 5 bytes" in capsys.readouterr().out


def test_copy_failure_aborts_preflight_and_cli_without_evidence(prepared, monkeypatch, tmp_path):
    task, builds, probes = prepared
    monkeypatch.setattr(task_assets, "MAX_BUFFERED_FALLBACK_BYTES", 4)
    with pytest.raises(SandboxError, match="cannot reflink"):
        release_preflight.preflight_release([task], gitnexus_root=tmp_path, claude_bin=Path("claude"))
    assert probes == []  # Failure must happen in real graph materialization.
    tasks_file = tmp_path / "tasks.yaml"
    tasks_file.write_text(yaml.safe_dump({"tasks": [task]}))
    monkeypatch.setattr(sys, "argv", [
        "preflight", "--tasks", str(tasks_file), "--gitnexus-root", str(tmp_path), "--claude-bin", "claude",
    ])
    with pytest.raises(SystemExit) as error:
        release_preflight.main()
    assert error.value.code == 2
    assert builds == [task["ref"], task["ref"]]
    assert not list(tmp_path.rglob("results.jsonl"))


def test_preflight_rejects_task_assets_that_replace_the_graph(prepared, tmp_path):
    task, _, _ = prepared
    index = Path(task["repo"]) / ".gitnexus"
    index.mkdir()
    (index / "meta.json").write_text(json.dumps({"fake": True}))
    with pytest.raises(SandboxError, match="prebuilt graph"):
        release_preflight.preflight_release(
            [{**task, "sandbox_copy": [".gitnexus/meta.json"]}], gitnexus_root=tmp_path, claude_bin=Path("claude"),
        )
