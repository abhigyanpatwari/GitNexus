"""Pinned, paired release measurements using the existing workflow benchmark."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .oracle_assets import capture_task_oracles
from .runner_tasks import normalized_model_identifier, select_tasks
from .task_assets import DEPENDENCY_CONTENT_BINDING_FIELD

SCHEMA = "gitnexus.release-evaluation/v1"
ARMS = ("baseline_nomcp", "baseline")
TASKS = Path(__file__).with_name("tasks.scenarios.yaml")
META_FIELDS = ("runtime_sha", "harness_sha", "task_set_digest", "model", "effort", "runs", "tasks")
ROW_FIELDS = (
    "task",
    "run",
    "arm",
    "model",
    "effort",
    "task_base_sha",
    "oracle_digest",
    "sandbox_backend",
    DEPENDENCY_CONTENT_BINDING_FIELD,
    "ok",
    "resolved",
    "authored_tests_passed",
    "oracle_passed",
    "error_kind",
    "transcript_missing",
    "cost_usd",
    "duration_s",
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)


def suite_binding(path: Path = TASKS) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
    tasks, _ = select_tasks(yaml.safe_load(path.read_text())["tasks"], include_expensive=True)
    snapshots = capture_task_oracles(tasks)
    definitions = []
    pins = {}
    for task, oracle in zip(tasks, snapshots, strict=True):
        if not re.fullmatch(r"[0-9a-f]{40}", task.get("ref", "")):
            raise ValueError(f"release task {task['id']} must pin a full commit SHA")
        definitions.append({**{k: v for k, v in task.items() if k != "repo"}, "oracle_digest": oracle.digest})
        pins[task["id"]] = {"sha": task["ref"], "oracle_digest": oracle.digest}
    digest = hashlib.sha256(json.dumps(definitions, sort_keys=True).encode()).hexdigest()
    return tasks, digest, pins


def pinned_task_sha(tasks: list[dict[str, Any]]) -> str:
    """The one task commit whose built checkout supplies every task's dependencies."""
    refs = {task["ref"] for task in tasks}
    if len(refs) != 1:
        raise ValueError("release tasks must share one pinned commit so both runtimes grade one dependency checkout")
    return refs.pop()


