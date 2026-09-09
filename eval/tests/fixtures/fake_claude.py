#!/usr/bin/env python3
"""A stand-in for the Claude Code CLI: real HTTP, real tool execution, real stream-json.

Not a mock of the harness's own code. It does what the CLI does at the two
boundaries the harness depends on - it calls ANTHROPIC_BASE_URL for a turn, it
EXECUTES the tool blocks that come back, and it prints the stream-json event
sequence the parent parses. Write and Skill really run; Bash is deliberately
stubbed, because arbitrary shell from a scripted reply buys no fidelity for the
paths this exercises and plenty of ways to damage the host. Everything between
those boundaries (the sandbox,
the artifact capture, the scoring, the row) stays real, which is the whole
point: those are the layers that shipped bugs no unit test could see.

Reads the prompt from stdin, as the real CLI does under "-p --input-format text".
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.request


def _turn(base_url: str, prompt: str) -> dict:
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/messages",
        data=json.dumps({"model": os.environ.get("ANTHROPIC_MODEL", "mock"), "max_tokens": 1024,
                         "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"Content-Type": "application/json",
                 "x-api-key": os.environ.get("ANTHROPIC_API_KEY", ""),
                 "anthropic-version": "2023-06-01"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def _run_tool(name: str, params: dict) -> str:
    """Execute for real. A Write here is what produces the review artifact."""

    if name == "Write":
        target = pathlib.Path(params["file_path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        # Atomic, exactly as the real Write tool does it: temp file beside the
        # target, then rename. This is the operation the read-only workspace
        # boundary has to permit for the artifact directory and refuse for the
        # workspace, so a stand-in that wrote in place would prove nothing.
        staging = target.with_name(target.name + ".tmp.fake")
        staging.write_text(params.get("content", ""))
        os.replace(staging, target)
        return f"wrote {target}"
    if name == "Skill":
        # Modelled explicitly rather than falling through to a generic success.
        # The parent's evidence gate keys on a Skill request with a non-error
        # result, so leaving this unimplemented let an unexecuted skill satisfy
        # the gate - the gate would have been measuring the fixture, not a skill.
        skill = params.get("skill") or params.get("command") or params.get("name")
        if not skill:
            raise NotImplementedError("Skill request carried no skill name")
        return f"loaded skill {skill}"
    if name == "Bash":
        return "(bash suppressed in the stand-in)"
    # An unsupported tool is a FAILED tool run, not a quiet success. Returning a
    # plain string here made the parent's evidence gate read an unexecuted Skill
    # request as a successful invocation.
    raise NotImplementedError(f"unsupported tool {name}")


def main() -> int:
    # stdin, because that is where the real CLI takes it under
    # "-p --input-format text": the parent pipes prompt bytes in. Scanning argv
    # for a non-flag token picks up a flag's VALUE instead ("text"), which is
    # exactly what the prompt-fidelity test caught.
    prompt = sys.stdin.read()
    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    if not base_url:
        print(json.dumps({"type": "result", "subtype": "error", "is_error": True,
                          "session_id": "fake-session", "num_turns": 0}), flush=True)
        return 1

    emit = lambda event: print(json.dumps(event), flush=True)  # noqa: E731
    emit({"type": "system", "subtype": "init", "session_id": "fake-session"})

    try:
        message = _turn(base_url, prompt)
    except (OSError, ValueError) as exc:
        # A provider failure is a failed SESSION, not a crashed process: dying
        # here leaves no terminal result event, so the parent reports a generic
        # stream error instead of the upstream failure it actually saw.
        emit({"type": "result", "subtype": "error", "is_error": True,
              "session_id": "fake-session", "num_turns": 0,
              "error": f"provider request failed: {type(exc).__name__}: {exc}"})
        return 1
    blocks = message.get("content", [])
    emit({"type": "assistant", "message": {"role": "assistant", "content": blocks}})

    tool_results = []
    for block in blocks:
        if block.get("type") == "tool_use":
            # A refused write is a tool ERROR the session reports and carries
            # on from, not a crash. Letting it kill the process would lose the
            # result event and misreport a working boundary as a broken run.
            failed = False
            try:
                output = _run_tool(block["name"], block.get("input", {}))
            except (OSError, NotImplementedError) as exc:
                output, failed = f"error: {type(exc).__name__}: {exc}", True
            # is_error is load-bearing: the parent treats an ABSENT is_error as
            # success, so a refused or unsupported tool would otherwise be
            # scored as a completed one.
            tool_results.append({
                "type": "tool_result", "tool_use_id": block["id"],
                "content": output, "is_error": failed,
            })
    if tool_results:
        emit({"type": "user", "message": {"role": "user", "content": tool_results}})

    # Unknown is not zero. A reply carrying no usage used to become four
    # zero-valued fields plus a fabricated cost, which the harness then treats
    # as a real measurement - the exact confusion the accounting this fixture
    # feeds exists to prevent.
    usage = message.get("usage")
    if not isinstance(usage, dict) or not all(
        isinstance(usage.get(f), int) and not isinstance(usage.get(f), bool) and usage.get(f) >= 0
        for f in ("input_tokens", "output_tokens")
    ):
        emit({"type": "result", "subtype": "error", "is_error": True,
              "session_id": "fake-session", "num_turns": 1,
              "error": "provider reply carried no usable usage; refusing to report a measured run"})
        return 1
    emit({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": "fake-session",
        "num_turns": 1,
        "duration_ms": 1200,
        # A measured zero is not the same as unmeasured; the parent rejects a
        # collapsed cost, so report a real one.
        "total_cost_usd": 0.42,
        # Forward exactly the fields the provider reported. Defaulting the
        # absent ones to 0 fabricated a complete measurement out of an
        # incomplete reply - and worse, it made the parent's own completeness
        # check (runner_sessions.USAGE_FIELDS / well_formed) unfirable from any
        # offline test, because the stand-in always satisfied it.
        "usage": {
            field: usage[field]
            for field in ("input_tokens", "output_tokens",
                          "cache_read_input_tokens", "cache_creation_input_tokens")
            if field in usage
        },
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
