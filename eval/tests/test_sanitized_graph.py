"""Sanitized, offline GitNexus graph preparation contracts."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench import sanitized_graph
from workflow_bench.proposer_sandbox import ReadOnlyMount, SandboxError


@pytest.mark.parametrize(
    "task",
    [
        {"sandbox_copy": [".gitnexus/lbug"]},
        {"sandbox_copy": ["eval/workflow_bench/oracles"]},
        {"sandbox_dependencies": [{"source": ".gitnexus", "target": "graph"}]},
        {"sandbox_dependencies": [{"source": "safe", "target": "eval/workflow_bench"}]},
    ],
)
def test_prebuilt_graph_and_harness_assets_are_rejected(task):
    with pytest.raises(SandboxError, match="prebuilt graph or harness"):
        sanitized_graph.validate_no_prebuilt_graph_assets(task)


def test_graph_environment_is_offline_deterministic_and_ignores_target_gitignore():
    env = sanitized_graph._graph_environment()

    assert env["GITNEXUS_HOME"] == "/home/agent/.gitnexus-index"
    assert env["GITNEXUS_NO_GITIGNORE"] == "1"
    assert env["GITNEXUS_WORKER_POOL_SIZE"] == "1"
    assert env["GITNEXUS_PARSE_CHUNK_CONCURRENCY"] == "1"
    assert "ANTHROPIC_API_KEY" not in env


def test_graph_scrub_checks_whole_node_and_relation_payloads(monkeypatch):
    calls: list[tuple[str, ...]] = []

    def fake_run(_prefix, arguments, *, timeout, capture_stdout=False):
        del timeout
        calls.append(tuple(arguments))
        return b'{"markdown":"| n |\\n| --- |","row_count":0}' if capture_stdout else None

    monkeypatch.setattr(sanitized_graph, "_run_graph_cli", fake_run)
    sanitized_graph._scrub_and_verify_graph(["sandbox"])

    statements = [call[1] for call in calls]
    assert len(statements) == 2
    assert all("RETURN" in statement and "LIMIT 1" in statement for statement in statements)
    assert all("CAST(n AS STRING)" in statement for statement in statements if "(n)" in statement)
    assert all("CAST(r AS STRING)" in statement for statement in statements if "[r]" in statement)
    for marker in sanitized_graph.GRAPH_MARKERS:
        assert any(marker in statement for statement in statements)


def test_source_scrub_covers_paths_and_stored_content_without_following_large_inputs(tmp_path: Path):
    safe = tmp_path / "safe.py"
    safe.write_text("print('safe')\n")
    content_reference = tmp_path / "docs.md"
    content_reference.write_text("See eval/workflow_bench for the answer\n")
    path_reference = tmp_path / "nested" / "tasks.scenarios.yaml.copy"
    path_reference.parent.mkdir()
    path_reference.write_text("opaque\n")
    large = tmp_path / "large.py"
    large.write_bytes(b"x" * (sanitized_graph.MAX_GRAPH_SCRUB_FILE_BYTES + 1))

    removed = sanitized_graph._scrub_source_references(tmp_path)

    assert removed == ("docs.md", "nested/tasks.scenarios.yaml.copy")
    assert safe.exists()
    assert large.exists()
    assert not content_reference.exists()
    assert not path_reference.exists()


def test_prepare_sanitized_graph_builds_once_from_parentless_tree_and_caches_only_curated_assets(
    monkeypatch,
    tmp_path: Path,
):
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / ".git").mkdir()
    old_index = seed / ".gitnexus"
    old_index.mkdir()
    (old_index / "lbug").write_text("UNSANITIZED")
    (seed / ".gitnexusrc").write_text('{"embeddings":true,"pdg":false}\n')
    (seed / ".gitnexusignore").write_text("eval/**\n")
    sanitized_head = "a" * 40
    prefix_options: list[dict[str, object]] = []
    graph_calls: list[tuple[str, ...]] = []
    removed: list[Path] = []

    class FakeSandbox:
        def command_prefix_for(self, **kwargs):
            prefix_options.append(dict(kwargs))
            return ["sandbox-prefix"]

    @contextmanager
    def fake_prepare_sandbox(**kwargs):
        assert kwargs["clone"] == seed
        assert kwargs["preflight"] is False
        yield FakeSandbox()

    def fake_graph_cli(_prefix, arguments, *, timeout, capture_stdout=False):
        del timeout
        graph_calls.append(tuple(arguments))
        if arguments[0] == "analyze":
            index = seed / ".gitnexus"
            index.mkdir()
            metadata = {
                "indexedAt": "2026-07-18T00:00:00Z",
                "lastCommit": sanitized_head,
                "pdg": {"hasCallSummary": True},
            }
            (index / "gitnexus.json").write_text(json.dumps(metadata))
            (index / "meta.json").write_text(json.dumps(metadata))
            (index / "lbug").write_bytes(b"SANITIZED")
            (index / "run.cjs").write_text("must not be cached")
        if capture_stdout:
            return b'{"markdown":"| n |\\n| --- |","row_count":0}'
        return None

    asset = SimpleNamespace(
        digest="graph-digest",
        manifest_digest="graph-manifest",
        materialize=lambda clone: None,
    )

    class FakeCache:
        def __init__(self):
            self.calls = []

        def prepare(self, task, *, repo, resolved_sha):
            self.calls.append((task, repo, resolved_sha))
            return asset

    cache = FakeCache()
    monkeypatch.setattr(sanitized_graph, "make_worktree", lambda *args, **kwargs: seed)
    monkeypatch.setattr(
        sanitized_graph,
        "sanitize_clone_for_hidden_oracles",
        lambda clone: sanitized_head,
    )
    monkeypatch.setattr(sanitized_graph, "prepare_sandbox", fake_prepare_sandbox)
    monkeypatch.setattr(sanitized_graph, "_run_graph_cli", fake_graph_cli)
    monkeypatch.setattr(sanitized_graph, "remove_clone", lambda clone: removed.append(clone))

    snapshot = sanitized_graph.prepare_sanitized_graph(
        {},
        repo=tmp_path,
        resolved_sha="b" * 40,
        parent=tmp_path,
        cache=cache,  # type: ignore[arg-type]
        claude_bin="claude",
        bwrap_bin="bwrap",
        runtime_mounts=(ReadOnlyMount(source=tmp_path, target="/opt/runtime"),),
    )

    analyze = graph_calls[0]
    assert analyze[:2] == ("analyze", "/workspace")
    for flag in ("--force", "--pdg", "--index-only", "--no-stats"):
        assert flag in analyze
    assert prefix_options == [{"unshare_network": True}]
    assert (seed / ".gitnexusrc").read_text() == "{}\n"
    assert (seed / ".gitnexusignore").read_text() == ""
    assert cache.calls == [
        (
            {"sandbox_copy": list(sanitized_graph.GRAPH_ASSET_PATHS)},
            seed,
            sanitized_head,
        )
    ]
    cached_paths = cache.calls[0][0]["sandbox_copy"]
    assert ".gitnexus/run.cjs" not in cached_paths
    assert all("parse-cache" not in path for path in cached_paths)
    assert snapshot.sanitized_head == sanitized_head
    assert snapshot.digest == "graph-digest"
    assert removed == [seed]


def test_graph_snapshot_rejects_arm_sanitization_identity_drift(tmp_path: Path):
    assets = SimpleNamespace(
        digest="digest",
        manifest_digest="manifest",
        materialize=lambda clone: pytest.fail("drift must fail before materialization"),
    )
    snapshot = sanitized_graph.SanitizedGraphSnapshot(
        assets=assets,  # type: ignore[arg-type]
        sanitized_head="a" * 40,
    )

    with pytest.raises(SandboxError, match="identity drifted"):
        snapshot.materialize(tmp_path, sanitized_head="b" * 40)
