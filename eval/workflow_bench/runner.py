"""Benchmark the gitnexus-plan/work workflow against a baseline agent.

Usage:
    uv run python -m workflow_bench.runner --tasks workflow_bench/tasks.scenarios.yaml --runs 3

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
the only reported number that includes subagent spend. A task-specific
``verify`` command decides ``resolved``; token savings on unresolved runs are
reported but flagged, because saving tokens by failing is not a saving.

Trust model: task files are EXECUTABLE INPUT — ``setup``/``verify`` run
through the shell and sessions default to ``--permission-mode
bypassPermissions`` with the parent environment. Only run task files, repos,
and candidate overlays you trust (see README § Trust model).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .evolution import (
    CANDIDATE_ARMS,
    EVIDENCE_MAX_AGE_DAYS,
    MAIN_LOOP_ONLY_METRICS,
    MAIN_LOOP_ONLY_WARNING,
    PROMOTION_METRICS,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    skill_fingerprint,
    unexercised_overlay_skills,
)

USAGE_FIELDS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)

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


def transcript_path(cwd: Path, session_id: str | None) -> Path | None:
    """Locate ``~/.claude/projects/<cwd-slug>/<session_id>.jsonl`` if present."""
    if not session_id:
        return None
    projects = Path.home() / ".claude" / "projects"
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(cwd))
    direct = projects / slug / f"{session_id}.jsonl"
    if direct.is_file():
        return direct
    # Transcripts can live under a differently derived slug; session ids are
    # unique, so a projects-wide glob is a safe fallback.
    return next(iter(projects.glob(f"*/{session_id}.jsonl")), None)


def skill_was_invoked(transcript: Path, skill_name: str) -> bool:
    """Scan a session transcript for a Skill tool_use invoking ``skill_name``.

    Liberal on event shape: any tool_use block named "Skill"/"skill" whose
    input mentions the skill, or a tool named after the skill itself.
    """
    for line in transcript.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        content = (message or {}).get("content") if isinstance(message, dict) else None
        if content is None:
            content = event.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name", ""))
            if name == skill_name:
                return True
            if name.lower() == "skill" and skill_name in json.dumps(block.get("input", {})):
                return True
    return False


def run_claude(
    prompt: str,
    cwd: Path,
    *,
    claude_bin: str,
    timeout: int,
    disallowed_tools: list[str] | None = None,
    model: str | None = None,
    env: dict[str, str] | None = None,
    permission_mode: str | None = None,
    expected_skill: str | None = None,
) -> dict[str, Any]:
    """Run one headless session and return its usage record."""
    cmd = [claude_bin, "-p", prompt, "--output-format", "json"]
    if permission_mode:
        cmd += ["--permission-mode", permission_mode]
    if model:
        cmd += ["--model", model]
    for tool in disallowed_tools or []:
        cmd += ["--disallowedTools", tool]
    started = time.monotonic()
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )
    wall_s = time.monotonic() - started
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        data = json.loads(line) if line else {}
    except json.JSONDecodeError:
        data = {}
    usage = data.get("usage") or {}
    subtype = data.get("subtype")
    # Fail closed: an exit-0 session whose report is empty/malformed or lacks
    # usage fields must not count as measured evidence (it would otherwise
    # record a "resolved" run with zero usage and corrupt promotion decisions).
    well_formed = all(f in usage for f in USAGE_FIELDS)
    session_error = (
        proc.returncode != 0
        or data.get("is_error", False)
        or str(subtype).startswith("error")  # e.g. error_max_turns — limit/infra death
        or not well_formed
    )
    record = {
        "ok": not session_error,
        "error_kind": "session-error" if session_error else None,
        "error_detail": (
            {
                "subtype": subtype,
                "returncode": proc.returncode,
                "stderr_tail": proc.stderr[-2000:],
            }
            if session_error
            else None
        ),
        "session_id": data.get("session_id"),
        "num_turns": data.get("num_turns", 0),
        "cost_usd": data.get("total_cost_usd", 0.0),
        "duration_s": round(data.get("duration_ms", wall_s * 1000) / 1000, 1),
        **{f: usage.get(f, 0) for f in USAGE_FIELDS},
    }
    if expected_skill is not None and record["ok"]:
        transcript = transcript_path(cwd, data.get("session_id"))
        # Missing transcript (e.g. CI keeps them elsewhere): record null, do
        # not fail the row — the report notes unverified skill invocations.
        record["skill_invoked"] = (
            None if transcript is None else skill_was_invoked(transcript, expected_skill)
        )
        if record["skill_invoked"] is False:
            record["ok"] = False
            record["error_kind"] = "skill-not-invoked"
            record["error_detail"] = (
                f"transcript {transcript} shows no {expected_skill} invocation"
            )
    return record


def sum_sessions(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    total: dict[str, Any] = {f: sum(s[f] for s in sessions) for f in USAGE_FIELDS}
    total["cost_usd"] = round(sum(s["cost_usd"] for s in sessions), 4)
    total["duration_s"] = round(sum(s["duration_s"] for s in sessions), 1)
    total["num_turns"] = sum(s["num_turns"] for s in sessions)
    total["ok"] = all(s["ok"] for s in sessions)
    total["session_ids"] = [s["session_id"] for s in sessions]
    kinds = [s.get("error_kind") for s in sessions if s.get("error_kind")]
    total["error_kind"] = kinds[0] if kinds else None
    details = [s.get("error_detail") for s in sessions if s.get("error_detail")]
    total["error_detail"] = details[0] if details else None
    # Merge per-session skill checks: any explicit miss fails the row; any
    # unlocatable transcript degrades the row to "unverified" (None).
    invocations = [s["skill_invoked"] for s in sessions if "skill_invoked" in s]
    if False in invocations:
        total["skill_invoked"] = False
    elif None in invocations or not invocations:
        total["skill_invoked"] = None
    else:
        total["skill_invoked"] = True
    total["transcript_missing"] = None in invocations
    return total


def new_plan_doc(worktree: Path, before: set[Path]) -> Path | None:
    """The plan document a session just wrote: any new file under docs/plans.

    A name glob is unreliable — the repo ships committed example plans whose
    clone-time mtimes tie, and sessions don't always follow the skill's naming
    convention — so plan discovery diffs against a pre-session snapshot.
    """
    fresh = [
        p
        for p in worktree.glob("docs/plans/*")
        if p not in before and p.suffix in (".md", ".html")
    ]
    return max(fresh, key=lambda p: p.stat().st_mtime, default=None)


def make_worktree(repo: Path, ref: str, parent: Path) -> Path:
    """Isolated CLONE per arm — refs (branches, stash) stay arm-local.

    `git worktree add` shares the ref namespace: an agent-created slug branch
    survived its worktree's removal and a later arm found and ADOPTED the
    previous arm's completed work (caught by identical churn fingerprints).
    `--shared` keeps the clone cheap (object store via alternates); every ref
    an agent creates dies with the clone directory.
    """
    target = Path(tempfile.mkdtemp(prefix="wfbench-", dir=parent))
    target.rmdir()  # git clone creates it
    subprocess.run(
        ["git", "clone", "--shared", "--quiet", str(repo), str(target)],
        check=True,
        capture_output=True,
    )
    # Non-default branches exist only as origin/<ref> in a fresh clone.
    for candidate in (ref, f"origin/{ref}"):
        proc = subprocess.run(
            ["git", "-C", str(target), "checkout", "--detach", "--quiet", candidate],
            capture_output=True,
        )
        if proc.returncode == 0:
            return target
    raise RuntimeError(f"ref {ref!r} not found in clone of {repo}")


def remove_clone(clone: Path) -> None:
    """Delete one throwaway arm clone (created by make_worktree)."""
    shutil.rmtree(clone, ignore_errors=True)


def parse_shortstat(text: str) -> dict[str, int]:
    """Parse `git diff --shortstat` output into churn counters."""
    keys = {
        "file": "diff_files",
        "insertion": "diff_insertions",
        "deletion": "diff_deletions",
    }
    out = dict.fromkeys(keys.values(), 0)
    for count, word in re.findall(r"(\d+) (file|insertion|deletion)", text):
        out[keys[word]] = int(count)
    return out


def diff_churn(worktree: Path, orig_sha: str) -> dict[str, int]:
    """Code churn (committed + uncommitted + new files) vs the worktree's
    starting sha — a cheap over-engineering proxy alongside pass/fail quality.

    intent-to-add makes untracked new files visible to `git diff` (arms that
    never commit would otherwise undercount); docs/plans is excluded so the
    workflow arm's committed plan document doesn't inflate its code churn.
    """
    subprocess.run(
        ["git", "-C", str(worktree), "add", "--intent-to-add", "-A"],
        capture_output=True,
        check=False,
    )
    proc = subprocess.run(
        [
            "git",
            "-C",
            str(worktree),
            "diff",
            "--shortstat",
            orig_sha,
            "--",
            ".",
            ":(exclude)docs/plans",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return parse_shortstat(proc.stdout)


def run_verify(command: str, cwd: Path, timeout: int) -> tuple[bool, str]:
    """Run the task's verify command; keep its output tail for diagnosis."""
    proc = subprocess.run(
        command, shell=True, cwd=cwd, capture_output=True, timeout=timeout, check=False
    )
    output = (proc.stdout + b"\n" + proc.stderr).decode(errors="replace")
    return proc.returncode == 0, output[-4000:]


