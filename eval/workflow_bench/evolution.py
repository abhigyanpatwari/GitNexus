"""Skill-candidate isolation, provenance, and deterministic promotion policy."""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
import statistics
from pathlib import Path, PurePosixPath
from typing import Any

from .process_control import ManagedProcessError
from .proposer_sandbox import (
    SANDBOX_TMP,
    SANDBOX_WORKSPACE,
    SandboxSession,
    build_sandbox_environment,
)

CANDIDATE_ARMS = {
    "candidate_workflow": "workflow",
    "candidate_workflow_direct": "workflow_direct",
}
CANDIDATE_SKILLS = {
    "gitnexus-plan",
    "gitnexus-work",
}
# Skills each incumbent arm actually loads in its sessions. An overlay that
# only touches other skills would never be exercised — the gate would decide
# from noise — so such overlays are rejected up front.
ARM_SKILLS = {
    "workflow": ("gitnexus-plan", "gitnexus-work"),
    "workflow_direct": ("gitnexus-work",),
}
# Repo-local prompts whose bytes are evidence for each executed arm. Keep this
# distinct from ``ARM_SKILLS``: that mapping defines which skills a promotable
# plan/work overlay must exercise, while this mapping also protects read-only
# review evaluation from task setup and review-phase prompt replacement.
EVALUATED_ARM_SKILLS = {
    **ARM_SKILLS,
    "review": ("gitnexus-review",),
}
PROMOTION_METRICS = ("output_tokens", "cost_usd", "duration_s", "num_turns")
# Token/turn metrics come from the CLI's top-level `usage`, which counts ONLY
# the main-loop session. `total_cost_usd` is the only reported number that
# includes subagent spend.
MAIN_LOOP_ONLY_METRICS = frozenset({"output_tokens", "num_turns"})
MAIN_LOOP_ONLY_WARNING = (
    "WARNING: token and turn metrics count only the main-loop session — subagent spend "
    "is invisible to them and systematically flatters subagent-heavy "
    "candidates. Prefer cost_usd (the only CLI-reported field that includes "
    "subagents), or sum usage from the digest-bound transcript_artifacts in "
    "each run output, deduplicating events "
    "that share one message.id."
)
EVIDENCE_MAX_AGE_DAYS = 90
MAX_CANDIDATE_OVERLAY_BYTES = 4 * 1024 * 1024
MAX_SKILL_FINGERPRINT_BYTES = 4 * 1024 * 1024
MAX_CANDIDATE_ENTRIES = 256
MAX_CANDIDATE_FILES = 64
MAX_CANDIDATE_PATH_BYTES = 512


