#!/usr/bin/env python3
"""
Results Analyzer for GitNexus SWE-bench Evaluation

Reads evaluation results and generates comparative analysis:
- Resolve rate by model x mode
- Cost comparison (total, per-instance)
- Token/API call efficiency
- GitNexus tool usage patterns
- Augmentation hit rates

Usage:
    python -m analysis.analyze_results /path/to/results
    python -m analysis.analyze_results /path/to/results --format markdown
    python -m analysis.analyze_results /path/to/results --swebench-eval  # run actual test verification
"""

import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from tool_registry import TOOL_METRIC_KEYS

logger = logging.getLogger("analyze_results")
console = Console()
app = typer.Typer(rich_markup_mode="rich", add_completion=False)


def load_run_results(results_dir: Path) -> dict[str, dict]:
    """
    Load all run results from the results directory.
    
    Returns: {run_id: {summary, preds, instances}}
    """
    runs = {}

    for run_dir in sorted(results_dir.iterdir()):
        if not run_dir.is_dir():
            continue

        run_id = run_dir.name
        run_data: dict[str, Any] = {"run_id": run_id, "dir": run_dir}

        # Load summary
        summary_path = run_dir / "summary.json"
        if summary_path.exists():
            run_data["summary"] = json.loads(summary_path.read_text())

        # Load predictions
        preds_path = run_dir / "preds.json"
        if preds_path.exists():
            run_data["preds"] = json.loads(preds_path.read_text())

        # Load individual trajectories for detailed metrics
        run_data["trajectories"] = {}
        for traj_dir in run_dir.iterdir():
            if not traj_dir.is_dir():
                continue
            for traj_file in traj_dir.glob("*.traj.json"):
                try:
                    traj = json.loads(traj_file.read_text())
                    instance_id = traj.get("instance_id", traj_dir.name)
                    run_data["trajectories"][instance_id] = traj
                except Exception:
                    pass

        if run_data.get("preds") or run_data.get("summary"):
            runs[run_id] = run_data

    return runs


def parse_run_id(run_id: str) -> tuple[str, str]:
    """Parse 'model_mode' into (model, mode) using known suffixes."""
    # Match the longest known suffix first to avoid hyphen collisions in model names.
    known_modes = [
        "native_augment",
        "native",
        "baseline",
        "mcp",
        "augment",
        "full",
    ]
    for mode in known_modes:
        suffix = f"_{mode}"
        if run_id.endswith(suffix):
            return run_id[: -len(suffix)], mode
    return run_id, "unknown"


def compute_metrics(run_data: dict) -> dict:
    """Compute evaluation metrics for a single run."""
    preds = run_data.get("preds", {})
    summary = run_data.get("summary", {})
    trajectories = run_data.get("trajectories", {})

    n_instances = len(preds)
    n_with_patch = sum(1 for p in preds.values() if p.get("model_patch", "").strip())

    # Cost and API call metrics from trajectories
    costs = []
    api_calls = []
    gn_tool_calls = []
    gn_augment_hits = []
    gn_augment_calls = []

    for instance_id, traj in trajectories.items():
        info = traj.get("info", {})
        model_stats = info.get("model_stats", {})
        costs.append(model_stats.get("instance_cost", 0))
        api_calls.append(model_stats.get("api_calls", 0))

        gn = info.get("gitnexus", {}).get("metrics", {})
        if gn:
            gn_tool_calls.append(gn.get("total_tool_calls", 0))
            gn_augment_hits.append(gn.get("augmentation_hits", 0))
            gn_augment_calls.append(gn.get("augmentation_calls", 0))

    # Also try summary-level metrics
    if not costs and summary:
        results = summary.get("results", [])
        for r in results:
            costs.append(r.get("cost", 0))
            api_calls.append(r.get("n_calls", 0))
            gn = r.get("gitnexus_metrics", {})
            if gn:
                gn_tool_calls.append(gn.get("total_tool_calls", 0))
                gn_augment_hits.append(gn.get("augmentation_hits", 0))
                gn_augment_calls.append(gn.get("augmentation_calls", 0))

    total_cost = sum(costs)
    total_calls = sum(api_calls)

    return {
        "n_instances": n_instances,
        "n_with_patch": n_with_patch,
        "patch_rate": n_with_patch / max(n_instances, 1),
        "total_cost": total_cost,
        "avg_cost": total_cost / max(n_instances, 1),
        "total_api_calls": total_calls,
        "avg_api_calls": total_calls / max(n_instances, 1),
        "total_gn_tool_calls": sum(gn_tool_calls),
        "avg_gn_tool_calls": sum(gn_tool_calls) / max(len(gn_tool_calls), 1) if gn_tool_calls else 0,
        "total_augment_hits": sum(gn_augment_hits),
        "total_augment_calls": sum(gn_augment_calls),
        "augment_hit_rate": sum(gn_augment_hits) / max(sum(gn_augment_calls), 1) if gn_augment_calls else 0,
    }


