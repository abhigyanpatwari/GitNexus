"""Hidden-oracle capture, staging, and promotion-boundary regressions."""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench import oracle_assets, runner
from workflow_bench.evolution import evaluate_candidate
from workflow_bench.oracle_assets import capture_task_oracle, staged_task_oracle


def oracle_task(*, command: str = "true", source: str = "oracle.test.ts") -> dict[str, object]:
    return {
        "id": "hidden",
        "oracle": {
            "command": command,
            "files": [{"source": source, "target": "nested/oracle.test.ts"}],
        },
    }


def write_oracle(root: Path, payload: bytes = b"hidden behavior") -> None:
    root.mkdir()
    (root / "oracle.test.ts").write_bytes(payload)


def session_record() -> dict[str, object]:
    return {
        "input_tokens": 1,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": 1,
        "cost_usd": 0.1,
        "duration_s": 1.0,
        "num_turns": 1,
        "ok": True,
        "session_id": "s",
        "error_kind": None,
        "error_detail": None,
    }


def bench_args() -> argparse.Namespace:
    return argparse.Namespace(
        claude_bin="claude",
        timeout=5,
        model="pinned-model",
        base_url=None,
        auth_token=None,
    )


def sandbox(tmp_path: Path) -> SimpleNamespace:
    calls: list[dict[str, object]] = []
    private_root = tmp_path / "sandbox-private"
    private_root.mkdir(exist_ok=True)
    instance = SimpleNamespace(
        claude_bin="claude",
        clone=tmp_path,
        private_root=private_root,
        command_prefix=[],
        command_prefix_calls=calls,
        settings_json="{}",
        transcript_projects=tmp_path / "transcripts",
    )
    instance.command_prefix_for = lambda **kwargs: calls.append(dict(kwargs)) or []
    return instance


def test_capture_digest_binds_command_targets_and_raw_bytes(tmp_path: Path) -> None:
    root = tmp_path / "oracles"
    write_oracle(root)
    original = capture_task_oracle(oracle_task(), root=root)
    same = capture_task_oracle(oracle_task(), root=root)
    changed_command = capture_task_oracle(oracle_task(command="false"), root=root)
    (root / "oracle.test.ts").write_bytes(b"changed behavior")
    changed_bytes = capture_task_oracle(oracle_task(), root=root)

    assert same == original
    assert changed_command.digest != original.digest
    assert changed_command.command_digest != original.command_digest
    assert changed_bytes.digest != original.digest
    assert changed_bytes.manifest_digest != original.manifest_digest
    assert original.binding["oracle_files"] == [
        {
            "target": "nested/oracle.test.ts",
            "sha256": hashlib.sha256(b"hidden behavior").hexdigest(),
            "size": len(b"hidden behavior"),
        }
    ]


