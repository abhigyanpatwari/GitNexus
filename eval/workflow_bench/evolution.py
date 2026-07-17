"""Skill-candidate isolation, provenance, and deterministic promotion policy."""

from __future__ import annotations

import hashlib
import shutil
import statistics
import subprocess
from pathlib import Path
from typing import Any

CANDIDATE_ARMS = {
    "candidate_workflow": "workflow",
    "candidate_workflow_direct": "workflow_direct",
}
CANDIDATE_SKILLS = {
    "gitnexus-plan",
    "gitnexus-work",
    "gitnexus-lfg",
    "gitnexus-review",
}
# Skills each incumbent arm actually loads in its sessions. An overlay that
# only touches other skills would never be exercised — the gate would decide
# from noise — so such overlays are rejected up front.
ARM_SKILLS = {
    "workflow": ("gitnexus-plan", "gitnexus-work"),
    "workflow_direct": ("gitnexus-work",),
}
PROMOTION_METRICS = ("output_tokens", "cost_usd", "duration_s", "num_turns")
# Token/turn metrics come from the CLI's top-level `usage`, which counts ONLY
# the main-loop session. `total_cost_usd` is the only reported number that
# includes subagent spend.
MAIN_LOOP_ONLY_METRICS = frozenset({"output_tokens"})
MAIN_LOOP_ONLY_WARNING = (
    "WARNING: token metrics count only the main-loop session — subagent spend "
    "is invisible to them and systematically flatters subagent-heavy "
    "candidates. Prefer cost_usd (the only CLI-reported field that includes "
    "subagents), or sum usage from the session transcripts "
    "(~/.claude/projects/<cwd-slug>/<session_id>.jsonl), deduplicating events "
    "that share one message.id."
)
EVIDENCE_MAX_AGE_DAYS = 90


def candidate_overlay_files(overlay: Path) -> list[Path]:
    """Return a candidate's files after enforcing the benchmark trust boundary.

    Candidates may change only the canonical repo-local skill prompts. They
    cannot modify task code, tests, or verification commands and thereby game
    the promotion gate.
    """
    overlay = overlay.expanduser().resolve()
    if not overlay.is_dir():
        raise ValueError(f"candidate overlay is not a directory: {overlay}")

    entries = sorted(
        (path for path in overlay.rglob("*") if path.is_file() or path.is_symlink()),
        key=lambda path: path.relative_to(overlay).as_posix(),
    )
    if not entries:
        raise ValueError(f"candidate overlay contains no files: {overlay}")

    for path in entries:
        relative = path.relative_to(overlay)
        parts = relative.parts
        if path.is_symlink():
            raise ValueError(f"candidate overlay cannot contain symlinks: {relative}")
        if (
            len(parts) < 4
            or parts[:2] != (".claude", "skills")
            or parts[2] not in CANDIDATE_SKILLS
            or path.suffix.lower() != ".md"
        ):
            raise ValueError(
                "candidate overlays may only contain Markdown files under "
                ".claude/skills/gitnexus-{plan,work,lfg,review}: "
                f"{relative}"
            )
    return entries


