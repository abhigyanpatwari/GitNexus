#!/usr/bin/env python3
"""
GitNexus SWE-bench Evaluation Runner

Main entry point for running SWE-bench evaluations with and without GitNexus.
Supports running a single configuration or a full matrix of models x modes.

Usage:
    # Single run (default: native_augment mode — GitNexus tools + grep enrichment)
    python run_eval.py single -m claude-sonnet --subset lite --slice 0:5

    # Baseline comparison (no GitNexus)
    python run_eval.py single -m claude-sonnet --mode baseline --subset lite --slice 0:5

    # Matrix run (all models x all modes)
    python run_eval.py matrix --subset lite --slice 0:50 --workers 4

    # Single instance for debugging
    python run_eval.py debug -m claude-haiku -i django__django-16527
"""

import concurrent.futures
import json
import logging
import os
import threading
import time
from itertools import product
from pathlib import Path
from typing import Any

import typer
import yaml
from rich.console import Console
from rich.live import Live
from rich.table import Table

from utils.errors import is_debug_enabled, log_safe_exception

# Load .env file from eval/ directory
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if value and key not in os.environ:  # Don't override existing env vars
                os.environ[key] = value

logger = logging.getLogger("gitnexus_eval")
console = Console()
app = typer.Typer(rich_markup_mode="rich", add_completion=False)

# Directory paths
EVAL_DIR = Path(__file__).parent
CONFIGS_DIR = EVAL_DIR / "configs"
MODELS_DIR = CONFIGS_DIR / "models"
MODES_DIR = CONFIGS_DIR / "modes"
DEFAULT_OUTPUT_DIR = EVAL_DIR / "results"

# Available models and modes (discovered from config files)
AVAILABLE_MODELS = sorted([p.stem for p in MODELS_DIR.glob("*.yaml")])
AVAILABLE_MODES = sorted([p.stem for p in MODES_DIR.glob("*.yaml")])

# SWE-bench dataset mapping (same as mini-swe-agent)
DATASET_MAPPING = {
    "full": "princeton-nlp/SWE-Bench",
    "verified": "princeton-nlp/SWE-Bench_Verified",
    "lite": "princeton-nlp/SWE-Bench_Lite",
}

_output_lock = threading.Lock()


def load_yaml_config(path: Path) -> dict:
    """Load a YAML config file."""
    with open(path) as f:
        return yaml.safe_load(f) or {}


def merge_configs(*configs: dict) -> dict:
    """Recursively merge multiple config dicts (later values win)."""
    result = {}
    for config in configs:
        for key, value in config.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = merge_configs(result[key], value)
            else:
                result[key] = value
    return result


def build_config(model_name: str, mode_name: str) -> dict:
    """Build a complete config from model + mode YAML files."""
    model_file = MODELS_DIR / f"{model_name}.yaml"
    mode_file = MODES_DIR / f"{mode_name}.yaml"

    if not model_file.exists():
        raise FileNotFoundError(f"Model config not found: {model_file}")
    if not mode_file.exists():
        raise FileNotFoundError(f"Mode config not found: {mode_file}")

    model_config = load_yaml_config(model_file)
    mode_config = load_yaml_config(mode_file)

    return merge_configs(mode_config, model_config)


def load_instances(subset: str, split: str, slice_spec: str = "", filter_spec: str = "") -> list[dict]:
    """Load SWE-bench instances."""
    from datasets import load_dataset
    import re

    dataset_path = DATASET_MAPPING.get(subset, subset)
    logger.info(f"Loading dataset: {dataset_path}, split: {split}")
    instances = list(load_dataset(dataset_path, split=split))

    if filter_spec:
        instances = [i for i in instances if re.match(filter_spec, i["instance_id"])]

    if slice_spec:
        values = [int(x) if x else None for x in slice_spec.split(":")]
        instances = instances[slice(*values)]

    logger.info(f"Loaded {len(instances)} instances")
    return instances


