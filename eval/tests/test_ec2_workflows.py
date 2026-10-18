"""Both trusted workflows must own a complete, serialized EC2 lifecycle."""

from pathlib import Path
import json
import os
import re
import subprocess
import sys
import time
import yaml
import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_shared_ec2_lock_obeys_repository_concurrency_gate():
    subprocess.run(
        [sys.executable, str(ROOT / ".github/scripts/check-workflow-concurrency.py"), str(ROOT / ".github/workflows")],
        check=True,
    )


def test_shared_lock_exception_cannot_be_reused_by_unrelated_workflows(tmp_path):
    source = "on: workflow_dispatch\nconcurrency:\n  group: gitnexus-evolution-runner\n"
    script = ROOT / ".github/scripts/check-workflow-concurrency.py"
    allowed = tmp_path / "release-evaluation.yml"
    allowed.write_text(source)
    assert subprocess.run([sys.executable, str(script), str(tmp_path)], capture_output=True).returncode == 0
    allowed.rename(tmp_path / "unrelated.yml")
    assert subprocess.run([sys.executable, str(script), str(tmp_path)], capture_output=True).returncode == 1


def workflow(name):
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text())


@pytest.mark.parametrize(
    "name,paid", [("gitnexus-skill-evolution.yml", "evolve"), ("release-evaluation.yml", "evaluate")]
)
def test_instance_is_serialized_and_cleanup_is_hosted_even_after_failure(name, paid):
    document = workflow(name)
    assert document["concurrency"] == {"group": "gitnexus-evolution-runner", "cancel-in-progress": False}
    jobs = document["jobs"]
    start, stop = jobs["start-runner"], jobs["stop-runner"]
    assert start["runs-on"] == stop["runs-on"] == "ubuntu-latest"
    assert start["environment"] == stop["environment"] == "gitnexus-evolution"
    assert "refs/heads/main" in start["if"] and "refs/heads/main" in stop["if"]
    assert "always()" in stop["if"]
    assert "cleanup_required == 'true'" in stop["if"]
    assert paid in stop["needs"] and "start-runner" in stop["needs"]
    assert start["permissions"] == stop["permissions"] == {"contents": "read", "id-token": "write"}
    assert "self-hosted" in jobs[paid]["runs-on"]
    assert set(jobs[paid]["needs"]) >= {"start-runner", "check-runner", "runner-ready"}
    assert jobs["runner-ready"]["needs"] == ["start-runner"]
    assert jobs["check-runner"]["needs"] == ["start-runner"]
    for job, operation in ((start, "start"), (stop, "stop")):
        action = next(step for step in job["steps"] if step.get("uses") == "./.github/actions/ec2-runner")
        assert action["with"]["operation"] == operation
        assert action["with"]["role-arn"] == "${{ secrets.GITNEXUS_EVOLUTION_AWS_ROLE_ARN }}"
        assert action["with"]["instance-id"] == "${{ secrets.GITNEXUS_EVOLUTION_EC2_INSTANCE_ID }}"
        assert action["with"]["region"] == "${{ vars.GITNEXUS_EVOLUTION_AWS_REGION }}"
        assert action["with"]["stop-schedule"] == "${{ vars.GITNEXUS_EVOLUTION_STOP_SCHEDULE_UTC }}"


def test_release_probe_skips_paid_calls_and_paid_job_has_pickup_watchdog():
    jobs = workflow("release-evaluation.yml")["jobs"]
    assert "inputs.runner_only != true" in jobs["evaluate"]["if"]
    watch = jobs["watch-evaluate-pickup"]
    assert watch["needs"] == jobs["evaluate"]["needs"]
    assert "watch-evaluate-pickup" not in jobs["evaluate"]["needs"]
    assert any('--job-name "Evaluate candidate and stable quality"' in step.get("run", "") for step in watch["steps"])
    assert watch["steps"][-1]["if"] == "failure()"


