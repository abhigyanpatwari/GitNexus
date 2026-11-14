"""Prepare DeepSWE task copies for a paired baseline vs GitNexus comparison.

DeepSWE tasks are Harbor tasks with a prebuilt image and no agent network. The
`baseline` arm copies them unchanged. The `gitnexus` arm gives each task a
derived image: the prebuilt one plus Node, the GitNexus package and an index of
`/app` built at image-build time, so the no-network agent sandbox has a ready
graph and no install step. It also appends a short CLI note to the instruction.
Both arms get the same seeded subset, so `report.py` can pair trials by task.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import tomllib
from pathlib import Path
from typing import Any

ARMS = ("baseline", "gitnexus")
# Renamed so pier's per-task image tag (`hb__<task name>`) never reuses a baseline image.
GITNEXUS_TASK_SUFFIX = "-gitnexus"
NODE_VERSION = "22.18.0"  # gitnexus/package.json engines: ^22.18.0
PACKAGE_FILE = "gitnexus.tgz"
MIN_BUILD_TIMEOUT_SEC = 3600.0  # the index is built inside the image build

# Appended to the gitnexus arm's instruction. "product" is the CLI form of the
# rules GitNexus ships in AGENTS.md (graph first, impact before edits,
# detect-changes before committing), as the release evaluation's arms load.
# "optional" only lists the commands, for an ablation.
GUIDANCE = {
    "product": """

## GitNexus

A GitNexus code graph of `/app` (indexed at the starting commit) is installed; the `gitnexus` command works offline. Follow GitNexus's agent rules:

- Explore with `gitnexus query "<concept>"` for concepts and execution flows, and `gitnexus context <symbol>` for a named symbol's callers, callees and flows. Graph first; use text search for literals or when the graph has no answer.
- Before editing a function, class or method, run `gitnexus impact <symbol> --direction upstream` and check its callers and risk. An empty result is not proof that nothing depends on it.
- Before committing, run `gitnexus detect-changes` to see which symbols and flows your edits affect.

Run `gitnexus <command> --help` for options.
""",
    "optional": """

## GitNexus

A GitNexus code graph of `/app` (indexed at the starting commit) is installed. The `gitnexus` command works offline:

- `gitnexus query "<concept>"`: code related to a concept, grouped by execution flow
- `gitnexus context <symbol>`: callers, callees and flows of a symbol
- `gitnexus impact <symbol> --direction upstream`: what depends on a symbol
- `gitnexus detect-changes`: symbols and flows touched by your uncommitted edits

Run `gitnexus <command> --help` for options. Using it is optional.
""",
}

DOCKERFILE = """FROM {image}

# GitNexus layer, written by eval/deepswe/prepare.py. The agent sandbox has no
# network, so Node, the package and the index of /app are all built in here.
ARG NODE_VERSION={node}
RUN set -eu; \\
    command -v curl >/dev/null || (apt-get update && apt-get install -y --no-install-recommends curl ca-certificates); \\
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac; \\
    tarball="node-v${{NODE_VERSION}}-linux-${{arch}}.tar.gz"; \\
    cd /tmp; \\
    curl -fsSLO "https://nodejs.org/dist/v${{NODE_VERSION}}/${{tarball}}"; \\
    curl -fsSL "https://nodejs.org/dist/v${{NODE_VERSION}}/SHASUMS256.txt" | grep " ${{tarball}}$" | sha256sum -c -; \\
    mkdir -p /opt/gitnexus-node; \\
    tar -xzf "${{tarball}}" -C /opt/gitnexus-node --strip-components=1; \\
    rm "${{tarball}}"
COPY {package} /tmp/{package}
# PATH is left alone so a task's own node/npm are not shadowed. The only new
# command is a /usr/local/bin wrapper pinned to this Node, which login shells keep too.
# An explicit --prefix, because task images may carry their own npm config.
RUN export PATH=/opt/gitnexus-node/bin:$PATH \\
    && npm install --global --prefix /opt/gitnexus --no-fund --no-audit /tmp/{package} \\
    && rm /tmp/{package} \\
    && pkg=/opt/gitnexus/lib/node_modules/gitnexus \\
    && cli="$pkg/$(node -p "require('$pkg/package.json').bin.gitnexus")" \\
    && printf '#!/bin/sh\\nPATH=/opt/gitnexus-node/bin:$PATH exec node %s "$@"\\n' "$cli" > /usr/local/bin/gitnexus \\
    && chmod 755 /usr/local/bin/gitnexus \\
    && gitnexus --version
# --index-only writes no AGENTS.md/CLAUDE.md/skills; .gitnexus/ is git-excluded.
# Fail the build if indexing changed what git sees, since that would leak into the graded patch.
RUN cd /app \\
    && before="$(git status --porcelain=v1 --untracked-files=all | sha256sum)" \\
    && gitnexus analyze --index-only \\
    && after="$(git status --porcelain=v1 --untracked-files=all | sha256sum)" \\
    && test "$before" = "$after"
