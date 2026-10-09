"""Find successful default-branch evidence for one exact release revision.

Run this module from the current main evaluator tree (``--evaluator-sha``), not
from the release commit: evidence counts only when the run that produced it
measured with a harness whose evaluation inputs still match that tree.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .release_report import render_markdown, suite_binding, validate_report

SHA = re.compile(r"[0-9a-f]{40}")
# Paths whose content defines what an agent evaluation measures: harness,
# graders, task pins, the evaluation workflow and its pinned agent CLI.
HARNESS_PATHS = ("eval/", ".github/workflows/release-evaluation.yml", ".github/claude-canary-runtime/")
# GitHub's compare API lists at most 300 changed files for a whole comparison.
COMPARE_FILE_LIMIT = 300
GH_TIMEOUT_S = 120
MAX_REASONS = 20


def eligible_runs(payload: dict[str, Any], repo: str) -> list[tuple[int, str]]:
    """Trusted main runs, newest first as listed, with the commit each one ran."""
    return [
        (run["id"], run["head_sha"])
        for run in payload.get("workflow_runs", [])
        if run.get("conclusion") == "success"
        and run.get("head_branch") == "main"
        and run.get("event") in ("schedule", "workflow_dispatch")
        and run.get("head_repository", {}).get("full_name") == repo
        and type(run.get("id")) is int
        and isinstance(run.get("head_sha"), str)
        and SHA.fullmatch(run["head_sha"])
    ]


def _gh(args: list[str]) -> str:
    try:
        return subprocess.run(["gh", *args], check=True, capture_output=True, text=True, timeout=GH_TIMEOUT_S).stdout
    except subprocess.TimeoutExpired:
        raise ValueError(f"gh {args[0]} timed out after {GH_TIMEOUT_S}s") from None
    except subprocess.CalledProcessError as exc:
        # gh's stderr is not echoed: keep the failure bounded and free of request details.
        raise ValueError(f"gh {args[0]} failed with exit status {exc.returncode}") from None


def _gh_json(endpoint: str) -> dict[str, Any]:
    return json.loads(_gh(["api", endpoint]))


def _recent_runs(repo: str) -> Iterator[tuple[int, str]]:
    # Reports expire after seven days; a run can start up to a day earlier.
    since = (datetime.now(UTC) - timedelta(days=8)).date().isoformat()
    page = 1
    while True:
        payload = _gh_json(
            f"repos/{repo}/actions/workflows/release-evaluation.yml/runs"
            f"?branch=main&status=success&created=%3E%3D{since}&per_page=100&page={page}"
        )
        yield from eligible_runs(payload, repo)
        if len(payload.get("workflow_runs", [])) < 100:
            return
        page += 1


def require_current_harness(repo: str, harness_sha: str, evaluator_sha: str) -> None:
    """Fail unless main reached ``evaluator_sha`` from ``harness_sha`` without touching evaluation inputs."""
    comparison = _gh_json(f"repos/{repo}/compare/{harness_sha}...{evaluator_sha}")
    if comparison.get("status") not in ("identical", "ahead"):
        raise ValueError(f"harness {harness_sha} is not an ancestor of the current main evaluator {evaluator_sha}")
    files = comparison.get("files")
    if not isinstance(files, list) or len(files) >= COMPARE_FILE_LIMIT:
        raise ValueError("cannot prove the harness is current: the compare file list is missing or truncated")
    changed: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
            raise ValueError("cannot prove the harness is current: malformed compare file entry")
        # A rename out of a harness path changes the harness too.
        names = (entry["filename"], entry.get("previous_filename"))
        changed.update(name for name in names if isinstance(name, str) and name.startswith(HARNESS_PATHS))
    if changed:
        raise ValueError(
            f"evaluation inputs changed on main since harness {harness_sha} "
            f"({len(changed)} file(s), e.g. {min(changed)}); re-run Release evaluation"
        )


def _verified_report(
    repo: str,
    run_id: int,
    head_sha: str,
    artifact_name: str,
    *,
    runtime_sha: str,
    evaluator_sha: str,
    digest: str,
    pins: dict[str, Any],
) -> tuple[str, dict[str, Any]] | None:
    """The run's validated report text and data; None when the run has no live artifact."""
    artifacts = _gh_json(f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100")
    if not any(
        item.get("name") == artifact_name and not item.get("expired") for item in artifacts.get("artifacts", [])
    ):
        return None
    with tempfile.TemporaryDirectory(prefix="release-evidence-") as folder:
        _gh(["run", "download", str(run_id), "--repo", repo, "--name", artifact_name, "--dir", folder])
        source = Path(folder) / "agent-evaluation.json"
        if not source.is_file() or source.is_symlink() or source.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("invalid release evidence artifact")
        source_text = source.read_text()
    report = json.loads(source_text)
    if not isinstance(report, dict) or report.get("harness_sha") != head_sha:
        raise ValueError(f"report harness_sha is not the commit workflow run {run_id} ran ({head_sha})")
    require_current_harness(repo, head_sha, evaluator_sha)
    # The tree running this module is that harness's evaluator, so its task
    # binding is the one the run measured, not the release commit's.
    validate_report(report, runtime_sha=runtime_sha, task_set_digest=digest, task_pins=pins)
    return source_text, report


def download_evidence(repo: str, runtime_sha: str, out: Path, *, evaluator_sha: str) -> None:
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not all(
        SHA.fullmatch(sha) for sha in (runtime_sha, evaluator_sha)
    ):
        raise ValueError("expected a repository name and full release commit SHA and evaluator SHA")
    _, digest, pins = suite_binding()
    artifact_name = f"release-agent-evaluation-{runtime_sha}"
    rejected: list[str] = []
    for run_id, head_sha in _recent_runs(repo):
        try:
            verified = _verified_report(
                repo,
                run_id,
                head_sha,
                artifact_name,
                runtime_sha=runtime_sha,
                evaluator_sha=evaluator_sha,
                digest=digest,
                pins=pins,
            )
        except (ValueError, KeyError, TypeError) as exc:
            # A rejected run never hides an older valid one; every reason is reported.
            reason = str(exc) if isinstance(exc, ValueError) else f"malformed report ({type(exc).__name__})"
            rejected.append(f"run {run_id}: {reason[:300]}")
            continue
        if verified is None:
            continue
        source_text, report = verified
        out.mkdir(parents=True, exist_ok=True)
        (out / "agent-evaluation.json").write_text(source_text)
        # Regenerate prose from verified numbers; never trust downloaded Markdown.
        (out / "agent-evaluation.md").write_text(render_markdown(report))
        print(f"Verified agent evidence from workflow run {run_id} (harness {head_sha}) for {runtime_sha}.")
        return
    details = "".join(f"\n- {reason}" for reason in rejected[:MAX_REASONS])
    if len(rejected) > MAX_REASONS:
        details += f"\n- ... and {len(rejected) - MAX_REASONS} more rejected run(s)"
    raise ValueError(
        "No complete paired agent evaluation for this exact commit from the current main evaluator. "
        "Run Release evaluation on main with candidate_ref set to the stable commit before publishing."
        + (f"\nRejected evidence:{details}" if rejected else "")
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--runtime-sha", required=True)
    parser.add_argument("--evaluator-sha", required=True, help="main commit whose eval/ tree runs this module")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    download_evidence(args.repo, args.runtime_sha, args.out, evaluator_sha=args.evaluator_sha)


if __name__ == "__main__":
    main()
