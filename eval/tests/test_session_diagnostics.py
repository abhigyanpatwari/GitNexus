"""Diagnostics must explain overhead without changing credit or exposing content."""

import json
from collections import Counter

import pytest

from tests.test_release_report import DIGEST, NOW, SHA, metadata, rows
from tests.test_workflow_bench_sessions import VALID_REPORT, fake_cli_result, session_record
from workflow_bench import runner_sessions, session_diagnostics as diagnostics
from workflow_bench.release_report import build_report, render_markdown, validate_report


def use(tool="mcp__gitnexus__query", *, tool_id="one", args=None):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tool_id, "name": tool, "input": args or {"query": "private source"}},
    ]}}


def result(body, *, tool_id="one", error=False):
    content = body if isinstance(body, str) else [{"type": "text", "text": json.dumps(body) + "\n\n---\nNext"}]
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tool_id, "is_error": error, "content": content},
    ]}}


@pytest.mark.parametrize("message", [None, {}, {"id": "message"}, {"content": None}, [], "invalid"])
def test_top_level_content_preserves_tool_results_and_source_followups(message):
    events = [use(), result({"definitions": []}), use("Read", tool_id="read"), result("source", tool_id="read")]
    for event in events:
        event["content"] = event["message"]["content"]
        event["message"] = message
    report = diagnostics.diagnose_session(events, [1, 2, 3, 4], 5)
    assert report["timing_complete"] is True
    assert report["tool_wait_s"] == 2
    query = report["tools"]["mcp__gitnexus__query"]
    assert query["calls"] == query["empty"] == query["source_followups"] == 1
    assert query["unfinished"] == 0
    assert report["tools"]["Read"]["calls"] == 1


@pytest.mark.parametrize("nested", [[], "invalid"])
def test_present_non_null_nested_content_prevents_top_level_fallback(nested):
    events = [use(), result("done")]
    for event in events:
        event["content"] = event["message"]["content"]
        event["message"]["content"] = nested
    report = diagnostics.diagnose_session(events, [1, 2], 3)
    assert report["calls"] == []
    assert report["tools"] == {}


def test_nested_tool_content_wins_over_conflicting_top_level_blocks():
    events = [use(), result("done")]
    events[0]["content"] = use("Read", tool_id="shadow")["message"]["content"]
    events[1]["content"] = result("shadow", tool_id="shadow")["message"]["content"]
    report = diagnostics.diagnose_session(events, [1, 2], 3)
    assert list(report["tools"]) == ["mcp__gitnexus__query"]
    assert report["tools"]["mcp__gitnexus__query"]["calls"] == 1
    assert report["timing_complete"] is True
    assert report["tool_wait_s"] == 1


@pytest.mark.parametrize(("wall", "expected"), [
    (0, 0), (500, 0.5), (123.5, 0.1235),
    (None, None), (True, None), ("1", None), (-1, None),
    (float("nan"), None), (float("inf"), None), (10**400, None),
])
def test_server_timing_values_do_not_fail_or_reclassify_completed_tool_calls(wall, expected):
    events = [use(), result({"timing": {"wall": wall}})]
    report = diagnostics.diagnose_session(events, [1, 2], 3)
    tool = report["tools"]["mcp__gitnexus__query"]
    assert tool["calls"] == 1
    assert tool["errors"] == tool["unfinished"] == 0
    assert tool["server_wall_s"] == expected
    assert tool["server_timed_calls"] == int(expected is not None)
    assert report["timing_complete"] is True
    assert report["tool_wait_s"] == 1


def test_event_clock_handles_chunk_boundaries_blank_lines_and_unterminated_event(monkeypatch):
    ticks = iter([10, 11, 13, 15])
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: next(ticks))
    clock = diagnostics.EventClock()
    clock.observe(b'\n  {"message":"')
    clock.observe('é"}\r\n\n'.encode())
    clock.observe(b'{"last":true}')
    assert clock.finish(2) == [3, 5]
    assert clock.finish(3) is None


