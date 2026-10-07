"""Exercise the dedicated EC2 lifecycle without accessing AWS."""

import importlib.util
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / ".github/scripts/evolution-runner.py"
spec = importlib.util.spec_from_file_location("evolution_runner", SCRIPT)
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)

CONFIG = {
    "AWS_REGION": "us-east-1",
    "AWS_ROLE_ARN": "arn:aws:iam::123456789012:role/evolution",
    "EC2_INSTANCE_ID": "i-0123456789abcdef0",
    "STOP_SCHEDULE_UTC": "SUN 03:00",
}


@pytest.fixture
def configured(monkeypatch, tmp_path):
    for key, value in CONFIG.items():
        monkeypatch.setenv(lifecycle.PREFIX + key, value)
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    return output


def driver(monkeypatch, configured, states, *, statuses=None, errors=None):
    calls = []
    clock = [0.0]
    errors = errors or {}
    monkeypatch.setattr(lifecycle.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(lifecycle.time, "sleep", lambda value: clock.__setitem__(0, clock[0] + value))
    monkeypatch.setattr(lifecycle, "stop_deadline", lambda schedule: 2000000000)

    def run(command, **kwargs):
        operation = command[2]
        calls.append(operation)
        assert command[3:7] == ["--instance-ids", CONFIG["EC2_INSTANCE_ID"], "--region", CONFIG["AWS_REGION"]]
        assert 0 < kwargs["timeout"] <= 30
        assert kwargs["capture_output"] and kwargs["text"]
        if operation == "start-instances":
            assert "cleanup_required=true" in configured.read_text()
        problem = errors.get(operation)
        if problem:
            if isinstance(problem, BaseException):
                raise problem
            return SimpleNamespace(returncode=1, stdout="", stderr="private account details")
        if operation == "describe-instances":
            state = states.pop(0) if len(states) > 1 else states[0]
            response = {
                "Reservations": [{"Instances": [{"InstanceId": CONFIG["EC2_INSTANCE_ID"], "State": {"Name": state}}]}]
            }
        elif operation == "describe-instance-status":
            status = statuses.pop(0) if statuses and len(statuses) > 1 else (statuses or ["ok"])[0]
            response = {
                "InstanceStatuses": [
                    {
                        "InstanceId": CONFIG["EC2_INSTANCE_ID"],
                        "SystemStatus": {"Status": status},
                        "InstanceStatus": {"Status": status},
                    }
                ]
            }
        else:
            response = {}
        return SimpleNamespace(returncode=0, stdout=json.dumps(response), stderr="")

    monkeypatch.setattr(lifecycle.subprocess, "run", run)
    return calls, clock


def test_start_waits_for_running_and_both_health_checks(monkeypatch, configured):
    calls, _ = driver(
        monkeypatch, configured, ["stopped", "pending", "running", "running"], statuses=["initializing", "ok"]
    )
    lifecycle.start(CONFIG, timeout=50)
    assert calls.count("start-instances") == 1
    assert calls.count("describe-instance-status") == 2
    assert "cleanup_required=true" in configured.read_text()
    assert "stop_deadline_epoch=2000000000" in configured.read_text()


def test_start_waits_out_an_existing_shutdown_before_restart(monkeypatch, configured):
    calls, _ = driver(monkeypatch, configured, ["stopping", "stopped", "pending", "running"])
    lifecycle.start(CONFIG, timeout=50)
    assert calls.count("start-instances") == 1
    assert calls.index("start-instances") == 2


def test_closed_startup_window_cannot_change_power_state(monkeypatch, configured):
    calls, _ = driver(monkeypatch, configured, ["stopped"])

    def closed_window(schedule):
        raise ValueError("insufficient time")

    monkeypatch.setattr(lifecycle, "stop_deadline", closed_window)
    with pytest.raises(ValueError, match="insufficient time"):
        lifecycle.start(CONFIG)
    assert calls == []
    assert not configured.exists()


@pytest.mark.parametrize("initial", ["running", "pending"])
def test_existing_active_dedicated_instance_is_claimed_for_cleanup(monkeypatch, configured, initial):
    calls, _ = driver(monkeypatch, configured, [initial, "running"])
    lifecycle.start(CONFIG, timeout=30)
    assert "start-instances" not in calls
    assert "cleanup_required=true" in configured.read_text()


def test_start_response_lost_still_attempts_stop_and_waits_for_stopped(monkeypatch, configured):
    problem = subprocess.TimeoutExpired(["aws", CONFIG["EC2_INSTANCE_ID"]], 30, stderr="private details")
    calls, _ = driver(
        monkeypatch,
        configured,
        ["stopped", "pending", "running", "stopping", "stopped"],
        errors={"start-instances": problem},
    )
    with pytest.raises(RuntimeError, match="start-instances") as exc:
        lifecycle.start(CONFIG, timeout=60)
    assert "cleanup_required=true" in configured.read_text()
    assert "stop_deadline_epoch" not in configured.read_text()
    assert "stop-instances" in calls
    assert calls[-1] == "describe-instances"
    assert "private" not in str(exc.value)
    assert CONFIG["EC2_INSTANCE_ID"] not in str(exc.value)


def test_denied_start_still_cleans_up_claimed_instance(monkeypatch, configured):
    calls, _ = driver(monkeypatch, configured, ["stopped", "stopped"], errors={"start-instances": "denied"})
    with pytest.raises(RuntimeError, match="start-instances") as exc:
        lifecycle.start(CONFIG, timeout=30)
    assert calls == ["describe-instances", "start-instances", "describe-instances"]
    assert "private" not in str(exc.value)
    assert "cleanup_required=true" in configured.read_text()


def test_health_failure_attempts_bounded_cleanup(monkeypatch, configured, capsys):
    calls, clock = driver(monkeypatch, configured, ["running"], statuses=["impaired"])
    with pytest.raises(RuntimeError, match="startup/health deadline"):
        lifecycle.start(CONFIG, timeout=20, cleanup_timeout=25)
    assert "stop-instances" in calls
    assert clock[0] == 45
    assert "cleanup also failed" in capsys.readouterr().out
    assert "stop_deadline_epoch" not in configured.read_text()


def test_stop_waits_for_pending_then_confirms_stopped(monkeypatch, configured):
    calls, _ = driver(monkeypatch, configured, ["pending", "running", "stopping", "stopped"])
    lifecycle.stop(CONFIG, timeout=40)
    assert calls == [
        "describe-instances",
        "describe-instances",
        "stop-instances",
        "describe-instances",
        "describe-instances",
    ]


def test_stop_is_idempotent(monkeypatch, configured):
    calls, _ = driver(monkeypatch, configured, ["stopped"])
    lifecycle.stop(CONFIG, timeout=20)
    assert calls == ["describe-instances"]


def test_stop_command_acceptance_does_not_prove_stopped(monkeypatch, configured):
    calls, clock = driver(monkeypatch, configured, ["running", "stopping"])
    with pytest.raises(RuntimeError, match="shutdown deadline"):
        lifecycle.stop(CONFIG, timeout=25)
    assert calls.count("stop-instances") == 1
    assert clock[0] == 25


def test_perpetually_pending_instance_has_bounded_shutdown(monkeypatch, configured):
    calls, clock = driver(monkeypatch, configured, ["pending"])
    with pytest.raises(RuntimeError, match="shutdown deadline"):
        lifecycle.stop(CONFIG, timeout=25)
    assert "stop-instances" not in calls
    assert clock[0] == 25


def test_stop_lost_response_can_still_confirm_stopped(monkeypatch, configured):
    calls, _ = driver(
        monkeypatch,
        configured,
        ["running", "stopping", "stopped"],
        errors={"stop-instances": subprocess.TimeoutExpired("aws", 30)},
    )
    lifecycle.stop(CONFIG, timeout=40)
    assert calls.count("stop-instances") == 1


def test_denied_stop_fails_bounded_without_private_diagnostics(monkeypatch, configured):
    _, clock = driver(monkeypatch, configured, ["running"], errors={"stop-instances": "denied"})
    with pytest.raises(RuntimeError, match="shutdown deadline") as exc:
        lifecycle.stop(CONFIG, timeout=20)
    assert clock[0] == 20
    assert "private" not in str(exc.value)


@pytest.mark.parametrize("operation", ["start", "stop"])
@pytest.mark.parametrize("state", ["terminated", "shutting-down", "unknown"])
def test_unusable_state_fails_loud_without_power_changes(monkeypatch, configured, operation, state):
    calls, _ = driver(monkeypatch, configured, [state])
    with pytest.raises(RuntimeError, match="state"):
        getattr(lifecycle, operation)(CONFIG, timeout=20)
    assert calls == ["describe-instances"]


@pytest.mark.parametrize(
    "response",
    [
        {"Reservations": []},
        {"Reservations": [{"Instances": [{"InstanceId": "i-fffffffffffffffff", "State": {"Name": "running"}}]}]},
        {
            "Reservations": [
                {"Instances": [{"InstanceId": CONFIG["EC2_INSTANCE_ID"]}, {"InstanceId": CONFIG["EC2_INSTANCE_ID"]}]}
            ]
        },
    ],
)
def test_instance_identity_must_match_exactly(monkeypatch, response):
    monkeypatch.setattr(lifecycle, "aws", lambda *args, **kwargs: response)
    with pytest.raises(RuntimeError, match="exactly the configured instance"):
        lifecycle.instance_state(CONFIG)


@pytest.mark.parametrize("field", ["SystemStatus", "InstanceStatus"])
def test_both_health_checks_are_required(monkeypatch, field):
    response = {
        "InstanceStatuses": [
            {
                "InstanceId": CONFIG["EC2_INSTANCE_ID"],
                "SystemStatus": {"Status": "ok"},
                "InstanceStatus": {"Status": "ok"},
            }
        ]
    }
    response["InstanceStatuses"][0][field]["Status"] = "impaired"
    monkeypatch.setattr(lifecycle, "aws", lambda *args, **kwargs: response)
    assert not lifecycle.healthy(CONFIG)


def test_health_response_cannot_substitute_another_instance(monkeypatch):
    response = {
        "InstanceStatuses": [
            {"InstanceId": "i-fffffffffffffffff", "SystemStatus": {"Status": "ok"}, "InstanceStatus": {"Status": "ok"}}
        ]
    }
    monkeypatch.setattr(lifecycle, "aws", lambda *args, **kwargs: response)
    with pytest.raises(RuntimeError, match="configured instance"):
        lifecycle.healthy(CONFIG)


def test_aws_command_timeout_never_exceeds_remaining_poll_budget(monkeypatch):
    monkeypatch.setattr(lifecycle.time, "monotonic", lambda: 10)

    def run(command, **kwargs):
        assert kwargs["timeout"] == 2
        return SimpleNamespace(returncode=0, stdout="{}")

    monkeypatch.setattr(lifecycle.subprocess, "run", run)
    assert lifecycle.aws(CONFIG, "describe-instances", until=12) == {}


@pytest.mark.parametrize(
    "result",
    [
        SimpleNamespace(returncode=1, stdout="", stderr="private details"),
        SimpleNamespace(returncode=0, stdout="private details"),
    ],
)
def test_aws_errors_do_not_echo_response(monkeypatch, result):
    monkeypatch.setattr(lifecycle.subprocess, "run", lambda *args, **kwargs: result)
    with pytest.raises(RuntimeError) as exc:
        lifecycle.aws(CONFIG, "describe-instances")
    assert "private" not in str(exc.value)


def test_missing_aws_cli_returns_safe_error(monkeypatch):
    def missing(*args, **kwargs):
        raise FileNotFoundError("private/path/aws")

    monkeypatch.setattr(lifecycle.subprocess, "run", missing)
    with pytest.raises(RuntimeError, match="command failed") as exc:
        lifecycle.aws(CONFIG, "describe-instances")
    assert "private" not in str(exc.value)


def test_command_is_not_started_after_deadline(monkeypatch):
    monkeypatch.setattr(lifecycle.time, "monotonic", lambda: 10)

    def unexpected(*args, **kwargs):
        pytest.fail("AWS command ran after deadline")

    monkeypatch.setattr(lifecycle.subprocess, "run", unexpected)
    with pytest.raises(RuntimeError, match="deadline expired"):
        lifecycle.aws(CONFIG, "describe-instances", until=10)


def test_configuration_reuses_only_historical_names(configured):
    assert lifecycle.configuration() == CONFIG


@pytest.mark.parametrize("key", CONFIG)
def test_missing_configuration_fails_closed(monkeypatch, configured, key):
    monkeypatch.delenv(lifecycle.PREFIX + key)
    with pytest.raises(ValueError, match=lifecycle.PREFIX + key):
        lifecycle.configuration()


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("AWS_REGION", "us-east-1;echo bad"),
        ("AWS_ROLE_ARN", "arbitrary"),
        ("EC2_INSTANCE_ID", "--all"),
        ("STOP_SCHEDULE_UTC", "SUN 27:00"),
    ],
)
def test_invalid_configuration_is_rejected(monkeypatch, configured, key, value):
    monkeypatch.setenv(lifecycle.PREFIX + key, value)
    with pytest.raises(ValueError):
        lifecycle.configuration()


