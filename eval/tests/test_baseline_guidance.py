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


@pytest.mark.parametrize("indent", ["", " ", "  ", "   "])
def test_gitnexus_sections_are_stripped_under_commonmark_heading_indentation(indent):
    guidance = (
        "Build first.\n"
        f"{indent}## GitNexus rules\n"
        "Always consult the code graph before editing.\n"
        "## Testing\n"
        "Run the unit tests.\n"
    )
    assert baseline_guidance.ordinary_repository_guidance(guidance) == "Build first.\n## Testing\nRun the unit tests.\n"


@pytest.mark.parametrize(
    "heading",
    [
        "## GitNexus rules ##",
        "## GitNexus rules #####",
        "   ### GitNexus — Code Intelligence ###",
        "##   GitNexus rules   ",
        "##\tGitNexus rules",
    ],
)
def test_gitnexus_sections_are_stripped_for_every_commonmark_atx_form(heading):
    guidance = (
        f"Build first.\n{heading}\nAlways consult the code graph before editing.\n## Testing\nRun the unit tests.\n"
    )
    assert baseline_guidance.ordinary_repository_guidance(guidance) == "Build first.\n## Testing\nRun the unit tests.\n"


@pytest.mark.parametrize("line", ["#GitNexus rules", "    ## GitNexus rules", "####### GitNexus rules"])
def test_lines_that_are_not_atx_headings_do_not_open_a_section(line):
    guidance = f"{line}\nRun the unit tests.\n"
    assert baseline_guidance.ordinary_repository_guidance(guidance) == guidance
