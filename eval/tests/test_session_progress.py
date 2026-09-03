"""Live progress reporting for long headless sessions.

The session event stream is evidence and is redacted before it is written
anywhere, so progress may only report metadata derived from it. These tests pin
that boundary along with the signals that distinguish work from a wedged run.
"""

from __future__ import annotations

import io
import json
import time

from workflow_bench.runner_sessions import SessionProgress


def _drain_lines(stream: io.StringIO) -> list[str]:
    return [line for line in stream.getvalue().splitlines() if line.strip()]


def test_progress_reports_bounded_redacted_tool_io_but_never_model_prose() -> None:
    stream = io.StringIO()
    progress = SessionProgress(
        "gen 0 proposer",
        stream=stream,
        heartbeat_s=3600,
        secrets=("SECRET-TOKEN-abc123",),
    )
    events = [
        {"type": "system", "subtype": "init"},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "SECRET-REASONING-abc123"},
                    {
                        "type": "tool_use",
                        "id": "t1",
                        "name": "Grep",
                        "input": {
                            "pattern": "TODO",
                            "path": "/workspace",
                            "token": "SECRET-TOKEN-abc123",
                        },
                    },
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "is_error": False,
                        "content": "src/a.py:1: TODO " + "x" * 1000,
                    }
                ]
            },
        },
        {"type": "result", "num_turns": 1, "is_error": False, "total_cost_usd": 1.5},
    ]
    for event in events:
        progress.observe((json.dumps(event) + "\n").encode())

    output = stream.getvalue()
    assert "SECRET-REASONING-abc123" not in output
    assert "SECRET-TOKEN-abc123" not in output
    assert "[REDACTED]" in output
    assert "session initialized" in output
    assert "turn 1 · Grep" in output
    assert 'tool Grep input={"pattern":"TODO","path":"/workspace","token":"[REDACTED]"}' in output
    assert "tool Grep result=ok output=" in output
    assert "truncated" in output
    assert "finished · 1 turns · ok · $1.50" in output


def test_progress_reports_errors_and_mcp_io_but_skips_other_tool_payloads() -> None:
    stream = io.StringIO()
    progress = SessionProgress("flow", stream=stream, heartbeat_s=3600)
    events = [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "m1",
                        "name": "mcp__gitnexus__query",
                        "input": {"search_query": "call resolution"},
                    },
                    {
                        "type": "tool_use",
                        "id": "e1",
                        "name": "Edit",
                        "input": {"file_path": "secret.py", "new_string": "do not log"},
                    },
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "m1",
                        "is_error": True,
                        "content": "repository is not indexed",
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "e1",
                        "content": "edited secret.py",
                    },
                ]
            },
        },
    ]
    for event in events:
        progress.observe((json.dumps(event) + "\n").encode())

    output = stream.getvalue()
    assert 'tool mcp__gitnexus__query input={"search_query":"call resolution"}' in output
    assert 'tool mcp__gitnexus__query result=error output="repository is not indexed"' in output
    assert "do not log" not in output
    assert "edited secret.py" not in output


def test_progress_distinguishes_mcp_semantic_errors_from_transport_success() -> None:
    stream = io.StringIO()
    progress = SessionProgress("flow", stream=stream, heartbeat_s=3600)
    events = [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "m1",
                        "name": "mcp__gitnexus__impact",
                        "input": {"target": "missing", "direction": "upstream"},
                    }
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "m1",
                        "is_error": False,
                        "content": [
                            {
                                "type": "text",
                                "text": '{"error":"Target missing not found"}\n\n---\n**Next:** retry',
                            }
                        ],
                    }
                ]
            },
        },
    ]
    for event in events:
        progress.observe((json.dumps(event) + "\n").encode())

    assert "tool mcp__gitnexus__impact result=semantic-error" in stream.getvalue()


def test_progress_calls_out_api_retries_because_that_is_the_stuck_signature() -> None:
    stream = io.StringIO()
    progress = SessionProgress("proposer", stream=stream, heartbeat_s=3600)
    event = {
        "type": "system",
        "subtype": "api_retry",
        "attempt": 7,
        "max_retries": 10,
        "retry_delay_ms": 34199.87,
        "error": "unknown",
    }
    progress.observe((json.dumps(event) + "\n").encode())

    line = _drain_lines(stream)[-1]
    assert "API retry 7/10 in 34s" in line
    assert "no response from the model endpoint" in line


def test_progress_speaks_up_while_a_session_is_silent() -> None:
    stream = io.StringIO()
    with SessionProgress("proposer", stream=stream, heartbeat_s=0.05):
        time.sleep(0.35)

    heartbeats = [line for line in _drain_lines(stream) if "still running" in line]
    assert heartbeats, "a silent session must still report that it is alive"
    assert "0 turns" in heartbeats[0]


def test_progress_survives_partial_chunks_garbage_and_unbounded_lines() -> None:
    stream = io.StringIO()
    progress = SessionProgress("proposer", stream=stream, heartbeat_s=3600)
    payload = json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash"}]}}
    ).encode()
    # An event split across reads, non-JSON noise, and a huge newline-free run.
    progress.observe(payload[:10])
    progress.observe(payload[10:] + b"\nnot json at all\n")
    progress.observe(b"x" * (4 * 1024 * 1024))
    progress.observe(b'\n{"type":"result","num_turns":2,"is_error":true}\n')

    output = stream.getvalue()
    assert "turn 1 · Bash" in output
    assert "finished · 2 turns · error" in output


def test_progress_sanitizes_a_hostile_tool_name() -> None:
    stream = io.StringIO()
    progress = SessionProgress("proposer", stream=stream, heartbeat_s=3600)
    event = {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash\nFAKE-LOG-LINE injected"}]},
    }
    progress.observe((json.dumps(event) + "\n").encode())

    assert "FAKE-LOG-LINE" not in stream.getvalue()
    assert len(_drain_lines(stream)) == 1


def test_cell_failure_detail_line_explains_why_a_cell_failed() -> None:
    from workflow_bench.runner import cell_failure_detail_line

    assert cell_failure_detail_line("t", "workflow", 0, {"error_kind": None}) is None
    assert cell_failure_detail_line("t", "workflow", 0, {"error_kind": "x"}) is None

    line = cell_failure_detail_line(
        "trivial-status-json-alias",
        "candidate_workflow",
        1,
        {
            "error_kind": "plan-evidence-invalid",
            "error_detail": "unauthorized workspace path\ntoken=sk-secret-value",
        },
        ("sk-secret-value",),
    )
    assert line is not None
    assert line.startswith("[trivial-status-json-alias][candidate_workflow][run 1] detail: ")
    assert "unauthorized workspace path" in line
    assert "sk-secret-value" not in line
    assert "\n" not in line


def test_cell_failure_detail_line_bounds_a_huge_detail() -> None:
    from workflow_bench.runner import MAX_CELL_DETAIL_CHARS, cell_failure_detail_line

    line = cell_failure_detail_line(
        "t", "workflow", 0, {"error_kind": "session-error", "error_detail": {"stdout_tail": "y" * 50_000}}
    )
    assert line is not None
    assert "truncated" in line
    assert len(line) < MAX_CELL_DETAIL_CHARS + 200