def claude_env(args: argparse.Namespace) -> dict[str, str]:
    """Environment for the headless sessions — free/alt-model routing hook.

    --base-url points Claude Code at any Anthropic-compatible endpoint (e.g. a
    local `litellm --config free-model.litellm.yaml` proxy fronting a free
    OpenRouter model or local Ollama); --auth-token supplies its key.
    """
    env = os.environ.copy()
    if args.base_url:
        env["ANTHROPIC_BASE_URL"] = args.base_url
    if args.auth_token:
        env["ANTHROPIC_AUTH_TOKEN"] = args.auth_token
    return env


def run_arm(
    arm: str, task: dict[str, Any], worktree: Path, args: argparse.Namespace
) -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    env = claude_env(args)
    common = {
        "claude_bin": args.claude_bin,
        "timeout": args.timeout,
        "model": args.model,
        "env": env,
        "permission_mode": args.permission_mode,
    }
    expected_skills = ARM_EXPECTED_SKILLS.get(arm, ())
    plan_doc: Path | None = None
    if arm in ("workflow", "ce_workflow"):
        plan_prompt = PLAN_PROMPT if arm == "workflow" else CE_PLAN_PROMPT
        work_prompt = WORK_PROMPT if arm == "workflow" else CE_WORK_PROMPT
        pre = set(worktree.glob("docs/plans/*"))
        sessions.append(
            run_claude(
                plan_prompt.format(task=task["prompt"]),
                worktree,
                expected_skill=expected_skills[0],
                **common,
            )
        )
        plan_doc = new_plan_doc(worktree, pre)
        if plan_doc is not None:
            sessions.append(
                run_claude(
                    work_prompt.format(plan=plan_doc.relative_to(worktree)),
                    worktree,
                    expected_skill=expected_skills[1],
                    **common,
                )
            )
    elif arm == "ce_workflow_direct":
        sessions.append(
            run_claude(
                CE_WORK_DIRECT_PROMPT.format(task=task["prompt"]),
                worktree,
                expected_skill=expected_skills[0],
                **common,
            )
        )
    elif arm == "review":
        sessions.append(
            run_claude(
                REVIEW_PROMPT.format(task=task["prompt"]),
                worktree,
                expected_skill=expected_skills[0],
                **common,
            )
        )
    elif arm == "ce_review":
        sessions.append(
            run_claude(
                CE_REVIEW_PROMPT.format(task=task["prompt"]),
                worktree,
                expected_skill=expected_skills[0],
                **common,
            )
        )
    elif arm == "workflow_direct":
        sessions.append(
            run_claude(
                WORK_DIRECT_PROMPT.format(task=task["prompt"]),
                worktree,
                expected_skill=expected_skills[0],
                **common,
            )
        )
    elif arm == "baseline_nomcp":
        # Isolates the workflow-discipline question from the GitNexus-tools
        # question: no skills AND no graph tools.
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill", "mcp__gitnexus"],
                **common,
            )
        )
    else:
        sessions.append(
            run_claude(
                BASELINE_PROMPT.format(task=task["prompt"]),
                worktree,
                disallowed_tools=["Skill"],
                **common,
            )
        )
    record = sum_sessions(sessions)
    record["arm"] = arm
    record["plan_produced"] = (
        arm not in ("workflow", "ce_workflow") or plan_doc is not None
    )
    verified, verify_output = run_verify(task["verify"], worktree, args.timeout)
    record["resolved"] = record["ok"] and verified
    record["verify_output"] = verify_output
    if record["error_kind"] is None and not verified:
        # The sessions completed — the produced change just failed the task's
        # verify command. Kept distinct from session-error so aggregates can
        # exclude infrastructure deaths without hiding real failures.
        record["error_kind"] = "verify-failed"
    return record


