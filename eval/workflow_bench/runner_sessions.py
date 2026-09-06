"""Headless session execution and transcript evidence for workflow benchmarks."""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import stat
import sys
import threading
import time
from collections import deque
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from .process_control import run_managed
from .proposer_sandbox import (
    SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_REGISTRY,
    SANDBOX_HOME,
    SANDBOX_NODE,
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
# Wall-clock ceiling for one headless session, shared by the runner and the
# evolution loop so both CLIs kill a session at the same point. 3600s was too
# tight for the `workflow` arm: run 29907431284 lost two investigation-task
# incumbent runs to SIGTERM at the ceiling while a Bash verification step was
# still going, and the promotion gate demands zero excluded runs in both paired
# arms — so a single ceiling hit costs the whole generation. Successful
# `workflow` rows in that run finished in ~1600-2600s across both sessions, so
# this leaves real headroom over observed work rather than over the timeout.
SESSION_TIMEOUT_SECONDS = 5400
# Provenance tag stamped on every parent-captured transcript artifact. The
# evidence preflight (evolve._transcript_artifact_metadata) validates against
# this exact value, so producer and consumer stay pinned to one schema.
PARENT_EVENT_STREAM_SOURCE = "parent-captured-stream-json"
# Progress reporting only. A session can work quietly for many minutes, so the
# reporter also speaks up on its own to distinguish "thinking" from "wedged".
PROGRESS_HEARTBEAT_SECONDS = 60.0
MAX_PROGRESS_LINE_BYTES = 1024 * 1024
MAX_PROGRESS_PENDING = 256
MAX_PROGRESS_TOOL_ID_CHARS = 256
MAX_TOOL_PREVIEW_CHARS = 800
_SAFE_TOOL_NAME = re.compile(r"[A-Za-z0-9._:-]{1,64}")
_GHA_WORKFLOW_COMMAND = re.compile(r"(^|[\n\r])::")
_GHA_HASH_COMMAND = re.compile(r"##\[")
_GHA_COMPILER_ANNOTATION = re.compile(r"\((\d+),(\d+)\):\s+error\b", re.IGNORECASE)


def neutralize_ci_log_text(text: str) -> str:
    """Stop GitHub Actions from promoting tool output into check annotations.

    Run 33962002890 logged in-sandbox ``tsc`` failures as
    ``file.ts(line,col): error TS2307``, which Actions parsed as workflow
    annotations on ``.github``. The same parser treats ``::error::`` and
    ``##[error]`` as commands. Progress previews are evidence, not CI
    signaling, so rewrite those forms before they hit the job log.
    """

    text = _GHA_WORKFLOW_COMMAND.sub(r"\1[:]", text)
    text = _GHA_HASH_COMMAND.sub("# [", text)
    return _GHA_COMPILER_ANNOTATION.sub(r"(\1,\2): compiler-error", text)


def _safe_tool_name(value: Any) -> str:
    """A tool name is an identifier; anything else is treated as content."""

    match = _SAFE_TOOL_NAME.fullmatch(value.strip()) if isinstance(value, str) else None
    return match.group(0) if match else "tool"


def _debuggable_tool(name: str) -> bool:
    return name in {"Read", "Bash", "Grep", "Glob"} or name.startswith("mcp__")


def _tool_preview(value: Any, secrets: Sequence[str]) -> str:
    """Render one bounded, redacted, single-line tool payload preview."""

    try:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        raw = json.dumps(str(value), ensure_ascii=False)
    redacted = redact_text(raw, secrets)
    if len(redacted) <= MAX_TOOL_PREVIEW_CHARS:
        return redacted
    omitted = len(redacted) - MAX_TOOL_PREVIEW_CHARS
    return f"{redacted[:MAX_TOOL_PREVIEW_CHARS]}…[truncated {omitted} chars]"


def _tool_result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
    return ""


def _mcp_result_has_semantic_error(content: Any) -> bool:
    """Recognize GitNexus error envelopes that MCP transported successfully."""

    text = _tool_result_text(content).strip()
    if not text:
        return False
    payload = text.split("\n\n---", 1)[0].strip()
    try:
        decoded = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return bool(re.match(r"^error\s*:", payload, re.IGNORECASE))
    return isinstance(decoded, dict) and isinstance(decoded.get("error"), str)


def _tool_result_log_status(name: str, block: dict[str, Any]) -> str:
    if block.get("is_error") is True:
        return "error"
    if name.startswith("mcp__") and _mcp_result_has_semantic_error(block.get("content")):
        return "semantic-error"
    return "ok"


class SessionProgress:
    """Report session metadata and bounded, redacted tool I/O previews.

    A session's stdout is evidence: it is redacted before anything is written
    out, so raw events and model prose are never streamed to the log. Turn
    counts, tool activity, API retries, and quiet time distinguish work from
    a wedged session. Tool arguments and results are content, not metadata.
    """

    def __init__(
        self,
        label: str,
        *,
        stream: Any = None,
        heartbeat_s: float = PROGRESS_HEARTBEAT_SECONDS,
        secrets: Sequence[str] = (),
    ) -> None:
        self.label = label
        self.heartbeat_s = heartbeat_s
        self._secrets = tuple(secret for secret in secrets if secret)
        # stdout, not stderr: the benchmark sweep runs as a child of the
        # evolution loop, which echoes only the child's stdout as it arrives
        # (run_managed(echo_stdout=True)). Its stderr surfaces as a bounded
        # tail after the fact, which is exactly the blind spot this closes.
        self._stream = stream if stream is not None else sys.stdout
        self._lock = threading.Lock()
        self._buffer = bytearray()
        self._started = time.monotonic()
        self._last_spoke = self._started
        self._events = 0
        self._turns = 0
        self._tools = 0
        self._pending_tools: dict[str, str] = {}
        self._last_activity = "starting"
        self._pending_messages: deque[str] = deque(maxlen=MAX_PROGRESS_PENDING)
        self._timer: threading.Thread | None = None
        self._done = threading.Event()

    def __enter__(self) -> SessionProgress:
        self._say(f"started (heartbeat every {self.heartbeat_s:g}s)")
        self._emit_pending()
        self._timer = threading.Thread(target=self._heartbeat, daemon=True)
        self._timer.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._done.set()
        timer, self._timer = self._timer, None
        if timer is not None:
            timer.join(timeout=2)
        self._emit_pending()

    def _elapsed(self) -> str:
        seconds = int(time.monotonic() - self._started)
        return f"{seconds // 60}m{seconds % 60:02d}s"

    def _say(self, message: str) -> None:
        # Queue only: the stdout drain thread calls observe() and must not
        # block on a full log pipe (process_control.stdout_observer contract).
        self._pending_messages.append(
            neutralize_ci_log_text(f"[{self.label} {self._elapsed()}] {message}")
        )
        self._last_spoke = time.monotonic()

    def _emit_pending(self) -> None:
        with self._lock:
            messages = list(self._pending_messages)
            self._pending_messages.clear()
        for message in messages:
            try:
                print(message, file=self._stream, flush=True)
            except (OSError, ValueError):
                return

    def _heartbeat(self) -> None:
        tick = min(1.0, max(self.heartbeat_s / 2, 0.01))
        while not self._done.wait(tick):
            with self._lock:
                quiet = time.monotonic() - self._last_spoke
                if quiet >= self.heartbeat_s:
                    self._say(
                        f"still running · {self._events} events · {self._turns} turns · "
                        f"{self._tools} tool calls · last: {self._last_activity}"
                    )
            self._emit_pending()

    def observe(self, chunk: bytes) -> None:
        """Consume one stdout chunk. Never raises; never blocks on I/O."""

        with self._lock:
            self._buffer.extend(chunk)
            # Bound the partial line: a single enormous event must not grow the
            # buffer without limit just because it has no newline yet.
            if len(self._buffer) > MAX_PROGRESS_LINE_BYTES:
                del self._buffer[:-MAX_PROGRESS_LINE_BYTES]
            while (newline := self._buffer.find(b"\n")) >= 0:
                line = bytes(self._buffer[:newline])
                del self._buffer[: newline + 1]
                self._observe_line(line)

    def _observe_line(self, line: bytes) -> None:
        if not line.strip():
            return
        try:
            event = json.loads(line.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, ValueError):
            return
        if not isinstance(event, dict):
            return
        self._events += 1
        kind = event.get("type")
        if kind == "assistant":
            self._turns += 1
            uses = [
                block for block in _event_content(event) if isinstance(block, dict) and block.get("type") == "tool_use"
            ]
            names = [_safe_tool_name(block.get("name")) for block in uses]
            if names:
                self._tools += len(names)
                self._last_activity = ", ".join(names[:4])
                self._say(f"turn {self._turns} · {self._last_activity}")
                for block, name in zip(uses, names, strict=True):
                    tool_id = block.get("id")
                    if isinstance(tool_id, str) and len(tool_id) <= MAX_PROGRESS_TOOL_ID_CHARS:
                        self._pending_tools.pop(tool_id, None)
                        self._pending_tools[tool_id] = name
                        if len(self._pending_tools) > MAX_PROGRESS_PENDING:
                            del self._pending_tools[next(iter(self._pending_tools))]
                    if _debuggable_tool(name):
                        self._say(f"tool {name} input={_tool_preview(block.get('input'), self._secrets)}")
            else:
                self._last_activity = "model reply"
        elif kind == "user":
            for block in _event_content(event):
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                tool_id = block.get("tool_use_id")
                name = self._pending_tools.pop(tool_id, "tool") if isinstance(tool_id, str) else "tool"
                if not _debuggable_tool(name):
                    continue
                status = _tool_result_log_status(name, block)
                self._last_activity = f"{name} result {status}"
                self._say(f"tool {name} result={status} output={_tool_preview(block.get('content'), self._secrets)}")
        elif kind == "system" and event.get("subtype") == "api_retry":
            # The signature of the gateway wedging: say it loudly and at once.
            attempt = event.get("attempt")
            limit = event.get("max_retries")
            delay = event.get("retry_delay_ms")
            wait = f" in {float(delay) / 1000:.0f}s" if isinstance(delay, (int, float)) else ""
            self._last_activity = f"API retry {attempt}/{limit}"
            self._say(f"API retry {attempt}/{limit}{wait} — no response from the model endpoint")
        elif kind == "system" and event.get("subtype") == "init":
            self._last_activity = "session init"
            self._say("session initialized")
        elif kind == "result":
            cost = event.get("total_cost_usd")
            self._last_activity = "result"
            self._say(
                f"finished · {event.get('num_turns', 0)} turns · "
                f"{'error' if event.get('is_error') else 'ok'}"
                + (f" · ${float(cost):.2f}" if isinstance(cost, (int, float)) else "")
            )


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


def _na(value: Any) -> Any:
    """Render an unmeasured metric as ``n/a`` instead of a misleading number.

    Lives next to ``measured_cost`` because it renders exactly what that
    returns: every caller reporting a cost has to distinguish "never measured"
    from a real 0.0.
    """
    return "n/a" if value is None else value


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
                    SANDBOX_NODE,
                    SANDBOX_GITNEXUS_ENTRYPOINT,
                    "mcp",
                ],
            }
        }
    }
    return json.dumps(config, sort_keys=True, separators=(",", ":"))