def get_swebench_docker_image(instance: dict) -> str:
    """Get Docker image name for a SWE-bench instance."""
    image_name = instance.get("image_name")
    if image_name is None:
        iid = instance["instance_id"]
        id_docker = iid.replace("__", "_1776_")
        image_name = f"docker.io/swebench/sweb.eval.x86_64.{id_docker}:latest".lower()
    return image_name


def _build_model(config: dict):
    """Construct the model from config."""
    from minisweagent.models import get_model

    return get_model(config=config.get("model", {}))


def _build_environment(config: dict, instance: dict):
    """Construct the environment for the instance."""
    env_config = dict(config.get("environment", {}))
    env_class_name = env_config.pop("environment_class", "docker")

    if env_class_name == "eval.environments.gitnexus_docker.GitNexusDockerEnvironment":
        from environments.gitnexus_docker import GitNexusDockerEnvironment

        env_config["image"] = get_swebench_docker_image(instance)
        return GitNexusDockerEnvironment(**env_config)

    from minisweagent.environments.docker import DockerEnvironment

    return DockerEnvironment(image=get_swebench_docker_image(instance), **env_config)


def _build_agent(config: dict, model, env, instance_dir: Path, instance_id: str):
    """Construct the GitNexus agent with trajectory output configured."""
    from agents.gitnexus_agent import GitNexusAgent

    agent_config = dict(config.get("agent", {}))
    agent_config.pop("agent_class", "eval.agents.gitnexus_agent.GitNexusAgent")
    traj_path = instance_dir / f"{instance_id}.traj.json"
    agent_config["output_path"] = traj_path
    return GitNexusAgent(model, env, **agent_config)


def _extract_submission(env, info: dict, run_id: str) -> str:
    """Pull the git diff patch from the container, falling back to the agent submission."""
    try:
        patch_output = env.execute({"command": "cd /testbed && git diff"})
        return patch_output.get("output", "").strip()
    except Exception as patch_err:
        logger.warning(f"[{run_id}] Failed to extract patch: {patch_err}")
        return info.get("submission", "")


def _record_failure(run_id: str, instance_id: str, result: dict, error: Exception):
    sanitized = log_safe_exception(
        logger,
        f"[{run_id}] Error on {instance_id}",
        error,
        include_debug=is_debug_enabled(),
    )
    result["exit_status"] = sanitized["error_type"]
    result["error_type"] = sanitized["error_type"]
    result["error_message"] = sanitized["error_message"]
    result["error"] = sanitized["error_message"]
    if "error_detail_debug" in sanitized:
        result["error_detail_debug"] = sanitized["error_detail_debug"]


def process_instance(
    instance: dict,
    config: dict,
    output_dir: Path,
    model_name: str,
    mode_name: str,
) -> dict:
    """
    Process a single SWE-bench instance with the given config.
    Returns result dict with instance_id, exit_status, submission, metrics.
    """
    instance_id = instance["instance_id"]
    run_id = f"{model_name}_{mode_name}"
    instance_dir = output_dir / run_id / instance_id
    instance_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "instance_id": instance_id,
        "model": model_name,
        "mode": mode_name,
        "exit_status": None,
        "submission": "",
        "cost": 0.0,
        "n_calls": 0,
        "gitnexus_metrics": {},
    }

    agent = None
    env = None

    try:
        model = _build_model(config)
        env = _build_environment(config, instance)
        agent = _build_agent(config, model, env, instance_dir, instance_id)

        # Run
        logger.info(f"[{run_id}] Starting {instance_id}")
        info = agent.run(instance["problem_statement"])

        result["exit_status"] = info.get("exit_status")
        result["cost"] = agent.cost
        result["n_calls"] = agent.n_calls
        result["gitnexus_metrics"] = agent.gitnexus_metrics.to_dict()

        # Extract git diff patch from the container (SWE-bench needs the model_patch)
        result["submission"] = _extract_submission(env, info, run_id)

    except Exception as e:
        _record_failure(run_id, instance_id, result, e)

    finally:
        if agent:
            agent.save(
                instance_dir / f"{instance_id}.traj.json",
                {"instance_id": instance_id, "run_id": run_id},
            )

        # Update predictions file
        _update_preds(output_dir / run_id / "preds.json", instance_id, model_name, result)

    return result