@pytest.mark.parametrize(
    "name,paid,watch",
    [
        ("gitnexus-skill-evolution.yml", "evolve", "watch-evolve-pickup"),
        ("release-evaluation.yml", "evaluate", "watch-evaluate-pickup"),
    ],
)
def test_pickup_watchdog_names_the_paid_job_it_bounds(name, paid, watch):
    jobs = workflow(name)["jobs"]
    command = f'python3 .github/scripts/evolution-runner-ready.py --job-name "{jobs[paid]["name"]}"'
    assert [step.get("run") for step in jobs[watch]["steps"]].count(command) == 1


def test_release_comparison_is_scheduled_or_manual_and_gates_outcomes():
    document = workflow("release-evaluation.yml")
    # PyYAML parses the bare `on` key as True.
    assert set(document[True]) == {"schedule", "workflow_dispatch", "workflow_call"}
    steps = document["jobs"]["evaluate"]["steps"]
    scripts = "\n".join(step.get("run", "") for step in steps)
    assert "releases/latest" in scripts
    assert "workflow_bench.release_gate" in scripts
    assert "--stable-sha" in scripts and "--candidate-sha" in scripts


def test_pr_preview_uses_trusted_main_and_authenticates_history_before_paid_sessions():
    document = workflow("release-evaluation.yml")
    inputs = document[True]["workflow_dispatch"]["inputs"]
    preview_inputs = {"candidate_pr", "expected_pr_sha", "comparison_run_id"}
    assert preview_inputs.isdisjoint(inputs)
    call_inputs = document[True]["workflow_call"]["inputs"]
    assert preview_inputs <= call_inputs.keys()
    assert all(call_inputs[key]["required"] for key in preview_inputs)
    job = document["jobs"]["evaluate"]
    assert "refs/heads/main" in job["if"]
    assert job["environment"] == "gitnexus-evolution"
    assert job["permissions"] == {"contents": "read", "actions": "read", "pull-requests": "read"}
    steps = job["steps"]
    resolve = next(step for step in steps if step.get("id") == "resolve")
    assert "workflow_bench.pr_evaluation resolve" in resolve["run"]
    assert '--sha "$INPUT_PR_SHA"' in resolve["run"]
    # Standard release candidates still require reviewed main ancestry.
    assert 'git merge-base --is-ancestor "$sha" HEAD' in resolve["run"]
    baseline = next(step for step in steps if "workflow_bench.pr_evaluation baseline" in step.get("run", ""))
    paid = next(step for step in steps if "workflow_bench.runner" in step.get("run", ""))
    assert steps.index(baseline) < steps.index(paid)
    assert "inputs.candidate_pr != ''" in baseline["if"]
    assert 'arms=(baseline)' in paid["run"]
    dependencies = next(step for step in steps if "workflow_bench.pr_evaluation dependencies" in step.get("run", ""))
    assert steps.index(dependencies) < steps.index(paid)
    assert "inputs.candidate_pr != ''" in dependencies["if"]
    opt_in = next(step for step in steps if step.get("name", "").startswith("Recheck PR opt-in"))
    assert steps.index(opt_in) + 1 == steps.index(paid)
    assert 'workflow_bench.pr_evaluation resolve' in opt_in["run"]
    assert "inputs.candidate_pr != ''" in opt_in["if"]


