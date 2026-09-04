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
from concurrent.futures import ThreadPoolExecutor, wait
import hashlib
import json
import os
import re
import secrets
import stat
import statistics
import sys
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from functools import partial
from dataclasses import dataclass, replace
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
    MAX_FAILED_TASK_REGRESSION_PCT,
    MIN_GATED_TASK_RATIO,
    PROMOTION_METRICS,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    evaluate_review_candidate,
    required_candidate_arms,
    seed_evaluated_skills,
    skill_fingerprint,
)
from .model_gateway import (
    attach_openai_gateway,
    anthropic_api_key_from_environ,
    credential_secrets,
    model_session_environment,
    openai_api_key_from_environ,
)
from .oracle_assets import (
    ORACLE_ENV_VAR,
    TaskOracleSnapshot,
    capture_task_oracles,
    sanitize_clone_for_hidden_oracles,
    staged_task_oracle,
    with_hidden_harness_apply_exclude,
)
from .process_control import ManagedProcessError
from .promotion_apply import committed_destination_base_digests
from .review_scoring import REVIEW_OUTPUT, expected_findings, parse_review_output, score_review
from .proposer_sandbox import (
    SANDBOX_GITNEXUS as SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_REGISTRY,
    SANDBOX_GITNEXUS_SHARED as SANDBOX_GITNEXUS_SHARED,
    SANDBOX_NODE as SANDBOX_NODE,
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    SandboxSession,
    build_sandbox_environment,
    preflight_bubblewrap,
    preflight_unsafe_host,
    prepare_sandbox,
    redact_text,
    require_claude_sandbox_helpers,
    sandbox_workspace_write_boundary,
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
    SESSION_TIMEOUT_SECONDS,
    USAGE_FIELDS,
    _na,
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
    CePluginSnapshot,
    HARNESS_ROOT as HARNESS_ROOT,
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
# Review cell: setup applies a historical PR diff, then the model sees a
# read-only checkout. Both arms emit the same strict artifact so quality can be
# scored deterministically against labels that remain hidden until it exits.
REVIEW_OUTPUT_CONTRACT = """
Write /workspace/review-output.json as UTF-8 JSON with exactly this shape:
{{"schema_version":1,"verdict":"approve|comment|request_changes","findings":[{{
"id":"unique stable id","severity":"critical|high|medium|low",
"path":"repository-relative changed file","line":1,"end_line":1,
"category":"correctness|security|compatibility|performance|tests|other",
"scenario":"specific failure scenario","evidence":"concrete code/graph evidence",
"recommendation":"bounded fix","blocking":true}}]}}
Use an empty findings list with verdict approve when there are no actionable
defects. Do not emit Markdown and do not edit any other file.
"""
REVIEW_PROMPT = (
    "Use the gitnexus-review skill to review the local uncommitted changes "
    "in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external." + REVIEW_OUTPUT_CONTRACT
)
CE_REVIEW_PROMPT = (
    "Use the ce-code-review skill (compound-engineering plugin) to review "
    "the local uncommitted changes in this repository. {task}\n"
    "Headless run: proceed without asking; do not post to GitHub or anywhere "
    "external." + REVIEW_OUTPUT_CONTRACT
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
                    require_pid_namespace=getattr(sandbox, "require_pid_namespace", True),
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


def _unchanged(value: Any) -> Any:
    return value


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
    environment_builder = getattr(sandbox, "environment", build_sandbox_environment)
    host_text = getattr(sandbox, "host_text", _unchanged)
    host_path = getattr(sandbox, "host_path", lambda value: str(value))
    backend = getattr(sandbox, "backend", "bwrap")
    env = model_session_environment(
        auth_token=args.auth_token,
        base_url=args.base_url,
        model=args.model,
        build_sandbox_environment=environment_builder,
    )
    # --bare hard-disables the Skill tool and every mcp__* tool — by Claude
    # Code design, not a bug (--allowedTools can't restore what --bare
    # removes). Every arm except baseline_nomcp needs Skill and/or MCP tools,
    # so only baseline_nomcp can keep --bare's tighter isolation; the rest
    # rely on ANTHROPIC_API_KEY alone (the sandboxed HOME has no OAuth/
    # keychain state to conflict with it).
    bare = arm == "baseline_nomcp"
    progress_label = transcript_output_prefix or f"{task.get('id', 'task')}-{arm}"
    common = {
        "progress_label": progress_label,
        "claude_bin": sandbox.claude_bin,
        "timeout": args.timeout,
        "model": args.model,
        "effort": args.effort,
        "env": env,
        "permission_mode": (
            "bypassPermissions" if backend == "host-unsafe" else "dontAsk"
        ),
        "command_prefix": sandbox.command_prefix_for(
            read_only_paths=_evaluated_skill_roots(worktree, arm),
        ),
        "require_pid_namespace": getattr(sandbox, "require_pid_namespace", True),
        "bare": bare,
        "settings_json": sandbox.settings_json,
        "strict_mcp_config": True,
        "mcp_config_json": host_text(sandbox_mcp_config()),
        "transcript_projects": sandbox.transcript_projects,
        "transcript_cwd": Path(SANDBOX_WORKSPACE),
        "transcript_wait_seconds": 5,
        "transcript_output_dir": transcript_output_dir,
        "transcript_output_prefix": transcript_output_prefix,
        "transcript_secrets": tuple(credential_secrets(args)),
    }
    if ce_plugin_dir is not None:
        common["plugin_dirs"] = (host_path(ce_plugin_dir),)
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
            **{
                **common,
                "progress_label": f"{progress_label} plan",
                "allowed_tools": allowed_agent_tools(implementation=False),
            },
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
                    **{
                        **common,
                        "progress_label": f"{progress_label} work",
                        "allowed_tools": allowed_agent_tools(implementation=True),
                    },
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
        review_output = worktree / REVIEW_OUTPUT
        review_output.write_text("")
        phase_before = workspace_snapshot(worktree) if enforce_phase_boundary else None
        review_common = {
            **common,
            "allowed_tools": allowed_agent_tools(implementation=False, allow_edit=False),
            "command_prefix": sandbox.command_prefix_for(
                read_only_workspace=True,
                read_only_paths=_evaluated_skill_roots(worktree, arm),
                extra_writable_mounts=(
                    ReadOnlyMount(
                        source=review_output,
                        target=f"{SANDBOX_WORKSPACE}/{REVIEW_OUTPUT}",
                    ),
                ),
            ),
        }
        with sandbox_workspace_write_boundary(
            sandbox,
            read_only_workspace=True,
            writable=(review_output,),
        ):
            review_session = run_claude(
                host_text(review_prompt.format(task=task["prompt"])),
                worktree,
                expected_skill=expected_skills[0],
                **review_common,
            )
        sessions.append(review_session)
        if review_session["ok"] and phase_before is not None:
            try:
                enforce_phase_workspace(
                    worktree,
                    phase_before,
                    allowed_artifact=worktree / REVIEW_OUTPUT,
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
            env=environment_builder(),
            require_pid_namespace=getattr(sandbox, "require_pid_namespace", True),
        )
    )
    review_score: dict[str, Any] | None = None
    if arm in ("review", "ce_review"):
        try:
            verdict, findings = parse_review_output(worktree / REVIEW_OUTPUT)
            labels = expected_findings(oracle_snapshot) if oracle_snapshot is not None else ()
            review_score = score_review(verdict, findings, labels)
        except (OSError, ValueError) as exc:
            record["ok"] = False
            record["error_kind"] = record["error_kind"] or "review-evidence-invalid"
            record["error_detail"] = str(exc)
        record["review_score"] = review_score
        if review_score is not None:
            record.update({f"review_{key}": value for key, value in review_score.items()})
    if oracle_snapshot is None:
        oracle_passed, oracle_output = False, "hidden oracle snapshot unavailable"
    elif arm in ("review", "ce_review"):
        oracle_passed = bool(
            review_score
            and review_score["false_positives"] == 0
            and review_score["false_negatives"] == 0
            and review_score["verdict_correct"]
        )
        oracle_output = "hidden review labels matched" if oracle_passed else "hidden review labels not fully matched"
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
EXCLUDED_ERROR_KINDS = frozenset(
    {"session-error", "infra-error", "evidence-unverified", "cleanup-failure", "review-evidence-invalid"}
)

# A sustained upstream outage shows up as a run of session/infra/cleanup
# failures. (cleanup-failure overwrites the primary error_kind, so a
# session-error whose worktree cleanup also failed still counts.) A task's own
# resolved=False is real signal, not an outage, so it never trips the breaker.
SYSTEMIC_ERROR_KINDS = frozenset({"session-error", "infra-error", "cleanup-failure"})
DEFAULT_OUTAGE_STREAK = 5

# A cell is a full clone plus a sandboxed agent session, so the ceiling is the
# machine, not the flag. Past a handful of siblings the cells lose CPU to each
# other, sessions reach their timeout, and a timed-out session is an excluded
# run the promotion gate refuses to work with — a mistyped --workers must fail
# at the command line rather than a quarter-day later as unusable evidence.
MAX_WORKERS = 8


def systemic_outage_streak(error_kind: str | None, prior_streak: int) -> int:
    """Consecutive systemic-failure count: +1 on a systemic kind, else reset to 0."""
    return prior_streak + 1 if error_kind in SYSTEMIC_ERROR_KINDS else 0


def _run_wave(
    wave: Sequence[tuple[int, str]],
    *,
    workers: int,
    run: Callable[[int, str], dict[str, Any]],
) -> list[dict[str, Any] | BaseException]:
    """Run one wave on a pool and settle every future, in submission order.

    The pool is owned explicitly rather than through ``with``: the context
    manager exits through ``shutdown(wait=True)``, so a Ctrl-C would be handed
    back to the operator only once the wave it was meant to abandon had
    finished anyway. Here the interrupt cancels whatever has not started and
    abandons — never joins — whatever has.

    Every future is read even after one of them failed. An exception a cell did
    not expect stays parked inside its Future until something asks for it, so
    skipping the reads would turn a harness bug into a silently missing run
    rather than a crash. Failures are returned rather than raised so the caller
    can persist the rows of the cells that did complete first.
    """
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(run, run_idx, arm) for run_idx, arm in wave]
        wait(futures)
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    # Nothing left to wait for — every future is done — so this only retires
    # the wave's threads instead of leaking one pool's worth per wave.
    pool.shutdown(wait=True)
    outcomes: list[dict[str, Any] | BaseException] = []
    for future in futures:
        error = future.exception()
        outcomes.append(error if error is not None else future.result())
    return outcomes


