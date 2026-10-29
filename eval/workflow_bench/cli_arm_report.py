"""Descriptive comparison of the opt-in baseline_cli arm with the paired release arms.

The release gate stays bound to `baseline_nomcp` and `baseline`; this report never
feeds it. It answers one question: how much of the MCP arm's cost remains when the
same tools are reached through a shell command instead of a tool catalog.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

ARMS = ("baseline_nomcp", "baseline", "baseline_cli")
EXPOSURE = {"baseline_nomcp": "none", "baseline": "stdio-only", "baseline_cli": "stdio-only"}
METRICS = ("cost_usd", "duration_s", "num_turns", "cache_read_input_tokens", "output_tokens")
# Command position only: `npm --prefix gitnexus test` names this repo's package, not the CLI.
_CLI_COMMAND = re.compile(r"(?:^|[;&|(`\n]\s*|\$\(\s*)gitnexus\s+([a-z_-]+)")


def _rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _trustworthy(row: dict[str, Any]) -> bool:
    return (
        row.get("ok") is True
        and row.get("sandbox_backend") == "bwrap"
        and row.get("runtime_exposure") == EXPOSURE.get(row.get("arm"))
        and row.get("error_kind") in (None, "verify-failed", "oracle-failed")
        and type(row.get("resolved")) is bool
        and row.get("transcript_missing") is False
    )


def cli_commands(row: dict[str, Any], results_dir: Path) -> Counter:
    """Count `gitnexus <command>` invocations in a cell's Bash tool calls."""

    counts: Counter = Counter()
    for name in row.get("transcript_artifacts", []):
        path = results_dir / name
        if not path.is_file():
            continue
        for line in path.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            content = (event.get("message") or {}).get("content")
            if event.get("type") != "assistant" or not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and part.get("type") == "tool_use" and part.get("name") == "Bash":
                    command = str((part.get("input") or {}).get("command", ""))
                    counts.update(match.group(1) for match in _CLI_COMMAND.finditer(command))
    return counts