def test_stop_deadline_caps_manual_dispatch_at_24_hours():
    now = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
    assert lifecycle.stop_deadline("SUN 03:00", now=now) == int((now + timedelta(hours=24)).timestamp())


def test_stop_deadline_obeys_the_actual_weekly_shutdown():
    now = datetime(2026, 10, 10, 23, 0, tzinfo=UTC)
    assert lifecycle.stop_deadline("SUN 03:00", now=now) == int(datetime(2026, 10, 11, 3, 0, tzinfo=UTC).timestamp())


@pytest.mark.parametrize("minute", [0, 30, 59])
def test_dispatch_during_stop_minute_is_rejected(minute):
    with pytest.raises(ValueError, match="due now"):
        lifecycle.stop_deadline("SUN 03:00", now=datetime(2026, 10, 11, 3, 0, minute, tzinfo=UTC))


def test_dispatch_without_startup_and_90_minute_reserve_is_rejected():
    with pytest.raises(ValueError, match="insufficient time"):
        lifecycle.stop_deadline("SUN 03:00", now=datetime(2026, 10, 11, 1, 21, tzinfo=UTC))


def test_cli_invokes_fake_aws_with_scoped_instance_and_confirms_state(tmp_path):
    fake = tmp_path / "aws"
    record = tmp_path / "calls.jsonl"
    fake.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"with open({str(record)!r}, 'a') as log: log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "instance = sys.argv[sys.argv.index('--instance-ids') + 1]\n"
        "print(json.dumps({'Reservations': [{'Instances': [{'InstanceId': instance, 'State': {'Name': 'stopped'}}]}]}))\n"
    )
    fake.chmod(0o755)
    environment = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    environment.update({lifecycle.PREFIX + key: value for key, value in CONFIG.items()})
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "stop"], env=environment, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert "confirmed stopped" in result.stdout
    calls = [json.loads(line) for line in record.read_text().splitlines()]
    assert len(calls) == 1
    assert calls[0][:4] == ["ec2", "describe-instances", "--instance-ids", CONFIG["EC2_INSTANCE_ID"]]
    assert "--force" not in calls[0]
    assert CONFIG["EC2_INSTANCE_ID"] not in result.stdout
    assert CONFIG["AWS_ROLE_ARN"] not in result.stdout
