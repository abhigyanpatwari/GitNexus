"""Security and provenance contracts for the CE comparator plugin runtime."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from workflow_bench import runner, runner_sessions, runtime_mounts
from workflow_bench.process_control import ManagedProcessResult
from workflow_bench.proposer_sandbox import SandboxError, prepare_sandbox
from workflow_bench.runtime_mounts import (
    CE_PLUGIN_MANIFEST_SCHEMA_VERSION,
    SANDBOX_CE_PLUGIN,
    ce_plugin_dir_for_arm,
    ce_plugin_mounts_for_arm,
    staged_ce_plugin_snapshot,
    validate_ce_plugin_inputs,
)

PLUGIN_VERSION = "3.19.0"


def make_plugin(root: Path, *, version: str = PLUGIN_VERSION, noise: bool = False) -> Path:
    manifest_dir = root / ".claude-plugin"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "compound-engineering",
                "version": version,
                "description": "Comparator canary",
                "author": {"name": "GitNexus tests"},
            }
        )
    )
    for name in ("ce-plan", "ce-work", "ce-code-review"):
        skill = root / "skills" / name / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(f"---\nname: {name}\ndescription: Comparator canary\n---\n\n# {name}\n")
    script = root / "scripts" / "helper.sh"
    script.parent.mkdir()
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    asset = root / "assets" / "icon.txt"
    asset.parent.mkdir()
    asset.write_text("icon\n")

    if noise:
        (manifest_dir / "CHANGELOG.md").write_text("not runtime input\n")
        for relative in (".git/config", "tests/test_plugin.py", "docs/notes.md", "src/internal.py"):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("excluded\n")
        for relative in (".env", ".npmrc", "skills/ce-plan/api-token.txt"):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("super-secret\n")
    return root


def test_parser_exposes_explicit_ce_plugin_inputs(tmp_path: Path) -> None:
    args = runner.build_parser().parse_args(
        [
            "--tasks",
            str(tmp_path / "tasks.yaml"),
            "--model",
            "claude-sonnet-4-20250514",
            "--arms",
            "ce_workflow",
            "--ce-plugin-dir",
            str(tmp_path / "plugin"),
            "--ce-plugin-version",
            PLUGIN_VERSION,
        ]
    )
    assert args.ce_plugin_dir == tmp_path / "plugin"
    assert args.ce_plugin_version == PLUGIN_VERSION


@pytest.mark.parametrize(
    ("arms", "plugin_dir", "version", "message"),
    [
        (("ce_workflow",), None, None, "require both"),
        (("ce_review",), Path("plugin"), None, "require both"),
        (("baseline",), Path("plugin"), PLUGIN_VERSION, "require at least one"),
        (("ce_workflow_direct",), Path("plugin"), "latest", "exact semantic version"),
        (("ce_workflow_direct",), Path("plugin"), "^3.19.0", "exact semantic version"),
    ],
)
def test_ce_plugin_preflight_rejects_unpinned_or_misapplied_inputs(
    arms: tuple[str, ...],
    plugin_dir: Path | None,
    version: str | None,
    message: str,
) -> None:
    with pytest.raises((ValueError, SandboxError), match=message):
        validate_ce_plugin_inputs(arms, plugin_dir, version)


def test_ce_plugin_preflight_accepts_only_matching_explicit_source(tmp_path: Path) -> None:
    source = make_plugin(tmp_path / "plugin")
    config = validate_ce_plugin_inputs(("baseline", "ce_review"), source, PLUGIN_VERSION)
    assert config is not None
    assert config.source == source
    assert config.version == PLUGIN_VERSION
    assert validate_ce_plugin_inputs(("baseline",), None, None) is None


def test_ce_plugin_snapshot_is_exact_bounded_and_secret_free(tmp_path: Path) -> None:
    source = make_plugin(tmp_path / "operator-plugin", noise=True)
    config = validate_ce_plugin_inputs(("ce_review",), source, PLUGIN_VERSION)
    assert config is not None
    with staged_ce_plugin_snapshot(config, destination_parent=tmp_path) as first:
        assert first is not None
        expected = {
            ".claude-plugin/plugin.json",
            "skills/ce-plan/SKILL.md",
            "skills/ce-work/SKILL.md",
            "skills/ce-code-review/SKILL.md",
            "scripts/helper.sh",
            "assets/icon.txt",
        }
        actual = {path.relative_to(first.root).as_posix() for path in first.root.rglob("*") if path.is_file()}
        assert actual == expected
        assert first.root != source
        assert first.mount.target == SANDBOX_CE_PLUGIN
        assert first.mount.source == first.root
        assert first.provenance == {
            "name": "compound-engineering",
            "version": PLUGIN_VERSION,
            "manifest_schema_version": CE_PLUGIN_MANIFEST_SCHEMA_VERSION,
            "manifest_digest": first.manifest_digest,
            "file_count": len(expected),
            "total_bytes": first.total_bytes,
        }
        assert all(not path.is_symlink() for path in first.root.rglob("*"))
        assert all(not (path.stat().st_mode & stat.S_IWUSR) for path in first.root.rglob("*"))
        first_digest = first.manifest_digest
    assert not first.root.exists()

    with staged_ce_plugin_snapshot(config, destination_parent=tmp_path) as second:
        assert second is not None
        assert second.manifest_digest == first_digest


def test_ce_plugin_snapshot_rejects_version_drift_and_symlinks(tmp_path: Path) -> None:
    source = make_plugin(tmp_path / "plugin", version="3.18.0")
    config = validate_ce_plugin_inputs(("ce_workflow",), source, PLUGIN_VERSION)
    assert config is not None
    with pytest.raises(SandboxError, match="version mismatch"):
        with staged_ce_plugin_snapshot(config, destination_parent=tmp_path):
            pass

    source = make_plugin(tmp_path / "symlinked-plugin")
    target = source / "real-reference.md"
    target.write_text("reference\n")
    (source / "skills" / "ce-plan" / "linked.md").symlink_to(target)
    config = validate_ce_plugin_inputs(("ce_workflow",), source, PLUGIN_VERSION)
    assert config is not None
    with pytest.raises(SandboxError, match="must not be symlinks"):
        with staged_ce_plugin_snapshot(config, destination_parent=tmp_path):
            pass


def test_ce_plugin_snapshot_enforces_total_byte_bound(monkeypatch, tmp_path: Path) -> None:
    source = make_plugin(tmp_path / "plugin")
    config = validate_ce_plugin_inputs(("ce_review",), source, PLUGIN_VERSION)
    assert config is not None
    monkeypatch.setattr(runtime_mounts, "MAX_CE_PLUGIN_TOTAL_BYTES", 1)
    with pytest.raises(SandboxError, match="total byte limit"):
        with staged_ce_plugin_snapshot(config, destination_parent=tmp_path):
            pass


def test_ce_plugin_mount_and_flag_are_ce_arm_only(tmp_path: Path) -> None:
    source = make_plugin(tmp_path / "plugin")
    config = validate_ce_plugin_inputs(("ce_review",), source, PLUGIN_VERSION)
    assert config is not None
    with staged_ce_plugin_snapshot(config, destination_parent=tmp_path) as snapshot:
        assert snapshot is not None
        assert ce_plugin_mounts_for_arm("ce_review", snapshot) == (snapshot.mount,)
        assert ce_plugin_dir_for_arm("ce_review", snapshot) == SANDBOX_CE_PLUGIN
        assert ce_plugin_mounts_for_arm("review", snapshot) == ()
        assert ce_plugin_dir_for_arm("review", snapshot) is None
        with pytest.raises(SandboxError, match="no staged"):
            ce_plugin_mounts_for_arm("ce_workflow", None)


def _valid_cli_result() -> ManagedProcessResult:
    report = json.dumps(
        {
            "session_id": "session",
            "num_turns": 1,
            "total_cost_usd": 0,
            "duration_ms": 1,
            "usage": {
                "input_tokens": 1,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "output_tokens": 1,
            },
        }
    )
    return ManagedProcessResult(
        state="exited",
        returncode=0,
        stdout_tail=report,
        stderr_tail="",
        duration_s=0.001,
    )


def test_run_claude_passes_plugin_dir_explicitly_under_bare(monkeypatch, tmp_path: Path) -> None:
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return _valid_cli_result()

    monkeypatch.setattr(runner_sessions, "run_managed", fake_run)
    runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        bare=True,
        plugin_dirs=(SANDBOX_CE_PLUGIN,),
    )
    runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5, bare=True)

    assert "--bare" in commands[0]
    assert commands[0][commands[0].index("--plugin-dir") + 1] == SANDBOX_CE_PLUGIN
    assert "--plugin-dir" not in commands[1]


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_CLAUDE_CANARY") != "1",
    reason="real Bubblewrap/Claude plugin canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_claude_strictly_validates_staged_plugin(tmp_path: Path) -> None:
    """Validate plugin discovery under Bubblewrap without contacting a model."""

    claude = Path(os.environ["CLAUDE_CANARY_BIN"]).resolve()
    clone = tmp_path / "clone"
    clone.mkdir()
    source = make_plugin(tmp_path / "plugin")
    config = validate_ce_plugin_inputs(("ce_review",), source, PLUGIN_VERSION)
    assert config is not None

    with staged_ce_plugin_snapshot(config, destination_parent=tmp_path) as snapshot:
        assert snapshot is not None
        with prepare_sandbox(
            clone=clone,
            claude_bin=claude,
            read_only_mounts=ce_plugin_mounts_for_arm("ce_review", snapshot),
            preflight=True,
        ) as sandbox:
            result = sandbox.run(
                [sandbox.claude_bin, "plugin", "validate", "--strict", SANDBOX_CE_PLUGIN],
                timeout=20,
            )

    assert result.ok, result.stderr_tail