def sweep_task_cells(
    cells: Sequence[tuple[int, str]],
    *,
    workers: int,
    run: Callable[[int, str], dict[str, Any]],
    on_start: Callable[[int, str], None],
    on_record: Callable[[int, str, dict[str, Any]], None],
    outage_streak: int,
    outage_limit: int,
) -> tuple[int, bool]:
    """Run one task's cells in waves of ``workers``; return (streak, tripped).

    Waves rather than one fan-out, because the outage breaker counts
    CONSECUTIVE systemic failures and "consecutive" only means anything in a
    fixed order — completion order under concurrency is not one. Each wave is
    folded in submission order once it has fully completed, and the next wave
    starts only if the breaker held, so the breaker overruns its limit by at
    most ``workers - 1`` cells: the ones already in flight when it tripped.

    ``workers == 1`` runs the cell directly instead of through a pool of one.
    That is not an optimisation — an async KeyboardInterrupt is delivered only
    to the main thread, so a cell on a worker thread is outside the reach of
    the ownership cleanup that kills its sandboxed process tree.
    """
    if workers < 1:
        raise ValueError("workers must be positive")
    for wave_start in range(0, len(cells), workers):
        wave = list(cells[wave_start : wave_start + workers])
        for run_idx, arm in wave:
            on_start(run_idx, arm)
        if workers == 1:
            records = [run(run_idx, arm) for run_idx, arm in wave]
        else:
            outcomes = _run_wave(wave, workers=workers, run=run)
            failure = next((outcome for outcome in outcomes if isinstance(outcome, BaseException)), None)
            if failure is not None:
                # The siblings of the failing cell have already completed and
                # spent their budget. Persist their rows, in submission order,
                # before the harness bug takes the process down — otherwise a
                # crash in one cell silently erases the evidence of the others.
                for (run_idx, arm), outcome in zip(wave, outcomes, strict=True):
                    if not isinstance(outcome, BaseException):
                        on_record(run_idx, arm, outcome)
                raise failure
            records = [outcome for outcome in outcomes if not isinstance(outcome, BaseException)]
        for (run_idx, arm), record in zip(wave, records, strict=True):
            # Every future in this wave has already completed and incurred its
            # cost. Persist all of them in canonical submission order even if
            # an earlier row trips the breaker; only later waves are skipped.
            on_record(run_idx, arm, record)
        for record in records:
            outage_streak = systemic_outage_streak(record.get("error_kind"), outage_streak)
            if outage_limit and outage_streak >= outage_limit:
                print(
                    f"[systemic-outage] {outage_streak} consecutive session/infra/cleanup "
                    "failures — aborting the remaining sweep; report and promotion are written "
                    "from partial evidence and the run exits non-zero."
                )
                return outage_streak, True
    return outage_streak, False


