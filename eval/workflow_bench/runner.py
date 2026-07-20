"""Benchmark the gitnexus-plan/work workflow against a baseline agent.

Usage:
    uv run --locked --extra dev python -m workflow_bench.runner \
        --tasks workflow_bench/tasks.scenarios.yaml --runs 3 \
        --model claude-sonnet-4-20250514

Each task runs in a fresh detached git worktree of the target repo, once per
arm per run:

* ``workflow`` — two headless Claude Code sessions: gitnexus-plan, then
  gitnexus-work on the produced plan.
* ``candidate_workflow`` / ``candidate_workflow_direct`` — the matching
  workflow arm with a prompt-only candidate overlay committed in its clone.
* ``baseline`` — one headless session with the same task text and the Skill
  tool disallowed (so it cannot borrow the workflow), everything else equal.

Token usage, cost, duration, and turn counts come from the CLI's own
``--output-format json`` report — nothing is estimated. Caveat: the report's
top-level ``usage`` counts ONLY the main-loop session; ``total_cost_usd`` is
the only reported number that includes subagent spend. A task's model-visible
``verify`` command is retained as an authored-test quality signal; ``resolved``
also requires its harness-owned hidden behavioral oracle. Token savings on
unresolved runs are reported but flagged, because saving tokens by failing is
not a saving.

Trust model: task files and candidate prompts are executable input. Every
setup, verifier, and model session runs inside a preflighted Linux Bubblewrap
boundary with an allowlisted environment, isolated home, PID namespace,
self-contained clone, and task-declared read-only dependencies. Unsupported
or unavailable containment fails before model invocation (README § Trust
model).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import statistics
import tempfile
import time
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .evolution import (
    CANDIDATE_ARMS,
    EVIDENCE_MAX_AGE_DAYS,
    EVALUATED_ARM_SKILLS,
    MAIN_LOOP_ONLY_METRICS,
    MAIN_LOOP_ONLY_WARNING,
    PROMOTION_METRICS,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    required_candidate_arms,
    skill_fingerprint,
)
from .oracle_assets import (
    ORACLE_ENV_VAR,
    TaskOracleSnapshot,
    capture_task_oracles,
    sanitize_clone_for_hidden_oracles,
    staged_task_oracle,
)
from .process_control import ManagedProcessError
from .promotion_apply import committed_destination_base_digests
from .proposer_sandbox import (
    SANDBOX_GITNEXUS as SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_REGISTRY,
    SANDBOX_GITNEXUS_SHARED as SANDBOX_GITNEXUS_SHARED,
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    SandboxSession,
    build_sandbox_environment,
    preflight_bubblewrap,
    prepare_sandbox,
    redact_text,
    require_claude_sandbox_helpers,
)
from .runner_artifacts import (
    IMPLEMENTATION_ARMS,
    MAX_PATCH_BYTES as MAX_PATCH_BYTES,
    MAX_WORKSPACE_SNAPSHOT_ENTRIES as MAX_WORKSPACE_SNAPSHOT_ENTRIES,
    MAX_WORKSPACE_SNAPSHOT_FILE_BYTES as MAX_WORKSPACE_SNAPSHOT_FILE_BYTES,
    MAX_WORKSPACE_SNAPSHOT_PATH_BYTES as MAX_WORKSPACE_SNAPSHOT_PATH_BYTES,
    _bounded_regular_bytes,
    _prepare_untracked_for_diff,
    _sandbox_git,
    capture_patch,
    diff_churn,
    enforce_phase_workspace,
    enforce_work_evidence,
    implementation_diff_digest,
    make_worktree,
    new_plan_doc,
    parse_shortstat as parse_shortstat,
    remove_clone,
    require_skill_fingerprint,
    run_verify,
    snapshot_plan_docs,
    VerificationResult,
    workspace_snapshot,
)
from .runner_sessions import (
    BUILTIN_AGENT_TOOLS as BUILTIN_AGENT_TOOLS,
    GITNEXUS_MUTATING_TOOLS as GITNEXUS_MUTATING_TOOLS,
    GITNEXUS_READ_ONLY_TOOLS as GITNEXUS_READ_ONLY_TOOLS,
    MAX_TRANSCRIPT_BYTES as MAX_TRANSCRIPT_BYTES,
    SANDBOX_GITNEXUS_ENTRYPOINT as SANDBOX_GITNEXUS_ENTRYPOINT,
    USAGE_FIELDS,
    allowed_agent_tools,
    run_claude,
    sandbox_mcp_config,
    sum_sessions,
)
from .runner_tasks import (
    normalized_model_identifier,
    resolve_task_bindings,
    select_tasks,
    selected_task_bindings as selected_task_bindings,
)
from .sanitized_graph import (
    SanitizedGraphSnapshot,
    prepare_sanitized_graph,
    validate_no_prebuilt_graph_assets,
)
from .runtime_mounts import (
    CE_ARMS,
    HARNESS_ROOT as HARNESS_ROOT,
    PINNED_GITNEXUS_VERSION as PINNED_GITNEXUS_VERSION,
    ce_plugin_dir_for_arm,
    ce_plugin_mounts_for_arm,
    staged_ce_plugin_snapshot,
    trusted_gitnexus_runtime_mounts,
    validate_ce_plugin_inputs,
)
from .task_assets import TaskAssetCache, TaskAssetSnapshot, stage_task_assets

PLAN_PROMPT = (
    "Use the gitnexus-plan skill for: {task}\n"
    "Headless run: make reasonable choices without asking; the plan document "
    "is the deliverable."
)
# Appended to every work-arm prompt. In a headless `claude -p` session there
# is no later turn: backgrounded test runs and scheduled wakeups never come
# back, so a session that "waits" for verification ends unverified (observed:
# a work arm backgrounded its slow tests, scheduled three wakeups that never
# fired, and reported done while two tests failed).
HEADLESS_VERIFY = (
    " Verification must be observed inside this session: run the typecheck "
    "and test commands in the foreground to completion and report their "
    "actual output — never background them or wait on scheduled wakeups."
)
WORK_PROMPT = (
    "Use the gitnexus-work skill to execute the plan at {plan}.\n"
    "Headless run: proceed without asking; report Definition of Done status "
    "at the end." + HEADLESS_VERIFY
)
WORK_DIRECT_PROMPT = (
    "Use the gitnexus-work skill for: {task}\n"
    "Headless run: proceed without asking. The user explicitly declines a "
    "separate planning pass — execute in direct mode with the skill's "
    "execution discipline." + HEADLESS_VERIFY
)
BASELINE_PROMPT = (
    "{task}\n\n"
    "Implement the change in this repository and verify it by running the "
    "relevant tests. Work autonomously without asking questions."
)
# External-comparator arms: the compound-engineering plugin's plan/work family,
# prompted with the same structure as the gitnexus arms so only the skill
# family differs. The plugin ships user-level, so clones need no repo files.
CE_PLAN_PROMPT = (
    "Use the ce-plan skill (compound-engineering plugin) for: {task}\n"
    "Headless run: make reasonable choices without asking; the plan document "
    "is the deliverable."
)
CE_WORK_PROMPT = (
    "Use the ce-work skill (compound-engineering plugin) to execute the plan "
    "at {plan}.\n"
    "Headless run: proceed without asking; report completion status at the "
    "end." + HEADLESS_VERIFY
)
CE_WORK_DIRECT_PROMPT = (
    "Use the ce-work skill (compound-engineering plugin) for: {task}\n"
    "Headless run: proceed without asking. The user explicitly declines a "
    "separate planning pass — execute directly with the skill's execution "
    "discipline." + HEADLESS_VERIFY
)
# Review cell: the task's `setup` applies the diff under review as local
# changes; both arms review the same working tree and write to the same file
# so `verify` can gate on a produced review.
REVIEW_PROMPT = (
    "Use the gitnexus-review skill to review the local uncommitted changes "
    "in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external; write the complete review to review-output.md in the "
    "repository root."
)
CE_REVIEW_PROMPT = (
    "Use the ce-code-review skill (compound-engineering plugin) to review "
    "the local uncommitted changes in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external; write the complete review to review-output.md in the "
    "repository root."
)


# Skill each arm's session(s) must actually invoke; a session that never ran
# its skill is a silent no-op arm, not a data point (checked via transcript).
ARM_EXPECTED_SKILLS: dict[str, tuple[str, ...]] = {
    "workflow": ("gitnexus-plan", "gitnexus-work"),
    "ce_workflow": ("ce-plan", "ce-work"),
    "workflow_direct": ("gitnexus-work",),
    "ce_workflow_direct": ("ce-work",),
    "review": ("gitnexus-review",),
    "ce_review": ("ce-code-review",),
}


def _require_implementation_fingerprint(
    session: dict[str, Any],
    worktree: Path,
    arm: str,
    expected: str | None,
) -> None:
    """Bind a just-finished implementation session to its original skill bytes."""

    try:
        require_skill_fingerprint(
            worktree,
            arm,
            expected,
            phase="implementation",
        )
    except ValueError as exc:
        if session.get("error_kind") is None:
            session["ok"] = False
            session["error_kind"] = "implementation-evidence-invalid"
            session["error_detail"] = str(exc)
        else:
            session.setdefault("evidence_diagnostics", []).append(str(exc))


def _verification_outcome(result: VerificationResult | tuple[bool, str]) -> tuple[bool, str]:
    if isinstance(result, VerificationResult):
        if result.process.state != "exited":
            # Hidden-oracle output can contain mounted test bytes. Preserve
            # terminal-state evidence without letting candidate-controlled
            # stdout/stderr enter results.jsonl through the exception string.
            safe_process = replace(
                result.process,
                stdout_tail="",
                stderr_tail="",
                detail=result.process.detail or "verifier infrastructure failed",
            )
            raise ManagedProcessError(result.command, safe_process)
        return result.passed, result.output
    return result


def _run_hidden_oracle(
    snapshot: TaskOracleSnapshot,
    worktree: Path,
    args: argparse.Namespace,
    sandbox: SandboxSession,
) -> tuple[bool, str]:
    """Stage a captured oracle after the model exits, execute it, then erase it."""

    if worktree.expanduser().absolute() != sandbox.clone.expanduser().absolute():
        raise SandboxError("hidden oracle sandbox does not bind the credited worktree")
    mount_name = f".wfbench-oracle-{secrets.token_hex(16)}"
    mount_point = worktree / mount_name
    mount_point.mkdir(mode=0o700)
    primary: BaseException | None = None
    try:
        with staged_task_oracle(sandbox.private_root, snapshot) as stage_root:
            oracle_env = build_sandbox_environment()
            # A private RO bind at a random workspace sibling preserves each
            # oracle's ../gitnexus import as the candidate implementation. The
            # empty mountpoint exists only post-model and is removed before the
            # credited patch is captured.
            oracle_mount = f"{SANDBOX_WORKSPACE}/{mount_name}"
            oracle_env[ORACLE_ENV_VAR] = oracle_mount
            passed, _output = _verification_outcome(
                run_verify(
                    snapshot.command,
                    sandbox.clone,
                    args.timeout,
                    command_prefix=sandbox.command_prefix_for(
                        read_only_workspace=True,
                        unshare_network=True,
                        extra_read_only_mounts=(ReadOnlyMount(source=stage_root, target=oracle_mount),),
                    ),
                    env=oracle_env,
                    require_pid_namespace=True,
                )
            )
            # Candidate code executes in this process. Never persist its stdout
            # or stderr: it can read the mounted hidden test bytes and print them.
            return passed, "hidden oracle passed" if passed else "hidden oracle failed"
    except BaseException as exc:
        primary = exc
        raise
    finally:
        try:
            metadata = mount_point.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise SandboxError("hidden oracle mountpoint changed type during verification")
            mount_point.rmdir()
        except (OSError, SandboxError) as cleanup:
            if primary is None:
                raise
            primary.add_note(f"hidden oracle mountpoint cleanup also failed: {cleanup}")


def _evaluated_skill_roots(worktree: Path, arm: str) -> tuple[Path, ...]:
    """Repo-local prompt roots that must remain immutable during a session."""

    return tuple(worktree / ".claude" / "skills" / name for name in EVALUATED_ARM_SKILLS.get(arm, ()))


def isolated_gitnexus_registry_mount(worktree: Path, parent: Path) -> ReadOnlyMount:
    """Create a one-clone registry that cannot route MCP to any host repo."""

    metadata_path = worktree / ".gitnexus" / "gitnexus.json"
    if not metadata_path.exists():
        metadata_path = worktree / ".gitnexus" / "meta.json"
    mode = metadata_path.lstat().st_mode
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise SandboxError(f"benchmark index metadata must be regular and non-symlink: {metadata_path}")
    raw = _bounded_regular_bytes(metadata_path, limit=2 * 1024 * 1024)
    try:
        metadata = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SandboxError(f"benchmark index metadata is malformed: {metadata_path}") from exc
    if not isinstance(metadata, dict):
        raise SandboxError(f"benchmark index metadata must be an object: {metadata_path}")
    indexed_at = metadata.get("indexedAt")
    last_commit = metadata.get("lastCommit")
    if not isinstance(indexed_at, str) or not indexed_at or not isinstance(last_commit, str) or not last_commit:
        raise SandboxError("benchmark index metadata is missing indexedAt or lastCommit")

    parent = parent.expanduser().absolute()
    registry = Path(tempfile.mkdtemp(prefix="wfbench-registry-", dir=parent))
    registry.chmod(0o700)
    entry: dict[str, Any] = {
        "name": "benchmark-target",
        "path": SANDBOX_WORKSPACE,
        "storagePath": f"{SANDBOX_WORKSPACE}/.gitnexus",
        "indexedAt": indexed_at,
        "lastCommit": last_commit,
    }
    for field in ("remoteUrl", "stats", "branch"):
        if field in metadata:
            entry[field] = metadata[field]
    registry_file = registry / "registry.json"
    descriptor = os.open(
        registry_file,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        payload = (json.dumps([entry], sort_keys=True, separators=(",", ":")) + "\n").encode()
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
    finally:
        os.close(descriptor)
    return ReadOnlyMount(source=registry, target=SANDBOX_GITNEXUS_REGISTRY)


def run_arm(
    arm: str,
    task: dict[str, Any],
    worktree: Path,
    args: argparse.Namespace,
    *,
    sandbox: SandboxSession,
    transcript_output_dir: Path | None = None,
    transcript_output_prefix: str | None = None,
    expected_skill_digest: str | None = None,
    enforce_phase_boundary: bool = False,
    ce_plugin_dir: str | None = None,
    oracle_snapshot: TaskOracleSnapshot | None = None,
) -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    env = build_sandbox_environment(
        auth_token=args.auth_token,
        base_url=args.base_url,
    )
    # --bare hard-disables the Skill tool and every mcp__* tool — by Claude
    # Code design, not a bug (--allowedTools can't restore what --bare
    # removes). Every arm except baseline_nomcp needs Skill and/or MCP tools,
    # so only baseline_nomcp can keep --bare's tighter isolation; the rest
    # rely on ANTHROPIC_API_KEY alone (the sandboxed HOME has no OAuth/
    # keychain state to conflict with it).
    bare = arm == "baseline_nomcp"
    common = {
        "claude_bin": sandbox.claude_bin,
        "timeout": args.timeout,
        "model": args.model,
        "env": env,
        "permission_mode": "dontAsk",
        "command_prefix": sandbox.command_prefix_for(
            read_only_paths=_evaluated_skill_roots(worktree, arm),
        ),
        "require_pid_namespace": True,
        "bare": bare,
        "settings_json": sandbox.settings_json,
        "strict_mcp_config": True,
        "mcp_config_json": sandbox_mcp_config(),
        "transcript_projects": sandbox.transcript_projects,
        "transcript_cwd": Path(SANDBOX_WORKSPACE),
        "transcript_wait_seconds": 5,
        "transcript_output_dir": transcript_output_dir,
        "transcript_output_prefix": transcript_output_prefix,
        "transcript_secrets": tuple(secret for secret in (args.auth_token,) if secret),
    }
    if ce_plugin_dir is not None:
        common["plugin_dirs"] = (ce_plugin_dir,)
    expected_skills = ARM_EXPECTED_SKILLS.get(arm, ())
    plan_doc: Path | None = None
    if arm in ("workflow", "ce_workflow"):
        plan_prompt = PLAN_PROMPT if arm == "workflow" else CE_PLAN_PROMPT
        work_prompt = WORK_PROMPT if arm == "workflow" else CE_WORK_PROMPT
        pre = snapshot_plan_docs(worktree)
        phase_before = workspace_snapshot(worktree) if enforce_phase_boundary else None
        plan_session = run_claude(
            plan_prompt.format(task=task["prompt"]),
            worktree,
            expected_skill=expected_skills[0],
            **{**common, "allowed_tools": allowed_agent_tools(implementation=False)},
        )
        sessions.append(plan_session)
        if plan_session["ok"]:
            try:
                plan_doc = new_plan_doc(worktree, pre)
                if phase_before is not None:
                    enforce_phase_workspace(
                        worktree,
                        phase_before,
                        allowed_artifact=plan_doc,
                    )
                    require_skill_fingerprint(
                        worktree,
                        arm,
                        expected_skill_digest,
                        phase="planning",
                    )
            except ValueError as exc:
                plan_session["ok"] = False
                plan_session["error_kind"] = "plan-evidence-invalid"
                plan_session["error_detail"] = str(exc)
            else:
                work_session = run_claude(
                    work_prompt.format(plan=plan_doc.relative_to(worktree)),
                    worktree,
                    expected_skill=expected_skills[1],
                    **{**common, "allowed_tools": allowed_agent_tools(implementation=True)},
                )
                _require_implementation_fingerprint(
                    work_session,
                    worktree,
                    arm,
                    expected_skill_digest,
                )
                sessions.append(work_session)
    elif arm == "ce_workflow_direct":
        work_session = run_claude(
            CE_WORK_DIRECT_PROMPT.format(task=task["prompt"]),
            worktree,
            expected_skill=expected_skills[0],
            **{**common, "allowed_tools": allowed_agent_tools(implementation=True)},
        )
        _require_implementation_fingerprint(
            work_session,
            worktree,
            arm,
            expected_skill_digest,
        )
        sessions.append(work_session)
    elif arm in ("review", "ce_review"):
        review_prompt = REVIEW_PROMPT if arm == "review" else CE_REVIEW_PROMPT
        phase_before = workspace_snapshot(worktree) if enforce_phase_boundary else None
        review_session = run_claude(
            review_prompt.format(task=task["prompt"]),
            worktree,
            expected_skill=expected_skills[0],
            **{**common, "allowed_tools": allowed_agent_tools(implementation=False)},
        )
        sessions.append(review_session)
        if review_session["ok"] and phase_before is not None:
            try:
                enforce_phase_workspace(
                    worktree,
                    phase_before,
                    allowed_artifact=worktree / "review-output.md",
                )
                require_skill_fingerprint(
                    worktree,
                    arm,
                    expected_skill_digest,
                    phase="review",
                )
            except ValueError as exc:
                review_session["ok"] = False
                review_session["error_kind"] = "review-evidence-invalid"
                review_session["error_detail"] = str(exc)
    elif arm == "workflow_direct":
        work_session = run_claude(
            WORK_DIRECT_PROMPT.format(task=task["prompt"]),
            worktree,
            expected_skill=expected_skills[0],
            **{**common, "allowed_tools": allowed_agent_tools(implementation=True)},
        )
        _require_implementation_fingerprint(
            work_session,
            worktree,
            arm,
            expected_skill_digest,
        )
        sessions.append(work_session)
    elif arm == "baseline_nomcp":
        # Isolates the workflow-discipline question from the GitNexus-tools
        # question: no skills AND no graph tools.
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill", "mcp__gitnexus"],
                **{
                    **common,
                    "mcp_config_json": '{"mcpServers":{}}',
                    "allowed_tools": allowed_agent_tools(
                        implementation=True,
                        include_mcp=False,
                    ),
                },
            )
        )
    else:
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill"],
                **{**common, "allowed_tools": allowed_agent_tools(implementation=True)},
            )
        )
    record = sum_sessions(sessions)
    record["arm"] = arm
    record["plan_produced"] = arm not in ("workflow", "ce_workflow") or plan_doc is not None
    authored_tests_passed, authored_test_output = _verification_outcome(
        run_verify(
            task["verify"],
            worktree,
            args.timeout,
            command_prefix=sandbox.command_prefix_for(
                read_only_workspace=True,
                unshare_network=True,
            ),
            env=build_sandbox_environment(),
            require_pid_namespace=True,
        )
    )
    if oracle_snapshot is None:
        oracle_passed, oracle_output = False, "hidden oracle snapshot unavailable"
    else:
        oracle_passed, oracle_output = _run_hidden_oracle(
            oracle_snapshot,
            worktree,
            args,
            sandbox,
        )
    record["authored_tests_passed"] = authored_tests_passed
    record["authored_test_output"] = authored_test_output
    record["oracle_passed"] = oracle_passed
    record["oracle_output"] = oracle_output
    record["resolved"] = record["ok"] and authored_tests_passed and oracle_passed
    # Compatibility alias for existing report consumers. The authored tests are
    # now an explicit signal and can never self-certify resolution.
    record["verify_output"] = authored_test_output
    if oracle_snapshot is not None:
        record.update(
            {
                "oracle_digest": oracle_snapshot.digest,
                "oracle_command_digest": oracle_snapshot.command_digest,
                "oracle_manifest_digest": oracle_snapshot.manifest_digest,
            }
        )
    if record["error_kind"] is None and not authored_tests_passed:
        # The sessions completed — the produced change just failed the task's
        # verify command. Kept distinct from session-error so aggregates can
        # exclude infrastructure deaths without hiding real failures.
        record["error_kind"] = "verify-failed"
    elif record["error_kind"] is None and not oracle_passed:
        record["error_kind"] = "oracle-failed" if oracle_snapshot is not None else "oracle-unavailable"
    return record


# ─── Pure aggregation/report helpers (unit-tested) ──────────────────────────


CHURN_FIELDS = ("diff_files", "diff_insertions", "diff_deletions")

# Rows where the session (or the harness) died carry no measured evidence and
# must not skew efficiency medians or resolve denominators. verify-failed and
# skill-not-invoked rows DO count: those sessions ran and spent real tokens.
EXCLUDED_ERROR_KINDS = frozenset({"session-error", "infra-error", "evidence-unverified", "cleanup-failure"})

# A sustained upstream outage shows up as a run of session/infra/cleanup
# failures. (cleanup-failure overwrites the primary error_kind, so a
# session-error whose worktree cleanup also failed still counts.) A task's own
# resolved=False is real signal, not an outage, so it never trips the breaker.
SYSTEMIC_ERROR_KINDS = frozenset({"session-error", "infra-error", "cleanup-failure"})
DEFAULT_OUTAGE_STREAK = 5


def systemic_outage_streak(error_kind: str | None, prior_streak: int) -> int:
    """Consecutive systemic-failure count: +1 on a systemic kind, else reset to 0."""
    return prior_streak + 1 if error_kind in SYSTEMIC_ERROR_KINDS else 0


def infra_error_record(exc: BaseException) -> dict[str, Any]:
    """Row for a run the harness itself killed (timeout, setup failure)."""
    if isinstance(exc, ManagedProcessError):
        process = exc.result
        detail = f"{process.state}: {process.detail or process.stderr_tail[-1500:]}"
    else:
        detail = f"{type(exc).__name__}: {exc}"
    record: dict[str, Any] = dict.fromkeys(USAGE_FIELDS, 0)
    record.update(
        {
            "ok": False,
            "resolved": False,
            "error_kind": "infra-error",
            "error_detail": detail[:2000],
            "session_ids": [],
            "cost_usd": 0.0,
            "duration_s": 0.0,
            "num_turns": 0,
            "plan_produced": False,
            "authored_tests_passed": False,
            "authored_test_output": "",
            "oracle_passed": False,
            "oracle_output": "",
            "verify_output": "",
            "skill_invoked": None,
            "transcript_missing": False,
        }
    )
    return record


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Median metrics + resolve rate across repeated runs of one task+arm.

    Session/infra-error rows are excluded from the medians (they measured
    nothing); ``valid_runs``/``excluded_runs`` make the exclusion visible.
    """
    valid = [r for r in records if r.get("error_kind") not in EXCLUDED_ERROR_KINDS]
    metrics = (*USAGE_FIELDS, "duration_s", "num_turns", *CHURN_FIELDS)
    out: dict[str, Any] = {m: statistics.median(r.get(m, 0) for r in (valid or [{}])) for m in metrics}
    # cost_usd can be None (unmeasured) on an otherwise-valid run; a single
    # unmeasured run makes the whole median unavailable so the gate won't rank
    # a candidate on a cost that was never actually captured.
    valid_costs = [r.get("cost_usd") for r in valid]
    out["cost_usd"] = None if (not valid or any(cost is None for cost in valid_costs)) else statistics.median(valid_costs)
    out["resolved"] = sum(1 for r in records if r["resolved"])
    out["runs"] = len(records)
    out["valid_runs"] = len(valid)
    out["excluded_runs"] = len(records) - len(valid)
    out["transcripts_missing"] = sum(1 for r in records if r.get("transcript_missing"))
    out["class"] = records[0].get("class", "")
    return out