def fingerprint_files(root: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode()
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def candidate_overlay_digest(overlay: Path) -> str:
    overlay = overlay.expanduser().resolve()
    return fingerprint_files(overlay, candidate_overlay_files(overlay))


def apply_candidate_overlay(overlay: Path, worktree: Path) -> str:
    """Apply and commit a prompt candidate inside one throwaway clone."""
    overlay = overlay.expanduser().resolve()
    files = candidate_overlay_files(overlay)
    relative_paths: list[str] = []
    for source in files:
        relative = source.relative_to(overlay)
        destination = worktree / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        relative_paths.append(relative.as_posix())

    subprocess.run(
        ["git", "-C", str(worktree), "add", "--", *relative_paths],
        check=True,
        capture_output=True,
    )
    changed = subprocess.run(
        ["git", "-C", str(worktree), "diff", "--cached", "--quiet"],
        check=False,
    )
    if changed.returncode == 0:
        raise ValueError("candidate overlay is byte-identical to the incumbent skills")
    if changed.returncode != 1:
        raise RuntimeError("could not inspect the staged candidate overlay")

    subprocess.run(
        [
            "git",
            "-C",
            str(worktree),
            "-c",
            "user.name=workflow-bench",
            "-c",
            "user.email=workflow-bench@invalid",
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "benchmark candidate skill overlay",
        ],
        check=True,
        capture_output=True,
    )
    return fingerprint_files(overlay, files)


def unexercised_overlay_skills(overlay: Path, candidate_arms: list[str]) -> list[str]:
    """Overlay skills that no selected candidate arm would ever load.

    A gitnexus-lfg-only (or gitnexus-review-only) overlay paired with the
    workflow arms is never read by any benchmarked session, so any promotion
    decision about it would be noise.
    """
    overlay = overlay.expanduser().resolve()
    exercised = {
        skill
        for arm in candidate_arms
        for skill in ARM_SKILLS[CANDIDATE_ARMS[arm]]
    }
    touched = {
        path.relative_to(overlay).parts[2] for path in candidate_overlay_files(overlay)
    }
    return sorted(touched - exercised)


def skill_fingerprint(worktree: Path, arm: str) -> str | None:
    skill_names = ARM_SKILLS.get(arm)
    if skill_names is None:
        return None

    files = sorted(
        (
            path
            for skill_name in skill_names
            for path in (worktree / ".claude" / "skills" / skill_name).rglob("*")
            if path.is_file()
        ),
        key=lambda path: path.relative_to(worktree).as_posix(),
    )
    return fingerprint_files(worktree, files)


def evaluate_candidate(
    results: dict[str, dict[str, dict[str, Any]]],
    *,
    incumbent_arm: str,
    candidate_arm: str,
    model: str | None,
    metric: str = "cost_usd",
    min_runs: int = 3,
    min_improvement_pct: float = 5.0,
    max_task_regression_pct: float = 20.0,
) -> dict[str, Any]:
    """Deterministically decide whether a prompt candidate is promotable.

    Resolution is lexicographically primary: a cheaper candidate that fails
    more tasks never wins. With equal quality, the candidate must clear the
    configured median efficiency gain without a large per-task regression.
    """
    if metric not in PROMOTION_METRICS:
        raise ValueError(f"unsupported promotion metric: {metric}")

    reasons: list[str] = []
    task_rows: list[dict[str, Any]] = []
    insufficient = False
    quality_regression = False
    efficiency_regression = False

    if not model:
        insufficient = True
        reasons.append("a named --model is required so prompt evidence cannot drift")

    for task_id, arms in sorted(results.items()):
        if incumbent_arm not in arms or candidate_arm not in arms:
            insufficient = True
            reasons.append(f"{task_id}: both {incumbent_arm} and {candidate_arm} are required")
            continue

        incumbent = arms[incumbent_arm]
        candidate = arms[candidate_arm]
        # Session/infra-error rows carry no measured evidence: only VALID runs
        # count toward the run minimum, the pairing check, and resolve rates.
        incumbent_runs = int(incumbent.get("valid_runs", incumbent["runs"]))
        candidate_runs = int(candidate.get("valid_runs", candidate["runs"]))
        incumbent_excluded = int(incumbent.get("excluded_runs", 0))
        candidate_excluded = int(candidate.get("excluded_runs", 0))
        incumbent_rate = incumbent["resolved"] / incumbent_runs if incumbent_runs else 0.0
        candidate_rate = candidate["resolved"] / candidate_runs if candidate_runs else 0.0
        incumbent_metric = float(incumbent[metric])
        candidate_metric = float(candidate[metric])
        improvement = (
            round(100 * (incumbent_metric - candidate_metric) / incumbent_metric, 1) if incumbent_metric else None
        )
        task_rows.append(
            {
                "task": task_id,
                "class": incumbent.get("class", ""),
                "incumbent_resolved": f"{incumbent['resolved']}/{incumbent_runs}",
                "candidate_resolved": f"{candidate['resolved']}/{candidate_runs}",
                "incumbent_excluded_runs": incumbent_excluded,
                "candidate_excluded_runs": candidate_excluded,
                "incumbent_metric": incumbent_metric,
                "candidate_metric": candidate_metric,
                "improvement_pct": improvement,
            }
        )

        if incumbent_runs < min_runs or candidate_runs < min_runs:
            insufficient = True
            reasons.append(f"{task_id}: needs at least {min_runs} valid runs per arm (got {incumbent_runs}/{candidate_runs})")
        if incumbent_runs != candidate_runs:
            insufficient = True
            reasons.append(
                f"{task_id}: paired arms have different valid run counts "
                f"({incumbent_runs}/{candidate_runs} valid; {incumbent_excluded}/{candidate_excluded} excluded)"
            )
        if candidate_rate < incumbent_rate:
            quality_regression = True
            reasons.append(f"{task_id}: resolution regressed from {incumbent_rate:.0%} to {candidate_rate:.0%}")
        if improvement is None:
            insufficient = True
            reasons.append(f"{task_id}: incumbent {metric} is zero; choose a metric with signal")
        elif improvement < -max_task_regression_pct:
            efficiency_regression = True
            reasons.append(
                f"{task_id}: {metric} regressed {-improvement:.1f}%, above the {max_task_regression_pct:.1f}% task cap"
            )

    if not task_rows:
        insufficient = True
        reasons.append("no paired task results were found")

    improvements = [row["improvement_pct"] for row in task_rows if row["improvement_pct"] is not None]
    median_improvement = round(statistics.median(improvements), 1) if improvements else None
    incumbent_resolved = sum(
        arms[incumbent_arm]["resolved"] for arms in results.values() if incumbent_arm in arms and candidate_arm in arms
    )
    candidate_resolved = sum(
        arms[candidate_arm]["resolved"] for arms in results.values() if incumbent_arm in arms and candidate_arm in arms
    )

    resolution_margin = candidate_resolved - incumbent_resolved
    if insufficient:
        decision = "insufficient_evidence"
    elif quality_regression or efficiency_regression:
        decision = "keep_incumbent"
    elif resolution_margin >= 2:
        decision = "promote"
        reasons.append(
            f"candidate improves total task resolution by {resolution_margin} runs "
            "(at least 2 required) with no task regression"
        )
    else:
        if resolution_margin == 1:
            reasons.append(
                "total resolution improved by only 1 run — within the noise floor "
                "(2 required); deciding on efficiency instead"
            )
        if median_improvement is not None and median_improvement >= min_improvement_pct:
            decision = "promote"
            reasons.append(
                f"median {metric} improvement is {median_improvement:.1f}% (required {min_improvement_pct:.1f}%)"
            )
        else:
            decision = "keep_incumbent"
            reasons.append(
                f"median {metric} improvement is {median_improvement or 0.0:.1f}% (required {min_improvement_pct:.1f}%)"
            )

    return {
        "incumbent_arm": incumbent_arm,
        "candidate_arm": candidate_arm,
        "decision": decision,
        "metric": metric,
        "metric_warning": (MAIN_LOOP_ONLY_WARNING if metric in MAIN_LOOP_ONLY_METRICS else None),
        "median_improvement_pct": median_improvement,
        "reasons": reasons,
        "tasks": task_rows,
    }