def allowed_agent_tools(
    *,
    implementation: bool,
    include_mcp: bool = True,
    allow_edit: bool = True,
) -> list[str]:
    tools = [tool for tool in BUILTIN_AGENT_TOOLS if allow_edit or tool != "Edit"]
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
    """Return the exact identifier token accepted by the Skill tool.

    Plugin skills are requested as ``plugin:skill`` (observed in review
    evolution: ``compound-engineering:ce-code-review``). Compare on the
    skill token after the last colon so a successful plugin-qualified
    invocation still counts as the expected skill.
    """

    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    token = stripped.split(maxsplit=1)[0]
    if token.startswith("/"):
        token = token[1:]
    if ":" in token:
        token = token.rsplit(":", 1)[-1]
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
    effort: str | None = None,
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
    progress_label: str | None = None,
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
    if effort:
        cmd += ["--effort", effort]
    for tool in disallowed_tools or []:
        cmd += ["--disallowedTools", tool]
    managed_cmd = [*(command_prefix or []), *cmd]
    started = time.monotonic()
    with contextlib.ExitStack() as progress_stack:
        progress = (
            progress_stack.enter_context(
                SessionProgress(
                    progress_label,
                    secrets=transcript_secrets,
                )
            )
            if progress_label
            else None
        )
        proc = run_managed(
            managed_cmd,
            cwd=None if command_prefix else cwd,
            timeout=timeout,
            env=env,
            require_pid_namespace=require_pid_namespace,
            stdin_data=prompt.encode(),
            capture_stdout_bytes=MAX_TRANSCRIPT_BYTES,
            stdout_observer=progress.observe if progress is not None else None,
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
        result_indexes = [index for index, event in enumerate(events) if event.get("type") == "result"]
        if len(result_indexes) != 1:
            raise ValueError(f"expected exactly one final result event, observed {len(result_indexes)}")
        result_index = result_indexes[0]
        data = events[result_index]
        # A session that used a background task drains its bookkeeping after
        # the final result event (`background_tasks_changed`, `task_updated`,
        # `task_notification` — all `type: "system"`), so the result is last
        # only among the events that carry evidence. `system` events hold no
        # tool_use/tool_result/usage payload and so cannot forge skill or cost
        # evidence; any other event after the result still fails closed.
        if any(event.get("type") != "system" for event in events[result_index + 1 :]):
            raise ValueError("final result event is not the last event in the captured stream")
        # Nothing after the result is evidence. Cut the window here so that is
        # a property of what the evidence readers below can see, rather than an
        # assumption that a `system` event never carries a tool_use block.
        events = events[: result_index + 1]
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
    tool_use_counts: dict[str, int] = {}
    for event in events:
        for block in _event_content(event):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                name = _safe_tool_name(block.get("name"))
                tool_use_counts[name] = tool_use_counts.get(name, 0) + 1
    record = {
        "ok": not session_error,
        "error_kind": "cancelled" if proc.state == "cancelled" else ("session-error" if session_error else None),
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
        "tool_use_counts": tool_use_counts,
        "gitnexus_tool_uses": sum(count for name, count in tool_use_counts.items() if name.startswith("mcp__gitnexus")),
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
    total["gitnexus_tool_uses"] = sum(session.get("gitnexus_tool_uses", 0) for session in sessions)
    tool_use_counts: dict[str, int] = {}
    for session in sessions:
        for name, count in session.get("tool_use_counts", {}).items():
            tool_use_counts[name] = tool_use_counts.get(name, 0) + int(count)
    total["tool_use_counts"] = tool_use_counts
    return total