def test_event_clock_bounds_memory_and_never_claims_complete_overflow(monkeypatch):
    monkeypatch.setattr(diagnostics, "MAX_EVENTS", 2)
    clock = diagnostics.EventClock()
    clock.observe(b'{}\n{}\n{}\n')
    assert len(clock.offsets) == 2
    assert clock.finish(3) is None


def test_overlapping_tools_are_not_double_counted_as_wall_time():
    events = [use(), use("Bash", tool_id="two"), result({"status": "found"}), result("done", tool_id="two")]
    report = diagnostics.diagnose_session(events, [1, 2, 5, 7], 10)
    assert report["timing_complete"] is True
    assert report["tool_wait_s"] == 6
    assert report["mcp_wait_s"] == 4
    assert report["other_wall_s"] == 4
    assert [call["duration_s"] for call in report["calls"]] == [4, 5]
    assert report["tools"]["Bash"]["elapsed_s"] == 5


@pytest.mark.parametrize("offsets", [None, [], [1], [3, 2], [-1, 2], [1, 20], [True, 2], [1, float("nan")]])
def test_unavailable_or_invalid_timing_is_unknown_not_zero(offsets):
    report = diagnostics.diagnose_session([use(), result("done")], offsets, 10)
    assert report["timing_complete"] is False
    assert report["tool_wait_s"] is report["mcp_wait_s"] is report["other_wall_s"] is None
    assert report["calls"][0]["duration_s"] is None


@pytest.mark.parametrize(("body", "signal"), [
    ({"error": "Symbol 'privateName' not found"}, "not_found"),
    ({"status": "ambiguous", "candidates": [{"name": "secret"}]}, "ambiguous"),
    ({"risk": "UNKNOWN"}, "unknown_risk"),
    ({"processes": [], "process_symbols": [], "definitions": []}, "empty"),
    ("Error: result (108,197 characters) exceeds maximum allowed tokens", "output_limit_exceeded"),
])
def test_resolution_problems_and_followup_source_reads_are_counted(body, signal):
    events = [use(), result(body), use("Read", tool_id="read"), result("source", tool_id="read")]
    report = diagnostics.diagnose_session(events, [1, 2, 3, 4], 5)
    tally = report["tools"]["mcp__gitnexus__query"]
    assert tally[signal] == 1
    assert tally["source_followups"] == 1
    assert report["calls"][0]["next_tools"] == ["Read"]
    assert "privateName" not in json.dumps(report)


def test_transport_errors_are_distinct_from_successful_resolution():
    bad = diagnostics.diagnose_session([use(), result("failure", error=True)], [1, 2], 3)
    good = diagnostics.diagnose_session([use(), result({"status": "found"})], [1, 2], 3)
    assert bad["tools"]["mcp__gitnexus__query"]["errors"] == 1
    assert good["tools"]["mcp__gitnexus__query"]["errors"] == 0


def test_plain_text_mcp_errors_are_not_counted_as_success():
    report = diagnostics.diagnose_session([use(), result("Error: database unavailable")], [1, 2], 3)
    assert report["tools"]["mcp__gitnexus__query"]["errors"] == 1


def test_non_ascii_payload_byte_counts_handle_escaped_lone_surrogates():
    report = diagnostics.diagnose_session([use(args={"query": "é\ud800"}), result("é\ud800")], [1, 2], 3)
    assert report["calls"][0]["result_bytes"] == len('"é\\ud800"'.encode())
    assert report["timing_complete"] is True


def test_identical_arguments_are_counted_without_publishing_arguments_or_hashes():
    events = [use(args={"token": "super-secret"}), result("done"),
              use(tool_id="two", args={"token": "super-secret"}), result("done", tool_id="two")]
    report = diagnostics.diagnose_session(events, [1, 2, 3, 4], 5)
    assert report["calls"][1]["repeat_of"] == 0
    assert report["tools"]["mcp__gitnexus__query"]["repeated"] == 1
    assert "super-secret" not in json.dumps(report)
    assert "signature" not in json.dumps(report)