def run_swebench_evaluation(results_dir: Path, run_id: str, subset: str = "lite") -> dict | None:
    """
    Run the official SWE-bench evaluation on predictions.
    
    Requires: pip install swebench
    """
    preds_path = results_dir / run_id / "preds.json"
    if not preds_path.exists():
        return None

    dataset_mapping = {
        "lite": "princeton-nlp/SWE-Bench_Lite",
        "verified": "princeton-nlp/SWE-Bench_Verified",
        "full": "princeton-nlp/SWE-Bench",
    }

    try:
        eval_output = results_dir / run_id / "swebench_eval"
        cmd = [
            sys.executable, "-m", "swebench.harness.run_evaluation",
            "--dataset_name", dataset_mapping.get(subset, subset),
            "--predictions_path", str(preds_path),
            "--max_workers", "4",
            "--run_id", run_id,
            "--output_dir", str(eval_output),
        ]

        logger.info(f"Running SWE-bench evaluation for {run_id}...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

        if result.returncode == 0:
            # Parse evaluation results
            report_path = eval_output / run_id / "results.json"
            if report_path.exists():
                return json.loads(report_path.read_text())

        logger.error(f"SWE-bench eval failed: {result.stderr[:500]}")
        return None

    except Exception as e:
        logger.error(f"SWE-bench eval error: {e}")
        return None


# ─── CLI Commands ───────────────────────────────────────────────────────────


@app.command()
def summary(
    results_dir: str = typer.Argument(..., help="Path to results directory"),
    format: str = typer.Option("table", "--format", help="Output format: table, markdown, json, csv"),
    swebench_eval: bool = typer.Option(False, "--swebench-eval", help="Run official SWE-bench test evaluation"),
    subset: str = typer.Option("lite", "--subset", help="SWE-bench subset (for --swebench-eval)"),
):
    """Generate comparative analysis of evaluation results."""
    results_path = Path(results_dir)
    if not results_path.exists():
        console.print(f"[red]Results directory not found: {results_path}[/red]")
        raise typer.Exit(1)

    runs = load_run_results(results_path)
    if not runs:
        console.print("[yellow]No evaluation results found[/yellow]")
        raise typer.Exit(0)

    console.print(f"\n[bold]Found {len(runs)} evaluation runs[/bold]\n")

    # Compute metrics per run
    all_metrics = {}
    for run_id, run_data in runs.items():
        model, mode = parse_run_id(run_id)
        metrics = compute_metrics(run_data)
        metrics["model"] = model
        metrics["mode"] = mode

        # Optionally run SWE-bench evaluation
        if swebench_eval:
            eval_result = run_swebench_evaluation(results_path, run_id, subset)
            if eval_result:
                metrics["resolved"] = eval_result.get("resolved", 0)
                metrics["resolve_rate"] = eval_result.get("resolved", 0) / max(metrics["n_instances"], 1)

        all_metrics[run_id] = metrics

    if format == "table":
        _print_table(all_metrics)
    elif format == "markdown":
        _print_markdown(all_metrics)
    elif format == "json":
        console.print(json.dumps(all_metrics, indent=2))
    elif format == "csv":
        _print_csv(all_metrics)


@app.command()
def compare_modes(
    results_dir: str = typer.Argument(..., help="Path to results directory"),
    model: str = typer.Option(..., "-m", "--model", help="Model to compare across modes"),
):
    """Compare modes for a specific model (baseline vs mcp vs augment vs full)."""
    results_path = Path(results_dir)
    runs = load_run_results(results_path)

    # Filter to the specified model
    model_runs = {
        run_id: data for run_id, data in runs.items()
        if parse_run_id(run_id)[0] == model
    }

    if not model_runs:
        console.print(f"[yellow]No results found for model: {model}[/yellow]")
        raise typer.Exit(1)

    console.print(f"\n[bold]Mode comparison for {model}[/bold]\n")

    metrics = {}
    for run_id, run_data in model_runs.items():
        _, mode = parse_run_id(run_id)
        metrics[mode] = compute_metrics(run_data)

    mode_order = [
        mode
        for mode in ["baseline", "native", "native_augment", "mcp", "augment", "full"]
        if mode in metrics
    ] or sorted(metrics.keys())

    # Print comparison table
    table = Table(title=f"Mode Comparison: {model}")
    table.add_column("Metric", style="bold")
    for mode in mode_order:
        table.add_column(mode, justify="right")

    rows = [
        ("Instances", "n_instances", "d"),
        ("With Patch", "n_with_patch", "d"),
        ("Patch Rate", "patch_rate", ".1%"),
        ("Total Cost", "total_cost", "$.4f"),
        ("Avg Cost", "avg_cost", "$.4f"),
        ("Total API Calls", "total_api_calls", "d"),
        ("Avg API Calls", "avg_api_calls", ".1f"),
        ("GN Tool Calls", "total_gn_tool_calls", "d"),
        ("Augment Hits", "total_augment_hits", "d"),
        ("Augment Hit Rate", "augment_hit_rate", ".1%"),
    ]

    for label, key, fmt in rows:
        values = []
        for mode in mode_order:
            if mode in metrics:
                v = metrics[mode].get(key, 0)
                if fmt == ".1%":
                    values.append(f"{v:.1%}")
                elif fmt == "$.4f":
                    values.append(f"${v:.4f}")
                elif fmt == ".1f":
                    values.append(f"{v:.1f}")
                else:
                    values.append(str(v))
        table.add_row(label, *values)

    # Add delta rows (improvement over baseline)
    if "baseline" in metrics:
        baseline_cost = metrics["baseline"]["avg_cost"]
        baseline_calls = metrics["baseline"]["avg_api_calls"]

        table.add_section()
        for mode in mode_order:
            if mode == "baseline":
                continue
            mode_cost = metrics[mode]["avg_cost"]
            mode_calls = metrics[mode]["avg_api_calls"]

            cost_delta = ((mode_cost - baseline_cost) / max(baseline_cost, 0.001)) * 100
            calls_delta = ((mode_calls - baseline_calls) / max(baseline_calls, 1)) * 100

            cost_str = f"{cost_delta:+.1f}%"
            calls_str = f"{calls_delta:+.1f}%"

            # Color-code: negative is good (cheaper/fewer calls)
            cost_color = "green" if cost_delta < 0 else "red"
            calls_color = "green" if calls_delta < 0 else "red"

            console.print(f"  {mode} vs baseline: cost [{cost_color}]{cost_str}[/{cost_color}], calls [{calls_color}]{calls_str}[/{calls_color}]")

    console.print(table)


@app.command()
def gitnexus_usage(
    results_dir: str = typer.Argument(..., help="Path to results directory"),
):
    """Analyze GitNexus tool usage patterns across all runs."""
    results_path = Path(results_dir)
    runs = load_run_results(results_path)

    console.print("\n[bold]GitNexus Tool Usage Analysis[/bold]\n")

    table = Table(title="Tool Usage by Run")
    table.add_column("Run", style="bold")
    for key in TOOL_METRIC_KEYS:
        table.add_column(key, justify="right")
    table.add_column("Total", justify="right")
    table.add_column("Augment Hits", justify="right")

    for run_id, run_data in sorted(runs.items()):
        _, mode = parse_run_id(run_id)
        if mode == "baseline":
            continue

        # Aggregate tool calls across trajectories
        tool_totals: dict[str, int] = {key: 0 for key in TOOL_METRIC_KEYS}
        augment_hits = 0

        for traj in run_data.get("trajectories", {}).values():
            gn = traj.get("info", {}).get("gitnexus", {}).get("metrics", {})
            for tool, count in gn.get("tool_calls", {}).items():
                tool_totals[tool] = tool_totals.get(tool, 0) + count
            augment_hits += gn.get("augmentation_hits", 0)

        # Also check summary
        for r in run_data.get("summary", {}).get("results", []):
            gn = r.get("gitnexus_metrics", {})
            for tool, count in gn.get("tool_calls", {}).items():
                tool_totals[tool] = tool_totals.get(tool, 0) + count
            augment_hits += gn.get("augmentation_hits", 0)

        total = sum(tool_totals.values())
        if total > 0 or augment_hits > 0:
            table.add_row(
                run_id,
                *[str(tool_totals.get(key, 0)) for key in TOOL_METRIC_KEYS],
                str(total),
                str(augment_hits),
            )

    console.print(table)


# ─── Output Formatters ─────────────────────────────────────────────────────


def _print_table(all_metrics: dict):
    """Print rich table summary."""
    table = Table(title="Evaluation Results")
    table.add_column("Run", style="bold")
    table.add_column("Model")
    table.add_column("Mode")
    table.add_column("N", justify="right")
    table.add_column("Patched", justify="right")
    table.add_column("Rate", justify="right")
    table.add_column("Cost", justify="right")
    table.add_column("Calls", justify="right")
    table.add_column("GN Tools", justify="right")

    for run_id, m in sorted(all_metrics.items()):
        resolved_str = ""
        if "resolve_rate" in m:
            resolved_str = f" ({m['resolve_rate']:.0%})"

        table.add_row(
            run_id,
            m["model"],
            m["mode"],
            str(m["n_instances"]),
            str(m["n_with_patch"]),
            f"{m['patch_rate']:.0%}{resolved_str}",
            f"${m['total_cost']:.2f}",
            str(m["total_api_calls"]),
            str(m["total_gn_tool_calls"]) if m["total_gn_tool_calls"] > 0 else "-",
        )

    console.print(table)


def _print_markdown(all_metrics: dict):
    """Print markdown table."""
    print("| Run | Model | Mode | N | Patched | Rate | Cost | Calls | GN Tools |")
    print("|-----|-------|------|---|---------|------|------|-------|----------|")
    for run_id, m in sorted(all_metrics.items()):
        gn = str(m["total_gn_tool_calls"]) if m["total_gn_tool_calls"] > 0 else "-"
        print(f"| {run_id} | {m['model']} | {m['mode']} | {m['n_instances']} | {m['n_with_patch']} | {m['patch_rate']:.0%} | ${m['total_cost']:.2f} | {m['total_api_calls']} | {gn} |")


def _print_csv(all_metrics: dict):
    """Print CSV output."""
    print("run_id,model,mode,n_instances,n_with_patch,patch_rate,total_cost,avg_cost,total_api_calls,avg_api_calls,total_gn_tool_calls,total_augment_hits,augment_hit_rate")
    for run_id, m in sorted(all_metrics.items()):
        print(
            f"{run_id},{m['model']},{m['mode']},{m['n_instances']},{m['n_with_patch']},"
            f"{m['patch_rate']:.4f},{m['total_cost']:.4f},{m['avg_cost']:.4f},"
            f"{m['total_api_calls']},{m['avg_api_calls']:.1f},{m['total_gn_tool_calls']},"
            f"{m['total_augment_hits']},{m['augment_hit_rate']:.4f}"
        )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app()
