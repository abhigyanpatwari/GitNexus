"""Reference grading must work before a paid release or telemetry session starts."""

from contextlib import nullcontext
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from workflow_bench import release_controls
from workflow_bench.proposer_sandbox import SandboxError, preflight_bubblewrap
from workflow_bench.task_assets import TaskAssetCache


@pytest.mark.parametrize("failure", [None, "negative_passes", "startup", "permission", "patch", "typecheck", "reference"])
def test_controls_require_behavioral_failure_then_a_typed_reference(monkeypatch, tmp_path, failure):
    task = {"id": "trivial-status-json-alias"}
    clone = tmp_path / "clone"
    clone.mkdir()
    mounts, calls = [], []
    sandbox = SimpleNamespace(clone=clone, environment=lambda: {},
                              command_prefix_for=lambda **kw: mounts.append(kw) or ["sandbox"])
    monkeypatch.setattr(release_controls, "make_worktree", lambda *_: clone)
    monkeypatch.setattr(release_controls, "sanitize_clone_for_hidden_oracles", lambda *_: None)
    monkeypatch.setattr(release_controls, "stage_task_assets", lambda *_a, **_kw: [])
    monkeypatch.setattr(release_controls, "capture_task_oracle", lambda *_: object())
    monkeypatch.setattr(release_controls, "prepare_sandbox", lambda **_: nullcontext(sandbox))

    def oracle(*_args, diagnostics=None):
        calls.append("negative" if diagnostics is not None else "reference")
        if diagnostics is not None:
            diagnostics.update(exit_code=1, assertion_failure=True, startup_failure=failure == "startup",
                               permission_failure=failure == "permission")
            return failure == "negative_passes", "hidden output withheld"
        return failure != "reference", "hidden output withheld"

    def verify(command, *_args, **_kwargs):
        step = "patch" if command.startswith("git apply") else "typecheck"
        calls.append(step)
        return failure != step, "PRIVATE OUTPUT"

    monkeypatch.setattr(release_controls, "_run_hidden_oracle", oracle)
    monkeypatch.setattr(release_controls, "run_verify", verify)
    if failure:
        with pytest.raises(SandboxError) as error:
            release_controls.check_task_controls(task, repo=tmp_path, sha="a" * 40, parent=tmp_path,
                                                assets=object(), claude_bin=Path("claude"), bwrap_bin=Path("bwrap"))
        assert "PRIVATE" not in str(error.value)
    else:
        release_controls.check_task_controls(task, repo=tmp_path, sha="a" * 40, parent=tmp_path,
                                            assets=object(), claude_bin=Path("claude"), bwrap_bin=Path("bwrap"))
        assert calls == ["negative", "patch", "typecheck", "reference"]
        assert mounts[-1] == {"read_only_workspace": True, "unshare_network": True}
    if failure in ("negative_passes", "startup", "permission"):
        assert calls == ["negative"]


@pytest.mark.skipif(os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
                    reason="requires the provisioned Linux containment runner")
def test_real_release_reference_controls_use_pinned_dependencies_and_read_only_grading(tmp_path):
    # No provider, proxy, or agent process. The pinned CLI executable is only a
    # sandbox mount; grading invokes the historical TypeScript/Vitest toolchain.
    repo = Path(os.environ["GITNEXUS_ORACLE_TASK_DEPENDENCIES"])
    claude = Path(os.environ["CLAUDE_CANARY_BIN"])
    tasks = yaml.safe_load((Path(__file__).parents[1] / "workflow_bench/tasks.scenarios.yaml").read_text())["tasks"]
    task = next(t for t in tasks if t["id"] == "trivial-status-json-alias")
    with TaskAssetCache(tmp_path / "assets") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha=task["ref"])
        release_controls.check_task_controls(task, repo=repo, sha=task["ref"], parent=tmp_path,
                                            assets=snapshot, claude_bin=claude, bwrap_bin=preflight_bubblewrap())