@dataclass(frozen=True)
class TaskCellContext:
    """Everything one benchmark cell needs from its task, prepared once.

    A cell is one (run, arm) pair: a private clone, a sandboxed session set, and
    the row it produces. Cells of the same task share this context read-only, so
    it is what makes them independent of each other — every per-cell mutable is
    local to ``run_cell``. Holding the fields explicitly, rather than closing
    over ``main``'s scope, is what lets a cell run off the main thread without
    dragging the whole sweep's state along with it.

    ``args`` is treated as immutable: ``main`` finishes mutating it during
    setup, well before any cell starts. ``argparse.Namespace`` cannot enforce
    that, so it is stated here.
    """

    task: dict[str, Any]
    oracle_snapshot: TaskOracleSnapshot
    repo: Path
    task_sha: str
    graph_snapshot: SanitizedGraphSnapshot | None
    graph_snapshot_error: BaseException | None
    asset_snapshot: TaskAssetSnapshot | None
    asset_snapshot_error: BaseException | None
    args: argparse.Namespace
    out_dir: Path
    oracle_mask: Path
    ce_plugin_snapshot: CePluginSnapshot | None
    trees_dir: Path
    bwrap_bin: Path
    runtime_mounts: tuple[ReadOnlyMount, ...]
    candidate_overlay: Path | None
    overlay_digest: str | None
    sandbox_backend: str = "bwrap"


