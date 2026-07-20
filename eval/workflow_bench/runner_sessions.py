"""Headless session execution and transcript evidence for workflow benchmarks."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import time
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from .process_control import run_managed
from .proposer_sandbox import (
    SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_REGISTRY,
    SANDBOX_HOME,
    SANDBOX_TMP,
    SANDBOX_WORKSPACE,
    SandboxError,
    redact_text,
)

USAGE_FIELDS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
# Provenance tag stamped on every parent-captured transcript artifact. The
# evidence preflight (evolve._transcript_artifact_metadata) validates against
# this exact value, so producer and consumer stay pinned to one schema.
PARENT_EVENT_STREAM_SOURCE = "parent-captured-stream-json"


def measured_cost(raw: Any) -> float | None:
    """Session cost as a finite non-negative float, or None when unmeasured.

    ``cost_usd`` is a promotion metric (lower wins), so an absent/garbage
    ``total_cost_usd`` must NOT collapse to a real measured $0 that a candidate
    could win on — it stays None and the gate refuses to rank on it. A genuine
    measured 0.0 is preserved distinctly.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    if not math.isfinite(raw) or raw < 0:
        return None
    return float(raw)
SANDBOX_GITNEXUS_ENTRYPOINT = f"{SANDBOX_GITNEXUS}/dist/cli/index.js"
SENSITIVE_EVENT_KEYS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "api_key",
        "anthropic-api-key",
        "anthropic_api_key",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "client_secret",
        "cookie",
        "set-cookie",
        "password",
    }
)

GITNEXUS_READ_ONLY_TOOLS = (
    "mcp__gitnexus__list_repos",
    "mcp__gitnexus__query",
    "mcp__gitnexus__context",
    "mcp__gitnexus__check",
    "mcp__gitnexus__impact",
    "mcp__gitnexus__explain",
    "mcp__gitnexus__pdg_query",
    "mcp__gitnexus__route_map",
    "mcp__gitnexus__tool_map",
    "mcp__gitnexus__shape_check",
    "mcp__gitnexus__api_impact",
    "mcp__gitnexus__trace",
    "mcp__gitnexus__detect_changes",
)
GITNEXUS_MUTATING_TOOLS = ("mcp__gitnexus__rename",)
BUILTIN_AGENT_TOOLS = ("Read", "Grep", "Glob", "Edit", "Write", "Bash", "Skill")


def sandbox_mcp_config() -> str:
    """Credential-free MCP configuration using only the pinned harness runtime."""

    entrypoint = PurePosixPath(SANDBOX_GITNEXUS_ENTRYPOINT)
    workspace = PurePosixPath(SANDBOX_WORKSPACE)
    if not entrypoint.is_absolute() or entrypoint == workspace or workspace in entrypoint.parents:
        raise SandboxError(f"GitNexus MCP executable must stay outside {SANDBOX_WORKSPACE}")

    config = {
        "mcpServers": {
            "gitnexus": {
                "type": "stdio",
                "command": "/usr/bin/env",
                "args": [
                    "-i",
                    f"HOME={SANDBOX_HOME}",
                    f"TMPDIR={SANDBOX_TMP}",
                    f"GITNEXUS_HOME={SANDBOX_GITNEXUS_REGISTRY}",
                    f"GITNEXUS_MCP_ALLOWED_REPOS={SANDBOX_WORKSPACE}",
                    f"GITNEXUS_MCP_DEFAULT_REPO={SANDBOX_WORKSPACE}",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "GIT_TERMINAL_PROMPT=0",
                    "/usr/local/bin/node",
                    SANDBOX_GITNEXUS_ENTRYPOINT,
                    "mcp",
                ],
            }
        }
    }
    return json.dumps(config, sort_keys=True, separators=(",", ":"))


def allowed_agent_tools(*, implementation: bool, include_mcp: bool = True) -> list[str]:
    tools = [*BUILTIN_AGENT_TOOLS]
    if include_mcp:
        tools.extend(GITNEXUS_READ_ONLY_TOOLS)
    if include_mcp and implementation:
        tools.extend(GITNEXUS_MUTATING_TOOLS)
    return tools