def test_clone_sanitization_prunes_harness_checkout_and_recoverable_history(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()

    def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=False,
            capture_output=True,
            text=True,
        )
        if check and result.returncode != 0:
            pytest.fail(f"git {' '.join(args)} failed: {result.stderr}")
        return result

    git(source, "init", "--quiet", "--initial-branch=main")
    git(source, "config", "user.name", "Oracle Test")
    git(source, "config", "user.email", "oracle-test.invalid")
    (source / "visible.txt").write_text("model-visible source\n")
    hidden = source / "eval" / "workflow_bench" / "oracles"
    hidden.mkdir(parents=True)
    (hidden / "secret.oracle.test.ts").write_text("unique hidden behavioral assertion\n")
    (source / "eval" / "workflow_bench" / "tasks.scenarios.yaml").write_text("secret command\n")
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "fixture with hidden oracle")
    git(source, "tag", "oracle-backup")

    clone = tmp_path / "clone"
    clone_result = subprocess.run(
        ["git", "clone", "--no-local", "--no-hardlinks", "--quiet", str(source), str(clone)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert clone_result.returncode == 0, clone_result.stderr
    original_head = git(clone, "rev-parse", "HEAD").stdout.strip()
    hidden_tree = git(clone, "rev-parse", "HEAD:eval/workflow_bench").stdout.strip()

    sanitized_head = oracle_assets.sanitize_clone_for_hidden_oracles(clone)

    assert sanitized_head != original_head
    assert (clone / "visible.txt").read_text() == "model-visible source\n"
    assert not (clone / "eval" / "workflow_bench").exists()
    assert git(clone, "show", f"{original_head}:eval/workflow_bench/tasks.scenarios.yaml", check=False).returncode != 0
    assert git(clone, "cat-file", "-e", original_head, check=False).returncode != 0
    assert git(clone, "cat-file", "-e", hidden_tree, check=False).returncode != 0
    assert git(clone, "for-each-ref", "--format=%(refname)").stdout == ""
    assert git(clone, "show", "-s", "--format=%P", "HEAD").stdout.strip() == ""
    assert git(clone, "status", "--porcelain=v1", "--untracked-files=all").stdout == ""


def test_clone_sanitization_prunes_remote_history_when_head_never_had_harness(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()

    def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=False,
            capture_output=True,
            text=True,
        )
        if check and result.returncode != 0:
            pytest.fail(f"git {' '.join(args)} failed: {result.stderr}")
        return result

    git(source, "init", "--quiet", "--initial-branch=main")
    git(source, "config", "user.name", "Oracle Test")
    git(source, "config", "user.email", "oracle-test.invalid")
    (source / "visible.txt").write_text("old task snapshot\n")
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "old snapshot without harness")
    old_head = git(source, "rev-parse", "HEAD").stdout.strip()

    hidden = source / "eval" / "workflow_bench" / "oracles"
    hidden.mkdir(parents=True)
    secret = hidden / "future-secret.test.ts"
    secret.write_text("UNRECOVERABLE_REMOTE_ORACLE_BYTES\n")
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "future remote-only oracle")
    future_head = git(source, "rev-parse", "HEAD").stdout.strip()

    sanitized_heads: list[str] = []
    for name in ("clone-one", "clone-two"):
        clone = tmp_path / name
        subprocess.run(
            ["git", "clone", "--no-local", "--no-hardlinks", "--quiet", str(source), str(clone)],
            check=True,
        )
        git(clone, "checkout", "--detach", "--quiet", old_head)
        assert git(clone, "show", f"{future_head}:eval/workflow_bench/oracles/future-secret.test.ts").stdout == (
            "UNRECOVERABLE_REMOTE_ORACLE_BYTES\n"
        )

        sanitized_heads.append(oracle_assets.sanitize_clone_for_hidden_oracles(clone))

        assert git(clone, "remote").stdout == ""
        assert git(clone, "for-each-ref", "--format=%(refname)").stdout == ""
        assert git(clone, "cat-file", "-e", future_head, check=False).returncode != 0
        assert (
            git(
                clone, "show", f"{future_head}:eval/workflow_bench/oracles/future-secret.test.ts", check=False
            ).returncode
            != 0
        )
        assert git(clone, "fsck", "--full", "--no-reflogs", "--unreachable").stdout == ""
        assert git(clone, "show", "-s", "--format=%P", "HEAD").stdout.strip() == ""

    assert sanitized_heads[0] == sanitized_heads[1]


@pytest.mark.skipif(os.name == "nt", reason="symlink contract is POSIX-specific")
def test_capture_rejects_symlinked_sources_and_parents(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "oracle.test.ts").write_text("secret")

    source_link_root = tmp_path / "source-link-root"
    source_link_root.mkdir()
    (source_link_root / "oracle.test.ts").symlink_to(outside / "oracle.test.ts")
    with pytest.raises(ValueError, match="regular non-symlink"):
        capture_task_oracle(oracle_task(), root=source_link_root)

    parent_link_root = tmp_path / "parent-link-root"
    parent_link_root.mkdir()
    (parent_link_root / "linked").symlink_to(outside, target_is_directory=True)
    task = oracle_task(source="linked/oracle.test.ts")
    with pytest.raises(ValueError, match="parents must be real"):
        capture_task_oracle(task, root=parent_link_root)


@pytest.mark.parametrize(
    ("constant", "value", "expected"),
    [
        ("MAX_ORACLE_FILE_BYTES", 4, "bounded regular"),
        ("MAX_ORACLE_TOTAL_BYTES", 4, "total byte limit"),
        ("MAX_ORACLE_PATH_BYTES", 4, "bounded portable path"),
    ],
)
def test_capture_enforces_file_total_and_path_bounds(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    constant: str,
    value: int,
    expected: str,
) -> None:
    root = tmp_path / "oracles"
    write_oracle(root, b"12345")
    monkeypatch.setattr(oracle_assets, constant, value)
    with pytest.raises(ValueError, match=expected):
        capture_task_oracle(oracle_task(), root=root)


