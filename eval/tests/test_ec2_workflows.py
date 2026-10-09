"""Both trusted workflows must own a complete, serialized EC2 lifecycle."""

from pathlib import Path
import json
import os
import re
import subprocess
import sys
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
    assert set(document[True]) == {"schedule", "workflow_dispatch"}
    steps = document["jobs"]["evaluate"]["steps"]
    scripts = "\n".join(step.get("run", "") for step in steps)
    assert "releases/latest" in scripts
    assert "workflow_bench.release_gate" in scripts
    assert "--stable-sha" in scripts and "--candidate-sha" in scripts


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
