"""Execute the hosted bootstrap state machine without AWS credentials."""

import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location(
    "evolution_runner_bootstrap", Path(__file__).resolve().parents[2] / ".github/scripts/evolution-runner.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

VALUES = {
    "AWS_REGION": "us-east-1",
    "AWS_ROLE_ARN": "arn:aws:iam::123456789012:role/evolution",
    "EC2_INSTANCE_ID": "i-0123456789abcdef0",
    "STOP_SCHEDULE_UTC": "SUN 03:00",
}


def driver(monkeypatch, tmp_path, states, *, health=True, denied=False, pickup=True, cleanup_denied=False):
    calls = []
    clock = [0.0]
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(bootstrap, "stop_deadline", lambda _s: 1800000000)
    monkeypatch.setattr(bootstrap.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(bootstrap.time, "sleep", lambda n: clock.__setitem__(0, clock[0] + n))

    def wait_for_runner():
        calls.append("runner-pickup")
        if not pickup:
            raise RuntimeError("runner service did not complete its pickup probe before the deadline")

    monkeypatch.setattr(bootstrap, "wait_for_runner", wait_for_runner)

    def run(command, **kwargs):
        assert kwargs["timeout"] == 30
        assert command[command.index("--instance-ids") + 1] == VALUES["EC2_INSTANCE_ID"]
        operation = command[2]
        calls.append(operation)
        if denied or (operation == "stop-instances" and cleanup_denied):
            return SimpleNamespace(returncode=1, stdout="", stderr="private account details")
        if operation == "describe-instances":
            state = states.pop(0) if len(states) > 1 else states[0]
            response = {
                "Reservations": [{"Instances": [{"InstanceId": VALUES["EC2_INSTANCE_ID"], "State": {"Name": state}}]}]
            }
        elif operation == "describe-instance-status":
            response = {
                "InstanceStatuses": [
                    {
                        "InstanceId": VALUES["EC2_INSTANCE_ID"],
                        "SystemStatus": {"Status": "ok" if health else "initializing"},
                        "InstanceStatus": {"Status": "ok"},
                    }
                ]
            }
        else:
            response = {}
        return SimpleNamespace(returncode=0, stdout=json.dumps(response))

    monkeypatch.setattr(bootstrap.subprocess, "run", run)
    return calls, output


def test_stopped_instance_starts_once_and_waits_for_health(monkeypatch, tmp_path):
    calls, output = driver(monkeypatch, tmp_path, ["stopped", "pending", "running"])
    bootstrap.start(VALUES, timeout=30)
    assert calls.count("start-instances") == 1
    assert "stop-instances" not in calls
    assert "started=true" in output.read_text()
    assert "stop_deadline_epoch=1800000000" in output.read_text()
    assert calls[-1] == "runner-pickup"


@pytest.mark.parametrize("states", [["running"], ["pending", "running"], ["stopping", "stopped", "running"]])
def test_bootstrap_does_not_restart_an_existing_instance(monkeypatch, tmp_path, states):
    owned = "stopped" in states
    calls, output = driver(monkeypatch, tmp_path, states)
    bootstrap.start(VALUES, timeout=30)
    assert calls.count("start-instances") == int(owned)
    assert f"started={str(owned).lower()}" in output.read_text()


def test_failed_bootstrap_cleans_up_only_the_instance_it_started(monkeypatch, tmp_path):
    calls, _ = driver(monkeypatch, tmp_path, ["stopped", "running"], health=False)
    with pytest.raises(RuntimeError, match="deadline expired"):
        bootstrap.start(VALUES, timeout=20)
    assert calls.count("stop-instances") == 1
    calls, _ = driver(monkeypatch, tmp_path, ["running"], health=False)
    with pytest.raises(RuntimeError, match="deadline expired"):
        bootstrap.start(VALUES, timeout=20)
    assert "stop-instances" not in calls


@pytest.mark.parametrize("states,owned", [(["stopped", "running"], True), (["running"], False)])
def test_healthy_ec2_with_offline_runner_fails_and_respects_ownership(monkeypatch, tmp_path, states, owned):
    calls, output = driver(monkeypatch, tmp_path, states, pickup=False)
    with pytest.raises(RuntimeError, match="pickup probe before the deadline"):
        bootstrap.start(VALUES, timeout=30)
    assert calls.count("stop-instances") == int(owned)
    assert not output.exists() or "stop_deadline_epoch" not in output.read_text()


def test_cleanup_failure_is_visible_without_private_aws_details(monkeypatch, tmp_path, capsys):
    driver(monkeypatch, tmp_path, ["stopped", "running"], pickup=False, cleanup_denied=True)
    with pytest.raises(RuntimeError, match="pickup probe before the deadline"):
        bootstrap.start(VALUES, timeout=30)
    diagnostic = capsys.readouterr().out
    assert "EC2 cleanup also failed; use the external stop watchdog" in diagnostic
    assert "private account details" not in diagnostic


def pickup_driver(monkeypatch, responses, *, denied=False):
    calls = []
    clock = [0.0]
    monkeypatch.setenv("GITHUB_REPOSITORY", "abhigyanpatwari/GitNexus")
    monkeypatch.setenv("GITHUB_RUN_ID", "1234")
    monkeypatch.setattr(bootstrap.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(bootstrap.time, "sleep", lambda n: clock.__setitem__(0, clock[0] + n))

    def run(command, **kwargs):
        calls.append(command)
        assert command == ["gh", "api", "repos/abhigyanpatwari/GitNexus/actions/runs/1234/jobs?per_page=100"]
        assert kwargs == {"capture_output": True, "text": True, "timeout": 30}
        jobs = responses.pop(0) if len(responses) > 1 else responses[0]
        return SimpleNamespace(returncode=int(denied), stdout=json.dumps({"jobs": jobs}), stderr="private details")

    monkeypatch.setattr(bootstrap.subprocess, "run", run)
    return calls


def probe(status, conclusion=None):
    return {"name": "Verify the runner service is online", "status": status, "conclusion": conclusion}


def test_pickup_waits_for_this_runs_successful_native_probe(monkeypatch):
    calls = pickup_driver(monkeypatch, [[], [probe("queued")], [probe("in_progress")], [probe("completed", "success")]])
    bootstrap.wait_for_runner(timeout=40)
    assert len(calls) == 4


@pytest.mark.parametrize(
    "jobs", [[], [probe("queued")], [probe("in_progress")], [dict(probe("completed", "success"), name="other job")]]
)
def test_pickup_missing_offline_or_unrelated_job_has_bounded_wait(monkeypatch, jobs):
    calls = pickup_driver(monkeypatch, [jobs])
    with pytest.raises(RuntimeError, match="before the deadline"):
        bootstrap.wait_for_runner(timeout=20)
    assert len(calls) == 2


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "skipped", "timed_out"])
def test_pickup_failed_native_probe_blocks_evolution(monkeypatch, conclusion):
    calls = pickup_driver(monkeypatch, [[probe("completed", conclusion)]])
    with pytest.raises(RuntimeError, match="probe failed"):
        bootstrap.wait_for_runner(timeout=20)
    assert len(calls) == 1


def test_pickup_api_denial_hides_private_response(monkeypatch):
    pickup_driver(monkeypatch, [[]], denied=True)
    with pytest.raises(RuntimeError, match="jobs API") as exc:
        bootstrap.wait_for_runner(timeout=20)
    assert "private details" not in str(exc.value)


def test_pickup_refuses_another_repository_or_non_numeric_run(monkeypatch):
    calls = pickup_driver(monkeypatch, [[]])
    monkeypatch.setenv("GITHUB_REPOSITORY", "other/repository")
    with pytest.raises(ValueError, match="current workflow run"):
        bootstrap.wait_for_runner()
    monkeypatch.setenv("GITHUB_REPOSITORY", "abhigyanpatwari/GitNexus")
    monkeypatch.setenv("GITHUB_RUN_ID", "1234/cancel")
    with pytest.raises(ValueError, match="current workflow run"):
        bootstrap.wait_for_runner()
    assert calls == []


@pytest.mark.parametrize("state", ["terminated", "shutting-down", "unknown"])
def test_terminal_or_unexpected_states_fail_without_starting(monkeypatch, tmp_path, state):
    calls, _ = driver(monkeypatch, tmp_path, [state])
    with pytest.raises(RuntimeError, match="cannot start"):
        bootstrap.start(VALUES, timeout=20)
    assert calls == ["describe-instances"]


def test_aws_denial_fails_without_exposing_response_details(monkeypatch, tmp_path):
    calls, _ = driver(monkeypatch, tmp_path, ["stopped"], denied=True)
    with pytest.raises(RuntimeError, match="scoped permissions") as exc:
        bootstrap.start(VALUES, timeout=20)
    assert "private account details" not in str(exc.value)
    assert calls == ["describe-instances"]


def test_configuration_is_required_and_instance_is_explicit(monkeypatch):
    for key, value in VALUES.items():
        monkeypatch.setenv(bootstrap.PREFIX + key, value)
    monkeypatch.delenv(bootstrap.PREFIX + "EC2_INSTANCE_ID")
    with pytest.raises(ValueError, match="EC2_INSTANCE_ID"):
        bootstrap.configuration()
    monkeypatch.setenv(bootstrap.PREFIX + "EC2_INSTANCE_ID", "--all")
    with pytest.raises(ValueError, match="invalid EC2"):
        bootstrap.configuration()


def test_weekly_stop_boundary_and_dispatch_cap():
    now = datetime(2026, 10, 6, 15, tzinfo=UTC)
    assert bootstrap.stop_deadline("SUN 03:00", now=now) == int(now.timestamp()) + 86400
    before = datetime(2026, 10, 10, 23, tzinfo=UTC)
    assert bootstrap.stop_deadline("SUN 03:00", now=before) == int(datetime(2026, 10, 11, 3, tzinfo=UTC).timestamp())
    with pytest.raises(ValueError, match="insufficient time"):
        bootstrap.stop_deadline("SUN 03:00", now=datetime(2026, 10, 11, 2, tzinfo=UTC))
    with pytest.raises(ValueError, match="due now"):
        bootstrap.stop_deadline("SUN 03:00", now=datetime(2026, 10, 11, 3, 0, 30, tzinfo=UTC))
    after = datetime(2026, 10, 11, 3, 1, tzinfo=UTC)
    assert bootstrap.stop_deadline("SUN 03:00", now=after) == int(after.timestamp()) + 86400
