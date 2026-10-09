"""Baseline (no-GitNexus) arm: strip GitNexus guidance from inherited repository docs."""

from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath

from .proposer_sandbox import (
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    _evidence_bytes,
    _prepare_clone_target,
)

GITNEXUS_UNAVAILABLE_NOTE = (
    "GitNexus tools are unavailable in this baseline_nomcp arm. "
    "No GitNexus graph, repository registry, MCP server, or harness CLI is supplied; "
    "the Skill tool is disabled. Use source reads, search, and repository tests "
    "to complete the task. Do not invoke or bootstrap GitNexus with npx or .gitnexus/run.cjs.\n"
)


_GITNEXUS_TOOL_GUIDANCE = re.compile(
    r"(?:\.gitnexus/run\.cjs|\b(?:npx|bunx|pnpm\s+dlx)\s+(?:--?\w[\w-]*(?:=[^\s`]+)?\s+)*gitnexus(?:@|\b)|"
    r"\bmcp__gitnexus(?:__|\b)|\bgitnexus:(?:start|end)\b|"
    r"\bgitnexus-(?:plan|work|review|lfg|exploring|impact-analysis|debugging|refactoring|guide|cli)\b|"
    r"\b(?:use|run|bootstrap|invoke)\s+(?:\*\*|`)?gitnexus\b|"
    r"\bgitnexus\s+(?:setup|analyze|query|context|impact|detect-changes)\b)",
    re.IGNORECASE,
)


def ordinary_repository_guidance(text: str) -> str:
    """Remove marked/tool-specific instructions, preserving development guidance."""

    kept: list[str] = []
    marked = False
    section_level: int | None = None
    skip_continuation = False
    for line in text.splitlines(keepends=True):
        marker = re.fullmatch(r"\s*<!--\s*gitnexus:(start|end)\s*-->\s*", line, re.IGNORECASE)
        if marker is not None:
            starts = marker.group(1).lower() == "start"
            if starts == marked:
                raise SandboxError("repository guidance contains unbalanced GitNexus markers")
            marked = starts
            continue
        if marked:
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)", line)
        if heading is not None:
            level = len(heading.group(1))
            if section_level is not None and level <= section_level:
                section_level = None
            skip_continuation = False
            if section_level is None and (
                _GITNEXUS_TOOL_GUIDANCE.search(line)
                or re.fullmatch(r"GitNexus(?:\s+rules|\s+[—-]\s+Code Intelligence)\s*", heading.group(2), re.IGNORECASE)
            ):
                section_level = level
            if section_level is not None:
                continue
        elif section_level is not None:
            continue
        if not line.strip():
            skip_continuation = False
        elif skip_continuation:
            if line[:1].isspace():
                continue
            skip_continuation = False
        if _GITNEXUS_TOOL_GUIDANCE.search(line):
            skip_continuation = bool(re.match(r"^\s*[-*]\s", line))
            continue
        kept.append(line)
    if marked:
        raise SandboxError("repository guidance contains unbalanced GitNexus markers")
    return "".join(kept)


def baseline_gitnexus_mounts(clone: Path, private_root: Path) -> tuple[ReadOnlyMount, ...]:
    """Hide inherited index/bootstrap bytes and graph-first startup guidance."""

    empty_index = private_root / "empty-gitnexus"
    empty_index.mkdir(mode=0o500)
    _prepare_clone_target(clone, PurePosixPath(".gitnexus"), directory=True, label="baseline index mask")
    mounts = [ReadOnlyMount(empty_index, f"{SANDBOX_WORKSPACE}/.gitnexus")]
    for index, name in enumerate(("AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md")):
        if os.path.lexists(clone / name):
            _prepare_clone_target(clone, PurePosixPath(name), directory=False, label="baseline guidance")
            ordinary = ordinary_repository_guidance(_evidence_bytes(clone / name, ()).decode("utf-8"))
            guidance = private_root / f"repository-guidance-{index}.md"
            guidance.write_text(ordinary.rstrip() + "\n\n" + GITNEXUS_UNAVAILABLE_NOTE)
            guidance.chmod(0o400)
            mounts.append(ReadOnlyMount(guidance, f"{SANDBOX_WORKSPACE}/{name}"))
    return tuple(mounts)
