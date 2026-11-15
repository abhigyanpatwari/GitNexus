"""Offline grading controls using the runner's dependency and sandbox boundaries."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .oracle_assets import ORACLE_ROOT, capture_task_oracle, sanitize_clone_for_hidden_oracles
from .proposer_sandbox import ReadOnlyMount, SandboxError, prepare_sandbox
from .runner import _run_hidden_oracle, _verification_outcome
from .runner_artifacts import make_worktree, run_verify
from .task_assets import stage_task_assets

REFERENCES = {
    "trivial-status-json-alias": "trivial-status-json-alias",
    "inv-feature-c-include-provenance": "inv-feature-c-include-provenance-flag",
    "inv-feature-list-repos-filter": "inv-feature-list-repos-filter",
    "cross-module-parse-retry": "cross-module-parse-retry",
}


def check_task_controls(task: dict[str, Any], *, repo: Path, sha: str, parent: Path,
                        assets: Any, claude_bin: Path, bwrap_bin: Path) -> None:
    """Reject broken setup before spending: base fails assertions, reference passes.

    Reference patches and oracle bytes never enter a paid cell. The probe uses
    the same immutable dependency snapshot and read-only verifier as the runner.
    """
    reference = REFERENCES.get(task["id"])
    if reference is None:
        raise ValueError(f"no offline grading control for release task {task['id']}")
    clone = make_worktree(repo, sha, parent)
    sanitize_clone_for_hidden_oracles(clone)
    mounts = stage_task_assets(task, repo=repo, clone=clone, snapshot=assets)
    snapshot = capture_task_oracle(task)
    args = argparse.Namespace(timeout=180)
    with prepare_sandbox(clone=clone, claude_bin=claude_bin, bwrap_bin=bwrap_bin,
                         read_only_mounts=mounts, preflight=False, gitnexus_available=False) as sandbox:
        negative: dict[str, Any] = {}
        passed, _ = _run_hidden_oracle(snapshot, clone, args, sandbox, diagnostics=negative)
        if (passed or negative.get("exit_code") != 1 or not negative.get("assertion_failure")
                or negative.get("startup_failure") or negative.get("permission_failure")):
            raise SandboxError("negative grading control did not fail on a behavioral assertion")
        patch_mount = ReadOnlyMount(ORACLE_ROOT / "reference" / f"{reference}.patch", "/tmp/reference.patch")
        applied = run_verify(
            "git apply /tmp/reference.patch", clone, 60,
            command_prefix=sandbox.command_prefix_for(unshare_network=True, extra_read_only_mounts=(patch_mount,)),
            env=sandbox.environment(), require_pid_namespace=True,
        )
        if not _verification_outcome(applied)[0]:
            raise SandboxError("reference patch could not be applied in grading control")
        typed = run_verify(
            "cd gitnexus && ./node_modules/.bin/tsc --noEmit", clone, 180,
            command_prefix=sandbox.command_prefix_for(read_only_workspace=True, unshare_network=True),
            env=sandbox.environment(), require_pid_namespace=True,
        )
        if not _verification_outcome(typed)[0]:
            raise SandboxError("reference grading control failed typecheck")
        if not _run_hidden_oracle(snapshot, clone, args, sandbox)[0]:
            raise SandboxError("reference grading control failed the hidden oracle")
