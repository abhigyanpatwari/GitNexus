"""Build a candidate without exposing the trusted evaluator or host environment."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path, PurePosixPath

from .oci_worker import run_worker
from .process_control import run_checked
from .proposer_sandbox import SANDBOX_PATH, ReadOnlyMount, SandboxError, bwrap_base_args, preflight_bubblewrap, real_directory


REGISTRY = "https://registry.npmjs.org/"
LOCKFILES = ("package-lock.json", "gitnexus/package-lock.json")


def require_registry_only_install(repo: Path) -> None:
    """Fail unless the online install can only fetch from the public npm registry.

    The download phase has network, and npm fetches every lockfile ``resolved``
    URL. A candidate must not steer it at other hosts (loopback, private
    networks, cloud metadata) through its lockfiles or an npm config file.
    """

    for config in (".npmrc", "gitnexus/.npmrc"):
        if os.path.lexists(repo / config):
            raise ValueError(f"release candidate must not ship npm configuration: {config}")
    for lockfile in LOCKFILES:
        try:
            packages = json.loads((repo / lockfile).read_text())["packages"]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError(f"release candidate lockfile is unreadable: {lockfile}") from exc
        if not isinstance(packages, dict):
            raise ValueError(f"release candidate lockfile is malformed: {lockfile}")
        root = PurePosixPath(lockfile).parent
        for name, entry in packages.items():
            resolved = entry.get("resolved") if isinstance(entry, dict) else None
            if resolved is None or (isinstance(resolved, str) and resolved.startswith(REGISTRY)):
                continue
            # Workspace links stay inside the checkout and fetch nothing.
            target = PurePosixPath(os.path.normpath(root / resolved)) if isinstance(resolved, str) else None
            if (
                entry.get("link") is True
                and target is not None
                and not target.is_absolute()
                and ".." not in target.parts
            ):
                continue
            raise ValueError(f"release candidate lockfile {lockfile} resolves {name!r} outside {REGISTRY}")


def build_candidate(repo: Path, *, backend: str = "auto") -> None:
    """Install dependencies with network, then run lifecycle scripts without it.

    Only the checkout, minus git metadata, is writable in either phase.
    """
    repo = real_directory(repo, label="release candidate")
    # Host git later runs in this checkout (e.g. actions/checkout cleanup), so
    # lifecycle scripts must not plant git config such as core.fsmonitor.
    git_dir = repo / ".git"
    git_mask = ["--ro-bind", str(git_dir), "/workspace/.git"] if os.path.lexists(git_dir) else []
    require_registry_only_install(repo)
    if backend not in {"auto", "bwrap", "docker"}:
        raise ValueError(f"unknown release build backend: {backend}")
    bwrap = None
    if backend != "docker":
        try:
            bwrap = preflight_bubblewrap()
        except SandboxError:
            if backend == "bwrap":
                raise

    def build_phase(script: list[str], *, offline: bool) -> None:
        command = ["/bin/bash", "--noprofile", "--norc", "-c", "\n".join(["set -euo pipefail", *script])]
        if bwrap is None:
            with tempfile.TemporaryDirectory(prefix="gnx-build-git-") as private:
                masks = []
                if os.path.lexists(git_dir):
                    mask = Path(private) / "metadata"
                    if git_dir.is_symlink():
                        raise SandboxError("release candidate git metadata must not be a symlink")
                    if git_dir.is_dir():
                        mask.mkdir()
                    else:
                        mask.touch()
                    masks.append(ReadOnlyMount(mask, "/workspace/.git"))
                run_worker(command, checkout=repo, readonly=False, mounts=masks, timeout=1200,
                           environment={"ONNXRUNTIME_NODE_INSTALL": "skip"}, registry_download=not offline)
            return
        argv = [
            str(bwrap),
            *bwrap_base_args(unshare_network=offline, cap_drop_all=True),
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
            # CPU binaries ship in the npm package. Optional CUDA downloads
            # cannot run during the network-isolated lifecycle phase.
            "--setenv",
            "ONNXRUNTIME_NODE_INSTALL",
            "skip",
            "--chdir",
            "/workspace",
            "--",
            *command,
        ]
        run_checked(argv, timeout=1200, env={})

    # Locked downloads need the network but run no package code. Every
    # lifecycle script (dependency installs, prepare, build) then runs with no
    # network, so candidate-controlled code cannot reach host-local services.
    # No host home, evaluator checkout, GitHub command files or tokens are mounted.
    build_phase(
        [
            "npm ci --ignore-scripts --audit=false --fund=false",
            "npm ci --prefix gitnexus --ignore-scripts --audit=false --fund=false",
        ],
        offline=False,
    )
    build_phase(
        [
            "npm rebuild --foreground-scripts",
            "npm rebuild --prefix gitnexus --foreground-scripts",
            "npm run build --prefix gitnexus",
            "mkdir -p gitnexus-shared/node_modules",
        ],
        offline=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--backend", choices=("auto", "bwrap", "docker"), default="auto")
    args = parser.parse_args()
    build_candidate(args.repo, backend=args.backend)


if __name__ == "__main__":
    main()