def test_unmatched_results_reused_ids_and_call_limit_make_timing_incomplete(monkeypatch):
    for events in ([use()], [result("orphan")], [use(), result("ok"), use(), result("ok")]):
        assert diagnostics.diagnose_session(events, list(range(len(events))), 10)["timing_complete"] is False
    monkeypatch.setattr(diagnostics, "MAX_CALLS", 1)
    report = diagnostics.diagnose_session([use(), use(tool_id="two")], [1, 2], 5)
    assert report["truncated"] is True and len(report["calls"]) == 1
    assert report["tool_wait_s"] is None


@pytest.mark.parametrize(("command", "tool"), [
    ("gitnexus impact parseFile --direction upstream", "cli__gitnexus__impact"),
    ("/usr/local/bin/gitnexus query 'some concept'", "cli__gitnexus__query"),
    ("gitnexus query 'x;y'", "cli__gitnexus__query"),
    ('gitnexus query "x;y"', "cli__gitnexus__query"),
    (r"gitnexus query x\;y", "cli__gitnexus__query"),
    ("gitnexus query '$(literal) | & > < `literal`'", "cli__gitnexus__query"),
    ('gitnexus query "$(cat secret)"', "Bash"),
    ('gitnexus query "`cat secret`"', "Bash"),
    ("gitnexus query x > result.txt", "Bash"),
    ("gitnexus query x < input.txt", "Bash"),
    ("gitnexus query x; touch changed", "Bash"),
    ("gitnexus query x | cat", "Bash"),
    ("gitnexus query x\nnpm test", "Bash"),
    ("gitnexus impact x && npm test", "Bash"),
    ("echo 'gitnexus query x'", "Bash"),
    ("gitnexus query $(cat secret)", "Bash"),
    ("gitnexus query 'unterminated", "Bash"),
])
def test_cli_attribution_only_covers_standalone_shim_commands(command, tool):
    report = diagnostics.diagnose_session([use("Bash", args={"command": command}), result("ok")], [1, 2], 3)
    assert report["calls"][0]["tool"] == tool
    assert command not in json.dumps(report)


@pytest.mark.parametrize("mask", range(1, 8))
@pytest.mark.parametrize("has_hit", [False, True])
def test_empty_query_signals_cover_every_selected_response_section(mask, has_hit):
    sections = [name for bit, name in enumerate(("processes", "process_symbols", "definitions")) if mask & (1 << bit)]
    body = dict.fromkeys(sections, [])
    if has_hit:
        body[sections[0]] = [{"name": "found"}]
    events = [use(), result(body), use("Read", tool_id="read", args={"file_path": "src/a.ts"}),
              result("source", tool_id="read")]
    report = diagnostics.diagnose_session(events, None, 5)
    tool = report["tools"]["mcp__gitnexus__query"]
    assert tool["empty"] == int(not has_hit)
    assert tool["source_followups"] == int(not has_hit)


@pytest.mark.parametrize("body", [{}, {"definitions": None}, {"timing": {"wall": 1}}])
def test_absent_or_invalid_query_sections_are_not_evidence_of_an_empty_result(body):
    report = diagnostics.diagnose_session([use(), result(body)], None, 5)
    assert report["tools"]["mcp__gitnexus__query"]["empty"] == 0


def test_usage_snapshots_are_deduplicated_and_no_cost_is_fabricated():
    event = use()
    event["message"].update(id="message", usage={"input_tokens": 10, "output_tokens": 2, "secret": "hidden"})
    later = {"type": "assistant", "message": {"id": "message", "content": [], "usage": {"output_tokens": 5}}}
    report = diagnostics.diagnose_session([event, result("ok"), later], [1, 2, 3], 4)
    assert report["assistant_usage"] == [{"event_index": 2, "output_tokens": 5}]
    assert "cost_usd" not in json.dumps(report)
    assert "hidden" not in json.dumps(report)