def test_cost_request_is_label_only_and_executes_trusted_base_code():
    document = workflow("pr-cost-evaluation.yml")
    assert document[True] == {"pull_request_target": {"types": ["labeled"], "branches": ["main"]}}
    assert document["permissions"] == {}
    job = document["jobs"]["request"]
    assert "github.event.label.name == 'run-cost-evaluation'" in job["if"]
    assert "github.run_attempt == 1" in job["if"]
    assert job["runs-on"] == "ubuntu-latest" and "environment" not in job
    assert job["permissions"] == {"contents": "read", "pull-requests": "read", "actions": "read"}
    checkout, dispatch = job["steps"]
    assert checkout["with"] == {"ref": "${{ github.sha }}", "persist-credentials": False}
    assert "dispatch-label" in dispatch["run"] and '"$GITHUB_EVENT_PATH"' in dispatch["run"]
    assert "${{ github.event." not in dispatch["run"]
    assert '"$GITHUB_OUTPUT"' in dispatch["run"]
    evaluate = document["jobs"]["evaluate"]
    assert evaluate["needs"] == ["request"]
    assert evaluate["if"] == "needs.request.outputs.run_attempt == github.run_attempt"
    assert evaluate["uses"] == "./.github/workflows/release-evaluation.yml"
    expected_secrets = {
        "GITNEXUS_EVOLUTION_AWS_ROLE_ARN", "GITNEXUS_EVOLUTION_EC2_INSTANCE_ID",
        "GITNEXUS_BENCH_OPENAI_API_KEY", "GITNEXUS_BENCH_ANTHROPIC_API_KEY",
    }
    assert evaluate["secrets"] == {key: "${{ secrets." + key + " }}" for key in expected_secrets}
    assert set(workflow("release-evaluation.yml")[True]["workflow_call"]["secrets"]) == expected_secrets
    assert evaluate["with"] == {
        "candidate_pr": "${{ needs.request.outputs.pr }}",
        "expected_pr_sha": "${{ needs.request.outputs.sha }}",
        "comparison_run_id": "${{ needs.request.outputs.comparison_run_id }}",
    }


def test_pr_preview_cannot_publish_release_approval_evidence():
    steps = workflow("release-evaluation.yml")["jobs"]["evaluate"]["steps"]
    gate = next(step for step in steps if "workflow_bench.release_gate" in step.get("run", ""))
    assert "inputs.candidate_pr == ''" in gate["if"]
    uploads = [step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@")]
    release = next(step for step in uploads if step["with"]["name"].startswith("release-agent-evaluation-"))
    preview = next(step for step in uploads if step["with"]["name"].startswith("pr-cost-comparison-"))
    assert "inputs.candidate_pr == ''" in release["if"]
    assert "inputs.candidate_pr != ''" in preview["if"]
    assert "agent-evaluation.json" not in preview["with"]["path"]
    assert "pr-cost-comparison.json" in preview["with"]["path"]


@pytest.mark.parametrize("pr,runtimes,arms", [
    ("3621", ["candidate"], ["baseline"]),
    ("", ["stable", "candidate"], ["baseline_nomcp", "baseline"]),
])
def test_real_paid_step_selects_only_the_requested_runtime_and_arms(tmp_path, pr, runtimes, arms):
    steps = workflow("release-evaluation.yml")["jobs"]["evaluate"]["steps"]
    script = next(step["run"] for step in steps if "workflow_bench.runner" in step.get("run", ""))
    script = re.sub(r"\$\{\{.*?\}\}", str(int(time.time()) + 7200), script)
    # Exercise the real shell branching without running a model or a timeout.
    binary = tmp_path / "uv"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "with open(os.environ['CAPTURE_ARGS'], 'a') as output:\n"
        "    output.write(json.dumps(sys.argv[1:]) + '\\n')\n"
    )
    binary.chmod(0o755)
    log = tmp_path / "arguments.jsonl"
    subprocess.run(
        ["bash", "--noprofile", "--norc", "-c", script], check=True, capture_output=True,
        env={**os.environ, "PATH": f"{tmp_path}:{os.defpath}", "CAPTURE_ARGS": str(log),
             "INPUT_PR": pr, "MODEL": "gpt-5.6-sol", "EFFORT": "xhigh",
             "GITHUB_WORKSPACE": str(tmp_path), "RUNNER_TEMP": str(tmp_path)},
    )
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(calls) == len(runtimes)
    for arguments, runtime in zip(calls, runtimes, strict=True):
        assert arguments[arguments.index("--gitnexus-root") + 1] == str(tmp_path / runtime)
        assert arguments[arguments.index("--arms") + 1:arguments.index("--runs")] == arms
        assert arguments[arguments.index("--runs") + 1] == "3"


