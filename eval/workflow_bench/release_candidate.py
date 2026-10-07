"""Carry one unpublished, versioned RC commit across trusted workflow jobs.

The small bundle requires the triggering source commit, already present in each
job's checkout. It contains Git objects only, never checkout credentials/config.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess


CANDIDATE_REF = "refs/heads/release-candidate"


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def _validate_commit(repo: Path, source_sha: str, candidate_sha: str, version: str | None) -> None:
    for sha in (source_sha, candidate_sha):
        if re.fullmatch(r"[0-9a-f]{40}", sha) is None:
            raise ValueError("release identity must be a full commit SHA")
    if _git(repo, "show", "-s", "--format=%P", candidate_sha) != source_sha:
        raise ValueError("candidate must have exactly the pinned source commit as its parent")
    package = json.loads(_git(repo, "show", f"{candidate_sha}:gitnexus/package.json"))
    actual = package.get("version", "")
    if not isinstance(actual, str) or re.fullmatch(r"\d+\.\d+\.\d+-rc\.\d+", actual) is None:
        raise ValueError("candidate package must carry an RC version")
    if version is not None and actual != version:
        raise ValueError("candidate version differs from the prepared RC")


def _require_clean(repo: Path) -> None:
    if _git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("candidate checkout has uncommitted tracked changes")


def create_bundle(repo: Path, source_sha: str, version: str, bundle: Path) -> str:
    """Export the current detached release commit without publishing a ref."""
    _require_clean(repo)
    candidate_sha = _git(repo, "rev-parse", "HEAD")
    _validate_commit(repo, source_sha, candidate_sha, version)
    bundle = bundle.resolve()
    bundle.parent.mkdir(parents=True, exist_ok=True)
    # The expected-old value prevents replacing a pre-existing local branch.
    _git(repo, "update-ref", CANDIDATE_REF, candidate_sha, "0" * 40)
    try:
        _git(repo, "bundle", "create", str(bundle), CANDIDATE_REF, f"^{source_sha}")
    finally:
        _git(repo, "update-ref", "-d", CANDIDATE_REF, candidate_sha)
    return candidate_sha


def restore_bundle(
    repo: Path, source_sha: str, candidate_sha: str, bundle: Path, version: str | None = None
) -> str:
    """Validate the exact current-run artifact before selecting its commit."""
    _require_clean(repo)
    bundle = bundle.resolve()
    refs = _git(repo, "bundle", "list-heads", str(bundle)).splitlines()
    if refs != [f"{candidate_sha} {CANDIDATE_REF}"]:
        raise ValueError("bundle must export the single expected release-candidate SHA/ref")
    _git(repo, "bundle", "verify", str(bundle))
    _git(repo, "fetch", "--no-tags", str(bundle), CANDIDATE_REF)
    _validate_commit(repo, source_sha, candidate_sha, version)
    _git(repo, "checkout", "--detach", candidate_sha)
    return candidate_sha


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "restore"))
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--candidate-sha")
    parser.add_argument("--version")
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "create":
        if not args.version:
            parser.error("create requires --version")
        print(create_bundle(args.repo, args.source_sha, args.version, args.bundle))
    else:
        if not args.candidate_sha:
            parser.error("restore requires --candidate-sha")
        print(restore_bundle(args.repo, args.source_sha, args.candidate_sha, args.bundle, args.version))


if __name__ == "__main__":
    main()