def _require_real_directory(path: Path, *, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ValueError(f"{label} is unavailable: {path}: {exc}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"{label} must be a real non-symlink directory: {path}")


def _require_directory_chain(root: Path, relative: Path, *, label: str) -> None:
    """Validate each lexical directory without erasing links via resolve()."""

    _require_real_directory(root, label=label)
    current = root
    for part in relative.parts:
        if part in {"", ".", ".."}:
            raise ValueError(f"{label} contains an unsafe path component: {relative}")
        current /= part
        _require_real_directory(current, label=label)


def _bounded_regular_bytes(path: Path, *, limit: int, label: str) -> bytes:
    """Read one bounded regular file without following its leaf link."""

    try:
        before = path.lstat()
    except OSError as exc:
        raise ValueError(f"{label} is unreadable: {path}: {exc}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError(f"{label} must be a regular non-symlink file: {path}")
    if before.st_size > limit:
        raise ValueError(f"{label} exceeds the bounded evidence limit")

    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise ValueError(f"{label} changed while opening: {path}")
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) > limit:
            raise ValueError(f"{label} exceeds the bounded evidence limit")
        after = os.fstat(descriptor)
        if (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) or len(content) != opened.st_size:
            raise ValueError(f"{label} changed while being read: {path}")
        return content
    finally:
        os.close(descriptor)


def candidate_overlay_payload(overlay: Path) -> tuple[str, list[tuple[PurePosixPath, bytes]]]:
    """Return the sole validated, bounded candidate payload and its digest."""

    root = overlay.expanduser().absolute()
    payload: list[tuple[PurePosixPath, bytes]] = []
    remaining = MAX_CANDIDATE_OVERLAY_BYTES
    for source in candidate_overlay_files(root):
        relative = PurePosixPath(source.relative_to(root).as_posix())
        _require_directory_chain(
            root,
            Path(*relative.parent.parts),
            label="candidate overlay directory",
        )
        content = _bounded_regular_bytes(
            source,
            limit=remaining,
            label="candidate overlay file",
        )
        remaining -= len(content)
        payload.append((relative, content))
    return _fingerprint_payload(payload), payload


def _fingerprint_payload(payload: list[tuple[PurePosixPath, bytes]]) -> str:
    digest = hashlib.sha256()
    for relative_path, content in payload:
        relative = relative_path.as_posix().encode()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _replace_regular_file(root: Path, relative: Path, content: bytes) -> None:
    """Replace a clone file through validated directory descriptors."""

    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ValueError(f"candidate destination escapes the clone: {relative}")
    _require_real_directory(root, label="candidate destination root")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(root, directory_flags)
    try:
        for part in relative.parts[:-1]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            try:
                child = os.open(part, directory_flags, dir_fd=descriptor)
            except OSError as exc:
                raise ValueError(
                    f"candidate destination parent must be a real directory: {relative.parent}: {exc}"
                ) from exc
            os.close(descriptor)
            descriptor = child

        leaf = relative.name
        try:
            existing = os.stat(leaf, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        except OSError as exc:
            raise ValueError(f"candidate destination is unreadable: {relative}: {exc}") from exc
        if existing is not None and (stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode)):
            raise ValueError(f"candidate destination must be a regular non-symlink file: {relative}")

        temporary = f".wfbench-overlay-{secrets.token_hex(12)}"
        temp_descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=descriptor,
        )
        try:
            view = memoryview(content)
            while view:
                written = os.write(temp_descriptor, view)
                if written <= 0:
                    raise OSError("short write while staging candidate overlay")
                view = view[written:]
            os.fchmod(temp_descriptor, 0o644)
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=descriptor)
            except OSError:
                pass
            raise
        finally:
            os.close(temp_descriptor)
        try:
            os.replace(
                temporary,
                leaf,
                src_dir_fd=descriptor,
                dst_dir_fd=descriptor,
            )
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=descriptor)
            except OSError:
                pass
            raise
    finally:
        os.close(descriptor)


def _sandbox_overlay_git(
    sandbox: SandboxSession,
    args: list[str],
    *,
    extra_config: tuple[str, ...] = (),
) -> Any:
    hooks = f"{SANDBOX_TMP}/wfbench-empty-hooks"
    command = [
        "/usr/bin/git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        f"core.hooksPath={hooks}",
        "-c",
        "commit.gpgsign=false",
    ]
    for item in extra_config:
        command.extend(("-c", item))
    command.extend(("-C", SANDBOX_WORKSPACE, *args))
    result = sandbox.run(
        command,
        timeout=60,
        env=build_sandbox_environment(),
    )
    return command, result


def candidate_overlay_files(overlay: Path) -> list[Path]:
    """Return a candidate's files after enforcing the benchmark trust boundary.

    Candidates may change only the canonical repo-local skill prompts. They
    cannot modify task code, tests, or verification commands and thereby game
    the promotion gate.
    """
    overlay = overlay.expanduser().absolute()
    try:
        resolved_overlay = overlay.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"candidate overlay is not a directory: {overlay}") from exc
    if resolved_overlay != overlay:
        raise ValueError(f"candidate overlay cannot traverse symlinks: {overlay}")
    _require_real_directory(overlay, label="candidate overlay")

    entries: list[Path] = []
    pending = [overlay]
    entry_count = 0
    while pending:
        directory = pending.pop()
        child_directories: list[Path] = []
        try:
            iterator = os.scandir(directory)
        except OSError as exc:
            raise ValueError(f"candidate overlay directory is unreadable: {directory}: {exc}") from exc
        with iterator:
            for item in iterator:
                entry_count += 1
                if entry_count > MAX_CANDIDATE_ENTRIES:
                    raise ValueError(f"candidate overlay exceeds the {MAX_CANDIDATE_ENTRIES}-entry limit")
                path = Path(item.path)
                relative = path.relative_to(overlay)
                if len(relative.as_posix().encode()) > MAX_CANDIDATE_PATH_BYTES:
                    raise ValueError(f"candidate overlay path exceeds {MAX_CANDIDATE_PATH_BYTES} bytes: {relative}")
                if item.is_symlink():
                    raise ValueError(f"candidate overlay cannot contain symlinks: {relative}")
                if item.is_dir(follow_symlinks=False):
                    child_directories.append(path)
                    continue
                if not item.is_file(follow_symlinks=False):
                    raise ValueError(f"candidate overlay entries must be regular files: {relative}")
                entries.append(path)
                if len(entries) > MAX_CANDIDATE_FILES:
                    raise ValueError(f"candidate overlay exceeds the {MAX_CANDIDATE_FILES}-file limit")
        pending.extend(child_directories)

    entries.sort(key=lambda path: path.relative_to(overlay).as_posix())
    if not entries:
        raise ValueError(f"candidate overlay contains no files: {overlay}")

    for path in entries:
        relative = path.relative_to(overlay)
        parts = relative.parts
        if (
            len(parts) < 4
            or parts[:2] != (".claude", "skills")
            or parts[2] not in CANDIDATE_SKILLS
            or path.suffix.lower() != ".md"
        ):
            raise ValueError(
                "candidate overlays may only contain Markdown files under "
                ".claude/skills/gitnexus-{plan,work}: "
                f"{relative}"
            )
    return entries