def test_oracle_is_staged_privately_then_removed_and_mutation_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "oracles"
    write_oracle(source)
    snapshot = capture_task_oracle(oracle_task(), root=source)
    worktree = tmp_path / "worktree"
    worktree.mkdir()

    with staged_task_oracle(worktree, snapshot) as stage:
        assert stage.parent == worktree
        assert stage.name.startswith(".wfbench-oracle-")
        staged = stage / "nested" / "oracle.test.ts"
        assert staged.read_bytes() == b"hidden behavior"
        assert not any(path.name == "oracle.test.ts" for path in worktree.iterdir())
    assert not list(worktree.glob(".wfbench-oracle-*"))

    with pytest.raises(ValueError, match="changed during verification"):
        with staged_task_oracle(worktree, snapshot) as stage:
            staged = stage / "nested" / "oracle.test.ts"
            staged.chmod(0o600)
            staged.write_bytes(b"weakened")
    assert not list(worktree.glob(".wfbench-oracle-*"))


def test_vacuous_authored_test_cannot_self_certify_resolution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "oracles"
    write_oracle(source)
    snapshot = capture_task_oracle(oracle_task(), root=source)
    monkeypatch.setattr(runner, "run_claude", lambda *args, **kwargs: session_record())
    outcomes = iter([(True, "authored test passed"), (False, "hidden behavior failed")])
    monkeypatch.setattr(runner, "run_verify", lambda *args, **kwargs: next(outcomes))

    record = runner.run_arm(
        "baseline",
        {"prompt": "implement behavior", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=sandbox(tmp_path),
        oracle_snapshot=snapshot,
    )

    assert record["authored_tests_passed"] is True
    assert record["oracle_passed"] is False
    assert record["resolved"] is False
    assert record["error_kind"] == "oracle-failed"


def test_oracle_path_and_bytes_appear_only_after_the_model_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "oracles"
    write_oracle(source)
    snapshot = capture_task_oracle(oracle_task(), root=source)
    stages_seen: list[list[Path]] = []

    def fake_session(*args, **kwargs):
        assert not list(tmp_path.glob(".wfbench-oracle-*"))
        assert b"hidden behavior" not in b"".join(path.read_bytes() for path in tmp_path.glob("*.test.ts"))
        return session_record()

    def fake_verify(*args, **kwargs):
        stages_seen.append(list(tmp_path.glob(".wfbench-oracle-*")))
        return True, "ok"

    monkeypatch.setattr(runner, "run_claude", fake_session)
    monkeypatch.setattr(runner, "run_verify", fake_verify)
    record = runner.run_arm(
        "baseline",
        {"prompt": "implement behavior", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=sandbox(tmp_path),
        oracle_snapshot=snapshot,
    )

    assert stages_seen[0] == []  # authored tests run before hidden files are staged
    assert len(stages_seen[1]) == 1
    assert record["resolved"] is True
    assert not list(tmp_path.glob(".wfbench-oracle-*"))


def test_hidden_oracle_uses_digest_bound_staged_config_not_candidate_config(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "oracles"
    source.mkdir()
    hidden_config = b"export default { test: { passWithNoTests: false, setupFiles: [] } };\n"
    (source / "vitest.config.mts").write_bytes(hidden_config)
    (source / "oracle.test.ts").write_text("hidden test")
    task = oracle_task(
        command=(
            'npx vitest run --config "$GITNEXUS_BENCH_ORACLE_ROOT/vitest.config.mts" '
            '"$GITNEXUS_BENCH_ORACLE_ROOT/nested/oracle.test.ts"'
        )
    )
    task["oracle"]["files"].insert(  # type: ignore[index]
        0,
        {"source": "vitest.config.mts", "target": "vitest.config.mts"},
    )
    snapshot = capture_task_oracle(task, root=source)
    candidate_config = tmp_path / "vitest.config.ts"
    candidate_config.write_text("export default { test: { passWithNoTests: true } };\n")
    calls = 0

    sandbox_instance = sandbox(tmp_path)

    def fake_verify(command, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return True, "authored"
        assert command == snapshot.command
        oracle_env_root = kwargs["env"][oracle_assets.ORACLE_ENV_VAR]
        assert oracle_env_root.startswith("/workspace/.wfbench-oracle-")
        assert Path(oracle_env_root).parent == Path("/workspace")
        # A hidden test's ../gitnexus import must resolve to the credited
        # candidate checkout, not to an unrelated /opt/gitnexus tree.
        assert Path(oracle_env_root).parent / "gitnexus" == Path("/workspace/gitnexus")
        prefix_options = sandbox_instance.command_prefix_calls[-1]
        assert prefix_options["read_only_workspace"] is True
        assert prefix_options["unshare_network"] is True
        oracle_mount = prefix_options["extra_read_only_mounts"][0]
        assert oracle_mount.target == oracle_env_root
        oracle_root = oracle_mount.source
        assert oracle_root.is_relative_to(sandbox_instance.private_root)
        assert (oracle_root / "vitest.config.mts").read_bytes() == hidden_config
        assert (oracle_root / "vitest.config.mts").read_bytes() != candidate_config.read_bytes()
        return True, "hidden"

    monkeypatch.setattr(runner, "run_claude", lambda *args, **kwargs: session_record())
    monkeypatch.setattr(runner, "run_verify", fake_verify)
    record = runner.run_arm(
        "baseline",
        {"prompt": "implement behavior", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=sandbox_instance,
        oracle_snapshot=snapshot,
    )

    assert calls == 2
    assert record["resolved"] is True
    assert snapshot.command_digest == hashlib.sha256(snapshot.command.encode()).hexdigest()
    assert any(item.target == "vitest.config.mts" for item in snapshot.files)


@pytest.mark.skipif(os.name == "nt", reason="Vitest module-resolution fixture uses symlinks")
def test_hidden_vitest_config_executes_sibling_oracle_against_candidate_checkout(tmp_path: Path) -> None:
    """Exercise the shipped config with the same sibling layout used by bwrap."""

    repository_root = Path(__file__).resolve().parents[2]
    vitest = repository_root / "gitnexus" / "node_modules" / ".bin" / "vitest"
    if not vitest.is_file():
        pytest.skip("GitNexus Vitest dependencies are not installed")

    workspace = tmp_path / "workspace"
    candidate = workspace / "gitnexus"
    candidate.mkdir(parents=True)
    (candidate / "candidate.ts").write_text("export const candidateValue = 'candidate-workspace';\n")

    # The test file is a workspace sibling, so bare `vitest` imports resolve
    # through this harness dependency link while candidate-relative imports
    # resolve through ../gitnexus exactly as they do in the sandbox.
    (workspace / "node_modules").symlink_to(repository_root / "gitnexus" / "node_modules", target_is_directory=True)
    (candidate / "node_modules").symlink_to(repository_root / "gitnexus" / "node_modules", target_is_directory=True)

    hidden = workspace / ".wfbench-oracle-smoke"
    hidden.mkdir()
    shipped_config = repository_root / "eval" / "workflow_bench" / "oracles" / "vitest.config.mts"
    config = hidden / "vitest.config.mts"
    config.write_bytes(shipped_config.read_bytes())
    sentinel = tmp_path / "oracle-ran.txt"
    oracle = hidden / "candidate-import.oracle.test.ts"
    oracle.write_text(
        "import { writeFileSync } from 'node:fs';\n"
        "import { expect, test } from 'vitest';\n"
        "import { candidateValue } from '../gitnexus/candidate';\n"
        "test('uses the credited candidate checkout', () => {\n"
        "  expect(candidateValue).toBe('candidate-workspace');\n"
        "  writeFileSync(process.env.ORACLE_SENTINEL!, `ran:${candidateValue}`);\n"
        "});\n"
    )
    environment = os.environ.copy()
    environment["ORACLE_SENTINEL"] = str(sentinel)

    completed = subprocess.run(
        [str(vitest), "run", "--config", str(config), str(oracle)],
        cwd=candidate,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert sentinel.read_text() == "ran:candidate-workspace"


def test_weakened_authored_tests_cannot_produce_a_promotion_decision() -> None:
    incumbent = runner.aggregate([{"class": "demo", "resolved": True, **_metrics()} for _ in range(3)])
    candidate = runner.aggregate(
        [
            {
                "class": "demo",
                "resolved": False,
                "authored_tests_passed": True,
                "oracle_passed": False,
                **_metrics(cost_usd=0.01),
            }
            for _ in range(3)
        ]
    )
    decision = evaluate_candidate(
        {"task": {"workflow": incumbent, "candidate_workflow": candidate}},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
        min_runs=3,
    )

    assert decision["decision"] == "keep_incumbent"
    assert any("resolution regressed" in reason for reason in decision["reasons"])


def _metrics(*, cost_usd: float = 1.0) -> dict[str, object]:
    return {
        "input_tokens": 10,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": 5,
        "cost_usd": cost_usd,
        "duration_s": 1.0,
        "num_turns": 1,
        "diff_files": 1,
        "diff_insertions": 1,
        "diff_deletions": 0,
    }
