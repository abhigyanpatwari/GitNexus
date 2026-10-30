"""Offline measurements must not invent attribution, completeness or savings."""

import copy
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest
import yaml

from tests.test_session_diagnostics import result, use
from workflow_bench.cost_diagnostics import build_cost_report, provider_summary
from workflow_bench.diagnostic_experiments import VARIANTS, prepare_plan
from workflow_bench.session_diagnostics import diagnose_session, public_diagnostics
from workflow_bench.workload_diagnostics import classify_bash


def trace(actions):
    events = []
    for index, (tool, args, body) in enumerate(actions):
        events += [use(tool, tool_id=str(index), args=args), result(body, tool_id=str(index))]
    return events


def test_graph_reference_is_not_confused_with_supplied_source_and_paths_stay_private():
    events = trace([
        ("mcp__gitnexus__query", {}, {"definitions": [{"filePath": "src/private.ts"}]}),
        ("mcp__gitnexus__context", {}, {"symbol": {"filePath": "src/private.ts", "content": "secret source"}}),
        ("Read", {"file_path": "/workspace/src/private.ts", "offset": 10, "limit": 5}, "source"),
        ("Read", {"file_path": "/workspace/src/private.ts", "offset": 10, "limit": 5}, "source"),
        ("Read", {"file_path": "/workspace/other/private.ts"}, "unrelated"),
    ])
    report = diagnose_session(events, None, 10)
    work = report["workload"]
    assert work["source_reads"] == 3
    assert work["repeated_source_reads"] == 1
    assert work["reads_after_graph_reference"] == work["reads_after_graph_content_reference"] == 2
    assert work["query_context_read_chains"] == 2
    assert "private.ts" not in json.dumps(public_diagnostics([report]))
    assert "secret source" not in json.dumps(report)


def test_read_before_graph_result_is_not_credited_as_a_followup():
    events = [use(), use("Read", tool_id="read", args={"file_path": "src/a.ts"}),
              result({"filePath": "src/a.ts"}), result("source", tool_id="read")]
    work = diagnose_session(events, None, 10)["workload"]
    assert work["reads_after_graph_reference"] == 0


def test_server_reported_time_is_separate_from_host_wait_and_missing_stays_unknown():
    events = trace([("mcp__gitnexus__query", {}, {"timing": {"wall": 125}, "epistemic": "lower-bound"}),
                    ("mcp__gitnexus__impact", {}, {"risk": "LOW"})])
    report = diagnose_session(events, [0, 2, 3, 5], 6)
    safe = public_diagnostics([report])[0]
    assert safe["tools"]["mcp__gitnexus__query"]["server_wall_s"] == 0.125
    assert safe["tools"]["mcp__gitnexus__query"]["elapsed_s"] == 2
    assert safe["tools"]["mcp__gitnexus__query"]["lower_bound"] == 1
    assert safe["tools"]["mcp__gitnexus__impact"]["server_wall_s"] is None


@pytest.mark.parametrize("command", ["cd gitnexus && npm test", "uv run --locked --extra dev python -m pytest"])
def test_verification_repetition_respects_edits_and_unknown_shell_mutations(command):
    check = ("Bash", {"command": command}, "ok")
    events = trace([check, check, ("Edit", {"file_path": "secret"}, "ok"), check,
                    ("Bash", {"command": "python custom_script.py"}, "ok"), check])
    work = diagnose_session(events, None, 10)["workload"]
    assert work["verification_calls"] == 4
    assert work["verification_repeated_without_observed_change"] == 1
    assert work["verification_repeated_after_possible_change"] == 2
    assert work["edits_after_verification"] == 1


