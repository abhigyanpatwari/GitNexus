#!/usr/bin/env python3
"""Enforce the GitHub Actions concurrency convention.

Enhanced version with:
- Colored terminal output
- Summary report
- File statistics
- Cleaner helper utilities
- Same validation logic preserved
"""

from __future__ import annotations

import pathlib
import re
import sys
from dataclasses import dataclass

# -------------------- Styling -------------------- #
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"

# -------------------- Constants -------------------- #
REQUIRED_TOKENS = ("${{ github.workflow }}", "CI-", "docker-build-push-")
CONCURRENCY_RE = re.compile(r"^concurrency:\s*$")
GROUP_RE = re.compile(r"^\s+group:\s*(.+?)\s*$")


@dataclass
class Stats:
    checked: int = 0
    reusable: int = 0
    passed: int = 0
    failed: int = 0


# -------------------- Utility Functions -------------------- #
def banner() -> None:
    print(f"{CYAN}{'=' * 60}")
    print(" GitHub Workflow Concurrency Validator ")
    print(f"{'=' * 60}{RESET}")


def error(path: pathlib.Path, msg: str) -> None:
    print(f"{RED}::error file={path}::{msg}{RESET}")


def success(path: pathlib.Path) -> None:
    print(f"{GREEN}✔ {path.name} passed validation{RESET}")


def warn(msg: str) -> None:
    print(f"{YELLOW}{msg}{RESET}")


# -------------------- Workflow Logic -------------------- #
def is_reusable(lines: list[str]) -> bool:
    inside = False
    base_indent = None
    collected = []

    for line in lines:
        clean = line.strip()

        if not clean or clean.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip(" "))

        if not inside:
            if line.startswith("on:"):
                remaining = line[3:].strip()

                if not remaining:
                    inside = True
                    base_indent = indent
                    continue

                if remaining.startswith("[") and remaining.endswith("]"):
                    events = [x.strip() for x in remaining[1:-1].split(",")]
                    return events == ["workflow_call"]

                return remaining == "workflow_call"

            continue

        if base_indent is not None and indent <= base_indent:
            break

        if ":" in clean:
            key = clean.split(":", 1)[0].strip()
            collected.append((indent, key))

    if not collected:
        return False

    minimum = min(i for i, _ in collected)
    events = [name for i, name in collected if i == minimum]

    return events == ["workflow_call"]


def has_top_level_concurrency(lines: list[str]) -> bool:
    return any(CONCURRENCY_RE.match(line) for line in lines)


def extract_group_key(lines: list[str]) -> str | None:
    active = False

    for line in lines:
        if CONCURRENCY_RE.match(line):
            active = True
            continue

        if active:
            if line and not line.startswith(" ") and line.rstrip().endswith(":"):
                break

            found = GROUP_RE.match(line)
            if found:
                return found.group(1).strip().strip("'").strip('"')

    return None


def validate_file(path: pathlib.Path, stats: Stats) -> bool:
    lines = path.read_text(encoding="utf-8").splitlines()

    stats.checked += 1
    reusable = is_reusable(lines)

    if reusable:
        stats.reusable += 1

    present = has_top_level_concurrency(lines)

    if reusable:
        if present:
            error(
                path,
                "Reusable workflow must not define concurrency. "
                "It inherits from caller.",
            )
            stats.failed += 1
            return False

        success(path)
        stats.passed += 1
        return True

    if not present:
        error(path, "Missing top-level concurrency block.")
        stats.failed += 1
        return False

    group = extract_group_key(lines)

    if group is None:
        error(path, "concurrency block missing `group:` key.")
        stats.failed += 1
        return False

    if not any(token in group for token in REQUIRED_TOKENS):
        error(
            path,
            f"Invalid concurrency.group `{group}`. "
            f"Must include one of {REQUIRED_TOKENS}.",
        )
        stats.failed += 1
        return False

    success(path)
    stats.passed += 1
    return True


def scan(directory: pathlib.Path) -> int:
    stats = Stats()

    files = sorted(directory.glob("*.yml")) + sorted(directory.glob("*.yaml"))

    if not files:
        warn("No workflow files found.")
        return 0

    banner()

    for workflow in files:
        validate_file(workflow, stats)

    print(f"\n{CYAN}{'-' * 60}{RESET}")
    print(f"Checked Files : {stats.checked}")
    print(f"Reusable     : {stats.reusable}")
    print(f"Passed       : {stats.passed}")
    print(f"Failed       : {stats.failed}")
    print(f"{CYAN}{'-' * 60}{RESET}")

    return 1 if stats.failed else 0


