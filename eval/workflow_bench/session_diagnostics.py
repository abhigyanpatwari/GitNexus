"""Content-free diagnostics from parent-captured agent events.

Tool intervals are observed at the stdout boundary, not inside the server.
The next tool action is a correlation, never proof of a workaround or its cost.
"""

from __future__ import annotations

import hashlib
import json
import math
import shlex
import time
from collections import Counter
from pathlib import PurePosixPath
from typing import Any

from .workload_diagnostics import COUNT_FIELDS, TOKEN_FIELDS, public_workload, workload_metrics

SCHEMA = "gitnexus.session-diagnostics/v1"
MAX_EVENTS = 100_000
MAX_CALLS = 2048
CELL_PHASES = ("validation", "clone", "graph_materialize", "dependencies", "mcp_startup",
               "sandbox_setup", "agent_and_verification", "artifacts", "cleanup")
COMMANDS = frozenset({
    "list_repos", "query", "context", "check", "impact", "explain", "pdg_query",
    "route_map", "tool_map", "shape_check", "api_impact", "trace", "detect_changes",
})
TOOLS = frozenset({
    "Read", "Grep", "Glob", "Edit", "Write", "Bash", "Skill", "ToolSearch", "other",
    *(f"mcp__gitnexus__{name}" for name in COMMANDS),
    *(f"cli__gitnexus__{name}" for name in COMMANDS),
})
USAGE = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
COUNTERS = (
    "calls", "errors", "ambiguous", "not_found", "empty", "unknown_risk", "repeated",
    "result_bytes", "max_result_bytes", "source_followups", "unfinished", "output_limit_exceeded", "timed_calls",
    "stale", "truncated_results",
    "lower_bound", "server_timed_calls",
)


class EventClock:
    """Record receipt offsets without retaining or parsing event content.

    Called on the stdout reader thread; no I/O, unbounded buffers, or locks.
    Several events in one chunk share a receipt time. Missing timing stays unknown.
    """

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.offsets: list[float] = []
        self.partial = False
        self.last = 0.0
        self.overflow = False

    def observe(self, chunk: bytes) -> None:
        self.last = time.monotonic() - self.started
        parts = chunk.split(b"\n")
        for part in parts[:-1]:
            if self.partial or part.strip():
                if len(self.offsets) < MAX_EVENTS:
                    self.offsets.append(self.last)
                else:
                    self.overflow = True
            self.partial = False
        self.partial = self.partial or bool(parts[-1].strip())

    def finish(self, expected: int) -> list[float] | None:
        offsets = [*self.offsets, *([self.last] if self.partial else [])]
        return offsets if not self.overflow and len(offsets) <= MAX_EVENTS and len(offsets) == expected else None


def _content(event: dict[str, Any]) -> list[Any]:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if content is None:
        content = event.get("content")
    return content if isinstance(content, list) else []


def _has_shell_control(command: str) -> bool:
    """Reject operators/expansions while allowing quoted or escaped literals."""
    quote = None
    escaped = False
    for char in command:
        if escaped:
            escaped = False
            continue
        if quote == "'":
            if char == "'":
                quote = None
            continue
        if char == "\\":
            escaped = True
        elif char == '"':
            quote = None if quote == '"' else '"'
        elif char == "'" and quote is None:
            quote = "'"
        elif char in "`$" or (quote is None and char in ";|&\n<>()"):
            return True
    return False


def _tool_name(block: dict[str, Any]) -> str:
    name = block.get("name")
    if name == "Bash" and isinstance(block.get("input"), dict):
        # Only a standalone shim command. Compound shell commands retain Bash
        # attribution: their elapsed time cannot be called GitNexus server time.
        command = block["input"].get("command")
        try:
            words = shlex.split(command) if isinstance(command, str) else []
        except ValueError:
            words = []
        if (len(words) >= 2 and PurePosixPath(words[0]).name == "gitnexus"
                and words[1] in COMMANDS and not _has_shell_control(command)):
            return f"cli__gitnexus__{words[1]}"
    return name if isinstance(name, str) and name in TOOLS else "other"