def _update_preds(preds_path: Path, instance_id: str, model_name: str, result: dict):
    """Thread-safe update of predictions file."""
    with _output_lock:
        preds_path.parent.mkdir(parents=True, exist_ok=True)
        data = {}
        if preds_path.exists():
            data = json.loads(preds_path.read_text())
        data[instance_id] = {
            "model_name_or_path": model_name,
            "instance_id": instance_id,
            "model_patch": result.get("submission", ""),
        }
        preds_path.write_text(json.dumps(data, indent=2))


def run_configuration(
    model_name: str,
    mode_name: str,
    instances: list[dict],
    output_dir: Path,
    workers: int = 1,
    redo_existing: bool = False,
) -> list[dict]:
    """Run a single (model, mode) configuration across all instances."""
    config = build_config(model_name, mode_name)
    run_id = f"{model_name}_{mode_name}"
    run_dir = output_dir / run_id

    # Skip existing instances
    if not redo_existing and (run_dir / "preds.json").exists():
        existing = set(json.loads((run_dir / "preds.json").read_text()).keys())
        instances = [i for i in instances if i["instance_id"] not in existing]
        if not instances:
            logger.info(f"[{run_id}] All instances already completed, skipping")
            return []

    console.print(f"  [bold]{run_id}[/bold]: {len(instances)} instances, {workers} workers")

    results = []

    if workers <= 1:
        for instance in instances:
            result = process_instance(instance, config, output_dir, model_name, mode_name)
            results.append(result)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    process_instance, instance, config, output_dir, model_name, mode_name
                ): instance["instance_id"]
                for instance in instances
            }
            for future in concurrent.futures.as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as e:
                    iid = futures[future]
                    log_safe_exception(
                        logger,
                        f"[{run_id}] Uncaught error for {iid}",
                        e,
                        include_debug=is_debug_enabled(),
                    )

    # Save run summary
    summary = {
        "run_id": run_id,
        "model": model_name,
        "mode": mode_name,
        "config": config,
        "total_instances": len(results),
        "completed": sum(1 for r in results if r["exit_status"] not in [None, "error"]),
        "total_cost": sum(r.get("cost", 0) for r in results),
        "total_api_calls": sum(r.get("n_calls", 0) for r in results),
        "results": results,
    }
    (run_dir / "summary.json").mkdir(parents=True, exist_ok=True) if not run_dir.exists() else None
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str))

    return results


# ─── CLI Commands ───────────────────────────────────────────────────────────


@app.command()
def single(
    model: str = typer.Option(..., "-m", "--model", help=f"Model config name. Available: {', '.join(AVAILABLE_MODELS)}"),
    mode: str = typer.Option("native_augment", "--mode", help=f"Evaluation mode. Available: {', '.join(AVAILABLE_MODES)}"),
    subset: str = typer.Option("lite", "--subset", help="SWE-bench subset: lite, verified, full"),
    split: str = typer.Option("dev", "--split", help="Dataset split"),
    slice_spec: str = typer.Option("", "--slice", help="Slice spec (e.g., '0:5')"),
    filter_spec: str = typer.Option("", "--filter", help="Filter instance IDs by regex"),
    workers: int = typer.Option(1, "-w", "--workers", help="Parallel workers"),
    output: str = typer.Option(str(DEFAULT_OUTPUT_DIR), "-o", "--output", help="Output directory"),
    redo: bool = typer.Option(False, "--redo", help="Redo existing instances"),
):
    """Run a single (model, mode) configuration on SWE-bench."""
    output_dir = Path(output)
    instances = load_instances(subset, split, slice_spec, filter_spec)

    console.print(f"\n[bold]Running evaluation:[/bold] {model} + {mode}")
    console.print(f"  Instances: {len(instances)}")
    console.print(f"  Output: {output_dir}\n")

    results = run_configuration(model, mode, instances, output_dir, workers, redo)

    # Print summary
    _print_summary(results, model, mode)


