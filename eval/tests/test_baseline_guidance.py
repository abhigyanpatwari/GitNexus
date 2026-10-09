"""Baseline (no-GitNexus) guidance scrubbing contracts."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from workflow_bench import baseline_guidance


@pytest.mark.parametrize("launcher", ["npx", "bunx", "pnpm dlx"])
def test_repository_guidance_filters_launcher_flags_without_hiding_ordinary_tests(launcher):
    guidance = (
        f"Bootstrap with {launcher} --yes --package=gitnexus gitnexus@1.6.12.\n"
        f"Validate with {launcher} --yes vitest run.\n"
    )
    assert baseline_guidance.ordinary_repository_guidance(guidance) == f"Validate with {launcher} --yes vitest run.\n"


def test_repository_guidance_does_not_backtrack_on_malformed_launcher_options():
    # The old overlapping dash quantifiers take exponential time on this input.
    # A subprocess deadline makes a recurrence fail without hanging pytest.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from workflow_bench.baseline_guidance import ordinary_repository_guidance; "
                "text = 'npx ' + '-- -' * 10000 + '\\n'; "
                "assert ordinary_repository_guidance(text) == text"
            ),
        ],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "guidance",
    [
        "Build first.\n<!-- gitnexus:end -->\n",
        "<!-- gitnexus:start -->\n<!-- gitnexus:start -->\nUse GitNexus.\n<!-- gitnexus:end -->\n",
        "Build first.\n<!-- gitnexus:start -->\nUse GitNexus.\n",
    ],
)
def test_unbalanced_gitnexus_markers_fail_closed(guidance):
    with pytest.raises(baseline_guidance.GuidanceError, match="unbalanced GitNexus markers"):
        baseline_guidance.ordinary_repository_guidance(guidance)


def test_module_has_no_sandbox_import_cycle():
    source = Path(baseline_guidance.__file__).read_text()
    assert "proposer_sandbox" not in source
