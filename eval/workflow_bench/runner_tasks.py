"""Model and immutable task-binding validation for workflow benchmarks."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .oracle_assets import TaskOracleSnapshot, capture_task_oracles, validate_oracle_declaration
from .process_control import run_checked, run_managed
from .task_assets import TaskAssetCache, capture_task_dependency_binding


def normalized_model_identifier(value: str | None, *, flag: str = "--model") -> str:
    model = (value or "").strip()
    if not model:
        raise ValueError(f"{flag} must name a nonblank, versioned model")
    if re.search(r"(?:^|[-/@:])(?:auto|latest)$", model.casefold()):
        raise ValueError(f"{flag} must not use a mutable auto/latest model alias: {model!r}")
    return model


def select_tasks(tasks: list[Any], *, include_expensive: bool) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate task metadata and filter opt-in expensive scenarios."""

    selected: list[dict[str, Any]] = []
    skipped: list[str] = []
    seen: set[str] = set()
    required_strings = ("id", "class", "repo", "prompt", "verify")
    optional_strings = ("ref", "setup")
    for index, raw_task in enumerate(tasks):
        if not isinstance(raw_task, Mapping):
            raise ValueError(f"task {index} must be a mapping")
        task = dict(raw_task)
        for field in required_strings:
            if not isinstance(task.get(field), str) or not task[field].strip():
                raise ValueError(f"task {index} requires a nonblank string {field}")
        for field in optional_strings:
            if field in task and not isinstance(task[field], str):
                raise ValueError(f"task {task['id']} field {field} must be a string")
        task_id = task["id"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", task_id):
            raise ValueError(f"task id must be a simple artifact-safe slug: {task_id!r}")
        if task_id in seen:
            raise ValueError(f"duplicate task id: {task_id}")
        seen.add(task_id)
        expensive = task.get("expensive", False)
        if not isinstance(expensive, bool):
            raise ValueError(f"task {task_id} expensive metadata must be boolean")
        copies = task.get("sandbox_copy", [])
        if not isinstance(copies, list) or not all(isinstance(path, str) and path for path in copies):
            raise ValueError(f"task {task_id} sandbox_copy must be a string list")
        dependencies = task.get("sandbox_dependencies", [])
        if not isinstance(dependencies, list):
            raise ValueError(f"task {task_id} sandbox_dependencies must be a list")
        for dependency in dependencies:
            if (
                not isinstance(dependency, Mapping)
                or set(dependency) != {"source", "target"}
                or not all(isinstance(dependency[field], str) and dependency[field] for field in ("source", "target"))
            ):
                raise ValueError(
                    f"task {task_id} sandbox_dependencies entries require nonblank source and target strings"
                )
        validate_oracle_declaration(task)
        if expensive and not include_expensive:
            skipped.append(task_id)
        else:
            selected.append(task)
    if not selected:
        raise ValueError("no tasks selected after expensive-task filtering")
    return selected, skipped


def _task_definition_binding(
    task: dict[str, Any],
    repo_identity: Path,
    oracle_snapshot: TaskOracleSnapshot,
    dependency_binding: Mapping[str, str],
) -> dict[str, Any]:
    return {
        "id": task["id"],
        "class": task.get("class", ""),
        "repo_identity": str(repo_identity),
        "ref": task.get("ref", "HEAD"),
        "prompt_digest": hashlib.sha256(task["prompt"].encode()).hexdigest(),
        "setup_digest": hashlib.sha256(str(task.get("setup", "")).encode()).hexdigest(),
        "verify_digest": hashlib.sha256(str(task["verify"]).encode()).hexdigest(),
        "expensive": bool(task.get("expensive", False)),
        "sandbox_copy": list(task.get("sandbox_copy", [])),
        "sandbox_dependencies": [dict(item) for item in task.get("sandbox_dependencies", [])],
        **dependency_binding,
        **oracle_snapshot.binding,
    }


def resolve_task_bindings(
    tasks: list[dict[str, Any]],
    expected: list[dict[str, Any]] | None = None,
    *,
    oracle_snapshots: list[TaskOracleSnapshot] | None = None,
    task_asset_cache: TaskAssetCache | None = None,
) -> list[dict[str, Any]]:
    """Resolve each repo/ref once and optionally honor an upstream immutable pin."""

    if expected is not None and len(expected) != len(tasks):
        raise ValueError("task binding count does not match selected tasks")
    snapshots = oracle_snapshots if oracle_snapshots is not None else capture_task_oracles(tasks)
    if len(snapshots) != len(tasks):
        raise ValueError("oracle snapshot count does not match selected tasks")
    bindings: list[dict[str, Any]] = []
    for index, (task, oracle_snapshot) in enumerate(zip(tasks, snapshots, strict=True)):
        requested_repo = Path(task["repo"]).expanduser().resolve()
        repo_output = run_checked(
            ["git", "-C", str(requested_repo), "rev-parse", "--show-toplevel"],
            timeout=60,
        ).stdout_tail.strip()
        repo_identity = Path(repo_output).resolve()
        if expected is None:
            resolved_sha = run_checked(
                [
                    "git",
                    "-C",
                    str(repo_identity),
                    "rev-parse",
                    f"{task.get('ref', 'HEAD')}^{{commit}}",
                ],
                timeout=60,
            ).stdout_tail.strip()
        else:
            supplied = expected[index]
            if not isinstance(supplied, dict):
                raise ValueError(f"task binding {index} must be an object")
            resolved_sha = str(supplied.get("resolved_sha", ""))
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", resolved_sha):
            raise ValueError(f"task {task['id']} did not resolve to an immutable commit")
        exists = run_managed(
            ["git", "-C", str(repo_identity), "cat-file", "-e", f"{resolved_sha}^{{commit}}"],
            timeout=60,
        )
        if not exists.ok:
            raise ValueError(f"pinned task commit is unavailable for {task['id']}: {resolved_sha}")
        if task_asset_cache is None:
            dependency_binding = capture_task_dependency_binding(
                task,
                repo=repo_identity,
                resolved_sha=resolved_sha.lower(),
            )
        else:
            dependency_binding = task_asset_cache.prepare(
                task,
                repo=repo_identity,
                resolved_sha=resolved_sha.lower(),
            ).dependency_binding
        definition = _task_definition_binding(
            task,
            repo_identity,
            oracle_snapshot,
            dependency_binding,
        )
        if expected is not None:
            supplied_definition = {key: supplied.get(key) for key in definition}
            if supplied_definition != definition:
                raise ValueError(f"task binding definition drifted for {task['id']}")
        bindings.append({**definition, "resolved_sha": resolved_sha.lower()})
    return bindings


def selected_task_bindings(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compatibility wrapper for callers that need newly resolved task pins."""

    return resolve_task_bindings(tasks)