def run_cell(ctx: TaskCellContext, run_idx: int, arm: str) -> dict[str, Any]:
    """Run one (run, arm) cell end to end and return its result row.

    Owns its clone for the whole call, including teardown: the ``finally``
    removes the worktree whatever happens, and an exception outside the five
    expected kinds is deliberately left to propagate — a harness bug must not be
    recorded as an ordinary infra-error and averaged into the evidence.
    """
    args = ctx.args
    task = ctx.task
    worktree: Path | None = None
    record: dict[str, Any] | None = None
    cleanup_error: OSError | None = None
    try:
        if ctx.asset_snapshot_error is not None:
            raise RuntimeError(f"task asset snapshot preparation failed: {ctx.asset_snapshot_error}")
        if ctx.graph_snapshot_error is not None:
            raise RuntimeError(f"sanitized graph snapshot preparation failed: {ctx.graph_snapshot_error}")
        if ctx.graph_snapshot is None:
            raise RuntimeError("sanitized graph snapshot is unavailable")
        if ctx.asset_snapshot is None:
            raise RuntimeError("task asset snapshot is unavailable")
        worktree = make_worktree(ctx.repo, ctx.task_sha, ctx.trees_dir)
        sanitized_head = sanitize_clone_for_hidden_oracles(worktree)
        ctx.graph_snapshot.materialize(worktree, sanitized_head=sanitized_head)
        dependency_mounts = stage_task_assets(
            task,
            repo=ctx.repo,
            clone=worktree,
            snapshot=ctx.asset_snapshot,
        )
        registry_mount = isolated_gitnexus_registry_mount(worktree, ctx.trees_dir)
        hidden_harness = worktree / "eval" / "workflow_bench"
        oracle_visibility_mounts: list[ReadOnlyMount] = []
        if hidden_harness.exists() or hidden_harness.is_symlink():
            hidden_metadata = hidden_harness.lstat()
            if stat.S_ISLNK(hidden_metadata.st_mode) or not stat.S_ISDIR(hidden_metadata.st_mode):
                raise SandboxError("benchmark harness path must be a real directory before it can be hidden")
            oracle_visibility_mounts.append(
                ReadOnlyMount(
                    source=ctx.oracle_mask,
                    target=f"{SANDBOX_WORKSPACE}/eval/workflow_bench",
                )
            )
        execution_arm = CANDIDATE_ARMS.get(arm, arm)
        ce_mounts = ce_plugin_mounts_for_arm(execution_arm, ctx.ce_plugin_snapshot)
        with prepare_sandbox(
            clone=worktree,
            claude_bin=args.claude_bin,
            bwrap_bin=ctx.bwrap_bin,
            read_only_mounts=[
                *dependency_mounts,
                *ctx.runtime_mounts,
                registry_mount,
                *ce_mounts,
                *oracle_visibility_mounts,
            ],
            preflight=False,
            backend=ctx.sandbox_backend,
        ) as sandbox:
            # Capture the BASE (pre-overlay) skill digest — identical
            # for the incumbent and candidate arms — then run the
            # task's untrusted setup against those base skills. The
            # candidate overlay is applied only afterwards, so setup
            # can never observe candidate prose and both arms share
            # byte-identical pre-overlay state.
            # Historical review SHAs may predate gitnexus-review. Seed
            # the current evaluated skill first so fingerprinting and
            # the model see the same incumbent prose on every case.
            if execution_arm == "review":
                seed_evaluated_skills(
                    HARNESS_ROOT,
                    worktree,
                    sandbox=sandbox,
                    arm=execution_arm,
                )
            base_skill_digest = skill_fingerprint(worktree, execution_arm)
            if task.get("setup"):
                # Sanitization already removed eval/workflow_bench. A historical
                # PR patch that still edits that tree (gitignored learnings.jsonl)
                # must skip those hunks or `git apply` fails closed.
                setup_command = ["/bin/sh", "-lc", with_hidden_harness_apply_exclude(str(task["setup"]))]
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
                if ctx.candidate_overlay is None:
                    raise RuntimeError("candidate overlay is unavailable")
                applied_digest = apply_candidate_overlay(
                    ctx.candidate_overlay,
                    worktree,
                    sandbox=sandbox,
                )
                if applied_digest != ctx.overlay_digest:
                    raise RuntimeError("candidate overlay changed during the benchmark run")
            # The digest the model must preserve during its run is the
            # post-overlay skill surface (candidate skills for
            # candidate arms; unchanged base skills otherwise).
            expected_skill_digest = (
                skill_fingerprint(worktree, execution_arm) if arm in CANDIDATE_ARMS else base_skill_digest
            )
            orig_sha = _sandbox_git(sandbox, ["rev-parse", "HEAD"]).strip()
            if not re.fullmatch(r"[0-9a-fA-F]{40,64}", orig_sha):
                raise RuntimeError("sandboxed candidate setup did not produce an immutable commit")
            before_work_digest = (
                implementation_diff_digest(sandbox, orig_sha) if execution_arm in IMPLEMENTATION_ARMS else ""
            )
            record = run_arm(
                execution_arm,
                task,
                worktree,
                args,
                sandbox=sandbox,
                transcript_output_dir=ctx.out_dir,
                transcript_output_prefix=f"{task['id']}-{arm}-run{run_idx}",
                expected_skill_digest=expected_skill_digest,
                enforce_phase_boundary=True,
                ce_plugin_dir=ce_plugin_dir_for_arm(execution_arm, ctx.ce_plugin_snapshot),
                oracle_snapshot=ctx.oracle_snapshot,
            )
            if execution_arm in ("review", "ce_review"):
                review_source = worktree / REVIEW_OUTPUT
                if review_source.is_file() and not review_source.is_symlink():
                    review_artifact = ctx.out_dir / f"{task['id']}-{arm}-run{run_idx}.review.json"
                    review_artifact.write_bytes(_bounded_regular_bytes(review_source, limit=256 * 1024))
                    record["review_artifact"] = review_artifact.name
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
                "effort": args.effort,
                "task_ref": task.get("ref", "HEAD"),
                "task_base_sha": ctx.task_sha,
                "sanitized_task_sha": sanitized_head,
                "variant_head_sha": orig_sha,
                "task_prompt_digest": hashlib.sha256(task["prompt"].encode()).hexdigest(),
                "skill_digest": expected_skill_digest,
                "candidate_overlay_digest": (ctx.overlay_digest if arm in CANDIDATE_ARMS else None),
                "recorded_at": datetime.now(UTC).isoformat(),
            }
        )
        # Final working-tree patch — the clone is destroyed, so
        # this is the only artifact for diagnosing verify fails.
        patch_path = ctx.out_dir / f"{task['id']}-{arm}-run{run_idx}.patch"
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
        # ManagedProcessError carries up to 1000 raw bytes of stderr_tail, and
        # this line now streams live into the CI log (run_managed echoes the
        # sweep's stdout). Redact it like every other sink this data reaches.
        detail = redact_text(str(exc), credential_secrets(args))
        print(f"[{task['id']}][{arm}][run {run_idx}] infra-error: {detail}")
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
            f"primary={primary_kind}: {primary_detail}; cleanup: {type(cleanup_error).__name__}: {cleanup_error}"
        )[:2000]
    record.update(
        {
            "task": task["id"],
            "class": task.get("class", ""),
            "run": run_idx,
            "sandbox_backend": ctx.sandbox_backend,
            "task_asset_snapshot_digest": (ctx.asset_snapshot.digest if ctx.asset_snapshot is not None else None),
            "task_asset_manifest_digest": (
                ctx.asset_snapshot.manifest_digest if ctx.asset_snapshot is not None else None
            ),
            "sandbox_dependency_content_digest": (
                ctx.asset_snapshot.dependency_content_digest if ctx.asset_snapshot is not None else None
            ),
            "sandbox_dependency_manifest_digest": (
                ctx.asset_snapshot.dependency_manifest_digest if ctx.asset_snapshot is not None else None
            ),
            "sanitized_graph_snapshot_digest": (ctx.graph_snapshot.digest if ctx.graph_snapshot is not None else None),
            "sanitized_graph_manifest_digest": (
                ctx.graph_snapshot.manifest_digest if ctx.graph_snapshot is not None else None
            ),
            "oracle_digest": ctx.oracle_snapshot.digest,
            "oracle_command_digest": ctx.oracle_snapshot.command_digest,
            "oracle_manifest_digest": ctx.oracle_snapshot.manifest_digest,
            "ce_plugin_version": (
                ctx.ce_plugin_snapshot.version if arm in CE_ARMS and ctx.ce_plugin_snapshot is not None else None
            ),
            "ce_plugin_manifest_digest": (
                ctx.ce_plugin_snapshot.manifest_digest
                if arm in CE_ARMS and ctx.ce_plugin_snapshot is not None
                else None
            ),
        }
    )
    return record


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


