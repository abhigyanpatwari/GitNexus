"""A partial cheap arm is not evidence of savings."""

import copy
import json
import sys

import pytest

from tests.test_release_report import metadata, rows
from workflow_bench import mcp_loading_report
from workflow_bench.mcp_loading_report import COUNTERS, compare_loading, render_markdown


def measurements():
    eager = rows()
    for row in eager:
        row.update({field: 10 for field in COUNTERS})
        row.update(
            mcp_tool_loading="none" if row["arm"] == "baseline_nomcp" else "eager",
            task_prompt_digest="1" * 64,
            sanitized_graph_snapshot_digest="2" * 64 if row["arm"] == "baseline" else None,
            sanitized_task_sha="3" * 40,
            runtime_sha=metadata()["runtime_sha"],
            harness_sha=metadata()["harness_sha"],
        )
    deferred = [dict(row, mcp_tool_loading="deferred", cost_usd=0.9) for row in eager if row["arm"] == "baseline"]
    return eager, deferred


def test_complete_comparison_keeps_failed_solutions_and_costs():
    report = compare_loading(*measurements(), metadata())
    assert report["complete"] is True
    assert report["arms"]["deferred"]["solved"] == 2
    assert report["arms"]["deferred"]["cells"] == 3
    assert report["paired"]["deferred_vs_eager"]["mean_cost_change_pct"] == pytest.approx(-28)
    assert report["paired"]["deferred_vs_none"]["solve_delta"] == -1
    assert len(report["per_run"]) == 9
    assert all("internal_path" not in row for row in report["per_run"])
    assert "2/3" in render_markdown(report)


def test_fresh_graph_bytes_can_differ_when_source_and_runtime_match():
    eager, deferred = measurements()
    for row in deferred:
        row["sanitized_graph_snapshot_digest"] = "f" * 64
    report = compare_loading(eager, deferred, metadata())
    assert report["complete"] is True
    assert report["per_run"][-1]["sanitized_graph_snapshot_digest"] == "f" * 64


@pytest.mark.parametrize("mutation", [
    lambda e, d: d.pop(),
    lambda e, d: d.append(copy.deepcopy(d[0])),
    lambda e, d: d.append(None),
    lambda e, d: d.append({"arm": []}),
    lambda e, d: d[0].update(mcp_tool_loading="eager"),
    lambda e, d: e[0].pop("mcp_tool_loading"),
    lambda e, d: d[0].update(model="different-model"),
    lambda e, d: d[0].update(effort="low"),
    lambda e, d: d[0].update(task_base_sha="f" * 40),
    lambda e, d: d[0].update(oracle_digest="f" * 64),
    lambda e, d: d[0].update(sandbox_dependency_content_digest="f" * 64),
    lambda e, d: d[0].update(sanitized_graph_snapshot_digest=None),
    lambda e, d: d[0].update(sanitized_task_sha="f" * 40),
    lambda e, d: d[0].update(runtime_sha="f" * 40),
    lambda e, d: d[0].update(harness_sha="f" * 40),
    lambda e, d: d[0].update(task_prompt_digest="f" * 64),
    lambda e, d: d[0].update(ok=False, error_kind="session-error"),
    lambda e, d: d[0].update(transcript_missing=True),
    lambda e, d: d[0].update(cost_usd=float("nan")),
    lambda e, d: d[0].update(cache_read_input_tokens=-1),
    lambda e, d: d[0].update(num_turns=True),
    lambda e, d: d[0].update(arm="baseline_nomcp"),
])
def test_incomplete_or_confounded_comparison_never_reports_savings(mutation):
    eager, deferred = measurements()
    mutation(eager, deferred)
    report = compare_loading(eager, deferred, metadata())
    assert report["complete"] is False and report["problems"]
    assert report["arms"] == report["paired"] == {}
    assert "no savings estimate" in render_markdown(report)
    json.dumps(report, allow_nan=False)


def test_report_command_writes_failure_receipt_for_missing_deferred_file(tmp_path, monkeypatch):
    eager, _ = measurements()
    (tmp_path / "eager.jsonl").write_text("\n".join(json.dumps(row) for row in eager))
    (tmp_path / "metadata.json").write_text(json.dumps(metadata()))
    monkeypatch.setattr(sys, "argv", [
        "report", "--eager", str(tmp_path / "eager.jsonl"), "--deferred", str(tmp_path / "missing.jsonl"),
        "--metadata", str(tmp_path / "metadata.json"), "--out", str(tmp_path / "out"),
    ])
    with pytest.raises(SystemExit, match="1"):
        mcp_loading_report.main()
    report = json.loads((tmp_path / "out/mcp-tool-loading.json").read_text())
    assert report["complete"] is False
    assert report["arms"] == {}