@app.command()
def matrix(
    models: list[str] = typer.Option(AVAILABLE_MODELS, "-m", "--models", help="Models to evaluate (comma-separated or repeated)"),
    modes: list[str] = typer.Option(AVAILABLE_MODES, "--modes", help="Modes to evaluate"),
    subset: str = typer.Option("lite", "--subset", help="SWE-bench subset"),
    split: str = typer.Option("dev", "--split", help="Dataset split"),
    slice_spec: str = typer.Option("", "--slice", help="Slice spec"),
    filter_spec: str = typer.Option("", "--filter", help="Filter instances by regex"),
    workers: int = typer.Option(1, "-w", "--workers", help="Parallel workers per config"),
    output: str = typer.Option(str(DEFAULT_OUTPUT_DIR), "-o", "--output", help="Output directory"),
    redo: bool = typer.Option(False, "--redo", help="Redo existing instances"),
):
    """Run the full evaluation matrix: all models x all modes."""
    output_dir = Path(output)
    instances = load_instances(subset, split, slice_spec, filter_spec)

    combos = list(product(models, modes))
    console.print(f"\n[bold]Matrix evaluation:[/bold] {len(models)} models x {len(modes)} modes = {len(combos)} configs")
    console.print(f"  Models: {', '.join(models)}")
    console.print(f"  Modes: {', '.join(modes)}")
    console.print(f"  Instances per config: {len(instances)}")
    console.print(f"  Total runs: {len(combos) * len(instances)}")
    console.print(f"  Output: {output_dir}\n")

    all_results = {}
    for model_name, mode_name in combos:
        run_id = f"{model_name}_{mode_name}"
        console.print(f"\n[bold cyan]━━━ {run_id} ━━━[/bold cyan]")
        results = run_configuration(model_name, mode_name, instances, output_dir, workers, redo)
        all_results[run_id] = results

    # Print comparative summary
    _print_matrix_summary(all_results)

    # Save master summary
    master = {
        "timestamp": time.time(),
        "models": models,
        "modes": modes,
        "subset": subset,
        "n_instances": len(instances),
        "runs": {
            run_id: {
                "total": len(results),
                "cost": sum(r.get("cost", 0) for r in results),
                "api_calls": sum(r.get("n_calls", 0) for r in results),
            }
            for run_id, results in all_results.items()
        },
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "matrix_summary.json").write_text(json.dumps(master, indent=2, default=str))
    console.print(f"\n[green]Results saved to {output_dir}[/green]")


@app.command()
def debug(
    model: str = typer.Option("claude-haiku", "-m", "--model", help="Model config name"),
    mode: str = typer.Option("native_augment", "--mode", help="Evaluation mode"),
    instance_id: str = typer.Option(..., "-i", "--instance", help="SWE-bench instance ID"),
    subset: str = typer.Option("lite", "--subset", help="SWE-bench subset"),
    split: str = typer.Option("dev", "--split"),
    output: str = typer.Option(str(DEFAULT_OUTPUT_DIR / "debug"), "-o", "--output"),
):
    """Debug a single SWE-bench instance."""
    from datasets import load_dataset

    dataset_path = DATASET_MAPPING.get(subset, subset)
    instances = {inst["instance_id"]: inst for inst in load_dataset(dataset_path, split=split)}

    if instance_id not in instances:
        console.print(f"[red]Instance '{instance_id}' not found in {subset}/{split}[/red]")
        raise typer.Exit(1)

    instance = instances[instance_id]
    config = build_config(model, mode)
    output_dir = Path(output)

    console.print(f"\n[bold]Debug run:[/bold] {model} + {mode}")
    console.print(f"  Instance: {instance_id}")
    console.print(f"  Problem: {instance['problem_statement'][:200]}...\n")

    result = process_instance(instance, config, output_dir, model, mode)
    _print_summary([result], model, mode)