def _persist_parent_event_stream(
    raw: bytes,
    *,
    output_dir: Path,
    relative_path: str,
    secrets: tuple[str, ...],
) -> dict[str, Any]:
    """Persist only the complete event stream captured by the trusted parent."""

    # Parsing before persistence proves the artifact is complete structured
    # evidence, rather than arbitrary output injected through a tool result.
    events = _parse_parent_event_stream(raw)
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or len(relative.parts) != 2 or relative.parts[0] != "transcripts":
        raise ValueError(f"event-stream artifact path must be transcripts/<file>: {relative_path!r}")
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError(f"unsafe event-stream artifact path: {relative_path!r}")

    root = output_dir.expanduser().absolute()
    root_mode = root.lstat().st_mode
    if stat.S_ISLNK(root_mode) or not stat.S_ISDIR(root_mode) or root.resolve(strict=True) != root:
        raise ValueError(f"event-stream output root must be a real non-symlink directory: {root}")
    transcript_dir = root / relative.parts[0]
    try:
        transcript_dir.mkdir(mode=0o700)
    except FileExistsError:
        mode = transcript_dir.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise ValueError(f"event-stream artifact parent must be a real directory: {transcript_dir}")
    transcript_dir.chmod(0o700)

    def redact_value(value: Any) -> Any:
        if isinstance(value, str):
            return redact_text(value, secrets)
        if isinstance(value, list):
            return [redact_value(item) for item in value]
        if isinstance(value, dict):
            redacted: dict[str, Any] = {}
            for key, item in value.items():
                source_key = str(key)
                redacted_key = redact_text(source_key, secrets)
                if redacted_key in redacted:
                    raise ValueError("event-stream keys collide after structural redaction")
                redacted[redacted_key] = (
                    "[REDACTED]" if source_key.strip().casefold() in SENSITIVE_EVENT_KEYS else redact_value(item)
                )
            return redacted
        return value

    payload = (
        "".join(
            json.dumps(
                redact_value(event),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            + "\n"
            for event in events
        )
    ).encode("utf-8")
    if len(payload) > MAX_TRANSCRIPT_BYTES:
        raise ValueError("redacted parent event stream exceeds the bounded artifact limit")
    _parse_parent_event_stream(payload)
    destination = transcript_dir / relative.name
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write while persisting parent event stream")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {
        "path": relative.as_posix(),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "source": PARENT_EVENT_STREAM_SOURCE,
    }


def _normalized_skill_identifier(value: Any) -> str | None:
    """Return the exact identifier token accepted by the Skill tool."""

    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    token = stripped.split(maxsplit=1)[0]
    if token.startswith("/"):
        token = token[1:]
    return token or None


def _event_content(event: dict[str, Any]) -> list[Any]:
    message = event.get("message")
    content = (message or {}).get("content") if isinstance(message, dict) else None
    if content is None:
        content = event.get("content")
    return content if isinstance(content, list) else []


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant: {value}")


def _parse_parent_event_stream(raw: bytes) -> list[dict[str, Any]]:
    """Strictly parse every CLI-emitted event through EOF."""

    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError("parent-captured Claude event stream is not UTF-8") from exc
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"malformed parent-captured event JSON at line {line_number}") from exc
        if not isinstance(event, dict):
            raise ValueError(f"parent-captured event {line_number} is not an object")
        events.append(event)
    if not events:
        raise ValueError("parent-captured Claude event stream contains no events")
    return events


