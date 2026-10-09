"""Find successful default-branch evidence for one exact release revision."""

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

from .release_report import suite_binding, validate_report


def eligible_runs(payload: dict[str, Any], repo: str) -> list[int]:
    return [
        run["id"]
        for run in payload.get("workflow_runs", [])
        if run.get("conclusion") == "success"
        and run.get("head_branch") == "main"
        and run.get("event") in ("schedule", "workflow_dispatch")
        and run.get("head_repository", {}).get("full_name") == repo
        and type(run.get("id")) is int
    ]


def _gh_json(endpoint: str) -> dict[str, Any]:
    return json.loads(subprocess.run(["gh", "api", endpoint], check=True, capture_output=True, text=True).stdout)


def _recent_runs(repo: str) -> Iterator[int]:
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


def download_evidence(repo: str, runtime_sha: str, out: Path) -> None:
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not re.fullmatch(r"[0-9a-f]{40}", runtime_sha):
        raise ValueError("expected a repository name and full release commit SHA")
    _, digest, pins = suite_binding()
    artifact_name = f"release-agent-evaluation-{runtime_sha}"
    for run_id in _recent_runs(repo):
        artifacts = _gh_json(f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100")
        if not any(
            item.get("name") == artifact_name and not item.get("expired") for item in artifacts.get("artifacts", [])
        ):
            continue
        with tempfile.TemporaryDirectory(prefix="release-evidence-") as folder:
            subprocess.run(
                ["gh", "run", "download", str(run_id), "--repo", repo, "--name", artifact_name, "--dir", folder],
                check=True,
                capture_output=True,
            )
            source = Path(folder) / "agent-evaluation.json"
            if not source.is_file() or source.is_symlink() or source.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("invalid release evidence artifact")
            source_text = source.read_text()
            report = json.loads(source_text)
            validate_report(report, runtime_sha=runtime_sha, task_set_digest=digest)
            if report["tasks"] != pins:
                raise ValueError("release task pins do not match the measured task set")
            out.mkdir(parents=True, exist_ok=True)
            (out / source.name).write_text(source_text)
            # Regenerate prose from verified numbers; never trust downloaded Markdown.
            from .release_report import render_markdown

            (out / "agent-evaluation.md").write_text(render_markdown(report))
            print(f"Verified agent evidence from workflow run {run_id} for {runtime_sha}.")
            return
    raise ValueError(
        "No complete paired agent evaluation for this exact commit. Run Release evaluation on main with candidate_ref set to the stable commit before publishing."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--runtime-sha", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    download_evidence(args.repo, args.runtime_sha, args.out)


if __name__ == "__main__":
    main()
