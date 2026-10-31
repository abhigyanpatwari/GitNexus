"""The paid trial must stay at two bounded calls and publish private-safe results."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
import yaml

from workflow_bench import diagnostic_experiments, diagnostic_trial
from workflow_bench.session_diagnostics import diagnose_session

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40


@pytest.fixture
def trial_plan(tmp_path, monkeypatch):
    runtime = tmp_path / "candidate"
    runtime.mkdir()
    task_repo = tmp_path / "tasks-base"
    task_repo.mkdir()
    monkeypatch.setattr(diagnostic_experiments, "trial_task_bindings", lambda tasks, expected=None: [{"id": tasks[0]["id"]}])
    output = tmp_path / "release-evaluation" / "trial"
    monkeypatch.setattr(sys, "argv", [
        "prepare", "--tasks", str(ROOT / "eval/workflow_bench/tasks.scenarios.yaml"),
        "--repository", str(task_repo), "--runtime", str(runtime), "--runtime-sha", SHA,
        "--harness-sha", SHA, "--model", diagnostic_trial.MODEL, "--repeats", "1",
        "--variants", "no_graph", "mcp_eager", "--task-ids", diagnostic_trial.TASK,
        "--max-budget-usd", "5", "--bind-task-dependencies", "--out", str(output),
    ])
    diagnostic_experiments.main()
    monkeypatch.setattr(diagnostic_trial, "_head", lambda repository:
                        "c4ecf398de637cf779ab2238e69958cfd5d601ce" if repository == task_repo else SHA)
    return output / "plan.json", runtime


def fake_runner(calls, *, codes=(0, 0), missing=None):
    events = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "one", "name": "Read",
                                                     "input": {"file_path": "PRIVATE"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "one", "content": "PRIVATE"}]}},
    ]
    diagnostics = diagnose_session(events, [1, 2], 3)

    def run(command, *, cwd, env, check):
        calls.append((command, env))
        output = Path(command[command.index("--out") + 1])
        output.mkdir(parents=True)
        row = {
            "task": diagnostic_trial.TASK, "arm": command[command.index("--arms") + 1], "run": 0,
            "model": diagnostic_trial.MODEL, "cost_usd": 0.1, "resolved": True, "ok": True,
            "session_diagnostics": [diagnostics] if missing != "diagnostics" else [],
        }
        if missing != "results":
            (output / "results.jsonl").write_text(json.dumps(row) + "\n")
        if missing != "ledger":
            Path(env["GITNEXUS_BENCH_PROVIDER_USAGE"]).write_text(json.dumps({
                "status": "success", "provider": "openai", "response_id": "private-id",
                "native_usage": {"prompt_tokens": 10, "completion_tokens": 2}, "prompt": "PRIVATE",
            }) + "\n")
        return SimpleNamespace(returncode=codes[len(calls) - 1])
    return run


@pytest.mark.parametrize("codes", [(0, 0), (1, 0), (0, 1)])
def test_trial_executes_exactly_two_serial_budgeted_cells_and_retains_failures(trial_plan, monkeypatch, codes):
    path, runtime = trial_plan
    calls = []
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", fake_runner(calls, codes=codes))
    assert diagnostic_trial.execute_trial(path, runtime, "/pinned/claude") == int(any(codes))
    assert len(calls) == 2
    assert [command[command.index("--arms") + 1] for command, _ in calls] == ["baseline", "baseline_nomcp"]
    for command, _ in calls:
        for flag, value in (("--max-budget-usd", "5.0"), ("--workers", "1"), ("--runs", "1"),
                            ("--timeout", "900"), ("--model", diagnostic_trial.MODEL), ("--claude-bin", "/pinned/claude")):
            assert command[command.index(flag) + 1] == value
        assert command[:3] == [sys.executable, "-m", "workflow_bench.runner"]
    assert len({env["GITNEXUS_BENCH_PROVIDER_USAGE"] for _, env in calls}) == 2
    receipt = json.loads((path.parent / "execution.json").read_text())
    assert [cell["exit_code"] for cell in receipt["cells"]] == list(codes)
    assert all(cell["measurements_present"] for cell in receipt["cells"])
    assert receipt["status"] == ("failed" if any(codes) else "completed")
    with pytest.raises(ValueError, match="repeat paid work"):
        diagnostic_trial.execute_trial(path, runtime, "/pinned/claude")
    assert len(calls) == 2


@pytest.mark.parametrize("field,value", [("model", "other"), ("workers", 2), ("repeats", 3),
                                        ("max_budget_usd_per_cell", 10), ("planned_cli_budget_usd", 20),
                                        ("release_gate_eligible", True), ("execution", "started"), ("seed", 1)])
def test_policy_changes_fail_before_any_paid_process(trial_plan, monkeypatch, field, value):
    path, runtime = trial_plan
    plan = json.loads(path.read_text())
    plan[field] = value
    path.write_text(json.dumps(plan))
    calls = []
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", fake_runner(calls))
    with pytest.raises(ValueError):
        diagnostic_trial.execute_trial(path, runtime, "/pinned/claude")
    assert calls == []


@pytest.mark.parametrize("change", ["third_cell", "extra_argument", "manifest_hash", "extra_task", "ledger", "revision"])
def test_cell_tampering_fails_before_any_paid_process(trial_plan, monkeypatch, change):
    path, runtime = trial_plan
    plan = json.loads(path.read_text())
    cell = plan["cells"][0]
    manifest = path.parent / "cell-0000.tasks.json"
    if change == "third_cell":
        plan["cells"].append(cell.copy())
    elif change == "extra_argument":
        cell["argv"] += ["--runs", "10"]
    elif change == "manifest_hash":
        manifest.write_text(manifest.read_text() + " ")
    elif change == "extra_task":
        document = json.loads(manifest.read_text())
        document["tasks"].append(document["tasks"][0].copy())
        manifest.write_text(json.dumps(document))
        cell["task_manifest_sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    elif change == "ledger":
        cell["env"]["GITNEXUS_BENCH_PROVIDER_USAGE"] = "/tmp/reused-ledger"
    else:
        plan["runtime_sha"] = "b" * 40
    path.write_text(json.dumps(plan))
    calls = []
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", fake_runner(calls))
    with pytest.raises(ValueError):
        diagnostic_trial.execute_trial(path, runtime, "/pinned/claude")
    assert calls == []


def test_interrupted_trial_cannot_be_reexecuted_without_a_new_plan(trial_plan, monkeypatch):
    path, runtime = trial_plan
    calls = []

    def crash(*args, **kwargs):
        calls.append(args)
        raise OSError("synthetic launch failure")

    monkeypatch.setattr(diagnostic_trial.subprocess, "run", crash)
    with pytest.raises(OSError):
        diagnostic_trial.execute_trial(path, runtime, "/pinned/claude")
    with pytest.raises(FileExistsError):
        diagnostic_trial.execute_trial(path, runtime, "/pinned/claude")
    assert len(calls) == 1


@pytest.mark.parametrize("missing", ["results", "ledger", "diagnostics"])
def test_missing_measurements_cannot_make_the_trial_green(trial_plan, monkeypatch, missing):
    path, runtime = trial_plan
    calls = []
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", fake_runner(calls, missing=missing))
    assert diagnostic_trial.execute_trial(path, runtime, "/pinned/claude") == 1
    assert len(calls) == 2


def workflow():
    return yaml.safe_load((ROOT / ".github/workflows/release-evaluation.yml").read_text())


@pytest.mark.parametrize("override", [{}, {"TRIAL": "false", "GITHUB_RUN_ATTEMPT": "2"},
                                     {"GITHUB_RUN_ATTEMPT": "2"}, {"GITHUB_EVENT_NAME": "schedule"},
                                     {"RUNNER_ONLY": "true"}, {"CLI_ARM": "true"}, {"DEFERRED_ARM": "true"},
                                     {"MODEL": "other"}, {"EFFORT": "max"}, {"CANDIDATE_REF": "latest-rc"}])
def test_real_startup_guard_rejects_expanded_or_repeated_paid_trials(override):
    step = workflow()["jobs"]["start-runner"]["steps"][0]
    env = {**os.environ, "TRIAL": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ATTEMPT": "1",
           "RUNNER_ONLY": "false", "CLI_ARM": "false", "DEFERRED_ARM": "false", "CANDIDATE_REF": SHA,
           "MODEL": diagnostic_trial.MODEL, "EFFORT": "xhigh", **override}
    result = subprocess.run(["bash", "-c", step["run"]], env=env, capture_output=True)
    assert (result.returncode == 0) == (not override or override.get("TRIAL") == "false")


@pytest.mark.parametrize("attempt", ["1", "2"])
def test_real_paid_step_routes_trial_to_bounded_executor_without_full_sweep(tmp_path, attempt):
    steps = workflow()["jobs"]["evaluate"]["steps"]
    script = next(step["run"] for step in steps if step.get("name") == "Run repeated paired agent sessions")
    script = re.sub(r"\$\{\{.*?\}\}", str(int(time.time()) + 7200), script)
    binary = tmp_path / "uv"
    binary.write_text(f"#!{sys.executable}\nimport json,os,sys\nwith open(os.environ['CAPTURE'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n")
    binary.chmod(0o755)
    capture = tmp_path / "calls.jsonl"
    result = subprocess.run(["bash", "-c", script], capture_output=True, env={
        **os.environ, "DIAGNOSTIC_TRIAL": "true", "CAPTURE": str(capture), "PATH": f"{tmp_path}:{os.defpath}",
        "RUNNER_TEMP": str(tmp_path), "GITHUB_WORKSPACE": str(tmp_path), "GITHUB_RUN_ATTEMPT": attempt,
    })
    if attempt != "1":
        assert result.returncode != 0 and not capture.exists()
        return
    assert result.returncode == 0
    calls = [json.loads(line) for line in capture.read_text().splitlines()]
    assert len(calls) == 1
    assert "workflow_bench.diagnostic_trial" in calls[0] and "--execute" in calls[0]
    assert "workflow_bench.runner" not in calls[0]


def test_trial_is_manual_only_and_cannot_publish_release_evidence():
    document = workflow()
    assert document[True]["workflow_dispatch"]["inputs"]["diagnostic_trial"]["default"] is False
    assert "diagnostic_trial" not in document[True]["workflow_call"]["inputs"]
    steps = document["jobs"]["evaluate"]["steps"]
    excluded = {"Summarize complete or incomplete measurements", "Require complete paired evidence and no task regression",
                "Collect sanitized evidence and publish summary", "Summarize time, cost, and tool measurements",
                "Upload sanitized release evidence", "Upload sanitized PR cost comparison"}
    for step in steps:
        if step.get("name") in excluded:
            assert "inputs.diagnostic_trial != true" in step["if"]
    upload = next(step for step in steps if step.get("name") == "Upload sanitized diagnostic trial measurements")
    assert "always()" in upload["if"] and "inputs.diagnostic_trial == true" in upload["if"]
    assert upload["with"]["name"].startswith("diagnostic-trial-")
    assert all("/public/trial-*-diagnostics." in line for line in upload["with"]["path"].splitlines())
    assert "refs/heads/main" in document["jobs"]["evaluate"]["if"]
    assert document["jobs"]["evaluate"]["environment"] == "gitnexus-evolution"


def test_real_trial_summary_publishes_both_cells_without_private_payloads(trial_plan, tmp_path, monkeypatch):
    path, runtime = trial_plan
    calls = []
    with monkeypatch.context() as scoped:
        scoped.setattr(diagnostic_trial.subprocess, "run", fake_runner(calls))
        assert diagnostic_trial.execute_trial(path, runtime, "/pinned/claude") == 0
    binary = tmp_path / "uv"
    binary.write_text(f"#!{sys.executable}\nimport os,sys\na=sys.argv[1:]; os.execv(sys.executable,[sys.executable,*a[a.index('python')+1:]])\n")
    binary.chmod(0o755)
    summary = tmp_path / "summary.md"
    step = next(step for step in workflow()["jobs"]["evaluate"]["steps"] if step.get("name") == "Summarize the diagnostic trial")
    subprocess.run(["bash", "-c", step["run"]], check=True, cwd=ROOT / "eval", capture_output=True, env={
        **os.environ, "PATH": f"{tmp_path}:{os.defpath}", "RUNNER_TEMP": str(tmp_path), "GITHUB_STEP_SUMMARY": str(summary),
    })
    body = summary.read_text()
    assert "Two-cell diagnostic trial" in body and "planned $10" in body
    assert body.count("Observed cells: 1") == 2
    assert "PRIVATE" not in body and "private-id" not in body
    assert len(list((tmp_path / "release-evaluation/public").glob("trial-*-diagnostics.json"))) == 2