# ─── Pure aggregation/report helpers (unit-tested) ──────────────────────────


CHURN_FIELDS = ("diff_files", "diff_insertions", "diff_deletions")

# Rows where the session (or the harness) died carry no measured evidence and
# must not skew efficiency medians or resolve denominators. verify-failed and
# skill-not-invoked rows DO count: those sessions ran and spent real tokens.
EXCLUDED_ERROR_KINDS = frozenset({"session-error", "infra-error"})


def infra_error_record(exc: BaseException) -> dict[str, Any]:
    """Row for a run the harness itself killed (timeout, setup failure)."""
    record: dict[str, Any] = dict.fromkeys(USAGE_FIELDS, 0)
    record.update(
        {
            "ok": False,
            "resolved": False,
            "error_kind": "infra-error",
            "error_detail": f"{type(exc).__name__}: {exc}"[:2000],
            "session_ids": [],
            "cost_usd": 0.0,
            "duration_s": 0.0,
            "num_turns": 0,
            "plan_produced": False,
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
    metrics = (*USAGE_FIELDS, "cost_usd", "duration_s", "num_turns", *CHURN_FIELDS)
    out: dict[str, Any] = {
        m: statistics.median(r.get(m, 0) for r in (valid or [{}])) for m in metrics
    }
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
        base = baseline[metric]
        out[metric] = round(100 * (base - workflow[metric]) / base, 1) if base else 0.0
    return out


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
                f"| {agg['cost_usd']:.4f} | {agg['duration_s']:.0f} | {agg['num_turns']:.0f} "
                f"| {agg['diff_files']:.0f}/+{agg['diff_insertions']:.0f}/−{agg['diff_deletions']:.0f} |"
            )
        for arm in arms:
            if arm != "baseline" and "baseline" in arms:
                s = savings(arms["baseline"], arms[arm])
                lines.append(
                    f"| {task_id} | {arms[arm]['class']} | **{arm} savings %** | — "
                    f"| {s['input_tokens']} | {s['cache_creation_input_tokens']} "
                    f"| {s['cache_read_input_tokens']} | {s['output_tokens']} "
                    f"| {s['cost_usd']} | {s['duration_s']} | — | — |"
                )
    lines.append("")
    all_aggs = [agg for arms in results.values() for agg in arms.values()]
    excluded_total = sum(agg.get("excluded_runs", 0) for agg in all_aggs)
    if excluded_total:
        lines.append(
            f"{excluded_total} run(s) hit session/infra errors and were excluded "
            "from medians and resolve denominators — see error_kind in results.jsonl."
        )
    missing_total = sum(agg.get("transcripts_missing", 0) for agg in all_aggs)
    if missing_total:
        lines.append(
            f"{missing_total} run(s) had no locatable session transcript, so their "
            "skill invocation could not be verified (skill_invoked=null in results.jsonl)."
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
    parser.add_argument("--timeout", type=int, default=3600, help="per session, seconds")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--model", default=None, help="model override passed to `claude --model`"
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="ANTHROPIC_BASE_URL override — point at an Anthropic-compatible "
        "proxy (see free-model.litellm.yaml) to run on a free model",
    )
    parser.add_argument(
        "--auth-token",
        default=None,
        help="ANTHROPIC_AUTH_TOKEN for the --base-url endpoint",
    )
    parser.add_argument(
        "--permission-mode",
        default="bypassPermissions",
        help="passed to `claude --permission-mode`; the default lets headless "
        "sessions edit/run unattended — arms run in throwaway worktrees",
    )
    parser.add_argument(
        "--candidate-overlay",
        type=Path,
        default=None,
        help="directory mirroring .claude/skills/gitnexus-{plan,work,lfg}; applied only to candidate_* arms",
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
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

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

    candidate_overlay = args.candidate_overlay.expanduser().resolve() if args.candidate_overlay is not None else None
    overlay_digest = candidate_overlay_digest(candidate_overlay) if candidate_overlay is not None else None
    if candidate_overlay is not None:
        unexercised = unexercised_overlay_skills(candidate_overlay, candidate_arms)
        if unexercised:
            parser.error(
                "candidate overlay touches skills no selected candidate arm "
                f"exercises: {', '.join(unexercised)} — those files would never "
                "be loaded by any session, so the gate would decide from noise"
            )

    tasks = yaml.safe_load(args.tasks.read_text())["tasks"]
    out_dir = args.out or Path("results") / time.strftime("wfbench-%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"

    results: dict[str, dict[str, dict[str, Any]]] = {}
    with tempfile.TemporaryDirectory(prefix="wfbench-trees-") as trees:
        for task in tasks:
            repo = Path(task["repo"]).expanduser().resolve()
            per_arm: dict[str, list[dict[str, Any]]] = {a: [] for a in args.arms}
            for run_idx in range(args.runs):
                for arm in args.arms:
                    worktree = make_worktree(repo, task.get("ref", "HEAD"), Path(trees))
                    try:
                        if task.get("setup"):
                            subprocess.run(
                                task["setup"],
                                shell=True,
                                cwd=worktree,
                                check=True,
                                capture_output=True,
                                timeout=600,
                            )
                        task_base_sha = subprocess.run(
                            ["git", "-C", str(worktree), "rev-parse", "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        ).stdout.strip()
                        execution_arm = CANDIDATE_ARMS.get(arm, arm)
                        if arm in CANDIDATE_ARMS:
                            assert candidate_overlay is not None
                            applied_digest = apply_candidate_overlay(candidate_overlay, worktree)
                            if applied_digest != overlay_digest:
                                raise RuntimeError("candidate overlay changed during the benchmark run")
                        orig_sha = subprocess.run(
                            ["git", "-C", str(worktree), "rev-parse", "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        ).stdout.strip()
                        record = run_arm(execution_arm, task, worktree, args)
                        record["arm"] = arm
                        record.update(
                            {
                                "model": args.model,
                                "task_ref": task.get("ref", "HEAD"),
                                "task_base_sha": task_base_sha,
                                "variant_head_sha": orig_sha,
                                "task_prompt_digest": hashlib.sha256(task["prompt"].encode()).hexdigest(),
                                "skill_digest": skill_fingerprint(worktree, execution_arm),
                                "candidate_overlay_digest": (overlay_digest if arm in CANDIDATE_ARMS else None),
                                "recorded_at": datetime.now(UTC).isoformat(),
                            }
                        )
                        record.update(diff_churn(worktree, orig_sha))
                        # Final working-tree patch — the clone is destroyed, so
                        # this is the only artifact for diagnosing verify fails.
                        patch = subprocess.run(
                            ["git", "-C", str(worktree), "diff", orig_sha],
                            capture_output=True,
                            text=True,
                            check=False,
                        ).stdout
                        (
                            out_dir / f"{task['id']}-{arm}-run{run_idx}.patch"
                        ).write_text(patch[:300_000])
                    except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
                        # One hung session or failed setup must not abort the
                        # sweep — record the run as infra-error and move on so
                        # report.md/promotion.json still get written.
                        record = infra_error_record(exc)
                        record["arm"] = arm
                        print(f"[{task['id']}][{arm}][run {run_idx}] infra-error: {exc}")
                    finally:
                        remove_clone(worktree)
                    record.update(
                        {
                            "task": task["id"],
                            "class": task.get("class", ""),
                            "run": run_idx,
                        }
                    )
                    per_arm[arm].append(record)
                    with results_path.open("a") as fh:
                        fh.write(json.dumps(record) + "\n")
                    print(
                        f"[{task['id']}][{arm}][run {run_idx}] resolved={record['resolved']} "
                        f"in={record['input_tokens']} out={record['output_tokens']} "
                        f"cost=${record['cost_usd']}"
                    )
            results[task["id"]] = {a: aggregate(rs) for a, rs in per_arm.items() if rs}

    report = render_report(results)
    (out_dir / "report.md").write_text(report)
    if candidate_arms:
        promotion_generated_at = datetime.now(UTC)
        promotion = {
            "schema_version": 1,
            "generated_at": promotion_generated_at.isoformat(),
            "evidence_expires_at": (promotion_generated_at + timedelta(days=EVIDENCE_MAX_AGE_DAYS)).isoformat(),
            "model": args.model,
            "candidate_overlay": str(candidate_overlay),
            "candidate_overlay_digest": overlay_digest,
            "policy": {
                "metric": args.promotion_metric,
                "metric_warning": (
                    MAIN_LOOP_ONLY_WARNING
                    if args.promotion_metric in MAIN_LOOP_ONLY_METRICS
                    else None
                ),
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


if __name__ == "__main__":
    main()
