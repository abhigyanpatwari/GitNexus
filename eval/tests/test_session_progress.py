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


def test_progress_reports_turns_and_tool_names_but_never_model_content() -> None:
    stream = io.StringIO()
    progress = SessionProgress("gen 0 proposer", stream=stream, heartbeat_s=3600)
    events = [
        {"type": "system", "subtype": "init"},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "SECRET-REASONING-abc123"},
                    {"type": "tool_use", "id": "t1", "name": "Grep", "input": {"pattern": "SECRET-INPUT"}},
                ]
            },
        },
        {"type": "result", "num_turns": 1, "is_error": False, "total_cost_usd": 1.5},
    ]
    for event in events:
        progress.observe((json.dumps(event) + "\n").encode())

    output = stream.getvalue()
    assert "SECRET-REASONING-abc123" not in output
    assert "SECRET-INPUT" not in output
    assert "session initialized" in output
    assert "turn 1 · Grep" in output
    assert "finished · 1 turns · ok · $1.50" in output


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