def _finite_nonnegative(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # JSON integers can exceed float range.
        return False


def _json_safe(value: Any) -> Any:
    """Replace non-finite floats at any depth so failure receipts still serialize."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def build_report(rows: list[Any], metadata: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    report = {key: metadata[key] for key in META_FIELDS}
    report.update(schema=SCHEMA, generated_at=(now or datetime.now(UTC)).isoformat())
    runs, tasks = report["runs"], report["tasks"]
    if type(runs) is not int or runs < 3 or not tasks:
        raise ValueError("release evaluation requires tasks and at least three runs per arm")
    normalized_model_identifier(report["model"])
    for field in ("runtime_sha", "harness_sha"):
        if not re.fullmatch(r"[0-9a-f]{40}", report[field]):
            raise ValueError(f"invalid {field}")
    problems = []
    measured = {}
    safe_rows = []
    expected = {(task, run, arm) for task in tasks for run in range(runs) for arm in ARMS}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            problems.append(f"row {index}: invalid measurement")
            continue
        # Invalid rows still need a public, JSON-serializable failure receipt.
        safe_rows.append({key: _json_safe(row[key]) for key in ROW_FIELDS if key in row})
        task, run, arm = row.get("task"), row.get("run"), row.get("arm")
        if not isinstance(task, str) or type(run) is not int or not isinstance(arm, str):
            problems.append(f"row {index}: invalid cell identity")
            continue
        key = task, run, arm
        if key not in expected or key in measured:
            problems.append(f"row {index}: unexpected or duplicate cell")
            continue
        measured[key] = row
        pin = tasks[task]
        valid = (
            row.get("task_base_sha") == pin["sha"]
            and row.get("oracle_digest") == pin["oracle_digest"]
            and row.get("model") == report["model"]
            and row.get("effort") == report["effort"]
            and row.get("sandbox_backend") == "bwrap"
            and row.get("ok") is True
            and type(row.get("resolved")) is bool
            and type(row.get("authored_tests_passed")) is bool
            and type(row.get("oracle_passed")) is bool
            and row["resolved"] == (row["authored_tests_passed"] and row["oracle_passed"])
            and row.get("error_kind") in (None, "verify-failed", "oracle-failed")
            and row.get("transcript_missing") is False
            and _finite_nonnegative(row.get("cost_usd"))
            and _finite_nonnegative(row.get("duration_s"))
            and isinstance(row.get(DEPENDENCY_CONTENT_BINDING_FIELD), str)
            and re.fullmatch(r"[0-9a-f]{64}", row[DEPENDENCY_CONTENT_BINDING_FIELD]) is not None
        )
        if not valid:
            problems.append(f"{task}/{arm}/{run}: untrustworthy measurement")
    if expected != set(measured):
        problems.append(f"missing {len(expected - set(measured))} paired cell(s)")
    report.update(complete=not problems, problems=problems, per_run=safe_rows, arms={}, paired={})
    if problems:
        return report
    for arm in ARMS:
        arm_rows = [measured[task, run, arm] for task in tasks for run in range(runs)]
        report["arms"][arm] = {
            "cells": len(arm_rows),
            "solved": sum(row["resolved"] for row in arm_rows),
            "mean_cost_usd": statistics.mean(row["cost_usd"] for row in arm_rows),
            "mean_wall_s": statistics.mean(row["duration_s"] for row in arm_rows),
        }
    baseline, tool = (report["arms"][arm] for arm in ARMS)
    report["paired"] = {"solve_delta": tool["solved"] - baseline["solved"]}
    for metric, label in (("mean_cost_usd", "cost"), ("mean_wall_s", "wall")):
        report["paired"][f"mean_{label}_change_pct"] = (
            100 * (tool[metric] - baseline[metric]) / baseline[metric] if baseline[metric] else None
        )
    return report


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "## Agent evaluation",
        "",
        f"Runtime `{report['runtime_sha']}`; harness `{report['harness_sha']}`.",
        f"Model `{report['model']}`, effort `{report['effort']}`, n={report['runs']} per task per arm.",
        "No-GitNexus `baseline_nomcp` is compared with MCP `baseline`; neither uses workflow skills.",
        "",
    ]
    if not report["complete"]:
        lines += ["**Incomplete evidence; release validation failed.**", "", *[f"- {p}" for p in report["problems"]]]
    else:
        lines += [
            "| Arm | Hidden tests + authored checks | Mean cost | Mean agent wall time |",
            "| --- | --- | --- | --- |",
        ]
        for arm, values in report["arms"].items():
            lines.append(
                f"| {arm} | {values['solved']}/{values['cells']} | ${values['mean_cost_usd']:.4f} | {values['mean_wall_s']:.1f}s |"
            )
        paired = report["paired"]
        lines += ["", f"Paired solve delta: {paired['solve_delta']:+d}."]
        for metric in ("cost", "wall"):
            value = paired[f"mean_{metric}_change_pct"]
            lines.append(
                f"Mean {metric} change vs no GitNexus: {'unavailable (zero baseline)' if value is None else f'{value:+.1f}%'}."
            )
    lines += [
        "",
        "Negative agent outcomes remain in the denominator. Indexing and grading are excluded from agent cost/time.",
        "The MCP arm also has readable compiled runtime code; this comparison includes that access and cannot isolate tool assistance from access to later fixes.",
        "This small pinned task set is release evidence; it does not establish general gains or statistical significance.",
        "",
    ]
    return "\n".join(lines)


def validate_report(
    report: dict[str, Any],
    *,
    runtime_sha: str,
    task_set_digest: str,
    task_pins: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> None:
    if report.get("schema") != SCHEMA or report.get("complete") is not True:
        raise ValueError("incomplete or unsupported release evidence")
    if report.get("runtime_sha") != runtime_sha or report.get("task_set_digest") != task_set_digest:
        raise ValueError("release evidence belongs to a different runtime or task set")
    if task_pins is not None and report.get("tasks") != task_pins:
        raise ValueError("release task pins do not match the measured task set")
    measured_at = datetime.fromisoformat(report["generated_at"])
    if measured_at.tzinfo is None or not timedelta(0) <= (now or datetime.now(UTC)) - measured_at <= timedelta(days=7):
        raise ValueError("release evidence must be at most seven days old and not future-dated")
    rebuilt = build_report(report["per_run"], report, now=measured_at)
    if not rebuilt["complete"] or any(rebuilt[key] != report[key] for key in ("arms", "paired", "problems")):
        raise ValueError("release summary does not match its measured cells")
    # Publication copies this document verbatim, so it must be exactly the
    # field-whitelisted rebuild: no extra top-level or per-run fields.
    # Compare serialized JSON, not Python values: True == 1 and 1.0 == 1 there.
    if json.dumps(rebuilt, allow_nan=False, sort_keys=True) != json.dumps(report, allow_nan=False, sort_keys=True):
        raise ValueError("release evidence carries fields outside the published report schema")


def _git_sha(repo: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, text=True, capture_output=True
    ).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--repo", required=True, type=Path, help="runtime under test (recorded as runtime_sha)")
    prepare.add_argument(
        "--task-repo",
        required=True,
        type=Path,
        help="built checkout of the pinned task commit; supplies every task's source and dependencies",
    )
    prepare.add_argument("--out", required=True, type=Path)
    prepare.add_argument("--model", required=True)
    prepare.add_argument("--effort", required=True)
    prepare.add_argument("--runs", type=int, default=3)
    summarize = commands.add_parser("summarize")
    summarize.add_argument("--results", required=True, type=Path)
    summarize.add_argument("--metadata", required=True, type=Path)
    summarize.add_argument("--out", required=True, type=Path)
    check = commands.add_parser("check")
    check.add_argument("--evidence", required=True, type=Path)
    check.add_argument("--runtime-sha", required=True)
    commands.add_parser("task-sha", help="print the pinned task commit for the dependency checkout")
    args = parser.parse_args()
    if args.command == "prepare":
        if args.runs < 3:
            parser.error("release evaluation requires at least three runs per arm")
        tasks, digest, pins = suite_binding()
        # Candidate and stable must grade identical task source and toolchains;
        # the runtime under test is supplied only through runner --gitnexus-root.
        if _git_sha(args.task_repo) != pinned_task_sha(tasks):
            parser.error("--task-repo must be checked out at the pinned task commit")
        args.out.mkdir(parents=True, exist_ok=True)
        for task in tasks:
            task["repo"] = str(args.task_repo.resolve())
        (args.out / "tasks.yaml").write_text(yaml.safe_dump({"tasks": tasks}, sort_keys=False))
        metadata = dict(
            runtime_sha=_git_sha(args.repo),
            harness_sha=_git_sha(Path(__file__).resolve().parents[2]),
            task_set_digest=digest,
            model=normalized_model_identifier(args.model),
            effort=args.effort,
            runs=args.runs,
            tasks=pins,
        )
        (args.out / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    elif args.command == "summarize":
        rows = []
        for line in args.results.read_text().splitlines() if args.results.is_file() else []:
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append(None)  # A torn/invalid row is incomplete evidence.
        report = build_report(rows, json.loads(args.metadata.read_text()))
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "agent-evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        (args.out / "agent-evaluation.md").write_text(render_markdown(report))
        if not report["complete"]:
            raise SystemExit(1)
    elif args.command == "task-sha":
        print(pinned_task_sha(suite_binding()[0]))
    else:
        _, digest, pins = suite_binding()
        report = json.loads(args.evidence.read_text())
        validate_report(report, runtime_sha=args.runtime_sha, task_set_digest=digest, task_pins=pins)
        print("Pinned paired agent evidence verified.")


if __name__ == "__main__":
    main()
