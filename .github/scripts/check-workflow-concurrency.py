#!/usr/bin/env python3
"""Enforce the GitHub Actions concurrency convention.

See CONTRIBUTING.md -> "GitHub Actions — Concurrency Convention" for the rules.

Invoked from .github/workflows/ci-quality.yml. Runs locally too:
    python3 .github/scripts/check-workflow-concurrency.py .github/workflows

Rules:
  1. Every entry-point (non-reusable) workflow declares a top-level
     `concurrency:` block.
  2. Reusable workflows (on: workflow_call ONLY) do NOT declare one.
  3. The `concurrency.group` expression MUST reference either
     `${{ github.workflow }}` or a literal `CI-` prefix (the documented
     ci.yml reusable-workflow-safe exception). This is checked by substring
     containment rather than prefix match because ci.yml's group is a
     conditional expression that resolves to a `CI-…` literal at runtime.

We deliberately do not use a YAML library — keeps the script dependency-free
on any vanilla runner. `on:` block parsing is line-based and handles both the
flat (`on: workflow_call`) and mapping (`on:\n  workflow_call:`) forms.
"""

from __future__ import annotations

import pathlib
import re
import sys


REQUIRED_TOKENS = ("${{ github.workflow }}", "CI-")


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
                f"reference one of {REQUIRED_TOKENS}. See CONTRIBUTING.md -> "
                "GitHub Actions — Concurrency Convention."
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
