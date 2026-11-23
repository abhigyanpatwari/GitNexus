"""Build and materialize release graphs before any paid agent sessions."""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .mock_provider import MockProvider, Reply
from .process_control import ManagedProcessError, cancellation_scope
from .proposer_sandbox import SandboxError, preflight_bubblewrap, prepare_sandbox, require_claude_sandbox_helpers
from .runner_tasks import resolve_task_bindings, select_tasks
from .runtime_mounts import trusted_gitnexus_runtime_mounts
from .release_controls import check_task_controls
from .sanitized_graph import prepare_sanitized_graph, validate_no_prebuilt_graph_assets
from .task_assets import TaskAssetCache, stage_task_assets


def check_bash_tool(claude_bin: Path, bwrap_bin: Path) -> None:
    """Observe a real Bash result before the release workflow opens a paid session."""
    marker = "gitnexus-release-preflight"
    tool = {"name": "Bash", "input": {"command": f"printf {marker} > bash-probe && cat bash-probe"}}
    with (
        tempfile.TemporaryDirectory(prefix="wfbench-bash-") as directory,
        prepare_sandbox(
            clone=Path(directory), claude_bin=claude_bin, bwrap_bin=bwrap_bin, preflight=False,
            gitnexus_available=False,
        ) as sandbox,
        MockProvider([Reply(tools=[tool])]) as provider,
    ):
        result = sandbox.run(
            [sandbox.claude_bin, "-p", "--model", "claude-sonnet-4-6", "--no-session-persistence",
             "--setting-sources", "", "--settings", sandbox.settings_json, "--strict-mcp-config",
             "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--tools", "Bash",
             "--allowedTools", "Bash", "--max-turns", "3", "--output-format", "json",
             "Check the disposable workspace."],
            env=sandbox.environment(auth_token="offline-preflight", base_url=provider.base_url),
            timeout=90,
        )
        # The CLI can exit zero and finish a model turn even when its sandbox
        # could not launch Bash. Check what the provider received and the file.
        replies = [
            block
            for request in provider.requests
            for message in request.body.get("messages", [])
            if message.get("role") == "user" and isinstance(message.get("content"), list)
            for block in message["content"]
            if block.get("type") == "tool_result" and block.get("tool_use_id") == "toolu_mock_0"
        ]
        content = replies[-1].get("content") if replies else None
        if isinstance(content, list):
            content = "\n".join(b["text"] for b in content if b.get("type") == "text")
        probe = Path(directory) / "bash-probe"
        if not (result.ok and replies and not replies[-1].get("is_error") and content == marker
                and probe.is_file() and probe.read_bytes() == marker.encode()):
            detail = (content or result.stderr_tail or "missing tool result")[:500]
            raise SandboxError(f"Claude Bash failed its offline workspace check: {detail}")


def legacy_sandbox_support(claude_bin: Path) -> tuple[bool, bool]:
    """Report the outer and nested sandbox capabilities of the unchanged host."""
    denials = ("bwrap: setting up uid map: Permission denied",
               "bwrap: No permissions to create new namespace",
               "bwrap: No permissions to create a new namespace")
    try:
        bwrap = preflight_bubblewrap()
    except SandboxError as exc:
        if not any(message in str(exc) for message in denials):
            raise
        return False, False
    require_claude_sandbox_helpers()
    try:
        check_bash_tool(claude_bin, bwrap)
    except SandboxError as exc:
        if not any(message in str(exc) for message in denials):
            raise
        return True, False
    return True, True


def preflight_release(tasks: list[dict[str, Any]], *, gitnexus_root: Path, claude_bin: Path,
                      grading_controls: bool = False) -> None:
    """Exercise the real snapshot/copy path on the same temp filesystem as the runner.

    The tool check uses a loopback fixture. Graphs are rebuilt by the paid
    runner afterwards, preserving its existing provenance and cache lifecycle.
    """
    bwrap_bin = preflight_bubblewrap()
    require_claude_sandbox_helpers()
    check_bash_tool(claude_bin, bwrap_bin)
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
            if grading_controls:
                check_task_controls(task, repo=repo, sha=sha, parent=Path(directory), assets=assets,
                                    claude_bin=claude_bin, bwrap_bin=bwrap_bin)
                print(f"Preflight {task['id']}: negative, reference, and typecheck controls passed", flush=True)
            print(f"Preflight {task['id']}: materialization passed", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--gitnexus-root", required=True, type=Path)
    parser.add_argument("--claude-bin", required=True, type=Path)
    parser.add_argument("--grading-controls", action="store_true", help="require offline controls for the release corpus")
    args = parser.parse_args()
    try:
        document = yaml.safe_load(args.tasks.read_text())
        if not isinstance(document, dict) or not isinstance(document.get("tasks"), list):
            raise ValueError("task file must contain a tasks list")
        tasks, _ = select_tasks(document["tasks"], include_expensive=True)
        with cancellation_scope(handle_signals=True):
            preflight_release(tasks, gitnexus_root=args.gitnexus_root, claude_bin=args.claude_bin,
                              grading_controls=args.grading_controls)
    except (ManagedProcessError, OSError, SandboxError, RuntimeError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