def cell_progress_line(task_id: str, arm: str, run_idx: int, record: dict[str, Any]) -> str:
    """The live one-line summary printed as each cell finishes.

    An infra-error row carries 0.0 cost and 0.0 duration as placeholders: the
    cell died before any session could report a number. Printed as bare zeros
    next to real rows they read as a run that was instant and free — the exact
    misreading ``_na`` exists to prevent — so they are rendered "n/a" instead.
    The row on disk is untouched: results.jsonl is promotion evidence and its
    field types stay as they are.
    """
    measured = record.get("error_kind") not in {"infra-error", "cleanup-failure"}
    cost_usd = record.get("cost_usd") if measured else None
    duration_s = record.get("duration_s") if measured else None
    quality = record.get("review_weighted_f1")
    quality_text = "n/a" if quality is None else f"{quality:.3f}"
    return (
        f"[{task_id}][{arm}][run {run_idx}] resolved={record['resolved']} "
        f"quality={quality_text} "
        f"in={record['input_tokens']} out={record['output_tokens']} "
        f"cost={'n/a' if cost_usd is None else f'${cost_usd}'} "
        f"took={'n/a' if duration_s is None else f'{duration_s}s'} "
        # An excluded run is what actually blocks promotion, so name it here
        # instead of leaving it to results.jsonl.
        f"error_kind={record.get('error_kind') or 'none'}"
    )


# A failing cell's error_kind names the category; the detail names the cause.
# Bounded because a session-error detail carries stdout/stderr tails.
MAX_CELL_DETAIL_CHARS = 1200


def cell_failure_detail_line(
    task_id: str,
    arm: str,
    run_idx: int,
    record: Mapping[str, Any],
    secrets: Sequence[str] = (),
) -> str | None:
    """The redacted reason a cell failed, or None when it succeeded.

    Without this the log says only ``error_kind=plan-evidence-invalid`` and the
    reason stays locked in results.jsonl, which is an uploaded artifact rather
    than something a watcher can read while the sweep is still running.
    """
    if not record.get("error_kind"):
        return None
    detail = record.get("error_detail")
    if detail in (None, "", {}, []):
        return None
    rendered = detail if isinstance(detail, str) else json.dumps(detail, default=str, sort_keys=True)
    rendered = redact_text(rendered, secrets).replace("\n", " ⏎ ")
    if len(rendered) > MAX_CELL_DETAIL_CHARS:
        rendered = f"{rendered[:MAX_CELL_DETAIL_CHARS]}…[truncated {len(rendered) - MAX_CELL_DETAIL_CHARS} chars]"
    return f"[{task_id}][{arm}][run {run_idx}] detail: {rendered}"


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
    out["cost_usd"] = (
        None if (not valid or any(cost is None for cost in valid_costs)) else statistics.median(valid_costs)
    )
    out["resolved"] = sum(1 for r in records if r["resolved"])
    out["runs"] = len(records)
    out["valid_runs"] = len(valid)
    out["excluded_runs"] = len(records) - len(valid)
    out["transcripts_missing"] = sum(1 for r in records if r.get("transcript_missing"))
    out["class"] = records[0].get("class", "")
    error_kinds: dict[str, int] = {}
    for r in records:
        kind = r.get("error_kind")
        if kind:
            error_kinds[kind] = error_kinds.get(kind, 0) + 1
    out["error_kinds"] = error_kinds
    review_metrics = (
        "review_true_positives",
        "review_false_positives",
        "review_false_negatives",
        "review_precision",
        "review_recall",
        "review_f1",
        "review_weighted_precision",
        "review_weighted_recall",
        "review_weighted_f1",
        "review_blocker_recall",
        "review_severity_accuracy",
        "review_category_accuracy",
        "review_grounded_evidence",
    )
    if any("review_weighted_f1" in record for record in valid):
        for metric in review_metrics:
            values = [record[metric] for record in valid if record.get(metric) is not None]
            out[metric] = statistics.median(values) if values and len(values) == len(valid) else None
        controls = [record["review_clean_control"] for record in valid if "review_clean_control" in record]
        out["review_clean_control"] = all(controls) if controls and len(controls) == len(valid) else None
        clean_passes = [record["review_clean_pass"] for record in valid if "review_clean_pass" in record]
        out["review_clean_pass"] = all(clean_passes) if clean_passes and len(clean_passes) == len(valid) else None
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


