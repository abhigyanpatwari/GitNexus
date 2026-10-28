"""Compare a pinned, unmerged PR's MCP sessions with authenticated past measurements.

The trusted main workflow owns this driver. Candidate code runs only through
the existing contained runtime builder and benchmark. Preview artifacts never
use the release-evidence schema or artifact name.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[\w.-]+/[\w.-]+")
COST_LABEL = "run-cost-evaluation"
# These additions orchestrate the preview; they do not change the measured
# runner, task/oracle bytes, dependency lock or pinned agent CLI.
PREVIEW_PATHS = {
    "eval/workflow_bench/pr_evaluation.py",
    "eval/tests/test_pr_evaluation.py",
    "eval/tests/test_ec2_workflows.py",
    "eval/workflow_bench/README.md",
}
EVALUATION_WORKFLOW = ".github/workflows/release-evaluation.yml"
MEASUREMENT_PATHS = ("eval/", ".github/claude-canary-runtime/", EVALUATION_WORKFLOW)


def _gh(arguments: list[str]) -> str:
    try:
        return subprocess.run(["gh", *arguments], check=True, capture_output=True, text=True, timeout=120).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise ValueError("GitHub evidence request failed") from None


def _gh_json(endpoint: str) -> dict[str, Any]:
    return json.loads(_gh(["api", endpoint]))


def resolve_pr(repo: str, number: int, expected_sha: str) -> str:
    if not REPO.fullmatch(repo) or type(number) is not int or number < 1 or not SHA.fullmatch(expected_sha):
        raise ValueError("expected a repository, positive PR number and full PR head SHA")
    pr = _gh_json(f"repos/{repo}/pulls/{number}")
    if (
        pr.get("state") != "open"
        or pr.get("head", {}).get("sha") != expected_sha
        or pr.get("base", {}).get("ref") != "main"
        or pr.get("base", {}).get("repo", {}).get("full_name") != repo
    ):
        raise ValueError("PR is closed, moved from the requested SHA, or targets a different repository/branch")
    if COST_LABEL not in {label.get("name") for label in pr.get("labels", [])}:
        raise ValueError(f"PR must retain the {COST_LABEL} label to enable a cost comparison")
    return expected_sha


def dispatch_labeled_pr(repo: str, event: dict[str, Any]) -> int:
    """Authorize a label request and select its baseline for the reusable evaluator."""
    if (
        not REPO.fullmatch(repo)
        or event.get("repository", {}).get("full_name") != repo
        or event.get("action") != "labeled"
        or event.get("label", {}).get("name") != COST_LABEL
    ):
        raise ValueError("expected a cost-evaluation label event for this repository")
    actor = event.get("sender", {}).get("login", "")
    if not re.fullmatch(r"[\w-]+(?:\[bot\])?", actor):
        raise ValueError("invalid label actor")
    permission = _gh_json(f"repos/{repo}/collaborators/{actor}/permission")
    if permission.get("role_name") not in ("admin", "maintain"):
        raise ValueError("only repository maintainers or administrators may request paid evaluations")
    pr = event.get("pull_request", {})
    number = event.get("number")
    sha = resolve_pr(repo, number, pr.get("head", {}).get("sha", ""))
    # Previews and runner-only probes are not historical release measurements.
    # The evaluator authenticates the chosen artifact's contents before spend.
    runs = _gh_json(
        f"repos/{repo}/actions/workflows/release-evaluation.yml/runs?branch=main&status=success&per_page=100"
    )
    for run in runs.get("workflow_runs", []):
        if (
            run.get("conclusion") != "success"
            or run.get("head_branch") != "main"
            or run.get("event") not in ("schedule", "workflow_dispatch")
            or run.get("head_repository", {}).get("full_name") != repo
            or type(run.get("id")) is not int
            or run["id"] < 1
            or not SHA.fullmatch(run.get("head_sha", ""))
        ):
            continue
        artifacts = _gh_json(f"repos/{repo}/actions/runs/{run['id']}/artifacts?per_page=100")
        if artifacts.get("total_count", 0) > 100:
            raise ValueError("historical artifact list is truncated")
        matches = [
            item
            for item in artifacts.get("artifacts", [])
            if isinstance(item.get("name"), str)
            and re.fullmatch(r"release-agent-evaluation-[0-9a-f]{40}", item["name"])
            and item.get("expired") is False
        ]
        if len(matches) != 1:
            continue
        resolve_pr(repo, number, sha)
        return run["id"]
    raise ValueError("no full successful main Release evaluation found in the latest 100 runs")


def measurement_protocol(source: str) -> dict[str, Any]:
    """Keep setup and paid execution identical, allowing only the preview routing."""
    import yaml

    job = yaml.safe_load(source)["jobs"]["evaluate"]
    protocol = {key: job[key] for key in ("runs-on", "environment", "timeout-minutes")}
    protocol["env"] = {
        key: value for key, value in job["env"].items() if key not in {"INPUT_PR", "INPUT_PR_SHA", "COMPARISON_RUN_ID"}
    }
    steps = []
    if sum(step.get("run", "").count("-m workflow_bench.runner") for step in job["steps"]) != 1:
        raise ValueError("expected one paid measurement step")
    for step in job["steps"]:
        if step.get("id") == "resolve":
            continue  # Runtime selection is intentionally different for an unmerged PR.
        if step.get("name") in {
            "Authenticate historical PR comparison evidence",
            "Require historical task dependencies before paid PR sessions",
            "Recheck PR opt-in and pinned head immediately before paid sessions",
        }:
            if step.get("if") != "inputs.candidate_pr != ''":
                raise ValueError("preview preflight must be conditional on the PR request")
            continue
        normalized = dict(step)
        if step.get("with", {}).get("path") == "stable" and step.get("if") == "inputs.candidate_pr == ''":
            normalized.pop("if")
        script = step.get("run", "")
        # Only the exact reviewed preview selectors may differ. Flags, setup
        # actions, pins, environment, timeouts, ordering and other shell stay.
        for variable in ("checkout", "runtime"):
            script = script.replace(f'  if [[ -n "$INPUT_PR" && "${variable}" == stable ]]; then continue; fi\n', "")
        script = script.replace(
            'arms=(baseline_nomcp baseline)\nif [[ -n "$INPUT_PR" ]]; then arms=(baseline); fi\n', ""
        )
        script = script.replace('--arms "${arms[@]}"', "--arms baseline_nomcp baseline")
        if "run" in step:
            normalized["run"] = script
        steps.append(normalized)
        if "-m workflow_bench.runner" in script:
            break
    protocol["steps"] = steps
    return protocol


def require_comparable_harness(repo: str, previous_sha: str, harness_sha: str) -> None:
    comparison = _gh_json(f"repos/{repo}/compare/{previous_sha}...{harness_sha}")
    files = comparison.get("files")
    if comparison.get("status") not in ("identical", "ahead") or not isinstance(files, list) or len(files) >= 300:
        raise ValueError("cannot prove historical measurement inputs are comparable")
    workflow_changed = False
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
            raise TypeError("malformed harness comparison")
        for name in (entry["filename"], entry.get("previous_filename")):
            if name == EVALUATION_WORKFLOW:
                if entry["filename"] != name or entry.get("previous_filename", name) != name:
                    raise ValueError("evaluation workflow was renamed; measure a fresh baseline")
                workflow_changed = True
                continue
            if isinstance(name, str) and name.startswith(MEASUREMENT_PATHS) and name not in PREVIEW_PATHS:
                raise ValueError(
                    "historical runner, tasks, dependencies or agent CLI changed; measure a fresh baseline"
                )
    if workflow_changed:
        protocols = [
            measurement_protocol(
                _gh(
                    [
                        "api",
                        f"repos/{repo}/contents/{EVALUATION_WORKFLOW}?ref={sha}",
                        "-H",
                        "Accept: application/vnd.github.raw+json",
                    ]
                )
            )
            for sha in (previous_sha, harness_sha)
        ]
        if protocols[0] != protocols[1]:
            raise ValueError("historical workflow measurement protocol changed; measure a fresh baseline")


def fetch_baseline(
    repo: str, run_id: int, harness_sha: str, model: str | None = None, effort: str | None = None
) -> dict[str, Any]:
    from .release_evidence import eligible_runs
    from .release_report import suite_binding, validate_report

    if not REPO.fullmatch(repo) or run_id < 1 or not SHA.fullmatch(harness_sha):
        raise ValueError("invalid historical run request")
    run = _gh_json(f"repos/{repo}/actions/runs/{run_id}")
    if (
        run.get("id") != run_id
        or run.get("path") != ".github/workflows/release-evaluation.yml"
        or not eligible_runs({"workflow_runs": [run]}, repo)
    ):
        raise ValueError("baseline must be a successful trusted main Release evaluation run")
    artifacts = _gh_json(f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100")
    if artifacts.get("total_count", 0) > 100:
        raise ValueError("historical artifact list is truncated")
    matches = [
        item
        for item in artifacts.get("artifacts", [])
        if isinstance(item.get("name"), str)
        and re.fullmatch(r"release-agent-evaluation-[0-9a-f]{40}", item["name"])
        and item.get("expired") is False
    ]
    if len(matches) != 1:
        raise ValueError("expected exactly one live release measurement artifact")
    artifact = matches[0]
    with tempfile.TemporaryDirectory(prefix="pr-evaluation-baseline-") as directory:
        _gh(["run", "download", str(run_id), "--repo", repo, "--name", artifact["name"], "--dir", directory])
        source = Path(directory) / "agent-evaluation.json"
        if not source.is_file() or source.is_symlink() or source.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("invalid historical report artifact")
        report = json.loads(source.read_text())
    _, digest, pins = suite_binding()
    runtime_sha = artifact["name"].removeprefix("release-agent-evaluation-")
    validate_report(report, runtime_sha=runtime_sha, task_set_digest=digest, task_pins=pins)
    if (
        report["harness_sha"] != run["head_sha"]
        or (model is not None and report["model"] != model)
        or (effort is not None and report["effort"] != effort)
        or report["runs"] != 3
    ):
        raise ValueError("historical harness, model, reasoning effort or repetition count does not match")
    require_comparable_harness(repo, run["head_sha"], harness_sha)
    return report


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and value >= 0 and math.isfinite(value)
    except OverflowError:
        return False


def check_dependency_bindings(bindings: list[dict[str, Any]], previous: dict[str, Any]) -> None:
    from .task_assets import DEPENDENCY_CONTENT_BINDING_FIELD

    if len(bindings) != len(previous["tasks"]) or {entry["id"] for entry in bindings} != set(previous["tasks"]):
        raise ValueError("prepared task inventory differs from the historical run")
    for entry in bindings:
        task = entry["id"]
        pin = previous["tasks"][task]
        expected = {
            row[DEPENDENCY_CONTENT_BINDING_FIELD]
            for row in previous["per_run"]
            if row["task"] == task and row["arm"] == "baseline"
        }
        if (
            entry["resolved_sha"] != pin["sha"]
            or entry["oracle_digest"] != pin["oracle_digest"]
            or expected != {entry[DEPENDENCY_CONTENT_BINDING_FIELD]}
        ):
            raise ValueError("prepared task/oracle/dependency bytes differ from the historical run")


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    cost = sum(row["cost_usd"] for row in rows)
    return {
        "cells": len(rows),
        "solved": sum(row["resolved"] for row in rows),
        "total_cost_usd": cost,
        "mean_cost_usd": cost / len(rows),
        "median_cost_usd": statistics.median(row["cost_usd"] for row in rows),
        "mean_wall_s": statistics.mean(row["duration_s"] for row in rows),
    }


def compare_candidate(
    rows: list[Any],
    metadata: dict[str, Any],
    previous: dict[str, Any],
    *,
    candidate_sha: str,
    pr: int,
    baseline_run: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    from .release_report import ROW_FIELDS, validate_report

    measured_at = now or datetime.now(UTC)
    validate_report(
        previous, runtime_sha=previous["runtime_sha"], task_set_digest=previous["task_set_digest"], now=measured_at
    )
    problems = []
    if not SHA.fullmatch(candidate_sha) or metadata.get("runtime_sha") != candidate_sha:
        problems.append("candidate runtime does not match the requested PR SHA")
    if not isinstance(metadata.get("harness_sha"), str) or not SHA.fullmatch(metadata["harness_sha"]):
        problems.append("invalid candidate harness SHA")
    for field in ("task_set_digest", "tasks", "model", "effort", "runs"):
        if metadata.get(field) != previous[field]:
            problems.append(f"candidate and historical run use different {field}")
    old_rows = [row for row in previous["per_run"] if row["arm"] == "baseline"]
    old_cells = {(row["task"], row["run"]): row for row in old_rows}
    cells = {}
    safe_rows = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not isinstance(row.get("task"), str) or type(row.get("run")) is not int:
            problems.append(f"row {index}: invalid cell identity")
            continue
        key = row["task"], row["run"]
        old = old_cells.get(key)
        valid = (
            old is not None
            and key not in cells
            and row.get("arm") == "baseline"
            and all(
                row.get(field) == old[field]
                for field in ("model", "effort", "task_base_sha", "oracle_digest", "sandbox_dependency_content_digest")
            )
            and row.get("sandbox_backend") == "bwrap"
            and row.get("runtime_exposure") == "stdio-only"
            and row.get("ok") is True
            and all(type(row.get(field)) is bool for field in ("resolved", "authored_tests_passed", "oracle_passed"))
            and row["resolved"] == (row["authored_tests_passed"] and row["oracle_passed"])
            and row.get("error_kind") in (None, "verify-failed", "oracle-failed")
            and row.get("transcript_missing") is False
            and _number(row.get("cost_usd"))
            and _number(row.get("duration_s"))
        )
        safe = {field: row[field] for field in ROW_FIELDS if field in row}
        try:
            json.dumps(safe, allow_nan=False)
        except (ValueError, TypeError, OverflowError):
            valid = False
        if not valid:
            problems.append(f"row {index}: duplicate, unexpected or untrustworthy measurement")
            continue
        cells[key] = row
        safe_rows.append(safe)
    if set(cells) != set(old_cells):
        problems.append("missing historical task/repetition pairs")
    result: dict[str, Any] = {
        "schema": "gitnexus.pr-cost-comparison/v1",
        "generated_at": measured_at.isoformat(),
        "purpose": "PR measurement, not release approval",
        "pr": pr,
        "candidate_sha": candidate_sha,
        "baseline_run": baseline_run,
        "baseline_runtime_sha": previous["runtime_sha"],
        "baseline_harness_sha": previous["harness_sha"],
        "harness_sha": metadata.get("harness_sha"),
        "model": previous["model"],
        "effort": previous["effort"],
        "runs": previous["runs"],
        "task_set_digest": previous["task_set_digest"],
        "complete": not problems,
        "problems": problems,
        "quality_preserved": False,
        "improved": False,
        "cost_reduction_pct": None,
        "previous": _summary(old_rows),
        "candidate": None,
        "tasks": {},
        "per_run": safe_rows,
    }
    if problems:
        return result
    result["candidate"] = _summary(list(cells.values()))
    quality = True
    for task in previous["tasks"]:
        old = _summary([row for row in old_rows if row["task"] == task])
        new = _summary([row for row in cells.values() if row["task"] == task])
        delta = new["solved"] - old["solved"]
        quality = quality and delta >= 0
        result["tasks"][task] = {"previous": old, "candidate": new, "solve_delta": delta}
    old_cost, new_cost = result["previous"]["total_cost_usd"], result["candidate"]["total_cost_usd"]
    result.update(
        quality_preserved=quality,
        improved=quality and new_cost < old_cost,
        cost_reduction_pct=100 * (old_cost - new_cost) / old_cost if old_cost else None,
    )
    return result


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "## PR cost comparison",
        "",
        "PR measurement, not release approval.",
        "",
        f"PR #{report['pr']} at `{report['candidate_sha']}` vs run {report['baseline_run']}.",
        f"Model `{report['model']}`, effort `{report['effort']}`, n={report['runs']} per task.",
        "",
    ]
    if not report["complete"]:
        return "\n".join([*lines, "**Incomplete evidence; no savings conclusion.**", "", *report["problems"], ""])
    lines += [
        "| MCP sessions | Solved | Total model cost | Mean model cost |",
        "| --- | --- | --- | --- |",
    ]
    for label, key in (("Previous run", "previous"), ("PR candidate", "candidate")):
        row = report[key]
        lines.append(
            f"| {label} | {row['solved']}/{row['cells']} | ${row['total_cost_usd']:.4f} | ${row['mean_cost_usd']:.4f} |"
        )
    reduction = report["cost_reduction_pct"]
    lines += [
        "",
        f"Cost reduction: {reduction:+.1f}%."
        if reduction is not None
        else "Cost reduction unavailable: zero historical cost.",
        f"Per-task quality preserved: {'yes' if report['quality_preserved'] else 'NO'}.",
        "",
        "| Task | Previous solved | PR solved | Previous cost | PR cost |",
        "| --- | --- | --- | --- | --- |",
    ]
    for task, row in report["tasks"].items():
        old, new = row["previous"], row["candidate"]
        lines.append(
            f"| {task} | {old['solved']}/{old['cells']} | {new['solved']}/{new['cells']} | ${old['total_cost_usd']:.4f} | ${new['total_cost_usd']:.4f} |"
        )
    return "\n".join(
        [
            *lines,
            "",
            "Only the PR MCP cells are newly measured; no-MCP and stable sessions are not rerun.",
            "Historical comparisons are descriptive and do not establish statistical significance or isolate this PR from other runtime changes.",
            "",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    dispatch = commands.add_parser("dispatch-label")
    dispatch.add_argument("--repo", required=True)
    dispatch.add_argument("--event", type=Path, required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--repo", required=True)
    resolve.add_argument("--pr", type=int, required=True)
    resolve.add_argument("--sha", required=True)
    baseline = commands.add_parser("baseline")
    for flag in ("repo", "harness-sha"):
        baseline.add_argument(f"--{flag}", required=True)
    for flag in ("model", "effort"):
        baseline.add_argument(f"--{flag}", help="Require this setting; otherwise inherit the authenticated report")
    baseline.add_argument("--run-id", type=int, required=True)
    baseline.add_argument("--out", type=Path, required=True)
    baseline.add_argument("--env-out", type=Path, help="Append authenticated MODEL/EFFORT to a GitHub environment file")
    dependencies = commands.add_parser("dependencies")
    dependencies.add_argument("--tasks", type=Path, required=True)
    dependencies.add_argument("--baseline", type=Path, required=True)
    summarize = commands.add_parser("summarize")
    for flag in ("results", "metadata", "baseline", "out"):
        summarize.add_argument(f"--{flag}", type=Path, required=True)
    summarize.add_argument("--sha", required=True)
    summarize.add_argument("--pr", type=int, required=True)
    summarize.add_argument("--run-id", type=int, required=True)
    args = parser.parse_args()
    if args.command == "dispatch-label":
        event = json.loads(args.event.read_text())
        run_id = dispatch_labeled_pr(args.repo, event)
        print(f"pr={event['number']}")
        print(f"sha={event['pull_request']['head']['sha']}")
        print(f"comparison_run_id={run_id}")
    elif args.command == "resolve":
        print(f"sha={resolve_pr(args.repo, args.pr, args.sha)}")
    elif args.command == "baseline":
        report = fetch_baseline(args.repo, args.run_id, args.harness_sha, args.model, args.effort)
        settings = {"MODEL": report["model"], "EFFORT": report["effort"]}
        if args.env_out and any(
            not isinstance(value, str) or not value or any(char in value for char in "\r\n\0")
            for value in settings.values()
        ):
            raise ValueError("historical model settings must be nonempty single-line strings")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        if args.env_out:
            with args.env_out.open("a") as environment:
                environment.writelines(f"{key}={value}\n" for key, value in settings.items())
    elif args.command == "dependencies":
        import yaml

        from .runner_tasks import resolve_task_bindings, select_tasks
        from .task_assets import TaskAssetCache

        tasks, _ = select_tasks(yaml.safe_load(args.tasks.read_text())["tasks"], include_expensive=True)
        with (
            tempfile.TemporaryDirectory(prefix="pr-evaluation-dependencies-") as directory,
            TaskAssetCache(Path(directory) / "cache") as cache,
        ):
            bindings = resolve_task_bindings(tasks, task_asset_cache=cache)
            check_dependency_bindings(bindings, json.loads(args.baseline.read_text()))
    else:
        rows = []
        for line in args.results.read_text().splitlines() if args.results.is_file() else []:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    rows.append(None)
        report = compare_candidate(
            rows,
            json.loads(args.metadata.read_text()),
            json.loads(args.baseline.read_text()),
            candidate_sha=args.sha,
            pr=args.pr,
            baseline_run=args.run_id,
        )
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "pr-cost-comparison.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        (args.out / "pr-cost-comparison.md").write_text(render_markdown(report))
        if not report["complete"] or not report["quality_preserved"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
