"""Offline cost evidence report; no API calls, pricing guesses, or release gates."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .provider_usage import NormalizedUsage, UsageSemanticsError, normalize_usage
from .session_diagnostics import CELL_PHASES, public_diagnostics, render_diagnostics

NUMERIC = ("cost_usd", "duration_s", "cell_duration_s", "num_turns", "diff_insertions", "diff_deletions", "diff_files")
COHORT = ("model", "effort", "task_base_sha", "task_prompt_digest", "runtime_digest", "mcp_tool_loading",
          "sandbox_dependency_content_digest", "oracle_digest", "max_budget_usd")
REQUEST_METRICS = ("messages_bytes", "tools_bytes", "system_bytes", "messages_count", "tools_count",
                   "duration_s", "proxy_estimated_cost_usd")


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True, help="runner results.jsonl or release report JSON")
    parser.add_argument("--provider-usage", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    raw = args.results.read_text()
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    else:
        rows = doc.get("per_run", [doc]) if isinstance(doc, dict) else doc
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("expected result rows")
    provider = [json.loads(line) for line in args.provider_usage.read_text().splitlines() if line.strip()] if args.provider_usage else None
    report = build_cost_report(rows, provider)
    with args.out.open("x") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