@pytest.mark.parametrize(("command", "category"), [
    ("uv run python -m pytest -q", "test"), ("npm run test:unit", "test"),
    ("uv run --locked --extra dev python -m pytest -q", "test"),
    ("uv run --frozen --no-sync --offline --extra=dev pytest", "test"),
    ("uv run --project ./eval --group dev --python 3.12 -- pytest", "test"),
    ("uv run --locked --extra dev ruff check .", "lint"),
    ("uv run --locked --extra dev ruff format .", "mutation"),
    ("uv run --unknown pytest", "other"), ("uv run --extra", "other"),
    ("uv run --extra= pytest", "other"), ("uv run --extra --locked pytest", "other"),
    ("uv run --locked=true pytest", "other"), ("uv run --locked", "other"),
    ("uv run -- --locked pytest", "other"),
    ("npx tsc --noEmit", "typecheck"), ("npx eslint .", "lint"),
    ("npx eslint . --fix", "mutation"), ("npm run build", "build"),
    ("cat source.ts", "source"), ("rg 'x' src", "source"),
    ("echo pytest", "other"), ("npm test && npm run build", "mixed"),
    ("cd gitnexus && npm test && touch x", "mixed"),
    ("cat x > y", "mixed"), ("sed -i 's/x/y/' a", "mutation"),
    ("sed --in-place 's/x/y/' a", "mutation"), ("npx prettier -w .", "mutation"),
    ("uv run ruff format .", "mutation"), ("uv run ruff format --check .", "lint"),
    ("echo $(npm test)", "mixed"), ("unterminated '", "other"),
])
def test_shell_classification_is_conservative(command, category):
    assert classify_bash(command) == category


def test_usage_missing_fields_are_unknown_and_cache_counts_are_not_double_counted():
    first = {"type": "assistant", "message": {"id": "a", "usage": {
        "input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "output_tokens": 4,
    }}}
    second = {"type": "assistant", "message": {"id": "b", "usage": {"input_tokens": 30}}}
    report = diagnose_session([first, second, {"type": "system", "subtype": "compact_boundary"}], None, 5)
    work = report["workload"]
    assert work["usage_snapshots"] == 2 and work["complete_input_snapshots"] == 1
    assert work["max_input_tokens"] == work["first_input_tokens"] == 130
    assert work["sum_input_tokens"] is work["last_input_tokens"] is None
    assert work["sum_cache_read_tokens"] is work["sum_output_tokens"] is None
    assert work["compactions"] == 1
    work["prompt"] = "secret"
    assert "secret" not in json.dumps(public_diagnostics([report]))


