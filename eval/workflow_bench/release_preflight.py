"""Build and materialize release graphs before any paid agent sessions."""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .process_control import ManagedProcessError, cancellation_scope
from .proposer_sandbox import SandboxError, preflight_bubblewrap, require_claude_sandbox_helpers
from .runner_tasks import resolve_task_bindings, select_tasks
from .runtime_mounts import trusted_gitnexus_runtime_mounts
from .sanitized_graph import prepare_sanitized_graph, validate_no_prebuilt_graph_assets
from .task_assets import TaskAssetCache, stage_task_assets


def preflight_release(tasks: list[dict[str, Any]], *, gitnexus_root: Path, claude_bin: Path) -> None:
    """Exercise the real snapshot/copy path on the same temp filesystem as the runner.

    No provider or session code is involved. Graphs are rebuilt by the paid
    runner afterwards, preserving its existing provenance and cache lifecycle.
    """
    bwrap_bin = preflight_bubblewrap()
    require_claude_sandbox_helpers()
    mounts = trusted_gitnexus_runtime_mounts(root=gitnexus_root)
    with (
        tempfile.TemporaryDirectory(prefix="wfbench-preflight-") as directory,
        TaskAssetCache(Path(directory) / ".task-assets") as cache,
    ):
        bindings = resolve_task_bindings(tasks, task_asset_cache=cache)
        graphs = {}
        for task, binding in zip(tasks, bindings, strict=True):
            validate_no_prebuilt_graph_assets(task)
            repo = Path(binding["repo_identity"])
            sha = binding["resolved_sha"]
            key = (str(repo), sha)
            if key not in graphs:
                graphs[key] = prepare_sanitized_graph(
                    task, repo=repo, resolved_sha=sha, parent=Path(directory), cache=cache,
                    claude_bin=claude_bin, bwrap_bin=bwrap_bin, runtime_mounts=mounts,
                )
            graph = graphs[key]
            assets = cache.prepare(task, repo=repo, resolved_sha=sha, expected_dependency_binding=binding)
            print(f"Preflight {task['id']}: graph snapshot {graph.assets.total_bytes} bytes", flush=True)
            with tempfile.TemporaryDirectory(prefix="probe-", dir=directory) as probe:
                clone = Path(probe)
                graph.materialize(clone, sanitized_head=graph.sanitized_head)
                stage_task_assets(task, repo=repo, clone=clone, snapshot=assets)
            print(f"Preflight {task['id']}: materialization passed", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--gitnexus-root", required=True, type=Path)
    parser.add_argument("--claude-bin", required=True, type=Path)
    args = parser.parse_args()
    try:
        document = yaml.safe_load(args.tasks.read_text())
        if not isinstance(document, dict) or not isinstance(document.get("tasks"), list):
            raise ValueError("task file must contain a tasks list")
        tasks, _ = select_tasks(document["tasks"], include_expensive=True)
        with cancellation_scope(handle_signals=True):
            preflight_release(tasks, gitnexus_root=args.gitnexus_root, claude_bin=args.claude_bin)
    except (ManagedProcessError, OSError, SandboxError, RuntimeError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