def skill_was_invoked_events(events: Sequence[dict[str, Any]], skill_name: str) -> bool:
    """Prove an exact Skill request had a later successful tool result."""

    expected_identifier = _normalized_skill_identifier(skill_name)
    if expected_identifier is None:
        raise ValueError("expected skill name must contain an identifier")
    tool_uses: dict[str, tuple[int, bool]] = {}
    tool_results: dict[str, tuple[int, bool]] = {}
    for event_index, event in enumerate(events):
        for block in _event_content(event):
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                tool_id = block.get("id")
                if not isinstance(tool_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", tool_id):
                    raise ValueError("tool request has no bounded tool-use id")
                if tool_id in tool_uses:
                    raise ValueError(f"duplicate tool-use id in parent event stream: {tool_id}")
                matched = False
                if str(block.get("name", "")).casefold() == "skill":
                    skill_input = block.get("input")
                    if isinstance(skill_input, dict):
                        matched = any(
                            _normalized_skill_identifier(skill_input.get(field)) == expected_identifier
                            for field in ("skill", "command", "name")
                        )
                tool_uses[tool_id] = (event_index, matched)
            elif block_type == "tool_result":
                tool_id = block.get("tool_use_id")
                if not isinstance(tool_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", tool_id):
                    raise ValueError("tool result has no bounded tool-use id")
                if tool_id in tool_results:
                    raise ValueError(f"duplicate tool result in parent event stream: {tool_id}")
                is_error = block.get("is_error")
                if is_error not in (None, False, True):
                    raise ValueError(f"tool result has malformed is_error for {tool_id}")
                tool_results[tool_id] = (event_index, is_error is True)

    matching = [(tool_id, request_index) for tool_id, (request_index, matched) in tool_uses.items() if matched]
    if not matching:
        return False
    successful = False
    for tool_id, request_index in matching:
        result = tool_results.get(tool_id)
        if result is None:
            raise ValueError(f"matching Skill request has no tool result: {tool_id}")
        result_index, is_error = result
        if result_index <= request_index:
            raise ValueError(f"matching Skill result does not follow its request: {tool_id}")
        successful = successful or not is_error
    return successful


def run_claude(
    prompt: str,
    cwd: Path,
    *,
    claude_bin: str,
    timeout: int,
    disallowed_tools: list[str] | None = None,
    model: str | None = None,
    env: dict[str, str] | None = None,
    permission_mode: str | None = None,
    expected_skill: str | None = None,
    command_prefix: list[str] | None = None,
    require_pid_namespace: bool = False,
    bare: bool = False,
    settings_json: str | None = None,
    strict_mcp_config: bool = False,
    allowed_tools: list[str] | None = None,
    disable_slash_commands: bool = False,
    mcp_config_json: str | None = None,
    transcript_projects: Path | None = None,
    transcript_cwd: Path | None = None,
    transcript_wait_seconds: float = 0,
    transcript_output_dir: Path | None = None,
    transcript_output_prefix: str | None = None,
    transcript_secrets: tuple[str, ...] = (),
    plugin_dirs: Sequence[str] = (),
) -> dict[str, Any]:
    """Run one headless session and return its usage record."""

    # Kept as compatibility parameters for callers, but deliberately ignored:
    # every file under the sandbox HOME is writable by agent tools and cannot
    # serve as trusted evidence.
    del transcript_projects, transcript_cwd, transcript_wait_seconds

    cmd = [
        claude_bin,
        "-p",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if bare:
        cmd.append("--bare")
    for plugin_dir in plugin_dirs:
        cmd += ["--plugin-dir", plugin_dir]
    if settings_json is not None:
        cmd += ["--settings", settings_json]
    if strict_mcp_config:
        cmd += ["--strict-mcp-config", "--mcp-config", mcp_config_json or '{"mcpServers":{}}']
    if allowed_tools:
        # --bare's own hard-coded Bash/Edit/Read ceiling already scopes bare
        # sessions; outside --bare the built-in toolset defaults to
        # everything (subagents, WebFetch, Task, ...), so --tools is needed
        # to actually restrict it — --allowedTools only pre-approves within
        # whatever set is available, it does not narrow that set.
        if not bare:
            cmd += ["--tools", *allowed_tools]
        cmd += ["--allowedTools", *allowed_tools]
    if disable_slash_commands:
        cmd.append("--disable-slash-commands")
    if permission_mode:
        cmd += ["--permission-mode", permission_mode]
    if model:
        cmd += ["--model", model]
    for tool in disallowed_tools or []:
        cmd += ["--disallowedTools", tool]
    managed_cmd = [*(command_prefix or []), *cmd]
    started = time.monotonic()
    proc = run_managed(
        managed_cmd,
        cwd=None if command_prefix else cwd,
        timeout=timeout,
        env=env,
        require_pid_namespace=require_pid_namespace,
        stdin_data=prompt.encode(),
        capture_stdout_bytes=MAX_TRANSCRIPT_BYTES,
    )
    wall_s = time.monotonic() - started
    event_stream_error: str | None = None
    events: list[dict[str, Any]] = []
    try:
        if proc.stdout_capture is None:
            raise ValueError("parent process did not capture Claude stdout")
        if proc.stdout_capture_overflow:
            raise ValueError(f"parent-captured event stream exceeds {MAX_TRANSCRIPT_BYTES} bytes")
        events = _parse_parent_event_stream(proc.stdout_capture)
        result_events = [event for event in events if event.get("type") == "result"]
        if len(result_events) != 1:
            raise ValueError(f"expected exactly one final result event, observed {len(result_events)}")
        data = result_events[0]
        if events[-1] is not data:
            raise ValueError("final result event is not the last event in the captured stream")
    except (UnicodeError, ValueError) as exc:
        event_stream_error = str(exc)
        data = {}
    usage = data.get("usage") or {}
    subtype = data.get("subtype")
    well_formed = all(field in usage for field in USAGE_FIELDS)
    session_error = (
        not proc.ok
        or event_stream_error is not None
        or data.get("is_error", False)
        or str(subtype).startswith("error")
        or not well_formed
    )
    record = {
        "ok": not session_error,
        "error_kind": "session-error" if session_error else None,
        "error_detail": (
            {
                "subtype": subtype,
                "returncode": proc.returncode,
                "process_state": proc.state,
                "stderr_tail": proc.stderr_tail[-2000:],
                # A session can exit non-zero with an empty stderr (e.g. a
                # pre-flight sandbox failure before any model turn): the tail
                # of raw stdout is the only place the actual event stream
                # (permission_denials, tool_use/tool_result, is_error) shows
                # up, so surface it here rather than leaving the failure
                # opaque. Callers already redact this record before it is
                # written to disk or an uploaded artifact.
                "stdout_tail": proc.stdout_tail[-2000:],
                "process_detail": proc.detail,
                "event_stream_error": event_stream_error,
            }
            if session_error
            else None
        ),
        "session_id": data.get("session_id"),
        "num_turns": data.get("num_turns", 0),
        "cost_usd": measured_cost(data.get("total_cost_usd")),
        "duration_s": round(data.get("duration_ms", wall_s * 1000) / 1000, 1),
        "transcript_missing": False,
        **{field: usage.get(field, 0) for field in USAGE_FIELDS},
    }
    needs_evidence = expected_skill is not None or transcript_output_dir is not None
    if needs_evidence:
        # Only stdout captured by the trusted parent is admissible evidence.
        # The session's HOME is writable by agent tools and is deliberately
        # ignored, including when the process reports an error or times out.
        evidence_diagnostics: list[str] = []
        if event_stream_error is not None:
            evidence_diagnostics.append(f"unverifiable parent event stream: {event_stream_error}")
        elif proc.stdout_capture is None:
            evidence_diagnostics.append("unverifiable parent event stream: capture is missing")
        elif proc.stdout_capture_overflow:
            evidence_diagnostics.append(
                f"unverifiable parent event stream: capture exceeds {MAX_TRANSCRIPT_BYTES} bytes"
            )
        else:
            if expected_skill is not None:
                try:
                    record["skill_invoked"] = skill_was_invoked_events(events, expected_skill)
                except ValueError as exc:
                    record["skill_invoked"] = None
                    evidence_diagnostics.append(f"unverifiable skill evidence: {exc}")

            if transcript_output_dir is not None:
                try:
                    prefix = transcript_output_prefix or "session"
                    if not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", prefix):
                        raise ValueError(f"unsafe transcript artifact prefix: {prefix!r}")
                    session_id = data.get("session_id")
                    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
                        raise ValueError(f"unsafe transcript session id: {session_id!r}")
                    record["session_id"] = session_id
                    record["transcript_artifact"] = _persist_parent_event_stream(
                        proc.stdout_capture,
                        output_dir=transcript_output_dir,
                        relative_path=f"transcripts/{prefix}-{session_id}.jsonl",
                        secrets=transcript_secrets,
                    )
                except (OSError, UnicodeError, ValueError) as exc:
                    evidence_diagnostics.append(f"unverifiable event-stream persistence: {exc}")

        if expected_skill is not None and "skill_invoked" not in record:
            record["skill_invoked"] = None
        if expected_skill is not None and record.get("skill_invoked") is False:
            detail = f"parent event stream shows no successful {expected_skill} invocation"
            if session_error:
                evidence_diagnostics.append(detail)
            elif not evidence_diagnostics:
                record["ok"] = False
                record["error_kind"] = "skill-not-invoked"
                record["error_detail"] = detail

        if evidence_diagnostics:
            record["transcript_missing"] = True
            record["evidence_diagnostics"] = evidence_diagnostics
            if not session_error:
                record["ok"] = False
                record["error_kind"] = "evidence-unverified"
                record["error_detail"] = "; ".join(evidence_diagnostics)
    return record


def sum_sessions(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    total: dict[str, Any] = {field: sum(session[field] for session in sessions) for field in USAGE_FIELDS}
    session_costs = [session["cost_usd"] for session in sessions]
    total["cost_usd"] = None if any(cost is None for cost in session_costs) else round(sum(session_costs), 4)
    total["duration_s"] = round(sum(session["duration_s"] for session in sessions), 1)
    total["num_turns"] = sum(session["num_turns"] for session in sessions)
    total["ok"] = all(session["ok"] for session in sessions)
    total["session_ids"] = [session["session_id"] for session in sessions]
    kinds = [session.get("error_kind") for session in sessions if session.get("error_kind")]
    total["error_kind"] = kinds[0] if kinds else None
    details = [session.get("error_detail") for session in sessions if session.get("error_detail")]
    total["error_detail"] = details[0] if details else None
    invocations = [session["skill_invoked"] for session in sessions if "skill_invoked" in session]
    if False in invocations:
        total["skill_invoked"] = False
    elif None in invocations or not invocations:
        total["skill_invoked"] = None
    else:
        total["skill_invoked"] = True
    total["transcript_missing"] = any(session.get("transcript_missing", False) for session in sessions)
    total["transcript_artifacts"] = [
        session["transcript_artifact"] for session in sessions if "transcript_artifact" in session
    ]
    total["evidence_diagnostics"] = [
        diagnostic for session in sessions for diagnostic in session.get("evidence_diagnostics", [])
    ]
    return total