"""


def task_ids(tasks_root: Path) -> list[str]:
    return sorted(path.parent.name for path in tasks_root.glob("*/task.toml"))


def select_tasks(available: list[str], *, include: list[str] | None, n_tasks: int | None, seed: int) -> list[str]:
    """The same subset for every arm: explicit ids, or a seeded sample of the sorted ids."""

    if include:
        missing = sorted(set(include) - set(available))
        if missing:
            raise SystemExit(f"unknown task id(s): {', '.join(missing)}")
        return sorted(dict.fromkeys(include))
    if n_tasks is None or n_tasks >= len(available):
        return sorted(available)
    return sorted(random.Random(seed).sample(sorted(available), n_tasks))


def _docker_image(task_toml: str) -> str:
    image = (tomllib.loads(task_toml).get("environment") or {}).get("docker_image")
    if not isinstance(image, str) or not image:
        raise ValueError("task has no [environment] docker_image to build the GitNexus layer on")
    return image


def gitnexus_task_toml(task_toml: str) -> str:
    """Build from the derived Dockerfile, under a distinct name, with room for indexing."""

    data = tomllib.loads(task_toml)
    name = data["task"]["name"]
    lines, section = [], ""
    for line in task_toml.splitlines():
        header = re.match(r"^\s*\[([^\[\]]+)\]\s*$", line)
        if header:
            section = header.group(1).strip()
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else ""
        if section == "environment" and key == "docker_image":
            continue
        if section == "task" and key == "name":
            line = f"name = {json.dumps(name + GITNEXUS_TASK_SUFFIX)}"
        if section == "environment" and key == "build_timeout_sec":
            current = float(data["environment"]["build_timeout_sec"])
            line = f"build_timeout_sec = {max(current, MIN_BUILD_TIMEOUT_SEC)}"
        lines.append(line)
    rewritten = "\n".join(lines) + "\n"
    tomllib.loads(rewritten)  # still valid TOML
    return rewritten


def prepare_task(source: Path, dest: Path, *, arm: str, package: Path | None, guidance: str = "product") -> None:
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest)
    if arm == "baseline":
        return
    if package is None:
        raise ValueError("the gitnexus arm needs --gitnexus-package")
    task_toml = (source / "task.toml").read_text(encoding="utf-8")
    image = _docker_image(task_toml)
    environment = dest / "environment"
    environment.mkdir(exist_ok=True)
    (environment / "Dockerfile").write_text(
        DOCKERFILE.format(image=image, node=NODE_VERSION, package=PACKAGE_FILE), encoding="utf-8"
    )
    shutil.copyfile(package, environment / PACKAGE_FILE)
    (dest / "task.toml").write_text(gitnexus_task_toml(task_toml), encoding="utf-8")
    instruction = dest / "instruction.md"
    instruction.write_text(instruction.read_text(encoding="utf-8").rstrip() + "\n" + GUIDANCE[guidance], encoding="utf-8")


def prepare(
    *, tasks_root: Path, out: Path, arms: list[str], selected: list[str], package: Path | None,
    guidance: str = "product",
) -> dict[str, Any]:
    for arm in arms:
        for task in selected:
            prepare_task(tasks_root / task, out / arm / task, arm=arm, package=package, guidance=guidance)
    manifest = {
        "schema": "gitnexus.deepswe-prepare/v1",
        "arms": arms,
        "tasks": selected,
        "gitnexus_task_suffix": GITNEXUS_TASK_SUFFIX,
        "guidance": guidance,
        "node_version": NODE_VERSION,
        "gitnexus_package": package.name if package else None,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--deep-swe", required=True, type=Path, help="checkout of github.com/datacurve-ai/deep-swe")
    parser.add_argument("--out", required=True, type=Path, help="writes <out>/<arm>/<task-id>/ and manifest.json")
    parser.add_argument("--arms", nargs="+", choices=ARMS, default=list(ARMS))
    parser.add_argument("--gitnexus-package", type=Path, help="`npm pack` tarball of gitnexus/ (gitnexus arm)")
    parser.add_argument("--task", action="append", dest="include", help="task id; repeatable")
    parser.add_argument("--n-tasks", type=int, help="seeded random subset size (default: all tasks)")
    parser.add_argument("--sample-seed", type=int, default=0)
    parser.add_argument("--guidance", choices=sorted(GUIDANCE), default="product",
                        help="note appended to the gitnexus arm's instruction (default: product)")
    args = parser.parse_args(argv)
    tasks_root = args.deep_swe / "tasks"
    available = task_ids(tasks_root)
    if not available:
        parser.error(f"no tasks under {tasks_root}")
    if "gitnexus" in args.arms and (args.gitnexus_package is None or not args.gitnexus_package.is_file()):
        parser.error("--gitnexus-package must name an existing `npm pack` tarball for the gitnexus arm")
    selected = select_tasks(available, include=args.include, n_tasks=args.n_tasks, seed=args.sample_seed)
    manifest = prepare(tasks_root=tasks_root, out=args.out, arms=args.arms, selected=selected,
                       package=args.gitnexus_package, guidance=args.guidance)
    print(f"prepared {len(selected)} task(s) x {len(manifest['arms'])} arm(s) under {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