def _measured(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def build_report(paired: Path, cli: Path) -> dict[str, Any]:
    rows = [(row, paired.parent) for row in _rows(paired) if row.get("arm") in ("baseline_nomcp", "baseline")]
    rows += [(row, cli.parent) for row in _rows(cli) if row.get("arm") == "baseline_cli"]
    report: dict[str, Any] = {"schema": "gitnexus.cli-arm-comparison/v1", "arms": {}, "problems": []}
    # Deltas compare the same (task, run) pairs; per-arm means alone hide interrupted sweeps.
    expected: dict[str, set[tuple[Any, Any]]] = {}
    trusted: dict[str, dict[tuple[Any, Any], dict[str, Any]]] = {}
    for arm in ARMS:
        cells = [(row, where) for row, where in rows if row["arm"] == arm]
        valid = [(row, where) for row, where in cells if _trustworthy(row)]
        pairs = Counter((row.get("task"), row.get("run")) for row, _ in cells)
        duplicates = sorted((pair for pair, count in pairs.items() if count > 1), key=str)
        if duplicates:
            report["problems"].append(f"{arm}: duplicate task/run pair(s) {duplicates}; excluded from deltas")
        expected[arm] = set(pairs)
        trusted[arm] = {
            (row.get("task"), row.get("run")): row
            for row, _ in valid
            if pairs[(row.get("task"), row.get("run"))] == 1
        }
        if len(valid) != len(cells):
            report["problems"].append(f"{arm}: {len(cells) - len(valid)} of {len(cells)} cell(s) untrustworthy")
        if not valid:
            report["problems"].append(f"{arm}: no trustworthy cells")
            continue
        summary: dict[str, Any] = {"cells": len(valid), "solved": sum(row["resolved"] for row, _ in valid)}
        summary["incomplete_metrics"] = []
        for metric in METRICS:
            values = [row[metric] for row, _ in valid if _measured(row.get(metric))]
            if len(values) == len(valid):
                summary[f"mean_{metric}"] = statistics.mean(values)
                continue
            # A mean over the measured subset would read as the arm's mean; leave it unknown.
            summary[f"mean_{metric}"] = None
            summary["incomplete_metrics"].append(metric)
            report["problems"].append(f"{arm}: {metric} missing on {len(valid) - len(values)} of {len(valid)} cell(s)")
        if arm == "baseline_cli":
            per_cell = [cli_commands(row, where) for row, where in valid]
            summary["mean_gitnexus_calls"] = statistics.mean(sum(c.values()) for c in per_cell)
            summary["cells_using_gitnexus"] = sum(1 for c in per_cell if c)
            summary["gitnexus_commands"] = dict(sum(per_cell, Counter()).most_common())
        else:
            summary["mean_gitnexus_calls"] = statistics.mean(row.get("gitnexus_tool_uses", 0) for row, _ in valid)
        report["arms"][arm] = summary
    report["changes"] = {}
    for reference in ("baseline_nomcp", "baseline"):
        for arm in ARMS:
            if arm == reference or arm not in report["arms"] or reference not in report["arms"]:
                continue
            pairs = expected[arm] | expected[reference]
            shared = [pair for pair in pairs if pair in trusted[arm] and pair in trusted[reference]]
            if len(shared) < len(pairs):
                report["problems"].append(
                    f"{arm} vs {reference}: {len(shared)} of {len(pairs)} task/run pair(s) matched; "
                    + "deltas use matched pairs only"
                )
            for metric in ("cost_usd", "duration_s", "cache_read_input_tokens", "num_turns"):
                matched = [
                    pair
                    for pair in shared
                    if _measured(trusted[arm][pair].get(metric)) and _measured(trusted[reference][pair].get(metric))
                ]
                if not matched:
                    continue
                b = statistics.mean(trusted[reference][pair][metric] for pair in matched)
                v = statistics.mean(trusted[arm][pair][metric] for pair in matched)
                if b:
                    report["changes"][f"{arm} vs {reference}: {metric}"] = {
                        "percent": 100 * (v - b) / b,
                        "pairs": len(matched),
                        "expected_pairs": len(pairs),
                    }
    return report


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "## CLI-only arm (descriptive)",
        "",
        "`baseline_cli` reaches the same read-only GitNexus tools as `baseline` through a `gitnexus` shell "
        + "command, so no tool catalog enters the model context. It is not part of the release gate.",
        "",
        "| Arm | Solved | Mean cost | Mean wall | Mean turns | Mean cache-read tokens | GitNexus calls/cell |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for arm, values in report["arms"].items():

        def show(metric: str, pattern: str) -> str:
            value = values.get(metric)
            if metric.removeprefix("mean_") in values.get("incomplete_metrics", ()):
                return "incomplete"
            return "-" if value is None else pattern.format(value)

        lines.append(
            f"| {arm} | {values['solved']}/{values['cells']} | {show('mean_cost_usd', '${:.4f}')} "
            f"| {show('mean_duration_s', '{:.1f}s')} | {show('mean_num_turns', '{:.1f}')} "
            f"| {show('mean_cache_read_input_tokens', '{:,.0f}')} | {show('mean_gitnexus_calls', '{:.1f}')} |"
        )
    if report["changes"]:
        lines.append("")
        for name, change in report["changes"].items():
            sample = f"{change['pairs']}/{change['expected_pairs']} pairs"
            if change["pairs"] < change["expected_pairs"]:
                sample += ", partial"
            lines.append(f"- {name}: {change['percent']:+.1f}% ({sample})")
    cli = report["arms"].get("baseline_cli")
    if cli:
        lines += ["", f"CLI usage: {cli['cells_using_gitnexus']}/{cli['cells']} cells; commands {cli['gitnexus_commands']}."]
    if report["problems"]:
        lines += ["", "**Problems:**", *[f"- {problem}" for problem in report["problems"]]]
    lines += ["", "Small pinned task set; descriptive evidence only, not statistical significance.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paired", required=True, type=Path, help="results.jsonl with baseline_nomcp and baseline")
    parser.add_argument("--cli", required=True, type=Path, help="results.jsonl with baseline_cli")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    report = build_report(args.paired, args.cli)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "cli-arm-comparison.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (args.out / "cli-arm-comparison.md").write_text(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