def savings(baseline: dict[str, Any], workflow: dict[str, Any]) -> dict[str, Any]:
    """Percent saved by the workflow arm per metric (positive = cheaper)."""
    out: dict[str, Any] = {}
    for metric in (*USAGE_FIELDS, "cost_usd", "duration_s"):
        base = baseline.get(metric)
        arm = workflow.get(metric)
        if base is None or arm is None:
            out[metric] = None
        else:
            out[metric] = round(100 * (base - arm) / base, 1) if base else 0.0
    return out


def _na(value: Any) -> Any:
    """Render an unmeasured metric as ``n/a`` instead of a misleading number."""
    return "n/a" if value is None else value


def _cost_cell(value: Any) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def render_report(results: dict[str, dict[str, dict[str, Any]]]) -> str:
    """results: {task_id: {arm: aggregate}} → markdown report."""
    lines = [
        "# gitnexus workflow benchmark",
        "",
        "Medians across runs; savings rows = (baseline − arm) / baseline per arm.",
        "A negative saving means that arm spent more than baseline. churn =",
        "files/+insertions/−deletions vs the worktree's starting commit.",
        "",
        "**WARNING:** token columns count only each arm's main-loop session —",
        "subagent spend is invisible to them and flatters subagent-heavy arms.",
        "cost $ is the only column that includes subagent spend; to rank token",
        "efficiency, sum usage from the session transcripts instead",
        "(dedup events sharing one message.id).",
        "",
        "| task | class | arm | resolved | input | cache_create | cache_read | output | cost $ | wall s | turns | churn |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for task_id, arms in results.items():
        for arm, agg in arms.items():
            excluded = agg.get("excluded_runs", 0)
            resolved_cell = f"{agg['resolved']}/{agg.get('valid_runs', agg['runs'])}"
            if excluded:
                resolved_cell += f" ({excluded} excluded)"
            lines.append(
                f"| {task_id} | {agg['class']} | {arm} | {resolved_cell} "
                f"| {agg['input_tokens']:.0f} | {agg['cache_creation_input_tokens']:.0f} "
                f"| {agg['cache_read_input_tokens']:.0f} | {agg['output_tokens']:.0f} "
                f"| {_cost_cell(agg['cost_usd'])} | {agg['duration_s']:.0f} | {agg['num_turns']:.0f} "
                f"| {agg['diff_files']:.0f}/+{agg['diff_insertions']:.0f}/−{agg['diff_deletions']:.0f} |"
            )
        for arm in arms:
            if arm != "baseline" and "baseline" in arms:
                s = savings(arms["baseline"], arms[arm])
                lines.append(
                    f"| {task_id} | {arms[arm]['class']} | **{arm} savings %** | — "
                    f"| {s['input_tokens']} | {s['cache_creation_input_tokens']} "
                    f"| {s['cache_read_input_tokens']} | {s['output_tokens']} "
                    f"| {_na(s['cost_usd'])} | {s['duration_s']} | — | — |"
                )
    lines.append("")
    all_aggs = [agg for arms in results.values() for agg in arms.values()]
    excluded_total = sum(agg.get("excluded_runs", 0) for agg in all_aggs)
    if excluded_total:
        lines.append(
            f"{excluded_total} run(s) hit session/infra errors or had unverifiable "
            "evidence and were excluded "
            "from medians and resolve denominators — see error_kind in results.jsonl."
        )
    missing_total = sum(agg.get("transcripts_missing", 0) for agg in all_aggs)
    if missing_total:
        lines.append(
            f"{missing_total} run(s) had no locatable session transcript or it was "
            "unreadable, so they were excluded from promotion evidence "
            "(skill_invoked=null in results.jsonl)."
        )
    lines.append(
        "Session ids for every run are in results.jsonl — open the matching "
        "transcript to see where each arm spent its tokens."
    )
    return "\n".join(lines)


# ─── Main ────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument(
        "--outage-streak",
        type=int,
        default=DEFAULT_OUTAGE_STREAK,
        help="abort the sweep after this many consecutive session/infra/cleanup "
        "failures (0 disables the circuit breaker)",
    )
    parser.add_argument(
        "--arms",
        nargs="+",
        default=["workflow", "workflow_direct", "baseline"],
        choices=[
            "workflow",
            "candidate_workflow",
            "workflow_direct",
            "candidate_workflow_direct",
            "ce_workflow",
            "ce_workflow_direct",
            "review",
            "ce_review",
            "baseline",
            "baseline_nomcp",
        ],
    )
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument(
        "--ce-plugin-dir",
        type=Path,
        default=None,
        help="operator-supplied Compound Engineering plugin directory; required for ce_* arms",
    )
    parser.add_argument(
        "--ce-plugin-version",
        default=None,
        help="exact Compound Engineering plugin version; required for ce_* arms",
    )
    parser.add_argument("--timeout", type=int, default=3600, help="per session, seconds")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--model",
        required=True,
        help="named, versioned model passed to every `claude --model` invocation",
    )
    parser.add_argument(
        "--proposer-model",
        default=None,
        help="model that generated the candidate overlay (recorded for provenance)",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="ANTHROPIC_BASE_URL override — point at an Anthropic-compatible "
        "proxy (see free-model.litellm.yaml) to run on a free model",
    )
    parser.add_argument(
        "--auth-token",
        default=os.environ.get("GITNEXUS_BENCH_AUTH_TOKEN"),
        help="ANTHROPIC_API_KEY for the --base-url endpoint (prefer GITNEXUS_BENCH_AUTH_TOKEN env)",
    )
    parser.add_argument(
        "--include-expensive",
        action="store_true",
        help="include scenarios marked expensive: true (excluded by default)",
    )
    parser.add_argument(
        "--candidate-overlay",
        type=Path,
        default=None,
        help="directory mirroring .claude/skills/gitnexus-{plan,work}; applied only to candidate_* arms",
    )
    parser.add_argument(
        "--promotion-metric",
        choices=PROMOTION_METRICS,
        default="cost_usd",
        help="efficiency metric used by the deterministic candidate gate; "
        "cost_usd (default) is the only CLI-reported number that includes "
        "subagent spend — token metrics count only the main loop",
    )
    parser.add_argument("--promotion-min-runs", type=int, default=3)
    parser.add_argument("--promotion-min-improvement", type=float, default=5.0)
    parser.add_argument("--promotion-max-task-regression", type=float, default=20.0)
    parser.add_argument("--task-bindings-json", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--promotion-target-bases-json", default=None, help=argparse.SUPPRESS)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.model = normalized_model_identifier(args.model)
        args.proposer_model = (
            normalized_model_identifier(args.proposer_model, flag="--proposer-model")
            if args.proposer_model is not None
            else None
        )
        task_document = yaml.safe_load(args.tasks.read_text())
        if not isinstance(task_document, Mapping) or not isinstance(task_document.get("tasks"), list):
            raise ValueError("task file must contain a tasks list")
        tasks, skipped_expensive = select_tasks(
            task_document["tasks"],
            include_expensive=args.include_expensive,
        )
        oracle_snapshots = capture_task_oracles(tasks)
        expected_task_bindings = json.loads(args.task_bindings_json) if args.task_bindings_json else None
        if expected_task_bindings is not None and not isinstance(expected_task_bindings, list):
            raise ValueError("--task-bindings-json must contain a list")
        supplied_promotion_target_bases = (
            json.loads(args.promotion_target_bases_json) if args.promotion_target_bases_json else {}
        )
        if not isinstance(supplied_promotion_target_bases, dict) or not all(
            isinstance(path, str) and isinstance(digest, str)
            for path, digest in supplied_promotion_target_bases.items()
        ):
            raise ValueError("--promotion-target-bases-json must contain a string mapping")
        ce_plugin_config = validate_ce_plugin_inputs(
            args.arms,
            args.ce_plugin_dir,
            args.ce_plugin_version,
        )
    except (OSError, SandboxError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))
        raise AssertionError("ArgumentParser.error() returned unexpectedly")

    candidate_arms = [arm for arm in args.arms if arm in CANDIDATE_ARMS]
    if candidate_arms and args.candidate_overlay is None:
        parser.error("candidate_* arms require --candidate-overlay")
    if args.candidate_overlay is not None and not candidate_arms:
        parser.error("--candidate-overlay requires at least one candidate_* arm")
    for candidate_arm in candidate_arms:
        incumbent_arm = CANDIDATE_ARMS[candidate_arm]
        if incumbent_arm not in args.arms:
            parser.error(f"{candidate_arm} must be paired with {incumbent_arm}")
    if args.runs < 1 or args.promotion_min_runs < 1:
        parser.error("--runs and --promotion-min-runs must be positive")

    candidate_overlay = args.candidate_overlay.expanduser().absolute() if args.candidate_overlay is not None else None
    overlay_digest = candidate_overlay_digest(candidate_overlay) if candidate_overlay is not None else None
    if candidate_overlay is not None:
        required_candidates = required_candidate_arms(candidate_overlay)
        required_arms = [arm for candidate in required_candidates for arm in (CANDIDATE_ARMS[candidate], candidate)]
        if args.arms != required_arms:
            parser.error("candidate overlay requires exactly these paired arms: " + " ".join(required_arms))
        try:
            promotion_target_bases = committed_destination_base_digests(candidate_overlay)
        except ValueError as exc:
            # Overlay adds a promotion target with no committed base — a clean
            # CLI error, not a traceback.
            parser.error(str(exc))
            raise AssertionError("ArgumentParser.error() returned unexpectedly")
        if supplied_promotion_target_bases and supplied_promotion_target_bases != promotion_target_bases:
            parser.error("--promotion-target-bases-json does not match the committed incumbent")
    else:
        if supplied_promotion_target_bases:
            parser.error("--promotion-target-bases-json requires --candidate-overlay")
        promotion_target_bases = {}

    try:
        bwrap_bin = preflight_bubblewrap()
        require_claude_sandbox_helpers()
        runtime_mounts = trusted_gitnexus_runtime_mounts()
    except SandboxError as exc:
        parser.error(str(exc))
        raise AssertionError("ArgumentParser.error() returned unexpectedly")
    out_dir = args.out or Path("results") / time.strftime("wfbench-%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"
    selected_ids = [task["id"] for task in tasks]
    print(
        f"selected {len(selected_ids)} task(s): {', '.join(selected_ids)}; "
        f"skipped {len(skipped_expensive)} expensive task(s): "
        f"{', '.join(skipped_expensive) if skipped_expensive else 'none'}"
    )

    results: dict[str, dict[str, dict[str, Any]]] = {}
    outage_streak = 0
    outage_tripped = False
    with (
        tempfile.TemporaryDirectory(prefix="wfbench-trees-") as trees,
        TaskAssetCache(Path(trees) / ".task-assets") as task_asset_cache,
        staged_ce_plugin_snapshot(
            ce_plugin_config,
            destination_parent=Path(trees),
        ) as ce_plugin_snapshot,
    ):
        try:
            task_bindings = resolve_task_bindings(
                tasks,
                expected_task_bindings,
                oracle_snapshots=oracle_snapshots,
                task_asset_cache=task_asset_cache,
            )
        except (OSError, SandboxError, ValueError) as exc:
            parser.error(str(exc))
            raise AssertionError("ArgumentParser.error() returned unexpectedly")
        oracle_mask = Path(trees) / ".oracle-mask"
        oracle_mask.mkdir(mode=0o500)
        oracle_mask.chmod(0o500)
        graph_snapshots: dict[tuple[str, str], SanitizedGraphSnapshot] = {}
        graph_snapshot_errors: dict[tuple[str, str], BaseException] = {}
        for task, task_binding, oracle_snapshot in zip(
            tasks,
            task_bindings,
            oracle_snapshots,
            strict=True,
        ):
            if outage_tripped:
                break
            repo = Path(task_binding["repo_identity"])
            task_sha = task_binding["resolved_sha"]
            asset_snapshot: TaskAssetSnapshot | None = None
            asset_snapshot_error: BaseException | None = None
            graph_key = (str(repo), task_sha)
            graph_snapshot: SanitizedGraphSnapshot | None = graph_snapshots.get(graph_key)
            graph_snapshot_error: BaseException | None = graph_snapshot_errors.get(graph_key)
            try:
                validate_no_prebuilt_graph_assets(task)
                if graph_snapshot is None and graph_snapshot_error is None:
                    graph_snapshot = prepare_sanitized_graph(
                        task,
                        repo=repo,
                        resolved_sha=task_sha,
                        parent=Path(trees),
                        cache=task_asset_cache,
                        claude_bin=args.claude_bin,
                        bwrap_bin=bwrap_bin,
                        runtime_mounts=runtime_mounts,
                    )
                    graph_snapshots[graph_key] = graph_snapshot
            except (ManagedProcessError, OSError, SandboxError, RuntimeError, ValueError) as exc:
                graph_snapshot_error = exc
                graph_snapshot_errors[graph_key] = exc
            per_arm: dict[str, list[dict[str, Any]]] = {a: [] for a in args.arms}
            for run_idx in range(args.runs):
                if outage_tripped:
                    break
                for arm in args.arms:
                    if outage_tripped:
                        break
                    worktree: Path | None = None
                    record: dict[str, Any] | None = None
                    cleanup_error: OSError | None = None
                    try:
                        if asset_snapshot_error is not None:
                            raise RuntimeError(f"task asset snapshot preparation failed: {asset_snapshot_error}")
                        if graph_snapshot_error is not None:
                            raise RuntimeError(f"sanitized graph snapshot preparation failed: {graph_snapshot_error}")
                        if graph_snapshot is None:
                            raise RuntimeError("sanitized graph snapshot is unavailable")
                        if asset_snapshot is None:
                            try:
                                asset_snapshot = task_asset_cache.prepare(
                                    task,
                                    repo=repo,
                                    resolved_sha=task_sha,
                                    expected_dependency_binding=task_binding,
                                )
                            except (OSError, SandboxError, ValueError) as exc:
                                asset_snapshot_error = exc
                                raise
                        worktree = make_worktree(repo, task_sha, Path(trees))
                        sanitized_head = sanitize_clone_for_hidden_oracles(worktree)
                        graph_snapshot.materialize(worktree, sanitized_head=sanitized_head)
                        dependency_mounts = stage_task_assets(
                            task,
                            repo=repo,
                            clone=worktree,
                            snapshot=asset_snapshot,
                        )
                        registry_mount = isolated_gitnexus_registry_mount(worktree, Path(trees))
                        hidden_harness = worktree / "eval" / "workflow_bench"
                        oracle_visibility_mounts: list[ReadOnlyMount] = []
                        if hidden_harness.exists() or hidden_harness.is_symlink():
                            hidden_metadata = hidden_harness.lstat()
                            if stat.S_ISLNK(hidden_metadata.st_mode) or not stat.S_ISDIR(hidden_metadata.st_mode):
                                raise SandboxError(
                                    "benchmark harness path must be a real directory before it can be hidden"
                                )
                            oracle_visibility_mounts.append(
                                ReadOnlyMount(
                                    source=oracle_mask,
                                    target=f"{SANDBOX_WORKSPACE}/eval/workflow_bench",
                                )
                            )
                        execution_arm = CANDIDATE_ARMS.get(arm, arm)
                        ce_mounts = ce_plugin_mounts_for_arm(execution_arm, ce_plugin_snapshot)
                        with prepare_sandbox(
                            clone=worktree,
                            claude_bin=args.claude_bin,
                            bwrap_bin=bwrap_bin,
                            read_only_mounts=[
                                *dependency_mounts,
                                *runtime_mounts,
                                registry_mount,
                                *ce_mounts,
                                *oracle_visibility_mounts,
                            ],
                            preflight=False,
                        ) as sandbox:
                            # Capture the BASE (pre-overlay) skill digest — identical
                            # for the incumbent and candidate arms — then run the
                            # task's untrusted setup against those base skills. The
                            # candidate overlay is applied only afterwards, so setup
                            # can never observe candidate prose and both arms share
                            # byte-identical pre-overlay state.
                            base_skill_digest = skill_fingerprint(worktree, execution_arm)
                            if task.get("setup"):
                                setup_command = ["/bin/sh", "-lc", str(task["setup"])]
                                setup = sandbox.run(
                                    setup_command,
                                    timeout=600,
                                    env=build_sandbox_environment(),
                                )
                                if not setup.ok:
                                    raise ManagedProcessError(setup_command, setup)
                            # Tamper-evidence: setup must not have rewritten the base
                            # skills, verified before any candidate overlay lands.
                            require_skill_fingerprint(
                                worktree,
                                execution_arm,
                                base_skill_digest,
                                phase="task setup",
                            )
                            if arm in CANDIDATE_ARMS:
                                assert candidate_overlay is not None
                                applied_digest = apply_candidate_overlay(
                                    candidate_overlay,
                                    worktree,
                                    sandbox=sandbox,
                                )
                                if applied_digest != overlay_digest:
                                    raise RuntimeError("candidate overlay changed during the benchmark run")
                            # The digest the model must preserve during its run is the
                            # post-overlay skill surface (candidate skills for
                            # candidate arms; unchanged base skills otherwise).
                            expected_skill_digest = skill_fingerprint(worktree, execution_arm)
                            orig_sha = _sandbox_git(sandbox, ["rev-parse", "HEAD"]).strip()
                            if not re.fullmatch(r"[0-9a-fA-F]{40,64}", orig_sha):
                                raise RuntimeError("sandboxed candidate setup did not produce an immutable commit")
                            before_work_digest = (
                                implementation_diff_digest(sandbox, orig_sha)
                                if execution_arm in IMPLEMENTATION_ARMS
                                else ""
                            )
                            record = run_arm(
                                execution_arm,
                                task,
                                worktree,
                                args,
                                sandbox=sandbox,
                                transcript_output_dir=out_dir,
                                transcript_output_prefix=f"{task['id']}-{arm}-run{run_idx}",
                                expected_skill_digest=expected_skill_digest,
                                enforce_phase_boundary=True,
                                ce_plugin_dir=ce_plugin_dir_for_arm(execution_arm, ce_plugin_snapshot),
                                oracle_snapshot=oracle_snapshot,
                            )
                            _prepare_untracked_for_diff(sandbox)
                            after_work_digest = (
                                implementation_diff_digest(
                                    sandbox,
                                    orig_sha,
                                    prepare_untracked=False,
                                )
                                if execution_arm in IMPLEMENTATION_ARMS
                                else ""
                            )
                            record.update(
                                diff_churn(
                                    sandbox,
                                    orig_sha,
                                    prepare_untracked=False,
                                )
                            )
                            enforce_work_evidence(
                                record,
                                arm=execution_arm,
                                before_digest=before_work_digest,
                                after_digest=after_work_digest,
                            )
                            patch_bytes = capture_patch(sandbox, worktree, orig_sha)
                        record["arm"] = arm
                        record.update(
                            {
                                "model": args.model,
                                "benchmark_model": args.model,
                                "proposer_model": args.proposer_model,
                                "task_ref": task.get("ref", "HEAD"),
                                "task_base_sha": task_sha,
                                "sanitized_task_sha": sanitized_head,
                                "variant_head_sha": orig_sha,
                                "task_prompt_digest": hashlib.sha256(task["prompt"].encode()).hexdigest(),
                                "skill_digest": expected_skill_digest,
                                "candidate_overlay_digest": (overlay_digest if arm in CANDIDATE_ARMS else None),
                                "recorded_at": datetime.now(UTC).isoformat(),
                            }
                        )
                        # Final working-tree patch — the clone is destroyed, so
                        # this is the only artifact for diagnosing verify fails.
                        patch_path = out_dir / f"{task['id']}-{arm}-run{run_idx}.patch"
                        patch_path.write_bytes(patch_bytes)
                    except (
                        ManagedProcessError,
                        SandboxError,
                        OSError,
                        RuntimeError,
                        ValueError,
                    ) as exc:
                        # One hung session or failed setup must not abort the
                        # sweep — record the run as infra-error and move on so
                        # report.md/promotion.json still get written.
                        record = infra_error_record(exc)
                        record["arm"] = arm
                        print(f"[{task['id']}][{arm}][run {run_idx}] infra-error: {exc}")
                    finally:
                        if worktree is not None and worktree.exists():
                            try:
                                remove_clone(worktree)
                            except OSError as exc:
                                cleanup_error = exc
                    assert record is not None
                    if cleanup_error is not None:
                        primary_kind = record.get("error_kind")
                        primary_detail = record.get("error_detail")
                        record["resolved"] = False
                        record["ok"] = False
                        record["error_kind"] = "cleanup-failure"
                        record["error_detail"] = (
                            f"primary={primary_kind}: {primary_detail}; cleanup: "
                            f"{type(cleanup_error).__name__}: {cleanup_error}"
                        )[:2000]
                    record.update(
                        {
                            "task": task["id"],
                            "class": task.get("class", ""),
                            "run": run_idx,
                            "task_asset_snapshot_digest": (
                                asset_snapshot.digest if asset_snapshot is not None else None
                            ),
                            "task_asset_manifest_digest": (
                                asset_snapshot.manifest_digest if asset_snapshot is not None else None
                            ),
                            "sandbox_dependency_content_digest": (
                                asset_snapshot.dependency_content_digest if asset_snapshot is not None else None
                            ),
                            "sandbox_dependency_manifest_digest": (
                                asset_snapshot.dependency_manifest_digest if asset_snapshot is not None else None
                            ),
                            "sanitized_graph_snapshot_digest": (
                                graph_snapshot.digest if graph_snapshot is not None else None
                            ),
                            "sanitized_graph_manifest_digest": (
                                graph_snapshot.manifest_digest if graph_snapshot is not None else None
                            ),
                            "oracle_digest": oracle_snapshot.digest,
                            "oracle_command_digest": oracle_snapshot.command_digest,
                            "oracle_manifest_digest": oracle_snapshot.manifest_digest,
                            "ce_plugin_version": (
                                ce_plugin_snapshot.version
                                if arm in CE_ARMS and ce_plugin_snapshot is not None
                                else None
                            ),
                            "ce_plugin_manifest_digest": (
                                ce_plugin_snapshot.manifest_digest
                                if arm in CE_ARMS and ce_plugin_snapshot is not None
                                else None
                            ),
                        }
                    )
                    per_arm[arm].append(record)
                    with results_path.open("a") as fh:
                        # Redact any API token a session-error stderr_tail
                        # echoed into error_detail before it enters the uploaded
                        # results.jsonl artifact (transcripts are redacted; this
                        # sink was not).
                        fh.write(redact_text(json.dumps(record), [args.auth_token or ""]) + "\n")
                    print(
                        f"[{task['id']}][{arm}][run {run_idx}] resolved={record['resolved']} "
                        f"in={record['input_tokens']} out={record['output_tokens']} "
                        f"cost=${_na(record['cost_usd'])}"
                    )
                    outage_streak = systemic_outage_streak(record.get("error_kind"), outage_streak)
                    if args.outage_streak and outage_streak >= args.outage_streak:
                        outage_tripped = True
                        print(
                            f"[systemic-outage] {outage_streak} consecutive session/infra/cleanup "
                            "failures — aborting the remaining sweep; report and promotion are written "
                            "from partial evidence and the run exits non-zero."
                        )
                        break
            results[task["id"]] = {a: aggregate(rs) for a, rs in per_arm.items() if rs}

    selection_report = [
        "## Run provenance",
        "",
        f"Benchmark model: `{args.model}`",
        f"Proposer model: `{args.proposer_model}`",
        f"Selected tasks ({len(selected_ids)}): {', '.join(selected_ids)}",
        (
            f"Skipped expensive tasks ({len(skipped_expensive)}): "
            + (", ".join(skipped_expensive) if skipped_expensive else "none")
        ),
    ]
    if ce_plugin_snapshot is not None:
        selection_report.append(
            f"Compound Engineering plugin: `{ce_plugin_snapshot.version}` (`{ce_plugin_snapshot.manifest_digest}`)"
        )
    report = render_report(results) + "\n\n" + "\n".join(selection_report) + "\n"
    (out_dir / "report.md").write_text(report)
    if candidate_arms:
        promotion_generated_at = datetime.now(UTC)
        promotion = {
            # Schema 3 is the first promotion evidence that requires hidden,
            # byte-bound behavioral oracles. Older self-authored-only rows are
            # intentionally ineligible for application.
            "schema_version": 3,
            "generated_at": promotion_generated_at.isoformat(),
            "evidence_expires_at": (promotion_generated_at + timedelta(days=EVIDENCE_MAX_AGE_DAYS)).isoformat(),
            "benchmark_model": args.model,
            "proposer_model": args.proposer_model,
            "candidate_origin": ("model-proposer" if args.proposer_model is not None else "manual-initial-overlay"),
            "candidate_overlay": str(candidate_overlay),
            "candidate_overlay_digest": overlay_digest,
            "target_base_digests": promotion_target_bases,
            "required_candidate_arms": candidate_arms,
            "selected_tasks": task_bindings,
            "ce_plugin": ce_plugin_snapshot.provenance if ce_plugin_snapshot is not None else None,
            "policy": {
                "metric": args.promotion_metric,
                "metric_warning": (MAIN_LOOP_ONLY_WARNING if args.promotion_metric in MAIN_LOOP_ONLY_METRICS else None),
                "min_runs": args.promotion_min_runs,
                "min_improvement_pct": args.promotion_min_improvement,
                "max_task_regression_pct": args.promotion_max_task_regression,
                "quality_rule": "no per-task resolution-rate regression",
                "max_age_days": EVIDENCE_MAX_AGE_DAYS,
            },
            "decisions": [
                evaluate_candidate(
                    results,
                    incumbent_arm=CANDIDATE_ARMS[candidate_arm],
                    candidate_arm=candidate_arm,
                    model=args.model,
                    metric=args.promotion_metric,
                    min_runs=args.promotion_min_runs,
                    min_improvement_pct=args.promotion_min_improvement,
                    max_task_regression_pct=args.promotion_max_task_regression,
                )
                for candidate_arm in candidate_arms
            ],
        }
        (out_dir / "promotion.json").write_text(json.dumps(promotion, indent=2) + "\n")
    print(f"\n{report}\n\nWritten to {out_dir}/")
    if outage_tripped:
        # Non-zero exit so a driver (evolve.py) treats the partial benchmark as a
        # failed run and halts instead of proposing from outage-truncated evidence.
        raise SystemExit(1)


if __name__ == "__main__":
    main()
