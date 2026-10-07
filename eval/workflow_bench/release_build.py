"""Build a candidate without exposing the trusted evaluator or host environment."""

from __future__ import annotations

import argparse
from pathlib import Path

from .process_control import run_checked
from .proposer_sandbox import SANDBOX_PATH, _real_directory, _runtime_mount_args, preflight_bubblewrap


def build_candidate(repo: Path) -> None:
    """Run candidate lifecycle scripts with only their checkout writable."""
    repo = _real_directory(repo, label="release candidate")
    bwrap = preflight_bubblewrap()
    command = [
        str(bwrap),
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        *_runtime_mount_args(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/home/build",
        "--bind",
        str(repo),
        "/workspace",
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