def test_release_session_headroom_keeps_the_global_stop_reserve():
    steps = workflow("release-evaluation.yml")["jobs"]["evaluate"]["steps"]
    paid = next(step for step in steps if "workflow_bench.runner" in step.get("run", ""))
    script = paid["run"]
    assert "--timeout 3600" in script
    assert "for runtime in stable candidate; do" in script
    assert "stop_deadline_epoch }} - $(date +%s) - 5400" in script
    assert 'timeout --signal=TERM --kill-after=60 "${remaining}s"' in script
    assert paid["timeout-minutes"] == 1140
    canary = next(step for step in steps if "tests/test_proposer_sandbox.py" in step.get("run", ""))
    assert "test_real_cli_background_completion_is_one_complete_measurement" in canary["run"]
    assert canary["env"]["GITNEXUS_REQUIRE_CLAUDE_CANARY"] == "1"
    assert steps.index(canary) < steps.index(paid)
    assert not canary.get("continue-on-error", False)


def test_both_runtimes_grade_tasks_against_one_pinned_task_dependency_checkout():
    steps = workflow("release-evaluation.yml")["jobs"]["evaluate"]["steps"]
    names = [step.get("name", step.get("uses", "")) for step in steps]
    resolve = next(step for step in steps if step.get("id") == "tasks")
    assert "workflow_bench.release_report task-sha" in resolve["run"]
    assert 'echo "sha=$sha" >> "$GITHUB_OUTPUT"' in resolve["run"]
    checkout = next(step for step in steps if step.get("with", {}).get("path") == "tasks-base")
    assert checkout["with"]["ref"] == "${{ steps.tasks.outputs.sha }}"
    assert checkout["with"]["persist-credentials"] is False
    build = next(step for step in steps if "workflow_bench.release_build" in step.get("run", ""))
    prepare = next(step for step in steps if "release_report prepare" in step.get("run", ""))
    sessions = next(step for step in steps if "workflow_bench.runner" in step.get("run", ""))
    assert steps.index(resolve) < steps.index(checkout) < steps.index(build) < steps.index(prepare)
    # The task checkout is built in the same sandbox as both runtimes.
    assert "for checkout in tasks-base stable candidate; do" in build["run"]
    assert '--repo "$GITHUB_WORKSPACE/$checkout"' in build["run"]
    # Task source and dependencies never come from the runtime under test,
    # which reaches the sessions only through --gitnexus-root.
    assert '--repo "$GITHUB_WORKSPACE/$runtime" --task-repo "$GITHUB_WORKSPACE/tasks-base"' in prepare["run"]
    assert '--gitnexus-root "$GITHUB_WORKSPACE/$runtime"' in sessions["run"]
    assert "tasks-base" not in sessions["run"]
    assert names.count("Resolve pinned task revision") == 1


def test_both_release_graphs_are_materialized_before_any_paid_sessions():
    steps = workflow("release-evaluation.yml")["jobs"]["evaluate"]["steps"]
    preflight = next(step for step in steps if "workflow_bench.release_preflight" in step.get("run", ""))
    paid = next(step for step in steps if "workflow_bench.runner" in step.get("run", ""))
    assert steps.index(preflight) < steps.index(paid)
    assert "for runtime in stable candidate; do" in preflight["run"]
    assert "set -euo pipefail" in preflight["run"]
    assert '--tasks "$RUNNER_TEMP/release-evaluation/$runtime/tasks.yaml"' in preflight["run"]
    assert '--gitnexus-root "$GITHUB_WORKSPACE/$runtime"' in preflight["run"]
    assert preflight.get("continue-on-error", False) is False
    assert "secrets." not in json.dumps(preflight)
    assert "if" not in paid  # A failed preflight must skip the paid step.


