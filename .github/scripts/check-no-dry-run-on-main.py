#!/usr/bin/env python3
"""Fail the build if any `inputs.dry_run` reference survives in publish.yml.

The unified release workflow (publish.yml) carries a temporary `dry_run`
workflow_dispatch input used for pre-merge rehearsal. The input itself is
explicitly meant to be removed in a final cleanup commit BEFORE the unification
PR (issue #1609) merges to main. Once on main, the input is dead weight at best
and a privilege-escalation surface at worst (any actor with write access could
dispatch it, bypassing every artifact-producing step while still exercising the
App-token mint and version-resolver paths).

This script is the mechanical enforcement. Invoked from ci-quality.yml so that
*any* push to main containing an `inputs.dry_run` reference fails CI loudly.
Runs locally too:
    python3 .github/scripts/check-no-dry-run-on-main.py

Convention: dependency-free, stdlib only. Mirrors the shape of
check-workflow-concurrency.py.

The guard is scoped to publish.yml only. Other workflows are free to use
`inputs.dry_run` for their own purposes.

Exits 0 on clean publish.yml, exits 1 with a clear error otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PUBLISH_YML = REPO_ROOT / ".github" / "workflows" / "publish.yml"
TOKEN = "DRY_RUN_REMOVE_BEFORE_MERGE"
PATTERN = re.compile(r"inputs\.dry_run", re.IGNORECASE)


def main() -> int:
    if not PUBLISH_YML.is_file():
        # If the workflow file is missing the guard is a no-op rather than a
        # spurious failure — keeps the script honest if publish.yml ever moves.
        print(f"check-no-dry-run-on-main: {PUBLISH_YML} not found; skipping.")
        return 0

    text = PUBLISH_YML.read_text(encoding="utf-8")
    lines = text.splitlines()

    offending: list[tuple[int, str]] = []
    for lineno, line in enumerate(lines, start=1):
        if PATTERN.search(line):
            offending.append((lineno, line.rstrip()))

    if not offending:
        print(
            f"check-no-dry-run-on-main: OK — no `inputs.dry_run` references in "
            f"{PUBLISH_YML.relative_to(REPO_ROOT)}."
        )
        return 0

    print(
        "::error::publish.yml still references `inputs.dry_run`. The rehearsal "
        "input must be removed before merging to main."
    )
    print("")
    print("Offending lines:")
    for lineno, line in offending:
        print(f"  {PUBLISH_YML.relative_to(REPO_ROOT)}:{lineno}: {line}")
    print("")
    print(
        f"Search for the token `{TOKEN}` in publish.yml to find every cleanup "
        "site, then remove the entire `dry_run` input declaration plus each "
        "`inputs.dry_run` reference (input passthrough, `Reject dry_run against "
        "main` step, per-step `if:` guards, vtag-gate report-only branch, "
        "rehearsal-only env vars)."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
