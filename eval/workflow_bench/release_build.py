"""Build a candidate without exposing the trusted evaluator or host environment."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .process_control import run_checked
from .proposer_sandbox import SANDBOX_PATH, bwrap_base_args, preflight_bubblewrap, real_directory


def build_candidate(repo: Path) -> None:
    """Run candidate lifecycle scripts with only their checkout, minus git metadata, writable."""
    repo = real_directory(repo, label="release candidate")
    # Host git later runs in this checkout (e.g. actions/checkout cleanup), so
    # lifecycle scripts must not plant git config such as core.fsmonitor.
    git_dir = repo / ".git"
    git_mask = ["--ro-bind", str(git_dir), "/workspace/.git"] if os.path.lexists(git_dir) else []
    bwrap = preflight_bubblewrap()
    command = [
        str(bwrap),
        *bwrap_base_args(cap_drop_all=True),
        "--tmpfs",
        "/tmp",
        "--dir",
        "/home/build",
        "--bind",
        str(repo),
        "/workspace",
        *git_mask,
        "--clearenv",
        "--setenv",
        "PATH",
        SANDBOX_PATH,
        "--setenv",
        "HOME",
        "/home/build",
        "--chdir",
        "/workspace",
        "--",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        "\n".join(
            [
                "set -euo pipefail",
                "npm ci --audit=false --fund=false",
                "npm ci --prefix gitnexus --audit=false --fund=false",
                "npm run build --prefix gitnexus",
                "mkdir -p gitnexus-shared/node_modules",
            ]
        ),
    ]
    # Network is available for locked dependency downloads. No host home,
    # evaluator checkout, GitHub command files, or inherited tokens are mounted.
    run_checked(command, timeout=1200, env={})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    build_candidate(parser.parse_args().repo)


if __name__ == "__main__":
    main()