def broken_incumbent_arms(
    results: dict[str, dict[str, dict[str, Any]]],
    incumbent_arms: set[str],
) -> list[str]:
    """Incumbent arms that resolved nothing across every task they ran.

    An incumbent arm is the currently-shipped, presumably-working skill: if it
    resolves NOTHING across every task it ran, that reads as an environment or
    harness failure (missing trusted interpreter, stale skill fingerprint,
    sandbox misconfiguration), not a skill regression. A candidate merely
    underperforming is a normal, expected outcome and must not trip this —
    only checking incumbents keeps that distinction.

    Deliberately does NOT require valid_runs > 0 per task: an incumbent that
    fails every run with an excluded-but-non-systemic error_kind (e.g.
    "evidence-unverified", which the outage-streak breaker explicitly resets
    on rather than accumulates) would otherwise never accumulate a single
    valid run and sail through silently — the exact "quiet no-promotion"
    outcome this guard exists to catch, and arguably worse than the
    some-runs-resolved-zero case since here nothing completed at all.
    aggregate() never marks an excluded/unverifiable row resolved=True, so
    resolved == 0 alone already covers both cases.
    """
    present = incumbent_arms & {arm for arms in results.values() for arm in arms}
    return sorted(arm for arm in present if all(arms[arm]["resolved"] == 0 for arms in results.values() if arm in arms))


