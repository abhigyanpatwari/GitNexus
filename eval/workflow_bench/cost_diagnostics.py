"""Offline cost evidence report; no API calls, pricing guesses, or release gates."""

from __future__ import annotations

import argparse
import html
import json
import math
import statistics
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .provider_usage import NormalizedUsage, UsageSemanticsError, normalize_usage
from .session_diagnostics import CELL_PHASES, public_diagnostics, render_diagnostics

NUMERIC = ("cost_usd", "duration_s", "cell_duration_s", "num_turns", "diff_insertions", "diff_deletions", "diff_files",
           "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
COHORT = ("model", "effort", "task_base_sha", "task_prompt_digest", "runtime_digest", "mcp_tool_loading",
          "sandbox_dependency_content_digest", "oracle_digest", "max_budget_usd")
REQUEST_METRICS = ("messages_bytes", "tools_bytes", "system_bytes", "messages_count", "tools_count",
                   "duration_s", "proxy_estimated_cost_usd")


def _number(value: Any) -> bool:
    if type(value) not in (int, float) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def distribution(values: list[Any]) -> dict[str, Any]:
    measured = [v for v in values if _number(v)]
    return {
        "observed": len(measured), "missing": len(values) - len(measured),
        "sum_observed": sum(measured) if measured else None,
        "mean": statistics.mean(measured) if measured else None,
        "median": statistics.median(measured) if measured else None,
        "min": min(measured) if measured else None, "max": max(measured) if measured else None,
        "stdev": statistics.stdev(measured) if len(measured) > 1 else None,
    }


def provider_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Deduplicate identical callbacks, withhold totals on identity conflicts.

    Never join to cells by wall-clock proximity. Concurrent sweeps require a
    session ID mapping; serial experiments can use one exclusive ledger/cell.
    """
    seen: dict[tuple, dict] = {}
    unique, duplicates, conflicts, unidentified = [], 0, set(), 0
    for event in events:
        response_id = event.get("response_id")
        if not isinstance(response_id, str) or not response_id:
            unique.append(event)
            unidentified += 1
            continue
        key = (event.get("sweep_id"), event.get("provider"), response_id)
        if key in seen:
            if seen[key] == event:
                duplicates += 1
            else:
                conflicts.add(key)
            continue
        seen[key] = event
        unique.append(event)
    normalized = []
    invalid = 0
    for event in unique:
        try:
            normalized.append(asdict(normalize_usage(event.get("provider"), event.get("native_usage"))))
        except (UsageSemanticsError, TypeError, ValueError):
            invalid += 1
            normalized.append({})
    token_fields = NormalizedUsage.__dataclass_fields__
    token_totals = {
        field: sum(row[field] for row in normalized)
        if normalized and not conflicts and not unidentified and all(_number(row.get(field)) for row in normalized) else None
        for field in token_fields
    }
    metrics = [e.get("request_metrics") if not conflicts and isinstance(e.get("request_metrics"), dict) else {} for e in unique]
    return {
        "records": len(events), "observed_requests": len(unique), "duplicate_callbacks": duplicates,
        "conflicting_response_ids": len(conflicts), "requests_without_response_id": unidentified,
        "invalid_usage_records": invalid,
        "successes": sum(e.get("status") == "success" for e in unique),
        "failures": sum(e.get("status") == "failure" for e in unique),
        "requests_with_session_id": sum(isinstance(e.get("session_id"), str) and bool(e["session_id"]) for e in unique),
        "unique_actual_models": len({e["actual_model"] for e in unique if isinstance(e.get("actual_model"), str)}),
        "token_totals": token_totals,
        "request_metrics": {field: distribution([m.get(field) for m in metrics]) for field in REQUEST_METRICS},
        "identity_complete": bool(unique) and not conflicts and unidentified == 0,
        "attribution": "ledger_only_no_cell_join",
        "limitations": [
            "No response ID means callbacks cannot be deduplicated; observed totals may overcount.",
            "Proxy cost is an estimate, not an invoice. Failures without usage may still incur cost.",
            "Callback duration includes proxy/provider work; it is not isolated model thinking time.",
            "Request payload bytes are serialized sizes, not token counts.",
        ],
    }


def build_cost_report(rows: list[dict[str, Any]], provider_events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    groups: dict[tuple, list[dict]] = {}
    seen_cells = set()
    for row in rows:
        arm, task = row.get("arm"), row.get("task")
        if not isinstance(arm, str) or not isinstance(task, str):
            raise ValueError("each cell needs arm and task labels")
        identity_fields = {field: row.get(field) if isinstance(row.get(field), str) else "" for field in COHORT}
        if arm == "baseline_cli" and "mcp_tool_loading" in row and row["mcp_tool_loading"] is None:
            identity_fields["mcp_tool_loading"] = "not_applicable"
        if "max_budget_usd" in row:
            budget = row["max_budget_usd"]
            identity_fields["max_budget_usd"] = "uncapped" if budget is None else str(float(budget)) if _number(budget) and budget > 0 else ""
        cohort = tuple(identity_fields[field] for field in COHORT)
        identity = (arm, task, row.get("run"), cohort)
        if type(row.get("run")) is int:
            if identity in seen_cells:
                raise ValueError("duplicate cell identity; do not concatenate repeated exports")
            seen_cells.add(identity)
        groups.setdefault((arm, task, cohort), []).append(row)
    summaries = []
    tool_sections = []
    for (arm, task, cohort), cells in sorted(groups.items()):
        costs = [row.get("cost_usd") for row in cells]
        solved = sum(row.get("resolved") is True for row in cells)
        summaries.append({
            "diagnostic_group": len(summaries) + 1,
            "arm": arm, "task": task, "cells": len(cells), "solved": solved,
            "cohort": dict(zip(COHORT, cohort, strict=True)),
            "provenance_complete": all(cohort),
            "quality_missing": sum(type(row.get("resolved")) is not bool for row in cells),
            "failed_cells": sum(row.get("ok") is False for row in cells),
            "diagnostic_cells": sum(bool(public_diagnostics(row.get("session_diagnostics"))) for row in cells),
            "metrics": {field: distribution([row.get(field) for row in cells]) for field in NUMERIC},
            "cell_phases": {phase: distribution([
                row["cell_phase_seconds"].get(phase) if isinstance(row.get("cell_phase_seconds"), dict) else None
                for row in cells
            ]) for phase in CELL_PHASES},
            "cost_per_solved": sum(costs) / solved if solved and all(_number(c) for c in costs) else None,
        })
        details = render_diagnostics(cells)
        if details:
            tool_sections += [f"### Diagnostic group {len(summaries)}", *details]
    return {
        "schema": "gitnexus.cost-diagnostics/v1", "cells": len(rows), "groups": summaries,
        "provider": provider_summary(provider_events) if provider_events is not None else None,
        "tool_markdown": "\n".join(tool_sections),
        "limitations": [
            "Descriptive observations only; no causal attribution, significance claim or release verdict.",
            "Groups include failed cells and cost per solved includes their reported spend.",
            "Missing cells require comparison to the experiment manifest; this report cannot infer omitted rows.",
            "Legacy rows without diagnostics cannot reveal retrieval relevance, instruction overhead or tool timings.",
            "Main-loop session telemetry excludes subagent internals; session cost may include subagents.",
            "Task labels, model/effort, runtime/source pins and prompt digests must match the intended treatment.",
        ],
    }


def render_markdown(report: dict[str, Any]) -> str:
    """Render measured distributions and coverage, without guessing missing spend."""
    def number(value: Any) -> str:
        return f"{value:,.4f}".rstrip("0").rstrip(".") if _number(value) else "n/a"

    def label(value: Any) -> str:
        return html.escape(str(value)).replace("\n", " ").translate(
            {ord(char): f"&#{ord(char)};" for char in "\\`*_[]()|!"}
        )

    def table(metrics: dict[str, dict]) -> list[str]:
        lines = ["| Measurement | Observed / missing | Observed total | Mean | Median | Min | Max | Std. dev. |",
                 "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
        for name, values in metrics.items():
            lines.append(f"| {name} | {values['observed']} / {values['missing']} | " + " | ".join(
                number(values[field]) for field in ("sum_observed", "mean", "median", "min", "max", "stdev")
            ) + " |")
        return lines

    lines = ["## Time, cost, and tool measurements", "",
             f"Observed cells: {report['cells']}. Missing measurements are shown as `n/a`, not zero.",
             "Cell token counters come from the CLI. Provider tokens below use provider-specific accounting; do not add the two together.", ""]
    if report.get("input_problems"):
        lines += ["**Partial input: totals cover only the readable records.**", "",
                  *[f"- {problem}" for problem in report["input_problems"]], ""]
    for group in report["groups"]:
        lines += [f"### Group {group['diagnostic_group']}: <code>{label(group['arm'])}</code> / <code>{label(group['task'])}</code>", "",
                  (f"Solved: {group['solved']}/{group['cells']}; failed sessions: {group['failed_cells']}; "
                   f"quality unknown: {group['quality_missing']}; diagnostics: {group['diagnostic_cells']}/{group['cells']}."),
                  f"Cost per solved cell (USD, including failed-session spend): {number(group['cost_per_solved'])}.",
                  f"Complete cohort provenance: {'yes' if group['provenance_complete'] else 'no'}.", "",
                  "<details><summary>Measurements and cohort</summary>", "",
                  "| Cohort field | Value |", "| --- | --- |",
                  *[f"| {field} | <code>{label(value) if value else 'unknown'}</code> |"
                    for field, value in group["cohort"].items()], "",
                  *table(group["metrics"]), "", "Cell phases (seconds; agent_and_verification includes grading):", "",
                  *table(group["cell_phases"]), "", "</details>", ""]
    provider = report["provider"]
    lines += ["### Provider requests", ""]
    if provider is None:
        lines += ["Provider ledger unavailable. Request counts, provider tokens, and proxy cost are unknown.", ""]
    else:
        lines += [(f"Observed requests: {provider['observed_requests']}; successes: {provider['successes']}; "
                   f"failures: {provider['failures']}; duplicate callbacks removed: {provider['duplicate_callbacks']}."),
                  (f"Conflicting response identities: {provider['conflicting_response_ids']}; "
                   f"requests without identity: {provider['requests_without_response_id']}; "
                   f"invalid usage records: {provider['invalid_usage_records']}."),
                  "Attribution is to this sweep's ledger. Requests are not assigned to individual concurrent cells.", "",
                  "| Provider token field | Observed total |", "| --- | ---: |",
                  *[f"| {field} | {number(value)} |" for field, value in provider["token_totals"].items()], "",
                  *table(provider["request_metrics"]), "",
                  *provider["limitations"], ""]
    lines += [report["tool_markdown"], "", *report["limitations"], ""]
    return "\n".join(lines)


def _read_rows(path: Path, *, allow_incomplete: bool, name: str, problems: list[str]) -> list[dict]:
    if not path.is_file() and allow_incomplete:
        problems.append(f"{name} file is missing.")
        return []
    raw = path.read_text()
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        rows = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                if not allow_incomplete:
                    raise
                rows.append(None)
    else:
        rows = doc.get("per_run", [doc]) if isinstance(doc, dict) else doc
    if not isinstance(rows, list):
        raise ValueError(f"expected {name} rows")
    invalid = sum(not isinstance(row, dict) for row in rows)
    if invalid:
        if not allow_incomplete:
            raise ValueError(f"expected {name} rows")
        problems.append(f"{name}: {invalid} unreadable record(s).")
    return [row for row in rows if isinstance(row, dict)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True, help="runner results.jsonl or release report JSON")
    parser.add_argument("--provider-usage", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--markdown-out", type=Path)
    parser.add_argument("--allow-incomplete", action="store_true", help="report missing/torn inputs after an interrupted run")
    args = parser.parse_args()
    problems: list[str] = []
    rows = _read_rows(args.results, allow_incomplete=args.allow_incomplete, name="Results", problems=problems)
    provider = None
    provider_problems: list[str] = []
    if args.provider_usage:
        provider = _read_rows(args.provider_usage, allow_incomplete=args.allow_incomplete,
                              name="Provider ledger", problems=provider_problems)
        if provider_problems and not provider:
            provider = None
        problems += provider_problems
    report = build_cost_report(rows, provider)
    if report["provider"] is not None:
        report["provider"]["ledger_complete"] = not provider_problems
        if provider_problems:
            report["provider"]["identity_complete"] = False
            report["provider"]["token_totals"] = dict.fromkeys(report["provider"]["token_totals"])
    report["input_problems"] = problems
    with args.out.open("x") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write("\n")
    if args.markdown_out:
        with args.markdown_out.open("x") as handle:
            handle.write(render_markdown(report))


if __name__ == "__main__":
    main()
