"""Paired report for DeepSWE pier jobs: baseline vs GitNexus.

Reads the `result.json` pier writes under `<job>/<trial>/`. Trials pair on the
task id (the gitnexus arm's `-gitnexus` suffix removed) and attempt order.
Deltas use only pairs graded in both arms with the metric measured in both;
missing, duplicated, ungraded or unbilled trials are listed as problems.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from .prepare import GITNEXUS_TASK_SUFFIX

ARMS = ("baseline", "gitnexus")
METRICS = ("cost_usd", "n_input_tokens", "n_cache_tokens", "n_output_tokens", "n_agent_steps", "agent_seconds")
# Command position only, so `ls gitnexus/` or a path argument does not count.
_CLI_COMMAND = re.compile(r"(?:^|[;&|(`\n]\s*|\$\(\s*)gitnexus\s+([a-z][a-z_-]*)")


def _measured(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def task_id(task_name: str) -> str:
    name = task_name.rsplit("/", 1)[-1]
    return name.removesuffix(GITNEXUS_TASK_SUFFIX)


def _seconds(timing: dict[str, Any] | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    start, end = (datetime.fromisoformat(str(timing[key]).replace("Z", "+00:00")) for key in ("started_at", "finished_at"))
    return (end - start).total_seconds()


def gitnexus_commands(trial_dir: Path) -> Counter:
    """`gitnexus <command>` calls in the trial's ATIF trajectory tool calls."""

    counts: Counter = Counter()
    path = trial_dir / "agent" / "trajectory.json"
    if not path.is_file():
        return counts
    try:
        steps = json.loads(path.read_text(encoding="utf-8", errors="replace")).get("steps") or []
    except ValueError:
        return counts
    for step in steps:
        for call in step.get("tool_calls") or []:
            for value in (call.get("arguments") or {}).values():
                if isinstance(value, str):
                    counts.update(match.group(1) for match in _CLI_COMMAND.finditer(value))
    return counts


def load_trial(trial_dir: Path) -> dict[str, Any] | None:
    path = trial_dir / "result.json"
    if not path.is_file():
        return None
    result = json.loads(path.read_text(encoding="utf-8"))
    agent = result.get("agent_result") or {}
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward")
    graded = result.get("exception_info") is None and reward in (0, 1)
    row = {
        "task": task_id(str(result.get("task_name", trial_dir.name))),
        "trial": result.get("trial_name") or trial_dir.name,
        "started_at": result.get("started_at") or "",
        "graded": graded,
        "resolved": graded and reward == 1,
        "error": (result.get("exception_info") or {}).get("exception_type"),
        "agent_seconds": _seconds(result.get("agent_execution")),
        "gitnexus_commands": dict(gitnexus_commands(trial_dir)),
    }
    for metric in METRICS[:-1]:
        row[metric] = agent.get(metric)
    return row


def load_job(job_dir: Path) -> list[dict[str, Any]]:
    if not job_dir.is_dir():
        return []
    trials = [load_trial(path) for path in sorted(job_dir.iterdir()) if path.is_dir()]
    return [trial for trial in trials if trial is not None]


