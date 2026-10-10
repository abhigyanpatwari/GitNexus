"""Reject per-task quality regressions between pinned RC and stable measurements.

The caller must resolve the candidate and published stable SHAs from trusted
release metadata. This command validates measurements; it does not establish
artifact provenance, select a release, or authorize publication by itself.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import re
from typing import Any

from .release_report import suite_binding, validate_report
from .task_assets import DEPENDENCY_CONTENT_BINDING_FIELD


def compare_reports(
    candidate: dict[str, Any],
    stable: dict[str, Any],
    *,
    candidate_sha: str,
    stable_sha: str,
    task_set_digest: str,
    task_pins: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    measured_at = now or datetime.now(UTC)
    result: dict[str, Any] = {
        "schema": "gitnexus.release-quality-gate/v1",
        "generated_at": measured_at.isoformat(),
        "candidate_sha": candidate_sha,
        "stable_sha": stable_sha,
        "passed": False,
        "problems": [],
        "tasks": {},
        "measurements": {},
    }
    for label, report, sha in (("candidate", candidate, candidate_sha), ("stable", stable, stable_sha)):
        try:
            validate_report(
                report, runtime_sha=sha, task_set_digest=task_set_digest, task_pins=task_pins, now=measured_at
            )
        except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
            # Do not echo untrusted report values or filesystem details into
            # the public artifact. Full measurements remain in their reports.
            result["problems"].append(f"{label}: invalid, incomplete, stale, or mismatched evidence/pins")
    if result["problems"]:
        return result

    for field in ("harness_sha", "task_set_digest", "tasks", "model", "effort", "runs"):
        if candidate[field] != stable[field]:
            result["problems"].append(f"candidate and stable use different {field}")
    # Every cell of a task, on both sides, must be graded against the same
    # staged dependency bytes (toolchain, test runner, shared build).
    for task in task_pins:
        dependencies = {
            digest if isinstance(digest := row.get(DEPENDENCY_CONTENT_BINDING_FIELD), str) else None
            for report in (candidate, stable)
            for row in report["per_run"]
            if row["task"] == task
        }
        if len(dependencies) != 1 or not re.fullmatch(r"[0-9a-f]{64}", next(iter(dependencies)) or ""):
            result["problems"].append(
                f"{task}: candidate and stable were not graded against identical task dependencies"
            )
    if result["problems"]:
        return result

    # Preserve both no-MCP comparisons and measured costs without turning a
    # small stochastic benchmark into a claim of statistical non-inferiority.
    result["measurements"] = {
        label: {"arms": report["arms"], "vs_no_gitnexus": report["paired"]}
        for label, report in (("candidate", candidate), ("stable", stable))
    }
    result.update(
        harness_sha=candidate["harness_sha"],
        task_set_digest=task_set_digest,
        model=candidate["model"],
        effort=candidate["effort"],
        runs=candidate["runs"],
    )
    for task in task_pins:
        counts = {
            label: sum(row["resolved"] for row in report["per_run"] if row["task"] == task and row["arm"] == "baseline")
            for label, report in (("candidate", candidate), ("stable", stable))
        }
        delta = counts["candidate"] - counts["stable"]
        result["tasks"][task] = {**counts, "solve_delta": delta}
        if delta < 0:
            result["problems"].append(
                f"{task}: RC solved {counts['candidate']}/{candidate['runs']}; stable solved {counts['stable']}/{stable['runs']}"
            )
    result["passed"] = not result["problems"]
    return result


def render_markdown(result: dict[str, Any]) -> str:
    lines = [
        "## RC quality comparison",
        "",
        f"Candidate `{result['candidate_sha']}`; stable `{result['stable_sha']}`.",
        f"**{'PASS' if result['passed'] else 'FAIL'}** — no task may lose solved repetitions versus stable.",
        "",
    ]
    if result["tasks"]:
        lines += ["| Task | RC solved | Stable solved | Delta |", "| --- | --- | --- | --- |"]
        for task, values in result["tasks"].items():
            lines.append(f"| {task} | {values['candidate']} | {values['stable']} | {values['solve_delta']:+d} |")
    lines += ["", *[f"- {problem}" for problem in result["problems"]], ""]
    if result["measurements"]:
        lines += [
            "| Runtime | Solved vs no-GitNexus | Mean MCP cost | Mean MCP duration |",
            "| --- | --- | --- | --- |",
        ]
        for label, values in result["measurements"].items():
            mcp = values["arms"]["baseline"]
            delta = values["vs_no_gitnexus"]["solve_delta"]
            lines.append(f"| {label} | {delta:+d} | ${mcp['mean_cost_usd']:.4f} | {mcp['mean_wall_s']:.1f}s |")
    lines += [
        "",
        "The no-GitNexus comparison, cost and duration are descriptive; they are not additional pass criteria.",
        "This conservative per-task rule measures observed outcomes, not statistical significance or all workloads.",
        "The publishing workflow must separately verify provenance and bind this decision to its exact candidate.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--stable", required=True, type=Path)
    parser.add_argument("--stable-sha", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    _, digest, pins = suite_binding()
    reports = []
    for path in (args.candidate, args.stable):
        try:
            reports.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            reports.append({})
    result = compare_reports(
        *reports,
        candidate_sha=args.candidate_sha,
        stable_sha=args.stable_sha,
        task_set_digest=digest,
        task_pins=pins,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "release-quality-gate.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    (args.out / "release-quality-gate.md").write_text(render_markdown(result))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
