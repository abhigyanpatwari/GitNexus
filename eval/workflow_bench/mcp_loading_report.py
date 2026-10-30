"""Matched no-MCP/eager/deferred experiment; never release approval evidence."""

from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path
from typing import Any

from .release_report import META_FIELDS, build_report
from .session_diagnostics import render_diagnostics

COUNTERS = ("num_turns", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
BINDINGS = ("task_prompt_digest", "sandbox_dependency_content_digest")


def compare_loading(eager: list[Any], deferred: list[Any], metadata: dict[str, Any]) -> dict[str, Any]:
    """Reuse release cell validation, then require the same task/run and assets."""
    control = build_report(eager, metadata)
    no_mcp = [row for row in eager if isinstance(row, dict) and row.get("arm") == "baseline_nomcp"]
    # Do not filter the experimental input: an unexpected arm or duplicate must
    # invalidate the comparison, not silently disappear from its denominator.
    experiment = build_report([*no_mcp, *deferred], metadata)
    problems = [f"eager: {p}" for p in control["problems"]]
    problems += [f"deferred: {p}" for p in experiment["problems"]]
    report = {key: metadata[key] for key in META_FIELDS}
    report.update(
        schema="gitnexus.mcp-tool-loading/v1",
        generated_at=control["generated_at"],
        complete=False, problems=problems, arms={}, paired={}, per_run=[],
    )
    groups: dict[str, list[dict[str, Any]]] = {"none": no_mcp, "eager": [], "deferred": []}
    for label, rows, public_rows in (
        ("eager", eager, control["per_run"]),
        ("deferred", deferred, experiment["per_run"][len(no_mcp):]),
    ):
        dictionaries = [row for row in rows if isinstance(row, dict)]
        for row, public in zip(dictionaries, public_rows, strict=True):
            expected_mode = "none" if label == "eager" and row.get("arm") == "baseline_nomcp" else label
            actual_mode = row.get("mcp_tool_loading")
            public = dict(public, mcp_tool_loading=actual_mode if actual_mode in ("none", "eager", "deferred") else None)
            for field in (*BINDINGS, "sanitized_task_sha", "sanitized_graph_snapshot_digest", "runtime_sha", "harness_sha"):
                value = row.get(field)
                if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
                    public[field] = value
            report["per_run"].append(public)
            if row.get("mcp_tool_loading") != expected_mode:
                problems.append(f"{label}: missing or incorrect host loading receipt")
            for field in ("runtime_sha", "harness_sha"):
                if row.get(field) != metadata[field]:
                    problems.append(f"{label}: mismatched {field}")
            for field in COUNTERS:
                value = row.get(field)
                if type(value) is not int or value < 0:
                    problems.append(f"{label}: invalid {field}")
                else:
                    public[field] = value
            if expected_mode != "none":
                groups[label].append(row)
    if problems:
        return report
    cells = {mode: {(row["task"], row["run"]): row for row in rows} for mode, rows in groups.items()}
    for key, row in cells["eager"].items():
        for field in (*BINDINGS, "sanitized_task_sha"):
            value = row.get(field)
            pattern = r"[0-9a-f]{40}" if field == "sanitized_task_sha" else r"[0-9a-f]{64}"
            if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
                problems.append(f"{key}: missing {field}")
            elif any(cells[mode][key].get(field) != value for mode in groups):
                problems.append(f"{key}: mismatched {field}")
        # Each sweep builds a fresh graph from the same sanitized commit with
        # the same pinned runtime. Database bytes/timestamps need not match.
        for mode in ("eager", "deferred"):
            digest = cells[mode][key].get("sanitized_graph_snapshot_digest")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                problems.append(f"{key}/{mode}: missing graph receipt")
    if problems:
        return report
    report["complete"] = True
    for mode, rows in groups.items():
        report["arms"][mode] = {
            "cells": len(rows), "solved": sum(row["resolved"] for row in rows),
            **{f"mean_{field}": statistics.mean(row[field] for row in rows)
               for field in ("cost_usd", "duration_s", *COUNTERS)},
        }
    for mode in ("none", "eager"):
        baseline = report["arms"][mode]
        treatment = report["arms"]["deferred"]
        report["paired"][f"deferred_vs_{mode}"] = {
            "solve_delta": treatment["solved"] - baseline["solved"],
            "mean_cost_change_pct": (
                100 * (treatment["mean_cost_usd"] / baseline["mean_cost_usd"] - 1)
                if baseline["mean_cost_usd"] else None
            ),
        }
    return report


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "## MCP tool-loading experiment", "",
        f"Runtime `{report['runtime_sha']}`; harness `{report['harness_sha']}`.",
        f"Model `{report['model']}`, effort `{report['effort']}`, n={report['runs']} per task and mode.",
        "Hooks disabled; prompts, MCP backend and outputs unchanged. Descriptive evidence only; no release approval.",
        "",
    ]
    for mode in ("none", "eager", "deferred"):
        details = render_diagnostics([row for row in report.get("per_run", []) if row.get("mcp_tool_loading") == mode])
        if details:
            lines += [f"### Diagnostics: {mode}", *details, ""]
    if not report["complete"]:
        return "\n".join([*lines, "**Incomplete or mismatched evidence; no savings estimate.**", "",
                          *[f"- {p}" for p in report["problems"]], ""])
    lines += [
        "| Mode | Solved | Mean cost | Mean seconds | Mean turns | Mean cache-read tokens | Mean output tokens |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for mode, arm in report["arms"].items():
        lines.append(
            f"| {mode} | {arm['solved']}/{arm['cells']} | ${arm['mean_cost_usd']:.4f} | "
            f"{arm['mean_duration_s']:.1f} | {arm['mean_num_turns']:.1f} | "
            f"{arm['mean_cache_read_input_tokens']:.0f} | {arm['mean_output_tokens']:.0f} |"
        )
    for label, pair in report["paired"].items():
        change = pair["mean_cost_change_pct"]
        cost = f"{change:+.1f}%" if change is not None else "undefined (zero control cost)"
        lines += ["", f"{label}: cost {cost}; solved delta {pair['solve_delta']:+d}."]
    lines += ["", "All completed repairs, including failed solutions, remain in the denominator. "
              + "Three repetitions per task are descriptive, not a significance claim.", ""]
    return "\n".join(lines)


def read_rows(path: Path) -> list[Any]:
    rows = []
    for line in path.read_text().splitlines() if path.is_file() else []:
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append(None)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eager", required=True, type=Path)
    parser.add_argument("--deferred", required=True, type=Path)
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = compare_loading(read_rows(args.eager), read_rows(args.deferred), json.loads(args.metadata.read_text()))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "mcp-tool-loading.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    (args.out / "mcp-tool-loading.md").write_text(render_markdown(report))
    if not report["complete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
