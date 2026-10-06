"""Release comparisons must retain negative outcomes and reject incomplete evidence."""

from datetime import UTC, datetime, timedelta
import json

import pytest

from workflow_bench.release_report import build_report, render_markdown, validate_report


SHA = "a" * 40
DIGEST = "b" * 64
NOW = datetime(2026, 10, 6, tzinfo=UTC)


def metadata():
    return {
        "runtime_sha": SHA,
        "harness_sha": "c" * 40,
        "task_set_digest": DIGEST,
        "model": "gpt-6.1-sol",
        "effort": "medium",
        "runs": 3,
        "tasks": {"task-one": {"sha": "d" * 40, "oracle_digest": "e" * 64}},
    }


def rows():
    return [
        {
            "task": "task-one",
            "run": run,
            "arm": arm,
            "model": "gpt-6.1-sol",
            "effort": "medium",
            "task_base_sha": "d" * 40,
            "oracle_digest": "e" * 64,
            "sandbox_backend": "bwrap",
            "ok": True,
            "resolved": arm == "baseline_nomcp" or run != 1,
            "authored_tests_passed": True,
            "oracle_passed": arm == "baseline_nomcp" or run != 1,
            "error_kind": "oracle-failed" if arm == "baseline" and run == 1 else None,
            "transcript_missing": False,
            "cost_usd": 1.0 if arm == "baseline_nomcp" else 1.25,
            "duration_s": 60.0 if arm == "baseline_nomcp" else 75.0,
            "internal_path": "/home/private/instructions.md",
        }
        for run in range(3)
        for arm in ("baseline_nomcp", "baseline")
    ]


def test_report_keeps_failed_solutions_and_compares_against_no_gitnexus():
    report = build_report(rows(), metadata(), now=NOW)
    assert report["complete"] is True
    assert report["arms"]["baseline_nomcp"]["solved"] == 3
    assert report["arms"]["baseline"]["solved"] == 2
    assert report["paired"]["solve_delta"] == -1
    assert report["paired"]["mean_cost_change_pct"] == 25.0
    assert report["paired"]["mean_wall_change_pct"] == 25.0
    assert "internal_path" not in report["per_run"][0]
    assert "baseline_nomcp" in render_markdown(report)
    assert "n=3" in render_markdown(report)
    validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda rs: rs.pop(),
        lambda rs: rs.append(dict(rs[0])),
        lambda rs: rs[0].update(cost_usd=None),
        lambda rs: rs[0].update(cost_usd=float("nan")),
        lambda rs: rs[0].update(duration_s=-1),
        lambda rs: rs[0].update(task_base_sha="f" * 40),
        lambda rs: rs[0].update(oracle_digest="f" * 64),
        lambda rs: rs[0].update(model="different-model"),
        lambda rs: rs[0].update(sandbox_backend="host-unsafe"),
        lambda rs: rs[0].update(error_kind="session-error", ok=False),
        lambda rs: rs[0].update(transcript_missing=True),
        lambda rs: rs[0].update(resolved="true"),
        lambda rs: rs[0].update(oracle_passed=False),
    ],
)
def test_partial_or_untrustworthy_measurements_cannot_pass_release_gate(mutation):
    measured = rows()
    mutation(measured)
    report = build_report(measured, metadata(), now=NOW)
    assert report["complete"] is False
    assert report["problems"]
    json.dumps(report, allow_nan=False)
    with pytest.raises(ValueError, match="incomplete"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


@pytest.mark.parametrize(
    "change",
    [
        {"runtime_sha": "f" * 40},
        {"task_set_digest": "f" * 64},
        {"generated_at": (NOW - timedelta(days=8)).isoformat()},
        {"generated_at": (NOW + timedelta(seconds=1)).isoformat()},
        {"runs": 2},
    ],
)
def test_evidence_is_bound_to_revision_task_set_repetitions_and_age(change):
    report = build_report(rows(), metadata(), now=NOW)
    report.update(change)
    with pytest.raises(ValueError):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


def test_gate_recomputes_measurements_instead_of_trusting_totals():
    report = build_report(rows(), metadata(), now=NOW)
    report["arms"]["baseline"]["solved"] = 3
    with pytest.raises(ValueError, match="summary"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


def test_torn_result_file_publishes_incomplete_evidence(tmp_path, monkeypatch):
    from workflow_bench.release_report import main

    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps(rows()[0]) + '\n{"unfinished":')
    meta = tmp_path / "metadata.json"
    meta.write_text(json.dumps(metadata()))
    out = tmp_path / "public"
    monkeypatch.setattr(
        "sys.argv",
        ["release-report", "summarize", "--results", str(results), "--metadata", str(meta), "--out", str(out)],
    )
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 1
    report = json.loads((out / "agent-evaluation.json").read_text())
    assert report["complete"] is False
    assert "invalid measurement" in report["problems"][0]
    assert "Incomplete evidence" in (out / "agent-evaluation.md").read_text()