def test_public_diagnostics_is_idempotent_and_cannot_publish_arbitrary_content():
    raw = diagnostics.diagnose_session([use(), result({"status": "found", "content": "secret source"})], [1, 2], 3)
    raw.update(prompt="secret prompt", api_key="secret key")
    raw["tools"]["private-tool-name"] = {"calls": 5}
    raw["calls"][0]["password"] = "secret password"
    safe = diagnostics.public_diagnostics([raw])
    assert diagnostics.public_diagnostics(safe) == safe
    assert safe[0]["largest_results"][0]["index"] == 0
    assert safe[0]["slowest_calls"][0]["duration_s"] == 1
    assert "secret" not in json.dumps(safe)
    assert "private-tool-name" not in json.dumps(safe)
    assert "calls" not in safe[0]


def test_missing_status_and_stale_or_truncated_results_are_visible_in_public_diagnostics():
    events = [use(), result({"status": "not_found", "risk": "UNKNOWN", "truncated": True,
                             "staleness": {"status": "behind"}}), use("Read", tool_id="read")]
    report = diagnostics.diagnose_session(events, None, 3)
    tally = report["tools"]["mcp__gitnexus__query"]
    assert tally["stale"] == tally["truncated_results"] == tally["source_followups"] == 1
    safe = diagnostics.public_diagnostics([report])
    assert safe[0]["problem_calls"][0]["not_found"] is True
    assert diagnostics.public_diagnostics(safe) == safe


def test_release_report_exports_diagnostics_without_changing_gate_or_accepting_injected_fields():
    measurements = rows()
    raw = diagnostics.diagnose_session([use(), result({"error": "private symbol not found"})], [1, 2], 3)
    measurements[1]["session_diagnostics"] = [raw]
    report = build_report(measurements, metadata(), now=NOW)
    assert report["complete"] is True
    assert report["paired"]["mean_cost_change_pct"] == 25
    validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)
    text = render_markdown(report)
    assert "Diagnostics available for 1/3 cells" in text
    assert "not proof of a workaround" in text
    assert "private symbol" not in json.dumps(report)
    report["per_run"][1]["session_diagnostics"][0]["secret"] = "forged"
    with pytest.raises(ValueError, match="outside the published report schema"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


def test_runner_collects_timings_without_progress_or_changing_session_cost(monkeypatch, tmp_path):
    events = [use(), result("ok"), json.loads(VALID_REPORT)]
    raw = b"".join((json.dumps(event) + "\n").encode() for event in events)

    def run(*args, **kwargs):
        for line in raw.splitlines(keepends=True):
            kwargs["stdout_observer"](line)
        return fake_cli_result(raw.decode())

    monkeypatch.setattr(runner_sessions, "run_managed", run)
    record = runner_sessions.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert record["ok"] is True and record["cost_usd"] == 0.1
    assert record["session_diagnostics"][0]["timing_complete"] is True
    assert len(record["session_diagnostics"][0]["calls"]) == 1
    combined = runner_sessions.sum_sessions([record, record])
    assert len(combined["session_diagnostics"]) == 2
    assert combined["cost_usd"] == 0.2
    assert runner_sessions.sum_sessions([session_record()])["session_diagnostics"] == []


def test_diagnostics_tool_whitelist_matches_the_harness_surface():
    assert {f"mcp__gitnexus__{name}" for name in diagnostics.COMMANDS} == set(runner_sessions.GITNEXUS_READ_ONLY_TOOLS)


def test_observational_followups_can_count_one_action_for_multiple_problem_results():
    first = use()
    second_block = use(tool_id="two")["message"]["content"][0]
    first["message"]["content"].append(second_block)
    events = [first, result({"risk": "UNKNOWN"}), result({"risk": "UNKNOWN"}, tool_id="two"), use("Read", tool_id="read")]
    report = diagnostics.diagnose_session(events, None, 5)
    assert report["tools"]["mcp__gitnexus__query"]["source_followups"] == 2
    assert Counter(call["tool"] for call in report["calls"])["Read"] == 1