def required_candidate_arms(overlay: Path) -> list[str]:
    """Return the smallest candidate-arm set that exercises every change.

    Plan prompts are loaded only by the two-session workflow. Work prompts are
    loaded by both workflow shapes, so a work candidate must prove itself in
    both rather than inheriting a decision from an untested execution mode.
    """
    overlay = overlay.expanduser().absolute()
    touched = {path.relative_to(overlay).parts[2] for path in candidate_overlay_files(overlay)}
    required: list[str] = []
    if "gitnexus-plan" in touched or "gitnexus-work" in touched:
        required.append("candidate_workflow")
    if "gitnexus-work" in touched:
        required.append("candidate_workflow_direct")
    return required


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
    digest, _ = candidate_overlay_payload(overlay)
    return digest


def apply_candidate_overlay(
    overlay: Path,
    worktree: Path,
    *,
    sandbox: SandboxSession,
) -> str:
    """Safely copy and commit a prompt candidate inside its outer sandbox."""

    overlay = overlay.expanduser().absolute()
    expected_clone = Path(os.path.abspath(worktree.expanduser()))
    sandbox_clone = Path(os.path.abspath(sandbox.clone.expanduser()))
    if sandbox_clone != expected_clone:
        raise ValueError("candidate sandbox does not bind the requested clone")
    digest, payload = candidate_overlay_payload(overlay)
    relative_paths: list[str] = []
    for relative, content in payload:
        _replace_regular_file(worktree, relative, content)
        relative_paths.append(relative.as_posix())

    mkdir_command = ["/bin/mkdir", "-p", f"{SANDBOX_TMP}/wfbench-empty-hooks"]
    mkdir_result = sandbox.run(
        mkdir_command,
        timeout=60,
        env=build_sandbox_environment(),
    )
    if not mkdir_result.ok:
        raise ManagedProcessError(mkdir_command, mkdir_result)

    command, added = _sandbox_overlay_git(sandbox, ["add", "--", *relative_paths])
    if not added.ok:
        raise ManagedProcessError(command, added)
    command, changed = _sandbox_overlay_git(
        sandbox,
        ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--"],
    )
    if changed.returncode == 0:
        raise ValueError("candidate overlay is byte-identical to the incumbent skills")
    if changed.returncode != 1:
        raise ManagedProcessError(command, changed)

    command, committed = _sandbox_overlay_git(
        sandbox,
        [
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "benchmark candidate skill overlay",
        ],
        extra_config=(
            "user.name=workflow-bench",
            "user.email=workflow-bench@invalid",
        ),
    )
    if not committed.ok:
        raise ManagedProcessError(command, committed)
    return digest


def unexercised_overlay_skills(overlay: Path, candidate_arms: list[str]) -> list[str]:
    """Overlay skills that no selected candidate arm would ever load.

    A gitnexus-lfg-only (or gitnexus-review-only) overlay paired with the
    workflow arms is never read by any benchmarked session, so any promotion
    decision about it would be noise.
    """
    overlay = overlay.expanduser().absolute()
    exercised = {skill for arm in candidate_arms for skill in ARM_SKILLS[CANDIDATE_ARMS[arm]]}
    touched = {path.relative_to(overlay).parts[2] for path in candidate_overlay_files(overlay)}
    return sorted(touched - exercised)


