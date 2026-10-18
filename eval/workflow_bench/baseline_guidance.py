"""Baseline (no-GitNexus) arm: strip GitNexus guidance from inherited repository docs.

Pure text handling only, so the sandbox module can import it without a cycle.
"""

from __future__ import annotations

import re


class GuidanceError(ValueError):
    """Repository guidance cannot be safely reduced to ordinary development guidance."""


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


# A CommonMark list item: bullet (-, *, +) or ordered marker (1-9 digits then
# . or )), followed by a space, tab or end of line. Its indented continuation
# lines belong to the item and are dropped with it.
_LIST_ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)")


def _atx_heading(line: str) -> tuple[int, str] | None:
    """Return (level, text) for a CommonMark ATX heading, else None.

    Up to three leading spaces, 1-6 '#', then a space or end of line; an
    optional closing run of '#' preceded by a space is not part of the text.
    """

    match = re.match(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$", line.rstrip("\r\n"))
    if match is None:
        return None
    text = re.sub(r"(?:^|[ \t]+)#+$", "", match.group(2) or "").strip()
    return len(match.group(1)), text


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
                raise GuidanceError("repository guidance contains unbalanced GitNexus markers")
            marked = starts
            continue
        if marked:
            continue
        heading = _atx_heading(line)
        if heading is not None:
            level, title = heading
            if section_level is not None and level <= section_level:
                section_level = None
            skip_continuation = False
            if section_level is None and (
                _GITNEXUS_TOOL_GUIDANCE.search(line)
                or re.fullmatch(r"GitNexus(?:\s+rules|\s+[—-]\s+Code Intelligence)\s*", title, re.IGNORECASE)
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
            skip_continuation = _LIST_ITEM.match(line) is not None
            continue
        kept.append(line)
    if marked:
        raise GuidanceError("repository guidance contains unbalanced GitNexus markers")
    return "".join(kept)
