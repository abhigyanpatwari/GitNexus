"""Prepared trials must reject dependency drift before launching paid cells."""

import json
from pathlib import Path
import subprocess
import sys
from typing import get_args

import pytest
import yaml

from tests import test_diagnostic_trial
from workflow_bench import diagnostic_experiments, diagnostic_trial
from workflow_bench.process_control import ProcessState
from workflow_bench.verification_diagnostics import public_verification


@pytest.fixture
def bound_trial(tmp_path, monkeypatch):
    repo, runtime = tmp_path / "tasks-base", tmp_path / "runtime"
    repo.mkdir()
    runtime.mkdir()
    (repo / ".gitignore").write_text("node_modules/\n")
    (repo / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
    for args in (
        ["init", "-q"], ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"],
    ):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
    sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    dependency = repo / "node_modules" / "fixture.js"
    dependency.parent.mkdir()
    dependency.write_text("module.exports = 'pinned';\n")
    corpus = yaml.safe_load((Path(__file__).parents[1] / "workflow_bench/tasks.scenarios.yaml").read_text())
    task = next(task for task in corpus["tasks"] if task["id"] == diagnostic_trial.TASK)
    task.update(ref=sha, sandbox_dependencies=[{"source": "node_modules", "target": "node_modules"}])
    manifest = tmp_path / "tasks.yaml"
    manifest.write_text(yaml.safe_dump({"tasks": [task]}))
    output = tmp_path / "trial"
    monkeypatch.setattr(sys, "argv", [
        "prepare", "--tasks", str(manifest), "--repository", str(repo), "--runtime", str(runtime),
        "--runtime-sha", test_diagnostic_trial.SHA, "--harness-sha", test_diagnostic_trial.SHA,
        "--model", diagnostic_trial.MODEL, "--repeats", "1", "--variants", "no_graph", "mcp_eager",
        "--max-budget-usd", "5", "--bind-task-dependencies", "--out", str(output),
    ])
    diagnostic_experiments.main()
    monkeypatch.setattr(diagnostic_trial, "_head", lambda path: sha if path == repo else test_diagnostic_trial.SHA)
    return output / "plan.json", runtime, repo, dependency


def test_prepared_bindings_reach_both_runner_processes(bound_trial, monkeypatch):
    path, runtime, _, _ = bound_trial
    plan = json.loads(path.read_text())
    calls = []
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", test_diagnostic_trial.fake_runner(calls))
    assert diagnostic_trial.execute_trial(path, runtime, "claude") == 0
    assert len(calls) == 2
    for (command, _), cell in zip(calls, plan["cells"], strict=True):
        bound = json.loads(command[command.index("--task-bindings-json") + 1])
        assert bound == cell["task_bindings"]
        assert bound[0]["sandbox_dependency_content_digest"]


@pytest.mark.parametrize("change", ["tracked", "staged", "modified_dependency", "new_dependency", "deleted_dependency", "missing_binding"])
def test_trial_rejects_checkout_or_dependency_drift_before_execution(bound_trial, monkeypatch, change):
    path, runtime, repo, dependency = bound_trial
    if change in ("tracked", "staged"):
        (repo / "package-lock.json").write_text('{"lockfileVersion": 2}\n')
        if change == "staged":
            subprocess.run(["git", "-C", str(repo), "add", "package-lock.json"], check=True)
    elif change == "modified_dependency":
        dependency.write_text("module.exports = 'changed';\n")
    elif change == "new_dependency":
        (dependency.parent / "extra.js").write_text("unexpected dependency\n")
    elif change == "deleted_dependency":
        dependency.unlink()
    else:
        plan = json.loads(path.read_text())
        del plan["cells"][0]["task_bindings"]
        path.write_text(json.dumps(plan))
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", lambda *_a, **_kw: pytest.fail("paid executor reached"))
    with pytest.raises(ValueError, match="clean pinned|definition drifted|pin task dependency"):
        diagnostic_trial.execute_trial(path, runtime, "claude")
    assert not (path.parent / "execution.json").exists()


def test_planning_rejects_dirty_dependency_source_before_pinning(bound_trial):
    path, _, repo, _ = bound_trial
    (repo / "package-lock.json").write_text("dirty\n")
    tasks = json.loads((path.parent / "cell-0000.tasks.json").read_text())["tasks"]
    with pytest.raises(ValueError, match="clean pinned"):
        diagnostic_experiments.trial_task_bindings(tasks)


@pytest.mark.parametrize("state", get_args(ProcessState))
def test_public_verification_preserves_every_terminal_process_state(state):
    assert public_verification({"state": state})["state"] == state


def test_public_verification_withholds_unknown_process_state():
    assert public_verification({"state": "private unrecognized output"})["state"] == "unknown"