def skill_fingerprint(worktree: Path, arm: str) -> str | None:
    skill_names = EVALUATED_ARM_SKILLS.get(arm)
    if skill_names is None:
        return None

    worktree = worktree.expanduser().absolute()
    _require_real_directory(worktree, label="skill fingerprint worktree")
    _require_directory_chain(
        worktree,
        Path(".claude") / "skills",
        label="skill fingerprint parent",
    )
    for skill_name in skill_names:
        _require_directory_chain(
            worktree,
            Path(".claude") / "skills" / skill_name,
            label="skill fingerprint root",
        )

    entries = sorted(
        (path for skill_name in skill_names for path in (worktree / ".claude" / "skills" / skill_name).rglob("*")),
        key=lambda path: path.relative_to(worktree).as_posix(),
    )
    files: list[Path] = []
    total = 0
    for path in entries:
        metadata = path.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"skill fingerprint input must be a regular non-symlink file: {path}")
        total += metadata.st_size
        if total > MAX_SKILL_FINGERPRINT_BYTES:
            raise ValueError("skill fingerprint input exceeds the bounded evidence limit")
        files.append(path)
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
    quality_floor_failed = False
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
        # cost_usd is None when a run's cost was never measured (see
        # runner_sessions.measured_cost): the arm's aggregate cost is then
        # unavailable and must not be ranked on, or a candidate could "win"
        # cheapness it never actually demonstrated.
        raw_incumbent_metric = incumbent.get(metric)
        raw_candidate_metric = candidate.get(metric)
        metric_unavailable = raw_incumbent_metric is None or raw_candidate_metric is None
        incumbent_metric = None if raw_incumbent_metric is None else float(raw_incumbent_metric)
        candidate_metric = None if raw_candidate_metric is None else float(raw_candidate_metric)
        improvement = (
            round(100 * (incumbent_metric - candidate_metric) / incumbent_metric, 1)
            if (not metric_unavailable and incumbent_metric)
            else None
        )
        task_rows.append(
            {
                "task": task_id,
                "class": incumbent.get("class", ""),
                "incumbent_resolved": f"{incumbent['resolved']}/{incumbent_runs}",
                "candidate_resolved": f"{candidate['resolved']}/{candidate_runs}",
                "incumbent_excluded_runs": incumbent_excluded,
                "candidate_excluded_runs": candidate_excluded,
                "candidate_quality_floor_met": candidate_runs > 0 and candidate["resolved"] == candidate_runs,
                "incumbent_metric": incumbent_metric,
                "candidate_metric": candidate_metric,
                "improvement_pct": improvement,
            }
        )

        if incumbent_runs < min_runs or candidate_runs < min_runs:
            insufficient = True
            reasons.append(
                f"{task_id}: needs at least {min_runs} valid runs per arm (got {incumbent_runs}/{candidate_runs})"
            )
        if incumbent_excluded or candidate_excluded:
            insufficient = True
            reasons.append(
                f"{task_id}: promotion requires zero excluded runs in both paired arms "
                f"(got {incumbent_excluded}/{candidate_excluded})"
            )
        if incumbent_runs != candidate_runs:
            insufficient = True
            reasons.append(
                f"{task_id}: paired arms have different valid run counts "
                f"({incumbent_runs}/{candidate_runs} valid; {incumbent_excluded}/{candidate_excluded} excluded)"
            )
        if candidate_rate < incumbent_rate:
            quality_regression = True
            reasons.append(f"{task_id}: resolution regressed from {incumbent_rate:.0%} to {candidate_rate:.0%}")
        if candidate_runs > 0 and candidate["resolved"] != candidate_runs:
            quality_floor_failed = True
            reasons.append(
                f"{task_id}: candidate must resolve every valid run for the oracle-backed quality floor "
                f"(got {candidate['resolved']}/{candidate_runs})"
            )
        if metric_unavailable:
            insufficient = True
            reasons.append(
                f"{task_id}: {metric} was not measured on every run in both paired arms; "
                "cannot rank on it (fix cost capture or choose another metric)"
            )
        elif improvement is None:
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
    elif quality_regression or quality_floor_failed or efficiency_regression:
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