def _cost_cell(value: Any) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def _review_metric_cell(value: Any) -> str:
    return "n/a" if value is None else f"{value:.3f}"


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
        "| task | class | arm | resolved | input | cache_create | cache_read | output | cost $ | wall s | turns | churn | errors |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for task_id, arms in results.items():
        for arm, agg in arms.items():
            excluded = agg.get("excluded_runs", 0)
            resolved_cell = f"{agg['resolved']}/{agg.get('valid_runs', agg['runs'])}"
            if excluded:
                resolved_cell += f" ({excluded} excluded)"
            error_cell = ", ".join(f"{kind}×{count}" for kind, count in sorted(agg.get("error_kinds", {}).items()))
            lines.append(
                f"| {task_id} | {agg['class']} | {arm} | {resolved_cell} "
                f"| {agg['input_tokens']:.0f} | {agg['cache_creation_input_tokens']:.0f} "
                f"| {agg['cache_read_input_tokens']:.0f} | {agg['output_tokens']:.0f} "
                f"| {_cost_cell(agg['cost_usd'])} | {agg['duration_s']:.0f} | {agg['num_turns']:.0f} "
                f"| {agg['diff_files']:.0f}/+{agg['diff_insertions']:.0f}/−{agg['diff_deletions']:.0f} "
                f"| {error_cell} |"
            )
        for arm in arms:
            if arm != "baseline" and "baseline" in arms:
                s = savings(arms["baseline"], arms[arm])
                lines.append(
                    f"| {task_id} | {arms[arm]['class']} | **{arm} savings %** | — "
                    f"| {s['input_tokens']} | {s['cache_creation_input_tokens']} "
                    f"| {s['cache_read_input_tokens']} | {s['output_tokens']} "
                    f"| {_na(s['cost_usd'])} | {s['duration_s']} | — | — | — |"
                )
    lines.append("")
    if any("review_clean_control" in agg for arms in results.values() for agg in arms.values()):
        lines.extend(
            [
                "## Review quality",
                "",
                "| case | arm | TP | FP | FN | precision | recall | blocker recall | weighted F1 | grounding |",
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for task_id, arms in results.items():
            for arm, agg in arms.items():
                if "review_clean_control" not in agg:
                    continue
                lines.append(
                    f"| {task_id} | {arm} | {agg['review_true_positives']:.1f} "
                    f"| {agg['review_false_positives']:.1f} | {agg['review_false_negatives']:.1f} "
                    f"| {_review_metric_cell(agg['review_precision'])} "
                    f"| {_review_metric_cell(agg['review_recall'])} "
                    f"| {_review_metric_cell(agg['review_blocker_recall'])} "
                    f"| {_review_metric_cell(agg['review_weighted_f1'])} "
                    f"| {_review_metric_cell(agg['review_grounded_evidence'])} |"
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


def worker_count(value: str) -> int:
    """``--workers`` as a 1..MAX_WORKERS int, rejected at parse time."""
    workers = int(value)
    if not 1 <= workers <= MAX_WORKERS:
        raise argparse.ArgumentTypeError(f"must be between 1 and {MAX_WORKERS}")
    return workers


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument(
        "--workers",
        type=worker_count,
        default=1,
        help=f"cells of one task to run at once (default 1, fully serial; max "
        f"{MAX_WORKERS}). Size this to the machine: a cell that loses CPU to "
        "its siblings takes longer, and a session that reaches its timeout is "
        "an excluded run the promotion gate refuses to work with. Above 1 the "
        "cells run on worker threads, so Ctrl-C no longer reaches the code "
        "owning a sandboxed process and abandons the running cells instead of "
        "cleaning up after them.",
    )
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
            "candidate_review",
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
    parser.add_argument(
        "--timeout",
        type=int,
        default=SESSION_TIMEOUT_SECONDS,
        help="per session, seconds",
    )
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--model",
        required=True,
        help="named, versioned model passed to every `claude --model` invocation",
    )
    parser.add_argument(
        "--effort",
        choices=("low", "medium", "high", "xhigh", "max"),
        default="xhigh",
        help="reasoning effort passed to every `claude --effort` invocation",
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
        "--anthropic-api-key",
        "--auth-token",
        dest="auth_token",
        default=anthropic_api_key_from_environ(),
        help="Anthropic API key for Claude Code sessions (prefer "
        "GITNEXUS_BENCH_ANTHROPIC_API_KEY). Not a Claude Code OAuth token. "
        "Legacy --auth-token / GITNEXUS_BENCH_AUTH_TOKEN is still accepted.",
    )
    parser.add_argument(
        "--openai-api-key",
        default=openai_api_key_from_environ(),
        help="OpenAI API key; starts a loopback Anthropic-compatible proxy "
        "(prefer GITNEXUS_BENCH_OPENAI_API_KEY). The key never enters the sandbox.",
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
        help="directory mirroring one promotable .claude/skills/gitnexus-* tree; applied only to candidate_* arms",
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
    parser.add_argument("--unsafe-no-bwrap", action="store_true", help=argparse.SUPPRESS)
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
        if required_candidates == ["candidate_review"]:
            required_arms.insert(0, "ce_review")
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

    if args.unsafe_no_bwrap and os.environ.get("CI"):
        parser.error("--unsafe-no-bwrap is forbidden when CI is set")
    if args.unsafe_no_bwrap and args.arms != ["ce_review", "review", "candidate_review"]:
        parser.error("--unsafe-no-bwrap is restricted to the paired review arms")
    try:
        if args.unsafe_no_bwrap:
            bwrap_bin = preflight_unsafe_host()
            sandbox_backend = "host-unsafe"
            print(
                "WARNING: --unsafe-no-bwrap runs sessions directly on the host with no "
                "containment; model and verifier processes can access the host filesystem, "
                "network, and credentials.",
                file=sys.stderr,
            )
        else:
            bwrap_bin = preflight_bubblewrap()
            sandbox_backend = "bwrap"
            require_claude_sandbox_helpers()
        runtime_mounts = trusted_gitnexus_runtime_mounts()
    except SandboxError as exc:
        parser.error(str(exc))
        raise AssertionError("ArgumentParser.error() returned unexpectedly")
    gateway = attach_openai_gateway(args)
    try:
        gateway.__enter__()
    except ValueError as exc:
        parser.error(str(exc))
        raise AssertionError("ArgumentParser.error() returned unexpectedly")
    try:
        _run_sweep(
            args,
            parser=parser,
            tasks=tasks,
            skipped_expensive=skipped_expensive,
            oracle_snapshots=oracle_snapshots,
            expected_task_bindings=expected_task_bindings,
            ce_plugin_config=ce_plugin_config,
            bwrap_bin=bwrap_bin,
            sandbox_backend=sandbox_backend,
            runtime_mounts=runtime_mounts,
            candidate_arms=candidate_arms,
            candidate_overlay=candidate_overlay,
            overlay_digest=overlay_digest,
            promotion_target_bases=promotion_target_bases,
        )
    finally:
        gateway.__exit__(None, None, None)


def _run_sweep(
    args: argparse.Namespace,
    *,
    parser: argparse.ArgumentParser,
    tasks: list[Any],
    skipped_expensive: list[str],
    oracle_snapshots: Any,
    expected_task_bindings: Any,
    ce_plugin_config: Any,
    bwrap_bin: Any,
    sandbox_backend: str,
    runtime_mounts: Any,
    candidate_arms: list[str],
    candidate_overlay: Path | None,
    overlay_digest: str | None,
    promotion_target_bases: dict[str, str],
) -> None:
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
    # Progress accounting for the sweep. A generation runs for hours and each
    # cell is a full set of agent sessions, so the log needs to say what is in
    # flight and how much is left, not only what already finished.
    total_cells = len(tasks) * args.runs * len(args.arms)
    started_cells = 0
    sweep_started = time.monotonic()
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
                        sandbox_backend=sandbox_backend,
                        runtime_mounts=runtime_mounts,
                    )
                    graph_snapshots[graph_key] = graph_snapshot
            except (ManagedProcessError, OSError, SandboxError, RuntimeError, ValueError) as exc:
                graph_snapshot_error = exc
                graph_snapshot_errors[graph_key] = exc
            try:
                # Prepared here, once, rather than lazily inside the first cell:
                # TaskAssetCache is a plain dict, so a lazy build would be a
                # read-then-write race the moment cells stop running serially.
                asset_snapshot = task_asset_cache.prepare(
                    task,
                    repo=repo,
                    resolved_sha=task_sha,
                    expected_dependency_binding=task_binding,
                )
            except (OSError, SandboxError, ValueError) as exc:
                asset_snapshot_error = exc
            cell_context = TaskCellContext(
                task=task,
                oracle_snapshot=oracle_snapshot,
                repo=repo,
                task_sha=task_sha,
                graph_snapshot=graph_snapshot,
                graph_snapshot_error=graph_snapshot_error,
                asset_snapshot=asset_snapshot,
                asset_snapshot_error=asset_snapshot_error,
                args=args,
                out_dir=out_dir,
                oracle_mask=oracle_mask,
                ce_plugin_snapshot=ce_plugin_snapshot,
                trees_dir=Path(trees),
                bwrap_bin=bwrap_bin,
                sandbox_backend=sandbox_backend,
                runtime_mounts=runtime_mounts,
                candidate_overlay=candidate_overlay,
                overlay_digest=overlay_digest,
            )
            per_arm: dict[str, list[dict[str, Any]]] = {a: [] for a in args.arms}
            cells = [(run_idx, arm) for run_idx in range(args.runs) for arm in args.arms]

            def announce(run_idx: int, arm: str) -> None:
                nonlocal started_cells
                started_cells += 1
                print(
                    f"[{task['id']}][{arm}][run {run_idx}] starting "
                    f"({started_cells}/{total_cells}, {(time.monotonic() - sweep_started) / 60:.0f}m elapsed)"
                )

            def keep(run_idx: int, arm: str, record: dict[str, Any]) -> None:
                per_arm[arm].append(record)
                with results_path.open("a") as fh:
                    # Redact any API token a session-error stderr_tail echoed
                    # into error_detail before it enters the uploaded
                    # results.jsonl artifact (transcripts are redacted; this
                    # sink was not).
                    fh.write(redact_text(json.dumps(record), credential_secrets(args)) + "\n")
                print(cell_progress_line(task["id"], arm, run_idx, record))
                failure = cell_failure_detail_line(task["id"], arm, run_idx, record, credential_secrets(args))
                if failure:
                    print(failure)

            outage_streak, outage_tripped = sweep_task_cells(
                cells,
                workers=args.workers,
                run=partial(run_cell, cell_context),
                on_start=announce,
                on_record=keep,
                outage_streak=outage_streak,
                outage_limit=args.outage_streak,
            )
            results[task["id"]] = {a: aggregate(rs) for a, rs in per_arm.items() if rs}

    selection_report = [
        "## Run provenance",
        "",
        f"Benchmark model: `{args.model}`",
        f"Proposer model: `{args.proposer_model}`",
        f"Reasoning effort: `{args.effort}`",
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
            # Schema 5 binds reasoning effort on top of schema 4's
            # gated/ungated task contract and schema 3's
            # hidden, byte-bound behavioral oracles: a decision now states which
            # tasks supplied quality signal and which were ungated because
            # neither arm resolved them. Schema 3 bindings are rejected outright
            # by the apply path — they cannot express that distinction, so their
            # verdicts are not comparable with these.
            "schema_version": 5,
            "generated_at": promotion_generated_at.isoformat(),
            "evidence_expires_at": (promotion_generated_at + timedelta(days=EVIDENCE_MAX_AGE_DAYS)).isoformat(),
            "benchmark_model": args.model,
            "proposer_model": args.proposer_model,
            "effort": args.effort,
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
                "max_failed_task_regression_pct": MAX_FAILED_TASK_REGRESSION_PCT,
                "min_gated_task_ratio": MIN_GATED_TASK_RATIO,
                "quality_rule": "no per-task resolution-rate regression",
                "max_age_days": EVIDENCE_MAX_AGE_DAYS,
            },
            "decisions": [
                (
                    evaluate_review_candidate(
                        results,
                        incumbent_arm=CANDIDATE_ARMS[candidate_arm],
                        candidate_arm=candidate_arm,
                        model=args.model,
                        min_runs=args.promotion_min_runs,
                    )
                    if candidate_arm == "candidate_review"
                    else evaluate_candidate(
                        results,
                        incumbent_arm=CANDIDATE_ARMS[candidate_arm],
                        candidate_arm=candidate_arm,
                        model=args.model,
                        metric=args.promotion_metric,
                        min_runs=args.promotion_min_runs,
                        min_improvement_pct=args.promotion_min_improvement,
                        max_task_regression_pct=args.promotion_max_task_regression,
                    )
                )
                for candidate_arm in candidate_arms
            ],
        }
        (out_dir / "promotion.json").write_text(json.dumps(promotion, indent=2) + "\n")
    print(f"\n{report}\n\nWritten to {out_dir}/")
    # A reviewer may legitimately match none of a difficult hidden corpus;
    # unlike an implementation arm, zero exact resolutions is quality signal,
    # not proof that the harness failed.
    broken_incumbents = broken_incumbent_arms(results, set(CANDIDATE_ARMS.values()) - {"review"})
    if broken_incumbents:
        # Fail loudly rather than let a broken environment read as a quiet
        # "no promotion, incumbent stands."
        print(
            f"[harness-health] incumbent arm(s) {', '.join(broken_incumbents)} resolved zero "
            "tasks across every valid run — this looks like an environment/harness failure, "
            "not a normal candidate miss. See the errors column in report.md and error_detail "
            "in results.jsonl. Exiting non-zero rather than reporting a quiet no-promotion."
        )
        raise SystemExit(1)
    if outage_tripped:
        # Non-zero exit so a driver (evolve.py) treats the partial benchmark as a
        # failed run and halts instead of proposing from outage-truncated evidence.
        raise SystemExit(1)


if __name__ == "__main__":
    main()
