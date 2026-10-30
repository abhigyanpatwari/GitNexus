"""Prepare counterbalanced experiment inputs. This module NEVER runs an agent."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import re
from pathlib import Path
from typing import Any

import yaml

from .runner_tasks import normalized_model_identifier, select_tasks
from .session_budget import session_budget

VARIANTS = {
    "no_graph": ("baseline_nomcp", "eager"),
    "mcp_eager": ("baseline", "eager"),
    "mcp_deferred": ("baseline", "deferred"),
    "cli": ("baseline_cli", "eager"),
    "mcp_optional_prompt": ("baseline", "eager"),
}
OPTIONAL_PROMPT = """

Experiment-specific instruction: GitNexus is available, but using it is optional
for this task. This overrides repository instructions that require graph-first
navigation, impact analysis before every edit, or detect_changes before commit.
Use the tools that help solve the task. Keep all other repository requirements,
tests, and safety constraints. Do not install or bootstrap additional tools.
"""


def prepare_plan(
    document: dict[str, Any], *, repository: str, runtime: str, runtime_sha: str,
    harness_sha: str, model: str, effort: str, repeats: int, seed: int,
    variants: list[str], task_ids: list[str] | None = None, max_budget_usd: float | None = None,
) -> dict[str, Any]:
    """A seeded Latin-square order within each task; no execution side effects.

    One runner process per cell makes its provider ledger attributable without
    guessing session IDs. Run indices in runner output are always zero; the
    experiment's block/sequence fields carry repetition identity instead.
    """
    max_budget_usd = session_budget(max_budget_usd)
    if not variants or len(set(variants)) != len(variants) or any(v not in VARIANTS for v in variants):
        raise ValueError("variants must be unique known experiment variants")
    if not 1 <= repeats <= 100:
        raise ValueError("repeats must be between 1 and 100")
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (runtime_sha, harness_sha)):
        raise ValueError("runtime and harness require full commit SHAs")
    if not isinstance(model, str):
        raise ValueError("use a named model, not auto/latest")
    model = normalized_model_identifier(model)
    if effort not in ("low", "medium", "high", "xhigh", "max"):
        raise ValueError("invalid effort")
    if not isinstance(document, dict):
        raise ValueError("task document must contain tasks")
    tasks = document.get("tasks")
    if not isinstance(tasks, list) or not tasks or not all(isinstance(t, dict) for t in tasks):
        raise ValueError("task document must contain tasks")
    tasks, _ = select_tasks([{**task, "repo": repository} for task in tasks], include_expensive=True)
    ids = [t["id"] for t in tasks]
    if task_ids is not None and (not task_ids or not set(task_ids) <= set(ids)):
        raise ValueError("unknown or empty task selection")
    tasks = [t for t in tasks if task_ids is None or t["id"] in task_ids]
    if any(not re.fullmatch(r"[0-9a-f]{40}", str(t.get("ref", ""))) or not isinstance(t.get("prompt"), str) for t in tasks):
        raise ValueError("each task needs a pinned ref and prompt")
    rng = random.Random(seed)
    order = variants.copy()
    rng.shuffle(order)
    rng.shuffle(tasks)
    cells = []
    for block in range(repeats):
        for task_index, task in enumerate(tasks):
            rotation = (block + task_index) % len(order)
            for position, variant in enumerate(order[rotation:] + order[:rotation]):
                arm, loading = VARIANTS[variant]
                prepared = copy.deepcopy(task)
                prepared["repo"] = repository
                if variant == "mcp_optional_prompt":
                    prepared["prompt"] += OPTIONAL_PROMPT
                sequence = len(cells)
                cell_id = f"cell-{sequence:04d}"
                cells.append({
                    "cell_id": cell_id, "sequence": sequence, "block": block,
                    "position": position, "task": task["id"], "task_class": task.get("class"),
                    "variant": variant, "arm": arm, "tool_loading": loading,
                    "base_prompt_sha256": hashlib.sha256(task["prompt"].encode()).hexdigest(),
                    "prompt_sha256": hashlib.sha256(prepared["prompt"].encode()).hexdigest(),
                    "task_document": {"tasks": [prepared]},
                    "argv": ["uv", "run", "--locked", "python", "-m", "workflow_bench.runner",
                             "--tasks", f"{cell_id}.tasks.json", "--runs", "1", "--workers", "1",
                             "--arms", arm, "--mcp-tool-loading", loading,
                             "--gitnexus-root", runtime, "--model", model, "--effort", effort,
                             "--include-expensive", *(["--max-budget-usd", str(max_budget_usd)] if max_budget_usd is not None else []),
                             "--out", f"results/{cell_id}"],
                    "env": {"GITNEXUS_BENCH_SWEEP_ID": cell_id,
                            "GITNEXUS_BENCH_PROVIDER_USAGE": f"results/{cell_id}.provider.jsonl"},
                })
    return {
        "schema": "gitnexus.diagnostic-experiments/v1", "execution": "not_started",
        "harness_sha": harness_sha, "runtime_sha": runtime_sha, "seed": seed,
        "task_repository": repository,
        "model": model, "effort": effort, "repeats": repeats, "workers": 1,
        "max_budget_usd_per_cell": max_budget_usd,
        "planned_cli_budget_usd": len(cells) * max_budget_usd if max_budget_usd is not None else None,
        "position_balanced": repeats % len(variants) == 0,
        "release_gate_eligible": False, "cells": cells,
        "limitations": [
            "No model-spend authorization; this plan does not execute commands.",
            "Verify checkout SHAs, instrumentation diff, dependencies and oracle bindings before execution.",
            "Run serially in listed sequence, with an exclusive proxy/ledger per cell; never reuse ledgers.",
            "Optional-prompt treatment changes tool-use policy, not repository guidance bytes or tool schemas.",
            "This plan controls concurrency at one; a separate matched worker-count study is needed for contention.",
            "Fresh processes do not guarantee cold filesystem/provider caches; record machine and cache policy.",
            "CLI budget stops use reported model cost; in-flight requests and provider billing can exceed them.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--runtime-sha", required=True)
    parser.add_argument("--harness-sha", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort", default="xhigh")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=3762)
    parser.add_argument("--max-budget-usd", type=float, help="CLI-reported budget stop per cell, not an invoice cap")
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    parser.add_argument("--task-ids", nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    plan = prepare_plan(
        yaml.safe_load(args.tasks.read_text()), repository=str(args.repository.resolve()),
        runtime=str(args.runtime.resolve()), runtime_sha=args.runtime_sha, harness_sha=args.harness_sha,
        model=args.model, effort=args.effort, repeats=args.repeats, seed=args.seed,
        variants=args.variants, task_ids=args.task_ids, max_budget_usd=args.max_budget_usd,
    )
    # Refuse overwrite: a previous plan/ledger may already be evidence.
    args.out.mkdir(parents=True, exist_ok=False)
    root = args.out.resolve()
    (root / "results").mkdir()
    for cell in plan["cells"]:
        manifest = root / f"{cell['cell_id']}.tasks.json"
        manifest.write_text(json.dumps(cell.pop("task_document"), indent=2) + "\n")
        cell["task_manifest_sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        cell["argv"][cell["argv"].index("--tasks") + 1] = str(manifest)
        cell["argv"][-1] = str(root / "results" / cell["cell_id"])
        cell["env"]["GITNEXUS_BENCH_PROVIDER_USAGE"] = str(root / "results" / f"{cell['cell_id']}.provider.jsonl")
        cell["cwd"] = str(Path(__file__).resolve().parents[1])
    (root / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    print(f"Prepared {len(plan['cells'])} cells at {root}; no agents started.")


if __name__ == "__main__":
    main()
