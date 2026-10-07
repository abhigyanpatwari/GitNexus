"""RC quality decisions must be based on comparable, complete measured reports."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
import json
import subprocess
import sys

import pytest

from workflow_bench.release_report import build_report, suite_binding


CANDIDATE = "a" * 40
STABLE = "b" * 40
NOW = datetime.now(UTC)


def reports():
    _, digest, pins = suite_binding()
    meta = dict(
        runtime_sha=CANDIDATE,
        harness_sha="c" * 40,
        task_set_digest=digest,
        model="gpt-6.1-sol",
        effort="medium",
        runs=3,
        tasks=pins,
    )
    rows = [
        dict(
            task=task,
            run=run,
            arm=arm,
            model=meta["model"],
            effort=meta["effort"],
            task_base_sha=pin["sha"],
            oracle_digest=pin["oracle_digest"],
            sandbox_backend="bwrap",
            ok=True,
            resolved=run != 0,
            authored_tests_passed=True,
            oracle_passed=run != 0,
            error_kind="oracle-failed" if run == 0 else None,
            transcript_missing=False,
            cost_usd=1.0,
            duration_s=60.0,
        )
        for task, pin in pins.items()
        for run in range(3)
        for arm in ("baseline_nomcp", "baseline")
    ]
    candidate = build_report(rows, meta, now=NOW)
    stable = build_report(rows, {**meta, "runtime_sha": STABLE}, now=NOW)
    return candidate, stable


def decide(candidate, stable):
    from workflow_bench.release_gate import compare_reports

    _, digest, pins = suite_binding()
    return compare_reports(
        candidate,
        stable,
        candidate_sha=CANDIDATE,
        stable_sha=STABLE,
        task_set_digest=digest,
        task_pins=pins,
        now=NOW,
    )


def rebuild(report):
    return build_report(report["per_run"], report, now=NOW)


def set_outcome(report, task, run, resolved):
    row = next(r for r in report["per_run"] if (r["task"], r["run"], r["arm"]) == (task, run, "baseline"))
    row.update(resolved=resolved, oracle_passed=resolved, error_kind=None if resolved else "oracle-failed")


def test_equal_quality_passes_with_recomputed_per_task_counts():
    candidate, stable = reports()
    result = decide(candidate, stable)
    assert result["passed"] is True
    assert result["candidate_sha"] == CANDIDATE
    assert result["stable_sha"] == STABLE
    assert result["problems"] == []
    assert all(task["solve_delta"] == 0 for task in result["tasks"].values())


def test_improvement_elsewhere_cannot_hide_a_task_regression():
    candidate, stable = reports()
    first, second, *_ = candidate["tasks"]
    set_outcome(candidate, first, 1, False)
    set_outcome(candidate, second, 0, True)
    result = decide(rebuild(candidate), stable)
    assert result["passed"] is False
    assert result["tasks"][first]["solve_delta"] == -1
    assert result["tasks"][second]["solve_delta"] == 1
    assert any(first in problem for problem in result["problems"])


def test_task_improvement_passes_without_claiming_statistical_significance():
    candidate, stable = reports()
    set_outcome(candidate, next(iter(candidate["tasks"])), 0, True)
    result = decide(rebuild(candidate), stable)
    assert result["passed"] is True
    assert sum(task["solve_delta"] for task in result["tasks"].values()) == 1


@pytest.mark.parametrize("side", [0, 1])
@pytest.mark.parametrize(
    "mutate",
    [
        lambda report: report.update(runtime_sha="f" * 40),
        lambda report: report.update(complete=False),
        lambda report: report.update(generated_at=(NOW - timedelta(days=8)).isoformat()),
        lambda report: report.update(generated_at=(NOW + timedelta(minutes=5)).isoformat()),
        lambda report: report["per_run"].pop(),
        lambda report: report["arms"]["baseline"].update(solved=999),
        lambda report: report["per_run"][0].update(transcript_missing=True),
        lambda report: report["per_run"][0].update(cost_usd=None),
    ],
)
def test_invalid_evidence_on_either_side_cannot_pass(side, mutate):
    measured = list(reports())
    mutate(measured[side])
    result = decide(*measured)
    assert result["passed"] is False
    assert result["problems"]


@pytest.mark.parametrize("field,value", [("harness_sha", "f" * 40), ("model", "gpt-5.6-sol"), ("effort", "high")])
def test_comparison_rejects_different_harness_or_model_settings(field, value):
    candidate, stable = reports()
    stable[field] = value
    if field in ("model", "effort"):
        for row in stable["per_run"]:
            row[field] = value
    result = decide(candidate, rebuild(stable))
    assert result["passed"] is False
    assert any(field in problem for problem in result["problems"])


def test_comparison_rejects_different_repetition_counts():
    candidate, stable = reports()
    stable["runs"] = 4
    extra = [deepcopy(row) for row in stable["per_run"] if row["run"] == 2]
    for row in extra:
        row["run"] = 3
    stable["per_run"].extend(extra)
    result = decide(candidate, rebuild(stable))
    assert result["passed"] is False
    assert any("runs" in problem for problem in result["problems"])


def test_both_reports_must_match_the_trusted_oracle_pins():
    candidate, stable = reports()
    for report in (candidate, stable):
        for task in report["tasks"].values():
            task["oracle_digest"] = "f" * 64
        for row in report["per_run"]:
            row["oracle_digest"] = "f" * 64
    result = decide(rebuild(candidate), rebuild(stable))
    assert result["passed"] is False
    assert any("pins" in problem for problem in result["problems"])


@pytest.mark.parametrize("regression", [False, True])
def test_cli_exit_status_and_saved_evidence_reflect_quality(tmp_path, regression):
    candidate, stable = reports()
    if regression:
        set_outcome(candidate, next(iter(candidate["tasks"])), 1, False)
        candidate = rebuild(candidate)
    for name, report in (("candidate", candidate), ("stable", stable)):
        (tmp_path / f"{name}.json").write_text(json.dumps(report))
    out = tmp_path / "public"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "workflow_bench.release_gate",
            "--candidate",
            str(tmp_path / "candidate.json"),
            "--candidate-sha",
            CANDIDATE,
            "--stable",
            str(tmp_path / "stable.json"),
            "--stable-sha",
            STABLE,
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == int(regression), result.stderr
    evidence = json.loads((out / "release-quality-gate.json").read_text())
    assert evidence["passed"] is (not regression)
    prose = (out / "release-quality-gate.md").read_text()
    assert CANDIDATE in prose and STABLE in prose
    assert "no-GitNexus" in prose
    assert "statistical" in prose