def _result_signals(content: Any) -> dict[str, Any]:
    text = content if isinstance(content, str) else "\n".join(
        block["text"] for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ) if isinstance(content, list) else ""
    signals = {
        "output_limit_exceeded": "exceeds maximum allowed tokens" in text,
        "semantic_error": text.lstrip().lower().startswith("error:"),
    }
    try:
        body = json.loads(text.split("\n\n---", 1)[0])
    except (ValueError, TypeError, RecursionError):
        return signals
    if not isinstance(body, dict):
        return signals
    error = body.get("error")
    signals["semantic_error"] = isinstance(error, str)
    signals["not_found"] = body.get("status") == "not_found" or isinstance(error, str) and "not found" in error.lower()
    signals["ambiguous"] = body.get("status") == "ambiguous"
    signals["unknown_risk"] = body.get("risk") == "UNKNOWN"
    sections = [body[key] for key in ("processes", "process_symbols", "definitions") if key in body]
    signals["empty"] = bool(sections) and all(section == [] for section in sections)
    signals["truncated"] = body.get("truncated") is True or body.get("partial") is True
    signals["lower_bound"] = body.get("epistemic") == "lower-bound"
    timing = body.get("timing")
    wall = timing.get("wall") if isinstance(timing, dict) else None
    if type(wall) in (int, float) and 0 <= wall <= 10**12:
        signals["server_wall_ms"] = wall
    staleness = body.get("staleness")
    if isinstance(staleness, dict) and staleness.get("status") in ("current", "behind", "diverged", "unknown"):
        signals["staleness"] = staleness["status"]
    return signals


def _union_seconds(intervals: list[tuple[float, float]]) -> float:
    total, end = 0.0, 0.0
    for start, stop in sorted(intervals):
        total += max(0.0, stop - max(end, start))
        end = max(end, stop)
    return round(total, 6)