@app.command()
def list_configs():
    """List available model and mode configurations."""
    console.print("\n[bold]Available Models:[/bold]")
    for name in AVAILABLE_MODELS:
        config = load_yaml_config(MODELS_DIR / f"{name}.yaml")
        model_name = config.get("model", {}).get("model_name", "unknown")
        console.print(f"  {name:<20} {model_name}")

    console.print("\n[bold]Available Modes:[/bold]")
    for name in AVAILABLE_MODES:
        config = load_yaml_config(MODES_DIR / f"{name}.yaml")
        gn_mode = config.get("agent", {}).get("gitnexus_mode", "baseline")
        console.print(f"  {name:<20} gitnexus_mode={gn_mode}")

    console.print(f"\n[bold]Matrix:[/bold] {len(AVAILABLE_MODELS)} models x {len(AVAILABLE_MODES)} modes = {len(AVAILABLE_MODELS) * len(AVAILABLE_MODES)} configurations")


# ─── Summary Output ────────────────────────────────────────────────────────


def _print_summary(results: list[dict], model: str, mode: str):
    """Print a summary table for a single run."""
    if not results:
        console.print("[yellow]No results to display[/yellow]")
        return

    table = Table(title=f"{model} + {mode}")
    table.add_column("Metric", style="bold")
    table.add_column("Value")

    total = len(results)
    completed = sum(1 for r in results if r.get("submission"))
    total_cost = sum(r.get("cost", 0) for r in results)
    total_calls = sum(r.get("n_calls", 0) for r in results)

    table.add_row("Instances", str(total))
    table.add_row("Completed", f"{completed}/{total}")
    table.add_row("Total Cost", f"${total_cost:.4f}")
    table.add_row("Total API Calls", str(total_calls))
    table.add_row("Avg Cost/Instance", f"${total_cost / max(total, 1):.4f}")
    table.add_row("Avg Calls/Instance", f"{total_calls / max(total, 1):.1f}")

    # GitNexus-specific metrics
    gn_tool_calls = sum(
        r.get("gitnexus_metrics", {}).get("total_tool_calls", 0) for r in results
    )
    gn_augment_hits = sum(
        r.get("gitnexus_metrics", {}).get("augmentation_hits", 0) for r in results
    )
    if gn_tool_calls > 0:
        table.add_row("GitNexus Tool Calls", str(gn_tool_calls))
    if gn_augment_hits > 0:
        table.add_row("Augmentation Hits", str(gn_augment_hits))

    console.print(table)


def _print_matrix_summary(all_results: dict[str, list[dict]]):
    """Print a comparative matrix summary."""
    table = Table(title="Evaluation Matrix Summary")
    table.add_column("Configuration", style="bold")
    table.add_column("Instances")
    table.add_column("Completed")
    table.add_column("Cost")
    table.add_column("API Calls")
    table.add_column("GN Tools")

    for run_id, results in sorted(all_results.items()):
        total = len(results)
        completed = sum(1 for r in results if r.get("submission"))
        cost = sum(r.get("cost", 0) for r in results)
        calls = sum(r.get("n_calls", 0) for r in results)
        gn_calls = sum(r.get("gitnexus_metrics", {}).get("total_tool_calls", 0) for r in results)

        table.add_row(
            run_id,
            str(total),
            f"{completed}/{total}",
            f"${cost:.2f}",
            str(calls),
            str(gn_calls) if gn_calls > 0 else "-",
        )

    console.print(table)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
    app()
