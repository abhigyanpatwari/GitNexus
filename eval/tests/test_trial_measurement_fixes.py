"""Regressions from the first paid two-cell telemetry trial. No model calls."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tests.test_diagnostic_trial import trial_plan, workflow  # noqa: F401
from tests.test_workflow_bench_sessions import _probe_cell_provisioning
from workflow_bench import cost_diagnostics, diagnostic_experiments, diagnostic_trial, runner
from workflow_bench.process_control import ManagedProcessResult
from workflow_bench.runner_artifacts import VerificationResult
from workflow_bench.runner_sessions import allowed_agent_tools
from workflow_bench.session_diagnostics import diagnose_session, public_cell_diagnostics
from workflow_bench.verification_diagnostics import public_verification, verification_metrics


def test_real_trial_planner_command_keeps_task_dependencies_separate_from_runtime(tmp_path, monkeypatch):
    step = next(s for s in workflow()["jobs"]["evaluate"]["steps"] if s.get("name") == "Prepare the capped diagnostic trial")
    capture = tmp_path / "argv.json"
    uv = tmp_path / "uv"
    uv.write_text(f"#!{sys.executable}\nimport json,os,sys\nopen(os.environ['CAPTURE'],'w').write(json.dumps(sys.argv[1:]))\n")
    uv.chmod(0o755)
    subprocess.run(["bash", "-c", step["run"]], check=True, env={
        **os.environ, "PATH": f"{tmp_path}:{os.defpath}", "CAPTURE": str(capture),
        "RUNNER_TEMP": str(tmp_path), "GITHUB_WORKSPACE": str(tmp_path),
        "GITHUB_SHA": "a" * 40, "RUNTIME_SHA": "b" * 40, "MODEL": diagnostic_trial.MODEL, "EFFORT": "xhigh",
    })
    argv = json.loads(capture.read_text())
    manifest = Path(argv[argv.index("--tasks") + 1])
    manifest.parent.mkdir(parents=True)
    source = Path(__file__).parents[1] / "workflow_bench/tasks.scenarios.yaml"
    manifest.write_bytes(source.read_bytes())
    monkeypatch.setattr(sys, "argv", ["prepare", *argv[argv.index("workflow_bench.diagnostic_experiments") + 1:]])
    diagnostic_experiments.main()
    plan_path = tmp_path / "release-evaluation/trial/plan.json"
    plan = json.loads(plan_path.read_text())
    for cell in plan["cells"]:
        task = json.loads((plan_path.parent / f"{cell['cell_id']}.tasks.json").read_text())["tasks"][0]
        assert task["repo"] == str(tmp_path / "tasks-base")
        assert task["repo"] == plan["task_repository"]
        assert task["ref"] == "c4ecf398de637cf779ab2238e69958cfd5d601ce"
        assert cell["argv"][cell["argv"].index("--gitnexus-root") + 1] == str(tmp_path / "candidate")


def test_old_candidate_dependency_override_fails_before_paid_executor(trial_plan, monkeypatch):  # noqa: F811
    path, runtime = trial_plan
    plan = json.loads(path.read_text())
    plan["task_repository"] = str(runtime)
    for cell in plan["cells"]:
        manifest = path.parent / f"{cell['cell_id']}.tasks.json"
        doc = json.loads(manifest.read_text())
        doc["tasks"][0]["repo"] = str(runtime)
        manifest.write_text(json.dumps(doc))
        cell["task_manifest_sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    path.write_text(json.dumps(plan))
    monkeypatch.setattr(diagnostic_trial.subprocess, "run", lambda *_a, **_k: pytest.fail("paid executor reached"))
    with pytest.raises(ValueError, match="pinned task checkout"):
        diagnostic_trial.execute_trial(path, runtime, "claude")
    assert not (path.parent / "execution.json").exists()


def test_placeholder_cli_usage_does_not_claim_zero_context():
    fields = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
    work = diagnose_session([{"type": "assistant", "message": {
        "id": "placeholder", "usage": dict.fromkeys(fields, 0), "content": [{"type": "text", "text": "done"}],
    }}], [1], 2)["workload"]
    assert work["usage_snapshots"] == 1 and work["complete_input_snapshots"] == 0
    for field in ("first_input_tokens", "max_input_tokens", "sum_input_tokens", "sum_output_tokens"):
        assert work[field] is None


def test_provider_request_context_uses_native_cache_semantics_and_withholds_conflicts():
    event = {"response_id": "r1", "provider": "litellm-normalized", "native_usage": {
        "prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 80}, "completion_tokens": 10,
    }}
    report = cost_diagnostics.provider_summary([event, event])
    assert report["request_tokens"]["total_input_tokens"]["max"] == 100
    assert report["request_tokens"]["cache_read_input_tokens"]["max"] == 80
    assert report["request_tokens"]["total_input_tokens"]["observed"] == 1
    conflicted = cost_diagnostics.provider_summary([event, {**event, "status": "failure"}])
    assert conflicted["request_tokens"]["total_input_tokens"]["max"] is None


def test_grading_evidence_survives_publication_without_hidden_output():
    result = VerificationResult("private command", ManagedProcessResult(
        state="exited", returncode=1, stdout_tail="PRIVATE hidden source", stderr_tail="EROFS", duration_s=2.5,
    ), "PRIVATE hidden source\nAssertionError: private test\nEROFS")
    evidence = verification_metrics(result, 2.5)
    public = public_cell_diagnostics({"verification_diagnostics": {"hidden": evidence | {"output": result.output}}})
    assert "PRIVATE" not in json.dumps(public)
    assert public["verification_diagnostics"]["hidden"]["exit_code"] == 1
    assert public["verification_diagnostics"]["hidden"]["assertion_failure"] is True
    assert public_verification({"state": "PRIVATE", "exit_code": True, "duration_s": float("nan")})["exit_code"] is None


def test_failed_cells_keep_task_provenance_and_budget(monkeypatch, tmp_path):
    ctx, *_ = _probe_cell_provisioning(monkeypatch, tmp_path)
    ctx.args.max_budget_usd = 5
    ctx.args.measurement_revisions = {"runtime_sha": "b" * 40, "harness_sha": "c" * 40}
    row = runner.run_cell(ctx, 0, "baseline_nomcp")
    assert row["error_kind"] == "infra-error"
    assert row["runtime_sha"] == "b" * 40 and row["harness_sha"] == "c" * 40
    assert row["max_budget_usd"] == 5 and row["task_base_sha"] == ctx.task_sha
    assert row["task_prompt_digest"] and row["model"] == ctx.args.model


def test_mcp_read_tools_are_permitted_and_measured_without_mutating_permissions():
    tools = allowed_agent_tools(implementation=True)
    assert {"mcp__gitnexus__grep", "mcp__gitnexus__read_file"} <= set(tools)
    assert "mcp__gitnexus__rename" not in tools and "mcp__gitnexus__cypher" not in tools
    events = [{"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "grep", "name": "mcp__gitnexus__grep", "input": {}},
    ]}}]
    assert diagnose_session(events, [0], 1)["workload"]["graph_calls"] == 1


def test_cost_summary_displays_setup_grading_and_provider_tokens(tmp_path, monkeypatch):
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"arm": "baseline", "task": "fixture", "verification_diagnostics": {
        "hidden": {"passed": False, "state": "exited", "exit_code": 1, "duration_s": 3, "typecheck_failure": True},
    }}) + "\n")
    timing = {"complete": True, "workers": 1, "total_s": 600, "before_first_cell_s": 500,
              "dependency_setup_s": 100, "foreground_graph_setup_s": 400, "private": "PRIVATE"}
    (tmp_path / "sweep-timing.json").write_text(json.dumps(timing))
    out, markdown = tmp_path / "public.json", tmp_path / "public.md"
    monkeypatch.setattr(sys, "argv", ["diagnostics", "--results", str(results), "--out", str(out), "--markdown-out", str(markdown)])
    cost_diagnostics.main()
    assert json.loads(out.read_text())["sweep_timing"]["before_first_cell_s"] == 500
    assert "PRIVATE" not in out.read_text()
    text = markdown.read_text()
    assert "before_first_cell_s | 500" in text and "typecheck_failure" in text


def test_release_preflight_requires_grading_controls_in_both_workflow_paths():
    step = next(s for s in workflow()["jobs"]["evaluate"]["steps"] if s.get("name") == "Materialize both release graphs before paid sessions")
    assert step["run"].count("workflow_bench.release_preflight") == step["run"].count("--grading-controls") == 2


def test_public_release_rows_keep_comparable_provenance_and_budget():
    from tests.test_release_report import metadata, rows
    from workflow_bench.release_report import build_report

    source = rows()
    for row in source:
        row.update(runtime_sha="a" * 40, harness_sha="c" * 40, task_prompt_digest="d" * 64,
                   max_budget_usd=5.0, mcp_tool_loading="eager" if row["arm"] == "baseline" else "none")
    exported = build_report(source, metadata())["per_run"]
    report = cost_diagnostics.build_cost_report(exported)
    assert all(group["provenance_complete"] for group in report["groups"])
    assert all(group["cohort"]["max_budget_usd"] == "5.0" for group in report["groups"])
    assert all(group["cohort"]["runtime_digest"] == "" for group in report["groups"])


def test_mcp_session_prompt_names_the_isolated_repository(monkeypatch, tmp_path):
    from tests.test_workflow_bench_sessions import VALID_REPORT, bench_args, fake_cli_result, fake_sandbox
    from workflow_bench import runner_sessions

    prompts = []

    def execute(command, **kwargs):
        prompts.append(kwargs["stdin_data"].decode())
        return fake_cli_result(VALID_REPORT)

    monkeypatch.setattr(runner_sessions, "run_managed", execute)
    monkeypatch.setattr(runner, "run_verify", lambda *_a, **_k: (True, "ok"))
    for arm in ("baseline", "baseline_nomcp"):
        runner.run_arm(arm, {"prompt": "Repair the task", "verify": "true"}, tmp_path,
                       bench_args(), sandbox=fake_sandbox(tmp_path))
    assert "benchmark-target" in prompts[0]
    assert "benchmark-target" not in prompts[1]


def test_interrupted_timing_does_not_discard_cell_evidence(tmp_path, monkeypatch):
    results, out = tmp_path / "results.jsonl", tmp_path / "public.json"
    results.write_text('{"arm":"baseline_nomcp","task":"fixture"}\n')
    (tmp_path / "sweep-timing.json").write_text('{"complete":')
    monkeypatch.setattr(sys, "argv", ["diagnostics", "--results", str(results), "--out", str(out), "--allow-incomplete"])
    cost_diagnostics.main()
    report = json.loads(out.read_text())
    assert report["cells"] == 1 and report["sweep_timing"] is None
    assert "Sweep timing file is unreadable." in report["input_problems"]
