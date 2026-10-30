"""Execute the fixed, explicitly authorized two-cell telemetry trial once."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

MODEL = "gpt-5.6-sol"
TASK = "trivial-status-json-alias"
BUDGET_USD = 5.0
HARNESS_ROOT = Path(__file__).resolve().parents[2]


def _head(repository: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True, timeout=60,
    ).stdout.strip()


def _validated_cells(plan_path: Path, runtime: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    plan = json.loads(plan_path.read_text())
    policy = {
        "schema": "gitnexus.diagnostic-experiments/v1", "execution": "not_started",
        "model": MODEL, "effort": "xhigh", "repeats": 1, "workers": 1, "seed": 3762,
        "max_budget_usd_per_cell": BUDGET_USD, "planned_cli_budget_usd": 10.0,
        "release_gate_eligible": False,
    }
    if not isinstance(plan, dict) or any(plan.get(key) != value for key, value in policy.items()):
        raise ValueError("trial plan does not match the authorized two-cell policy")
    if plan.get("harness_sha") != _head(HARNESS_ROOT) or plan.get("runtime_sha") != _head(runtime):
        raise ValueError("trial checkout does not match its pinned revision")
    cells = plan.get("cells")
    if not isinstance(cells, list) or len(cells) != 2 or not all(isinstance(c, dict) for c in cells):
        raise ValueError("trial must contain exactly two cells")
    if {cell.get("variant") for cell in cells} != {"no_graph", "mcp_eager"}:
        raise ValueError("trial requires one no-graph and one eager-MCP cell")
    root = plan_path.parent
    for index, cell in enumerate(cells):
        cell_id = f"cell-{index:04d}"
        arm = "baseline" if cell["variant"] == "mcp_eager" else "baseline_nomcp"
        manifest = root / f"{cell_id}.tasks.json"
        output = root / "results" / cell_id
        ledger = root / "results" / f"{cell_id}.provider.jsonl"
        expected = [
            "uv", "run", "--locked", "python", "-m", "workflow_bench.runner",
            "--tasks", str(manifest), "--runs", "1", "--workers", "1", "--arms", arm,
            "--mcp-tool-loading", "eager", "--gitnexus-root", str(runtime),
            "--model", MODEL, "--effort", "xhigh", "--include-expensive",
            "--max-budget-usd", str(BUDGET_USD), "--out", str(output),
        ]
        if (cell.get("cell_id") != cell_id or cell.get("task") != TASK or cell.get("argv") != expected
                or cell.get("cwd") != str(HARNESS_ROOT / "eval") or cell.get("env") != {
                    "GITNEXUS_BENCH_SWEEP_ID": cell_id, "GITNEXUS_BENCH_PROVIDER_USAGE": str(ledger),
                }):
            raise ValueError("trial cell has unexpected arguments or paths")
        if manifest.is_symlink() or hashlib.sha256(manifest.read_bytes()).hexdigest() != cell.get("task_manifest_sha256"):
            raise ValueError("trial task manifest changed after preparation")
        document = json.loads(manifest.read_text())
        tasks = document.get("tasks") if isinstance(document, dict) else None
        if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict) or tasks[0].get("id") != TASK:
            raise ValueError("trial manifest must contain only the authorized task")
        task_repo = tasks[0].get("repo")
        if (not isinstance(task_repo, str) or task_repo != plan.get("task_repository")
                or _head(Path(task_repo)) != tasks[0].get("ref")):
            raise ValueError("task source and dependencies must come from the pinned task checkout")
        if output.exists() or output.is_symlink() or ledger.exists() or ledger.is_symlink():
            raise ValueError("trial results already exist; refusing to repeat paid work")
    return plan, cells


def execute_trial(plan_path: Path, runtime: Path, claude_bin: str) -> int:
    plan_path, runtime = plan_path.resolve(), runtime.resolve()
    plan, cells = _validated_cells(plan_path, runtime)
    receipt = plan_path.parent / "execution.json"
    state: dict[str, Any] = {
        "schema": "gitnexus.diagnostic-trial-execution/v1", "status": "running",
        "harness_sha": plan["harness_sha"], "runtime_sha": plan["runtime_sha"],
        "planned_cli_budget_usd": 10.0, "budget_is_invoice_cap": False, "cells": [],
    }
    # A crash can happen after a paid request but before its result is saved.
    # Never resume/retry this plan automatically, even when no result exists.
    with receipt.open("x") as stream:
        stream.write(json.dumps(state, indent=2) + "\n")
    failed = False
    for cell in cells:
        command = [sys.executable, *cell["argv"][4:], "--timeout", "900", "--claude-bin", claude_bin]
        item: dict[str, Any] = {"cell_id": cell["cell_id"], "variant": cell["variant"], "status": "started"}
        state["cells"].append(item)
        receipt.write_text(json.dumps(state, indent=2) + "\n")
        completed = subprocess.run(command, cwd=cell["cwd"], env={**os.environ, **cell["env"]}, check=False)
        output = plan_path.parent / "results" / cell["cell_id"] / "results.jsonl"
        ledger = Path(cell["env"]["GITNEXUS_BENCH_PROVIDER_USAGE"])
        try:
            rows = [json.loads(line) for line in output.read_text().splitlines() if line.strip()]
            measured = (len(rows) == 1 and isinstance(rows[0], dict) and rows[0].get("task") == TASK
                        and rows[0].get("arm") == cell["arm"] and bool(rows[0].get("session_diagnostics"))
                        and ledger.is_file() and ledger.stat().st_size > 0)
        except (OSError, ValueError):
            measured = False
        item.update(status="finished", exit_code=completed.returncode, measurements_present=measured)
        failed |= completed.returncode != 0 or not measured
        receipt.write_text(json.dumps(state, indent=2) + "\n")
    state["status"] = "failed" if failed else "completed"
    receipt.write_text(json.dumps(state, indent=2) + "\n")
    return int(failed)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", required=True, help="Authorize these two paid cells")
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--claude-bin", required=True)
    args = parser.parse_args()
    raise SystemExit(execute_trial(args.plan, args.runtime, args.claude_bin))


if __name__ == "__main__":
    main()