def provider_event():
    return {"status": "success", "response_id": "one", "sweep_id": "sweep", "provider": "litellm-normalized",
            "native_usage": {"prompt_tokens": 100, "completion_tokens": 20,
                             "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 10}},
            "request_metrics": {"tools_bytes": 300, "duration_s": 2}}


def test_provider_deduplicates_identical_hooks_and_refuses_conflicting_totals():
    event = provider_event()
    report = provider_summary([event, copy.deepcopy(event)])
    assert report["observed_requests"] == 1 and report["duplicate_callbacks"] == 1
    assert report["token_totals"]["total_input_tokens"] == 100
    assert report["token_totals"]["ordinary_input_tokens"] == 30
    assert report["token_totals"]["reasoning_output_tokens"] is None
    assert report["attribution"] == "ledger_only_no_cell_join"
    conflicting = copy.deepcopy(event)
    conflicting["native_usage"]["prompt_tokens"] = 120
    report = provider_summary([event, conflicting])
    assert report["conflicting_response_ids"] == 1
    assert all(value is None for value in report["token_totals"].values())


def test_missing_identity_failed_usage_and_unknown_providers_remain_visible():
    event = provider_event()
    del event["response_id"]
    report = provider_summary([event, event, {"status": "failure", "provider": "unknown"}])
    assert report["requests_without_response_id"] == 3 and not report["identity_complete"]
    assert report["failures"] == report["invalid_usage_records"] == 1
    assert report["token_totals"]["total_input_tokens"] is None
    assert report["request_metrics"]["tools_bytes"]["missing"] == 1


def test_cost_report_keeps_failures_in_spend_and_missing_telemetry_is_not_zero():
    rows = [{"arm": "baseline", "task": "test", "resolved": True, "ok": True, "cost_usd": 2},
            {"arm": "baseline", "task": "test", "resolved": False, "ok": False, "cost_usd": 3}]
    report = build_cost_report(rows)
    group = report["groups"][0]
    assert group["cost_per_solved"] == 5
    assert group["failed_cells"] == 1 and group["diagnostic_cells"] == 0
    assert group["metrics"]["duration_s"]["mean"] is None
    rows[1]["cost_usd"] = float("nan")
    assert build_cost_report(rows)["groups"][0]["cost_per_solved"] is None


def test_different_model_or_prompt_cohorts_and_duplicate_exports_cannot_blend():
    row = {"arm": "baseline", "task": "test", "run": 0, "model": "model-a", "cost_usd": 2}
    other = row | {"model": "model-b", "cost_usd": 20}
    assert len(build_cost_report([row, other])["groups"]) == 2
    with pytest.raises(ValueError, match="duplicate cell"):
        build_cost_report([row, row])


def test_tool_summaries_preserve_cohort_boundaries_and_budget_treatment():
    diagnostic = diagnose_session(trace([("Read", {"file_path": "source.ts"}, "source")]), None, 5)
    row = {"arm": "baseline", "task": "test", "run": 0, "max_budget_usd": None,
           "session_diagnostics": [diagnostic]}
    report = build_cost_report([row, row | {"max_budget_usd": 5}])
    assert len(report["groups"]) == 2
    assert report["tool_markdown"].count("Diagnostics available for 1/1 cells") == 2
    assert "Diagnostics available for 2/2 cells" not in report["tool_markdown"]


def test_proxy_envelope_metrics_preserve_accounting_without_recording_content(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from workflow_bench.litellm_usage_callback import USAGE_LOG_ENV_VAR, ProviderUsageLogger

    log = tmp_path / "provider.jsonl"
    monkeypatch.setenv(USAGE_LOG_ENV_VAR, str(log))
    kwargs = {"messages": [{"role": "user", "content": "SECRET PROMPT"}],
              "optional_params": {"tools": [{"name": "PRIVATE TOOL"}]}, "response_cost": 0.25}
    ProviderUsageLogger()._append("success", kwargs, SimpleNamespace(usage={"prompt_tokens": 20}), 10, 12)
    payload = log.read_text()
    row = json.loads(payload)
    assert "SECRET" not in payload and "PRIVATE" not in payload
    assert row["request_metrics"]["tools_count"] == 1
    assert row["request_metrics"]["messages_count"] == 1
    assert row["request_metrics"]["duration_s"] == 2
    assert row["request_metrics"]["proxy_estimated_cost_usd"] == 0.25
    ProviderUsageLogger()._append("failure", {"optional_params": [], "response_cost": float("nan")},
                                  SimpleNamespace(usage={"prompt_tokens": 20}), None, None)
    row = json.loads(log.read_text().splitlines()[-1])
    assert row["native_usage"]["prompt_tokens"] == 20
    assert row["request_metrics"]["tools_bytes"] is row["request_metrics"]["duration_s"] is None


@pytest.mark.parametrize("fail", [False, True])
def test_cell_phases_include_cleanup_and_partial_failure_without_changing_credit(monkeypatch, tmp_path, fail):
    from tests.test_runner_hardening import _cell_context, _stub_cell_dependencies
    from workflow_bench import runner
    from workflow_bench.session_diagnostics import CELL_PHASES

    _stub_cell_dependencies(monkeypatch, tmp_path)
    if fail:
        def explode(*args, **kwargs):
            raise RuntimeError("synthetic failure")
        monkeypatch.setattr(runner, "run_arm", explode)
    row = runner.run_cell(_cell_context(tmp_path), 2, "workflow")
    phases = row["cell_phase_seconds"]
    assert set(phases) <= set(CELL_PHASES)
    assert "cleanup" in phases and "agent_and_verification" in phases
    assert ("artifacts" not in phases) == fail
    assert sum(phases.values()) == pytest.approx(row["cell_duration_s"])
    assert row["cell_finished_at"] >= row["cell_started_at"]
    assert row["resolved"] is (not fail)


def test_release_and_cli_artifacts_publish_safe_diagnostics_and_keep_phase_validation(tmp_path):
    from tests.test_cli_shim import _report_row, _write_results
    from tests.test_release_report import DIGEST, NOW, SHA, metadata, rows
    from workflow_bench import cli_arm_report, release_report

    diagnostic = diagnose_session(trace([("Bash", {"command": "gitnexus query secret"}, "ok")]), None, 10)
    extra = {"session_diagnostics": [diagnostic], "cell_duration_s": 12,
             "cell_phase_seconds": {"clone": 1.0, "secret content": 99, "mcp_startup": float("nan")}}
    measurements = rows()
    measurements[1].update(extra)
    report = release_report.build_report(measurements, metadata(), now=NOW)
    release_report.validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)
    assert report["per_run"][1]["cell_phase_seconds"] == {"clone": 1.0, "mcp_startup": None}
    assert "secret" not in json.dumps(report)
    paired, cli = _write_results(tmp_path, [_report_row("baseline", 0, 1), _report_row("baseline_nomcp", 0, 1)],
                                  [_report_row("baseline_cli", 0, 1, **extra)])
    report = cli_arm_report.build_report(paired, cli)
    assert "secret" not in json.dumps(report)
    assert "Tool diagnostics: baseline_cli" in cli_arm_report.render_markdown(report)


def plan_args():
    return dict(repository="/repo", runtime="/runtime", runtime_sha="a" * 40, harness_sha="b" * 40,
                model="gpt-5.6-sol", effort="xhigh", repeats=5, seed=3762, variants=list(VARIANTS))


def task_document():
    return {"tasks": [
        {"id": name, "ref": "c" * 40, "prompt": "Fix this", "class": task_class, "verify": "true",
         "oracle": {"command": "true", "files": [{"source": "fixture.txt", "target": "fixture.txt"}]}}
        for name, task_class in (("one", "trivial"), ("two", "cross-module"))
    ]}


def test_plan_is_deterministic_balanced_isolated_and_never_runs_a_model():
    original = task_document()
    plan = prepare_plan(original, **plan_args())
    assert plan == prepare_plan(original, **plan_args())
    assert len(plan["cells"]) == 50 and plan["position_balanced"]
    assert plan["execution"] == "not_started" and plan["release_gate_eligible"] is False
    assert original == task_document()
    for task in ("one", "two"):
        for variant in VARIANTS:
            positions = Counter(c["position"] for c in plan["cells"] if c["task"] == task and c["variant"] == variant)
            assert set(positions.values()) == {1} and len(positions) == 5
    ledgers = {c["env"]["GITNEXUS_BENCH_PROVIDER_USAGE"] for c in plan["cells"]}
    assert len(ledgers) == 50
    for cell in plan["cells"]:
        assert (cell["prompt_sha256"] != cell["base_prompt_sha256"]) == (cell["variant"] == "mcp_optional_prompt")
        assert "--unsafe-no-bwrap" not in cell["argv"]


@pytest.mark.parametrize("override", [{"runtime_sha": "main"}, {"model": "latest"}, {"repeats": 0},
                                     {"variants": ["cli", "cli"]}, {"task_ids": ["missing"]}])
def test_plan_rejects_unpinned_or_ambiguous_inputs(override):
    with pytest.raises(ValueError):
        prepare_plan(task_document(), **(plan_args() | override))


@pytest.mark.parametrize("model", [None, 1, "", "  ", " auto ", "claude-sonnet-LATEST",
                                  "provider/latest", "provider:auto", "provider@AUTO"])
def test_plan_uses_runner_model_validation(model):
    with pytest.raises(ValueError):
        prepare_plan(task_document(), **(plan_args() | {"model": model}))


def test_plan_normalizes_model_in_metadata_and_commands():
    plan = prepare_plan(task_document(), **(plan_args() | {"model": "  gpt-5.6-sol  "}))
    assert plan["model"] == "gpt-5.6-sol"
    for cell in plan["cells"]:
        assert cell["argv"][cell["argv"].index("--model") + 1] == "gpt-5.6-sol"


@pytest.mark.parametrize("task_id", ["_task", "-task", "a" * 129])
def test_plan_rejects_task_ids_the_runner_cannot_use(task_id):
    document = task_document()
    document["tasks"][0]["id"] = task_id
    with pytest.raises(ValueError, match="artifact-safe slug"):
        prepare_plan(document, **plan_args())


def test_every_prepared_task_satisfies_the_runner_metadata_contract():
    from workflow_bench.runner_tasks import select_tasks

    document = task_document()
    document["tasks"][0]["id"] = "a.task-1"
    plan = prepare_plan(document, **plan_args())
    for cell in plan["cells"]:
        selected, skipped = select_tasks(cell["task_document"]["tasks"], include_expensive=True)
        assert selected == cell["task_document"]["tasks"] and skipped == []
    document["tasks"][0]["verify"] = ""
    with pytest.raises(ValueError, match="verify"):
        prepare_plan(document, **plan_args())


@pytest.mark.parametrize("intervening_read", [False, True])
def test_post_graph_input_totals_require_every_relevant_snapshot(intervening_read):
    complete = {"type": "assistant", "message": {"id": "complete", "usage": {
        "input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20,
    }}}
    incomplete = {"type": "assistant", "message": {"id": "incomplete", "usage": {"input_tokens": 30}}}
    events = [use(), result({}), complete]
    if intervening_read:
        events += [use("Read", tool_id="read", args={"file_path": "src/a.ts"}), result("source", tool_id="read")]
    events.append(incomplete)
    work = diagnose_session(events, None, 5)["workload"]
    assert work["sum_input_tokens"] is None
    assert work["usage_after_graph_snapshots"] == (1 if intervening_read else 2)
    assert work["input_tokens_after_graph"] == (130 if intervening_read else None)
    # Preserve the actual first/last positions, even when a snapshot is incomplete.
    reversed_usage = diagnose_session([incomplete, complete], None, 5)["workload"]
    assert reversed_usage["first_input_tokens"] is None and reversed_usage["last_input_tokens"] == 130
    complete_usage = diagnose_session([complete], None, 5)["workload"]
    assert complete_usage["sum_input_tokens"] == 130


def test_trial_plan_passes_each_cell_budget_without_starting_a_model():
    args = plan_args() | {"repeats": 1, "variants": ["no_graph", "mcp_eager"], "task_ids": ["one"], "max_budget_usd": 5.0}
    plan = prepare_plan(task_document(), **args)
    assert len(plan["cells"]) == 2
    assert plan["planned_cli_budget_usd"] == 10.0
    assert plan["execution"] == "not_started"
    for cell in plan["cells"]:
        assert cell["argv"][cell["argv"].index("--max-budget-usd") + 1] == "5.0"


@pytest.mark.parametrize("budget", [0, -1, float("nan"), float("inf"), True, 10 ** 1000])
def test_invalid_budget_fails_before_any_process_starts(monkeypatch, tmp_path, budget):
    from workflow_bench import runner_sessions

    def must_not_start(*args, **kwargs):
        pytest.fail("invalid budget launched a process")

    monkeypatch.setattr(runner_sessions, "run_managed", must_not_start)
    with pytest.raises(ValueError, match="max-budget-usd"):
        runner_sessions.run_claude("task", tmp_path, claude_bin="claude", timeout=1, max_budget_usd=budget)


def test_cli_budget_stop_remains_a_failed_billed_session(monkeypatch, tmp_path):
    from tests.test_workflow_bench_sessions import fake_cli_result, report_variant
    from workflow_bench import runner_sessions

    captured = []

    def run(command, **kwargs):
        captured.extend(command)
        return fake_cli_result(report_variant(subtype="error_max_budget_usd", total_cost_usd=5.1))

    monkeypatch.setattr(runner_sessions, "run_managed", run)
    record = runner_sessions.run_claude("task", tmp_path, claude_bin="claude", timeout=1, max_budget_usd=5)
    assert captured[captured.index("--max-budget-usd") + 1] == "5.0"
    assert record["ok"] is False and record["cost_usd"] == 5.1
    assert record["max_budget_usd"] == 5


def test_budget_rejects_multisession_arms_before_reading_task_inputs(monkeypatch, capsys):
    from workflow_bench import runner

    monkeypatch.setattr("sys.argv", ["runner", "--tasks", "nonexistent.yaml", "--model", "gpt-5.6-sol",
                                    "--arms", "workflow", "--max-budget-usd", "5"])
    with pytest.raises(SystemExit) as failure:
        runner.main()
    assert failure.value.code == 2
    assert "--max-budget-usd is limited to single-session baseline arms" in capsys.readouterr().err


def test_summary_cli_gathers_safe_measurements_and_provider_coverage(tmp_path, monkeypatch):
    from workflow_bench import cost_diagnostics

    diagnostic = diagnose_session(trace([
        ("mcp__gitnexus__query", {"query": "SECRET QUERY"}, {"staleness": {"status": "behind"}}),
        ("Bash", {"command": "uv run --locked --extra dev pytest"}, "SECRET RESULT"),
    ]), [0, 2, 3, 5], 8)
    rows = [{"task": "one", "arm": "baseline", "run": 0, "cost_usd": 2, "duration_s": 8,
             "ok": False, "resolved": False, "session_diagnostics": [diagnostic], "private": "SECRET PATH",
             "cell_phase_seconds": {"clone": 1, "agent_and_verification": 9, "PRIVATE PHASE": 123}}]
    results, ledger = tmp_path / "results.jsonl", tmp_path / "provider.jsonl"
    results.write_text(json.dumps(rows[0]) + "\n")
    event = provider_event() | {"messages": "SECRET PROMPT", "response_id": "SECRET ID"}
    ledger.write_text(json.dumps(event) + "\n")
    out, markdown = tmp_path / "diagnostics.json", tmp_path / "diagnostics.md"
    monkeypatch.setattr("sys.argv", ["cost_diagnostics", "--results", str(results), "--provider-usage", str(ledger),
                                    "--out", str(out), "--markdown-out", str(markdown)])
    cost_diagnostics.main()
    body = markdown.read_text()
    assert "SECRET" not in out.read_text() + body and "PRIVATE PHASE" not in body
    assert "Solved: 0/1; failed sessions: 1" in body
    assert "| clone | 1 / 0 | 1 |" in body
    assert "| verification_calls | 1 | 1/1 |" in body
    assert "| tools_bytes | 1 / 0 | 300 |" in body
    assert "| total_input_tokens | 100 |" in body
    assert "Largest, slowest, and problematic tool calls" in body
    assert "requests without identity: 0" in body
    assert json.loads(out.read_text())["provider"]["ledger_complete"] is True


def test_summary_cli_reports_missing_legacy_telemetry_and_torn_provider_rows(tmp_path, monkeypatch):
    from workflow_bench import cost_diagnostics

    results, ledger = tmp_path / "results.jsonl", tmp_path / "provider.jsonl"
    results.write_text(json.dumps({"task": "old", "arm": "baseline", "cost_usd": 1}) + "\n{torn")
    ledger.write_text(json.dumps(provider_event()) + "\n{torn")
    out, markdown = tmp_path / "diagnostics.json", tmp_path / "diagnostics.md"
    monkeypatch.setattr("sys.argv", ["cost_diagnostics", "--results", str(results), "--provider-usage", str(ledger),
                                    "--allow-incomplete", "--out", str(out), "--markdown-out", str(markdown)])
    cost_diagnostics.main()
    report = json.loads(out.read_text())
    assert len(report["input_problems"]) == 2
    assert report["provider"]["observed_requests"] == 1
    assert report["provider"]["ledger_complete"] is False
    assert all(value is None for value in report["provider"]["token_totals"].values())
    body = markdown.read_text()
    assert "Partial input" in body and "diagnostics: 0/1" in body
    assert "| clone | 0 / 1 | n/a |" in body
    assert "| total_input_tokens | n/a |" in body


def test_summary_cli_reports_unavailable_inputs_after_early_failure(tmp_path, monkeypatch):
    from workflow_bench import cost_diagnostics

    out, markdown = tmp_path / "diagnostics.json", tmp_path / "diagnostics.md"
    monkeypatch.setattr("sys.argv", ["cost_diagnostics", "--results", str(tmp_path / "missing"),
                                    "--provider-usage", str(tmp_path / "missing-ledger"), "--allow-incomplete",
                                    "--out", str(out), "--markdown-out", str(markdown)])
    cost_diagnostics.main()
    assert "Observed cells: 0" in markdown.read_text()
    assert "Provider ledger unavailable" in markdown.read_text()
    assert json.loads(out.read_text())["provider"] is None


def test_summary_escapes_markdown_and_html_labels():
    from workflow_bench.cost_diagnostics import render_markdown

    report = build_cost_report([{"arm": "baseline", "task": "</code><img src=x>|bad![x](https://example.test)"}])
    markdown = render_markdown(report)
    assert "<img" not in markdown and "&#124;" in markdown
    assert "![x]" not in markdown


def test_summary_does_not_turn_missing_tool_counters_into_zero():
    from workflow_bench.session_diagnostics import SCHEMA, render_diagnostics

    body = "\n".join(render_diagnostics([{"arm": "baseline", "session_diagnostics": [
        {"schema": SCHEMA, "tools": {"Read": {"calls": 1}}},
    ]}]))
    assert "| Read | 1 | n/a |" in body
    assert "Other session wall time (seconds): n/a." in body


def test_summary_treats_unrepresentable_numbers_as_unknown():
    report = build_cost_report([{"arm": "baseline", "task": "one", "cost_usd": 10 ** 1000}])
    assert report["groups"][0]["metrics"]["cost_usd"]["observed"] == 0
    assert report["groups"][0]["metrics"]["cost_usd"]["missing"] == 1


@pytest.mark.skipif(os.name == "nt", reason="release summary executes in bash on the Linux runner")
@pytest.mark.parametrize(("pr", "expected"), [("", {"stable", "candidate", "cli", "deferred"}),
                                            ("3773", {"candidate", "cli"})])
def test_actual_workflow_summary_step_publishes_each_enabled_sweep(tmp_path, pr, expected):
    repository = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((repository / ".github/workflows/release-evaluation.yml").read_text())
    step = next(step for job in workflow["jobs"].values() for step in job.get("steps", [])
                if step.get("name") == "Summarize time, cost, and tool measurements")
    # Run the workflow's actual shell and report command with this test's Python;
    # dependency provisioning and paid model commands are outside this step.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv = bin_dir / "uv"
    uv.write_text('#!/bin/sh\n[ "$1 $2 $3 $4 $5" = "run --locked --extra dev python" ] || exit 90\n'
                  'shift 5\nexec "$SUMMARY_TEST_PYTHON" "$@"\n')
    uv.chmod(0o755)
    root = tmp_path / "release-evaluation"
    for runtime, directory, ledger in (("stable", "raw", "provider-usage.jsonl"),
                                       ("candidate", "raw", "provider-usage.jsonl"),
                                       ("candidate", "cli-raw", "cli-provider-usage.jsonl"),
                                       ("candidate", "deferred", "deferred-provider-usage.jsonl")):
        out = root / runtime / directory
        out.mkdir(parents=True)
        out.joinpath("results.jsonl").write_text(json.dumps({
            "arm": "baseline_cli" if directory == "cli-raw" else "baseline", "task": "one",
            "run": 0, "cost_usd": 2, "duration_s": 5, "resolved": True, "ok": True,
        }) + "\n")
        (root / runtime / ledger).write_text(json.dumps(provider_event() | {"request": "SECRET"}) + "\n")
    summary = tmp_path / "summary.md"
    completed = subprocess.run(["bash", "-euo", "pipefail", "-c", step["run"]], cwd=repository / "eval",
                               env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                                    "SUMMARY_TEST_PYTHON": sys.executable, "RUNNER_TEMP": str(tmp_path),
                                    "GITHUB_STEP_SUMMARY": str(summary), "INPUT_PR": pr,
                                    "CLI_ARM": "true", "DEFERRED_ARM": "true"},
                               capture_output=True, text=True, timeout=60)
    assert completed.returncode == 0, completed.stderr
    assert {p.name.removesuffix("-diagnostics.json") for p in (root / "public").glob("*.json")} == expected
    body = summary.read_text()
    for variant in expected:
        assert f"Detailed measurements: {variant}" in body
        assert json.loads((root / "public" / f"{variant}-diagnostics.json").read_text())["provider"]["observed_requests"] == 1
    assert "SECRET" not in body