def diagnose_session(
    events: list[dict[str, Any]], offsets: list[float] | None, duration_s: float,
) -> dict[str, Any]:
    """Explain observed tool work; never estimate tool dollars or causal savings."""
    timing = offsets is not None and len(offsets) == len(events) and all(
        type(value) in (int, float) and math.isfinite(value) and 0 <= value <= duration_s
        and (index == 0 or value >= offsets[index - 1]) for index, value in enumerate(offsets)
    )
    calls: list[dict[str, Any]] = []
    inputs: dict[int, Any] = {}
    results: dict[int, Any] = {}
    pending: dict[str, dict[str, Any]] = {}
    signatures: dict[str, int] = {}
    turns: dict[str, dict[str, Any]] = {}
    retries = 0
    truncated = False
    duplicate_ids = False
    seen_ids: set[str] = set()
    for index, event in enumerate(events):
        if event.get("type") == "system" and event.get("subtype") == "api_retry":
            retries += 1
        if event.get("type") == "assistant":
            message = event.get("message") or {}
            # Streaming can repeat a message id. Retain its last usage snapshot
            # rather than adding cumulative snapshots as separate model requests.
            if isinstance(message, dict) and isinstance(message.get("usage"), dict):
                key = str(message.get("id", index))
                if key in turns or len(turns) < MAX_CALLS:
                    turns[key] = {"event_index": index, **{
                        field: value for field in USAGE
                        if type(value := message["usage"].get(field)) is int and value >= 0
                    }}
                else:
                    truncated = True
            for block in _content(event):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                if len(calls) >= MAX_CALLS:
                    truncated = True
                    continue
                tool_id = block.get("id")
                if not isinstance(tool_id, str) or not 0 < len(tool_id) <= 256:
                    duplicate_ids = True
                    continue
                if tool_id in seen_ids:
                    duplicate_ids = True
                    continue
                seen_ids.add(tool_id)
                name = _tool_name(block)
                encoded = json.dumps(block.get("input"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                signature = hashlib.sha256((name + encoded).encode(errors="backslashreplace")).hexdigest()
                call = {
                    "index": len(calls), "tool": name, "request_event": index,
                    "started_s": offsets[index] if timing else None,
                    "completed_s": None, "duration_s": None, "result_event": None,
                    "input_bytes": len(encoded.encode(errors="backslashreplace")), "result_bytes": None,
                    "repeat_of": signatures.get(signature), "outcome": "unfinished",
                    "source_followups": 0,
                }
                signatures[signature] = call["index"]
                pending[tool_id] = call
                calls.append(call)
                inputs[call["index"]] = block.get("input")
        elif event.get("type") == "user":
            for block in _content(event):
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                tool_id = block.get("tool_use_id")
                call = pending.pop(tool_id, None) if isinstance(tool_id, str) else None
                if call is None:
                    duplicate_ids = True
                    continue
                content = block.get("content")
                results[call["index"]] = content
                call["result_bytes"] = len(json.dumps(
                    content, ensure_ascii=False, separators=(",", ":"),
                ).encode(errors="backslashreplace"))
                call["result_event"] = index
                if timing:
                    call["completed_s"] = offsets[index]
                    call["duration_s"] = round(offsets[index] - call["started_s"], 6)
                call["outcome"] = "error" if block.get("is_error") is True else "ok"
                if "__gitnexus__" in call["tool"]:
                    call.update(_result_signals(content))
                    if call.get("semantic_error") or call.get("output_limit_exceeded"):
                        call["outcome"] = "error"
    # Only inspect the immediately following assistant action; this is a
    # temporal signal, not evidence that GitNexus caused the source read.
    next_actions: dict[int, list[str]] = {}
    next_tools: list[str] = []
    for index in range(len(events) - 1, -1, -1):
        next_actions[index] = next_tools
        if events[index].get("type") == "assistant":
            next_tools = [_tool_name(b) for b in _content(events[index])
                          if isinstance(b, dict) and b.get("type") == "tool_use"]
    tools: dict[str, Counter] = {}
    intervals, mcp_intervals = [], []
    for call in calls:
        following = next_actions.get(call["result_event"], [])
        call["next_tools"] = following
        call["source_followups"] = sum(name in ("Read", "Grep", "Glob") for name in following)
        totals = tools.setdefault(call["tool"], Counter({**dict.fromkeys(COUNTERS, 0), "elapsed_s": 0.0, "server_wall_s": 0.0}))
        totals["calls"] += 1
        totals["errors"] += call["outcome"] == "error"
        totals["unfinished"] += call["outcome"] == "unfinished"
        totals["repeated"] += call["repeat_of"] is not None
        totals["result_bytes"] += call["result_bytes"] or 0
        totals["max_result_bytes"] = max(totals["max_result_bytes"], call["result_bytes"] or 0)
        for field in ("ambiguous", "not_found", "empty", "unknown_risk", "output_limit_exceeded", "lower_bound"):
            totals[field] += call.get(field) is True
        if "server_wall_ms" in call:
            totals["server_timed_calls"] += 1
            totals["server_wall_s"] += call["server_wall_ms"] / 1000
        totals["stale"] += call.get("staleness") in ("behind", "diverged")
        totals["truncated_results"] += call.get("truncated") is True
        call["problematic"] = call["outcome"] == "error" or any(
            call.get(field) for field in ("not_found", "ambiguous", "empty", "unknown_risk")
        )
        totals["source_followups"] += call["source_followups"] if call["problematic"] else 0
        if call["duration_s"] is not None:
            totals["timed_calls"] += 1
            totals["elapsed_s"] += call["duration_s"]
            interval = (call["started_s"], call["completed_s"])
            intervals.append(interval)
            if call["tool"].startswith("mcp__gitnexus__"):
                mcp_intervals.append(interval)
    complete = bool(events) and timing and not (pending or truncated or duplicate_ids)
    wait = _union_seconds(intervals) if complete else None
    return {
        "schema": SCHEMA, "timing_complete": complete, "truncated": truncated,
        "tool_wait_s": wait, "mcp_wait_s": _union_seconds(mcp_intervals) if complete else None,
        "other_wall_s": round(max(0.0, duration_s - wait), 6) if wait is not None else None,
        "api_retries": retries, "tools": {
            name: {**values, "elapsed_s": round(values["elapsed_s"], 6) if values["timed_calls"] else None,
                   "server_wall_s": round(values["server_wall_s"], 6) if values["server_timed_calls"] else None}
            for name, values in tools.items()
        }, "calls": calls, "assistant_usage": list(turns.values()),
        "workload": workload_metrics(
            [(call, inputs.get(call["index"]), results.get(call["index"])) for call in calls],
            sorted(turns.values(), key=lambda turn: turn["event_index"]), events,
        ),
    }


def public_diagnostics(value: Any) -> list[dict[str, Any]]:
    """Idempotent metadata whitelist for public summaries and bounded outliers."""
    output = []
    for session in value[:16] if isinstance(value, list) else []:
        if not isinstance(session, dict) or session.get("schema") != SCHEMA:
            continue
        safe: dict[str, Any] = {"schema": SCHEMA}
        for field in ("timing_complete", "truncated"):
            safe[field] = session.get(field) is True
        for field in ("tool_wait_s", "mcp_wait_s", "other_wall_s", "api_retries"):
            number = session.get(field)
            safe[field] = number if type(number) in (int, float) and 0 <= number <= 10**12 else None
        safe["tools"] = {}
        if "workload" in session:
            safe["workload"] = public_workload(session["workload"])
        tools = session.get("tools")
        if isinstance(tools, dict):
            for name in sorted(TOOLS):
                row = tools.get(name)
                if not isinstance(row, dict):
                    continue
                safe["tools"][name] = {
                    field: number if type(number := row.get(field)) is int and 0 <= number <= 10**12 else None
                    for field in COUNTERS
                }
                for field in ("elapsed_s", "server_wall_s"):
                    elapsed = row.get(field)
                    safe["tools"][name][field] = elapsed if type(elapsed) in (int, float) and 0 <= elapsed <= 10**12 else None
        # Keep a few inspectable outliers in the already-uploaded release JSON.
        # Full calls and assistant usage remain in local results.jsonl.
        for field, sort_key in (
            ("largest_results", "result_bytes"), ("slowest_calls", "duration_s"), ("problem_calls", "result_bytes"),
        ):
            candidates = session.get(field, session.get("calls", []))
            safe[field] = []
            if not isinstance(candidates, list):
                continue
            for call in sorted(
                [c for c in candidates[:MAX_CALLS] if isinstance(c, dict)
                 and (field != "problem_calls" or c.get("problematic") is True)
                 and type(c.get(sort_key)) in (int, float) and 0 <= c[sort_key] <= 10**12],
                key=lambda c: c[sort_key], reverse=True,
            )[:5]:
                tool = call.get("tool")
                item = {"tool": tool if isinstance(tool, str) and tool in TOOLS else "other"}
                for name in ("index", "request_event", "result_event", "input_bytes", "result_bytes", "duration_s", "source_followups", "server_wall_ms"):
                    number = call.get(name)
                    item[name] = number if type(number) in (int, float) and 0 <= number <= 10**12 else None
                outcome = call.get("outcome")
                item["outcome"] = outcome if outcome in ("ok", "error", "unfinished") else "unknown"
                for name in ("problematic", "not_found", "ambiguous", "empty", "unknown_risk", "output_limit_exceeded"):
                    item[name] = call.get(name) is True
                safe[field].append(item)
        output.append(safe)
    return output


def public_cell_diagnostics(row: dict[str, Any]) -> dict[str, Any]:
    """Shared publication boundary for release and optional-arm artifacts."""
    safe = {}
    if "session_diagnostics" in row:
        safe["session_diagnostics"] = public_diagnostics(row["session_diagnostics"])
    if "cell_duration_s" in row:
        value = row["cell_duration_s"]
        safe["cell_duration_s"] = value if type(value) in (int, float) and 0 <= value <= 10**12 else None
    phases = row.get("cell_phase_seconds")
    if isinstance(phases, dict):
        safe["cell_phase_seconds"] = {
            field: value if type(value := phases[field]) in (int, float) and 0 <= value <= 10**12 else None
            for field in CELL_PHASES if field in phases
        }
    return safe


def render_diagnostics(rows: list[dict[str, Any]]) -> list[str]:
    """Add tool diagnostics to the existing public report without new CI wiring."""
    lines = []
    for arm in ("baseline_nomcp", "baseline", "baseline_cli"):
        cells = [row for row in rows if row.get("arm") == arm]
        sessions = [s for row in cells for s in public_diagnostics(row.get("session_diagnostics"))]
        if not sessions:
            continue
        measured = sum(bool(public_diagnostics(row.get("session_diagnostics"))) for row in cells)
        lines += ["", f"### Tool diagnostics: {arm}", "",
                  f"Diagnostics available for {measured}/{len(cells)} cells.", "",
                  "| Tool | Calls | Errors | Ambiguous | Not found | Empty | UNKNOWN risk | Repeated args | Result bytes | Largest result | Source follow-ups after problems | Timed calls | Elapsed seconds |",
                  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
        totals: dict[str, Counter] = {}
        coverage: dict[str, Counter] = {}
        tool_sessions: Counter = Counter()
        for session in sessions:
            for name, values in session["tools"].items():
                tally = totals.setdefault(name, Counter())
                known = coverage.setdefault(name, Counter())
                tool_sessions[name] += 1
                for field, number in values.items():
                    if number is not None:
                        known[field] += 1
                        tally[field] = max(tally[field], number) if field == "max_result_bytes" else tally[field] + number
        for name, tally in sorted(totals.items()):
            lines.append("| " + " | ".join(str(v) for v in (
                name, *(tally[f] if coverage[name][f] == tool_sessions[name] else "n/a" for f in
                        ("calls", "errors", "ambiguous", "not_found", "empty", "unknown_risk",
                         "repeated", "result_bytes", "max_result_bytes", "source_followups", "timed_calls")),
                f"{tally['elapsed_s']:.1f}" if tally["timed_calls"] else "n/a",
            )) + " |")
        lines += ["", "| Tool | Stale | Truncated results | Lower bound | Output limit | Unfinished | Server-timed calls | Server seconds |",
                  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
        for name, tally in sorted(totals.items()):
            lines.append("| " + " | ".join(str(v) for v in (
                name, *(tally[f] if coverage[name][f] == tool_sessions[name] else "n/a" for f in
                        ("stale", "truncated_results", "lower_bound", "output_limit_exceeded", "unfinished", "server_timed_calls")),
                f"{tally['server_wall_s']:.3f}" if tally["server_timed_calls"] else "n/a",
            )) + " |")
        complete = [s for s in sessions if s["timing_complete"] and s["tool_wait_s"] is not None]
        lines += ["", f"Complete host timing: {len(complete)}/{len(sessions)} sessions."]
        limited = sum(s["truncated"] for s in sessions)
        if limited:
            lines.append(f"Diagnostics truncated in {limited} session(s); tool counts are lower bounds.")
        if complete:
            lines.append(f"Observed tool wait: {sum(s['tool_wait_s'] for s in complete):.1f}s; "
                         f"MCP wait: {sum(s['mcp_wait_s'] or 0 for s in complete):.1f}s "
                         "(a subset of tool wait). Parallel intervals are counted once per session.")
        for field, label in (("other_wall_s", "Other session wall time (seconds)"), ("api_retries", "Observed API retries")):
            values = [s[field] for s in sessions if s.get(field) is not None]
            lines.append(f"{label}: {sum(values):.1f} across {len(values)}/{len(sessions)} sessions."
                         if values else f"{label}: n/a.")
        workloads = [s["workload"] for s in sessions if s.get("workload")]
        if workloads:
            lines += ["", f"Workload signals available for {len(workloads)}/{len(sessions)} sessions.", "",
                      "| Workload signal | Observed count | Sessions reporting |", "| --- | ---: | ---: |"]
            for field in COUNT_FIELDS:
                values = [w[field] for w in workloads if w.get(field) is not None]
                lines.append(f"| {field} | {sum(values) if values else 'n/a'} | {len(values)}/{len(sessions)} |")
            peaks = [w["max_input_tokens"] for w in workloads if w.get("max_input_tokens") is not None]
            if peaks:
                lines.append(f"\nLargest observed CLI input context: {max(peaks):,} tokens. "
                             "Uses complete Anthropic-shaped usage snapshots; provider-native usage may differ.")
            lines += ["", "| Context/cache signal | Session minimum | Session maximum | Sessions reporting |",
                      "| --- | ---: | ---: | ---: |"]
            for field in TOKEN_FIELDS:
                values = [w[field] for w in workloads if w.get(field) is not None]
                lines.append(f"| {field} | {min(values) if values else 'n/a'} | {max(values) if values else 'n/a'} | "
                             f"{len(values)}/{len(sessions)} |")
        lines += ["", "<details><summary>Largest, slowest, and problematic tool calls</summary>", "",
                  "Session and call indexes identify observations; arguments and source content are omitted.", "",
                  "| View | Session | Call | Tool | Result bytes | Host seconds | Outcome |",
                  "| --- | ---: | ---: | --- | ---: | ---: | --- |"]
        for view, sort_key in (("largest_results", "result_bytes"), ("slowest_calls", "duration_s"),
                               ("problem_calls", "result_bytes")):
            calls = [(index, call) for index, session in enumerate(sessions) for call in session[view]]
            for index, call in sorted(calls, key=lambda item: item[1][sort_key], reverse=True)[:5]:
                duration = call["duration_s"]
                lines.append(f"| {view} | {index} | {call['index']} | {call['tool']} | {call['result_bytes']} | "
                             f"{f'{duration:.3f}' if duration is not None else 'n/a'} | {call['outcome']} |")
        lines += ["", "</details>"]
    if lines:
        lines += ["", ("Receipt timing includes transport and scheduling, not just server execution. Other wall time is not model time. "
                  "Bytes are serialized payload bytes, not tokens. Repeated arguments may be justified after edits. "
                  "Source follow-ups are the next assistant action after a problematic result, not proof of a workaround. "
                  "Per-tool elapsed sums may overlap. Session cost includes all work; no per-tool dollar attribution is available.")]
        lines += [("A file read after a graph reference is an association, not duplicated content or low relevance. "
                  "Repeated verification can be necessary. Bash classification is conservative; mixed commands stay unclassified. "
                  "Missing usage fields remain unknown. Context totals describe observed snapshots only.")]
    return lines