def _keyed(trials: list[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trial in trials:
        by_task[trial["task"]].append(trial)
    keyed = {}
    for task, rows in by_task.items():
        for attempt, row in enumerate(sorted(rows, key=lambda r: (r["started_at"], r["trial"]))):
            keyed[(task, attempt)] = row
    return keyed


def build_report(jobs: dict[str, Path]) -> dict[str, Any]:
    report: dict[str, Any] = {"schema": "gitnexus.deepswe-comparison/v1", "arms": {}, "changes": {}, "problems": []}
    keyed: dict[str, dict[tuple[str, int], dict[str, Any]]] = {}
    for arm in ARMS:
        trials = load_job(jobs[arm])
        if not trials:
            report["problems"].append(f"{arm}: no trial results under {jobs[arm]}")
        keyed[arm] = _keyed(trials)
        graded = [row for row in trials if row["graded"]]
        ungraded = [row for row in trials if not row["graded"]]
        if ungraded:
            kinds = Counter(row["error"] or "no reward" for row in ungraded)
            report["problems"].append(f"{arm}: {len(ungraded)} of {len(trials)} trial(s) ungraded ({dict(kinds)})")
        summary: dict[str, Any] = {"trials": len(trials), "graded": len(graded),
                                   "resolved": sum(row["resolved"] for row in graded), "incomplete_metrics": []}
        for metric in METRICS:
            values = [row[metric] for row in graded if _measured(row.get(metric))]
            if graded and len(values) == len(graded):
                summary[f"mean_{metric}"] = statistics.mean(values)
            else:
                summary[f"mean_{metric}"] = None
                if graded:
                    summary["incomplete_metrics"].append(metric)
                    report["problems"].append(
                        f"{arm}: {metric} missing on {len(graded) - len(values)} of {len(graded)} graded trial(s)"
                    )
        if arm == "gitnexus":
            per_trial = [Counter(row["gitnexus_commands"]) for row in graded]
            summary["trials_using_gitnexus"] = sum(1 for counts in per_trial if counts)
            summary["mean_gitnexus_calls"] = statistics.mean(sum(c.values()) for c in per_trial) if per_trial else None
            summary["gitnexus_commands"] = dict(sum(per_trial, Counter()).most_common())
        report["arms"][arm] = summary

    expected = set(keyed["baseline"]) | set(keyed["gitnexus"])
    shared = sorted(key for key in expected if all(key in keyed[arm] and keyed[arm][key]["graded"] for arm in ARMS))
    if len(shared) < len(expected):
        report["problems"].append(
            f"{len(shared)} of {len(expected)} task/attempt pair(s) graded in both arms; deltas use those only"
        )
    report["pairs"] = {"graded_in_both": len(shared), "expected": len(expected)}
    if shared:
        report["paired_resolved"] = {arm: sum(keyed[arm][key]["resolved"] for key in shared) for arm in ARMS}
    for metric in METRICS:
        matched = [key for key in shared if all(_measured(keyed[arm][key].get(metric)) for arm in ARMS)]
        if not matched:
            continue
        base = statistics.mean(keyed["baseline"][key][metric] for key in matched)
        value = statistics.mean(keyed["gitnexus"][key][metric] for key in matched)
        if base:
            report["changes"][metric] = {"percent": 100 * (value - base) / base, "pairs": len(matched),
                                         "expected_pairs": len(expected)}
    report["per_task"] = {
        f"{task}#{attempt}": {arm: _cell(keyed[arm].get((task, attempt))) for arm in ARMS}
        for task, attempt in sorted(expected)
    }
    return report


def _cell(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row.get(key) for key in ("graded", "resolved", "cost_usd", "n_agent_steps", "error")}


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "## DeepSWE: baseline vs GitNexus (descriptive)",
        "",
        "| Arm | Resolved / graded | Mean cost | Mean input tokens | Mean steps | Mean agent time | GitNexus calls/trial |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for arm, values in report["arms"].items():

        def show(metric: str, pattern: str) -> str:
            if metric.removeprefix("mean_") in values.get("incomplete_metrics", ()):
                return "incomplete"
            value = values.get(metric)
            return "-" if value is None else pattern.format(value)

        lines.append(
            f"| {arm} | {values['resolved']}/{values['graded']} | {show('mean_cost_usd', '${:.3f}')} "
            f"| {show('mean_n_input_tokens', '{:,.0f}')} | {show('mean_n_agent_steps', '{:.1f}')} "
            f"| {show('mean_agent_seconds', '{:.0f}s')} | {show('mean_gitnexus_calls', '{:.1f}')} |"
        )
    pairs = report["pairs"]
    if "paired_resolved" in report:
        resolved = report["paired_resolved"]
        lines += ["", f"Paired ({pairs['graded_in_both']}/{pairs['expected']} task/attempt pairs): "
                  f"baseline resolved {resolved['baseline']}, gitnexus resolved {resolved['gitnexus']}."]
    if report["changes"]:
        lines.append("")
        for metric, change in report["changes"].items():
            sample = f"{change['pairs']}/{change['expected_pairs']} pairs"
            if change["pairs"] < change["expected_pairs"]:
                sample += ", partial"
            lines.append(f"- gitnexus vs baseline: {metric}: {change['percent']:+.1f}% ({sample})")
    gitnexus = report["arms"].get("gitnexus")
    if gitnexus and gitnexus.get("graded"):
        lines += ["", f"GitNexus usage: {gitnexus['trials_using_gitnexus']}/{gitnexus['graded']} graded trials; "
                  f"commands {gitnexus['gitnexus_commands']}."]
    if report["problems"]:
        lines += ["", "**Problems:**", *[f"- {problem}" for problem in report["problems"]]]
    lines += ["", "Descriptive evidence on a sampled subset, not statistical significance.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", required=True, type=Path, help="pier job directory of the baseline arm")
    parser.add_argument("--gitnexus", required=True, type=Path, help="pier job directory of the gitnexus arm")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    report = build_report({"baseline": args.baseline, "gitnexus": args.gitnexus})
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "deepswe-comparison.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (args.out / "deepswe-comparison.md").write_text(render_markdown(report))
    print(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