# -------------------- Main -------------------- #
def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <workflows-dir>", file=sys.stderr)
        return 2

    target = pathlib.Path(argv[1])

    if not target.is_dir():
        print(f"not a directory: {target}", file=sys.stderr)
        return 2

    return scan(target)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
def is_reusable(lines: list[str]) -> bool:
    """Return True iff the workflow's `on:` block names only `workflow_call`."""
    in_on = False
    on_indent: int | None = None
    keys: list[str] = []

    for raw in lines:
        # Skip blank lines and comments
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        if not in_on:
            if raw.startswith("on:"):
                remainder = raw[len("on:"):].strip()
                if not remainder:
                    # `on:` followed by indented mapping on next lines
                    in_on = True
                    on_indent = indent
                    continue
                if remainder.startswith("[") and remainder.endswith("]"):
                    # Flow-style list: on: [workflow_call]
                    items = [
                        item.strip() for item in remainder.strip("[]").split(",")
                    ]
                    return items == ["workflow_call"]
                # Scalar form: on: workflow_call  (or a single other event)
                return remainder == "workflow_call"
            continue

        # Inside the `on:` block; stop when indentation returns to <= on_indent
        if on_indent is not None and indent <= on_indent:
            break

        # Only consider keys at on_indent + indentation step (anything deeper
        # is nested config like `types:`)
        if ":" not in stripped:
            continue
        # Heuristic: first-level event keys are those with indent == on_indent + 2
        # (the canonical step for a 2-space YAML doc). We collect all first-level
        # keys by tracking the smallest indent seen inside the block.
        keys.append((indent, stripped.split(":", 1)[0].strip()))

    if not keys:
        return False

    # Take only the outermost-indented keys as the event list
    min_indent = min(i for i, _ in keys)
    events = [name for i, name in keys if i == min_indent]
    return events == ["workflow_call"]


CONCURRENCY_RE = re.compile(r"^concurrency:\s*$")
GROUP_RE = re.compile(r"^\s+group:\s*(.+?)\s*$")


def extract_group_key(lines: list[str]) -> str | None:
    """Return the `group:` value of the top-level `concurrency:` block, or None."""
    for idx, raw in enumerate(lines):
        if CONCURRENCY_RE.match(raw):
            # Scan forward until we leave the concurrency block (next top-level key
            # is at column 0 and ends with `:`).
            for follow in lines[idx + 1:]:
                if follow and not follow.startswith(" ") and follow.rstrip().endswith(":"):
                    break
                m = GROUP_RE.match(follow)
                if m:
                    return m.group(1).strip().strip("'").strip('"')
            break
    return None


def has_top_level_concurrency(lines: list[str]) -> bool:
    return any(CONCURRENCY_RE.match(raw) for raw in lines)


def check(workflows_dir: pathlib.Path) -> int:
    fail = 0
    files = sorted(
        list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml"))
    )
    for path in files:
        lines = path.read_text(encoding="utf-8").splitlines()
        reusable = is_reusable(lines)
        has_conc = has_top_level_concurrency(lines)

        if reusable:
            if has_conc:
                print(
                    f"::error file={path}::Reusable workflow (on: workflow_call) "
                    "must NOT declare its own concurrency block — it inherits "
                    "from the caller. See CONTRIBUTING.md -> GitHub Actions — "
                    "Concurrency Convention."
                )
                fail = 1
            continue

        if not has_conc:
            print(
                f"::error file={path}::Missing top-level concurrency block. "
                "See CONTRIBUTING.md -> GitHub Actions — Concurrency Convention."
            )
            fail = 1
            continue

        group = extract_group_key(lines)
        if group is None:
            print(
                f"::error file={path}::concurrency block is missing a "
                "`group:` key."
            )
            fail = 1
            continue

        if not any(token in group for token in REQUIRED_TOKENS):
            print(
                f"::error file={path}::concurrency.group `{group}` must "
                f"reference one of {REQUIRED_TOKENS} (use ${{{{ github.workflow }}}} "
                "for normal entry-point workflows; use an approved literal prefix "
                "only for workflows that are both entry-points AND reusable — "
                "see CONTRIBUTING.md -> GitHub Actions — Concurrency Convention)."
            )
            fail = 1

    return fail


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <workflows-dir>", file=sys.stderr)
        return 2
    workflows_dir = pathlib.Path(argv[1])
    if not workflows_dir.is_dir():
        print(f"not a directory: {workflows_dir}", file=sys.stderr)
        return 2
    return check(workflows_dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
