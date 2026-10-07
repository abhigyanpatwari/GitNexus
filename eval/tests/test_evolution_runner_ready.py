"""Verify bounded native runner pickup without AWS credentials or configuration."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location(
    "evolution_runner_ready", Path(__file__).resolve().parents[2] / ".github/scripts/evolution-runner-ready.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


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


def evolution(status, conclusion=None):
    return {"name": "Propose, benchmark, and gate skill candidates", "status": status, "conclusion": conclusion}


def test_evolution_watchdog_waits_for_actual_job_after_successful_probe(monkeypatch):
    calls = pickup_driver(monkeypatch, [
        [probe("completed", "success")],
        [probe("completed", "success"), evolution("queued")],
        [probe("completed", "success"), evolution("in_progress")],
    ])
    bootstrap.wait_for_runner(timeout=40, evolve=True)
    assert len(calls) == 3


def test_evolution_watchdog_bounds_offline_runner_after_successful_probe(monkeypatch):
    calls = pickup_driver(monkeypatch, [[probe("completed", "success"), evolution("queued")]])
    with pytest.raises(RuntimeError, match="before the deadline"):
        bootstrap.wait_for_runner(timeout=20, evolve=True)
    assert len(calls) == 2


@pytest.mark.parametrize("conclusion", ["success", "failure", "timed_out"])
def test_evolution_watchdog_accepts_already_finished_job_pickup(monkeypatch, conclusion):
    calls = pickup_driver(monkeypatch, [[evolution("completed", conclusion)]])
    bootstrap.wait_for_runner(timeout=20, evolve=True)
    assert len(calls) == 1


@pytest.mark.parametrize("conclusion", ["skipped", "cancelled"])
def test_evolution_watchdog_rejects_job_that_never_ran(monkeypatch, conclusion):
    pickup_driver(monkeypatch, [[evolution("completed", conclusion)]])
    with pytest.raises(RuntimeError, match="did not run"):
        bootstrap.wait_for_runner(timeout=20, evolve=True)