@pytest.mark.parametrize(
    "name,paid", [("gitnexus-skill-evolution.yml", "evolve"), ("release-evaluation.yml", "evaluate")]
)
@pytest.mark.parametrize(
    "startup_attempt,current_attempt,fresh", [("1", "1", True), ("1", "2", False), ("", "2", False), ("2", "2", True)]
)
def test_partial_reruns_fail_on_hosted_runner_before_any_work(name, paid, startup_attempt, current_attempt, fresh):
    jobs = workflow(name)["jobs"]
    assert jobs["start-runner"]["outputs"]["run_attempt"] == "${{ github.run_attempt }}"
    for name in ("runner-ready", paid):
        job = jobs[name]
        # Parse the actual conditional routing expression, including both JSON
        # branches. A job-if skip would make the reusable workflow look green.
        routing = re.fullmatch(
            r"\$\{\{\s*fromJSON\(needs\.start-runner\.outputs\.run_attempt == github\.run_attempt\s*"
            r"&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\)\s*\}\}",
            job["runs-on"],
        )
        assert routing is not None, job["runs-on"]
        labels = json.loads(routing[1 if startup_attempt == current_attempt else 2])
        assert labels == (["self-hosted", "linux", "x64", "gitnexus-evolution"] if fresh else ["ubuntu-latest"])
        assert "run_attempt" not in job["if"]
        guard = job["steps"][0]
        assert not {"if", "uses", "env"}.intersection(guard)
        assert "${{ needs.start-runner.outputs.run_attempt }}" in guard["run"]
        script = guard["run"].replace("${{ needs.start-runner.outputs.run_attempt }}", startup_attempt)
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", script],
            env={**os.environ, "GITHUB_RUN_ATTEMPT": current_attempt},
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.returncode == (0 if fresh else 1), result.stderr
        if not fresh:
            assert "Re-run all jobs" in result.stdout


def test_both_cold_boot_workflows_wait_for_package_lock():
    for name, paid in (("gitnexus-skill-evolution.yml", "evolve"), ("release-evaluation.yml", "evaluate")):
        scripts = "\n".join(step.get("run", "") for step in workflow(name)["jobs"][paid]["steps"])
        apt_commands = [line.strip() for line in scripts.splitlines() if line.strip().startswith("sudo apt-get ")]
        assert len(apt_commands) == 2
        assert "sudo apt-get -o DPkg::Lock::Timeout=600 update" in apt_commands
        assert (
            "sudo apt-get -o DPkg::Lock::Timeout=600 install --yes --no-install-recommends bubblewrap ripgrep socat"
            in apt_commands
        )


def test_shared_lifecycle_jobs_stay_identical_across_both_ec2_workflows():
    # The two workflows duplicate the verified lifecycle instead of sharing a
    # reusable workflow; this pins them together so an edit to one copy fails.
    evaluation = workflow("release-evaluation.yml")["jobs"]
    evolution = workflow("gitnexus-skill-evolution.yml")["jobs"]
    renamed = {"watch-evaluate-pickup": "watch-evolve-pickup", "evaluate": "evolve"}
    for job in ("start-runner", "check-runner", "runner-ready", "stop-runner"):
        expected = {key: value for key, value in evaluation[job].items() if key != "name"}
        if job != "stop-runner":
            preview = "(github.event_name == 'pull_request_target' && inputs.candidate_pr != '') ||\n "
            assert expected["if"].count(preview) == 1
            expected["if"] = expected["if"].replace(preview, "", 1)
        expected["needs"] = [renamed.get(need, need) for need in expected.get("needs", [])]
        actual = {key: value for key, value in evolution[job].items() if key != "name"}
        actual["needs"] = actual.get("needs", [])
        assert actual == expected, job
