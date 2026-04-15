#!/usr/bin/env python3
"""Detect tree-sitter ecosystem drift that Dependabot cannot see.

Two invariants that Dependabot does not enforce:

  1. ABI consistency. The tree-sitter runtime we pin (gitnexus/package.json
     -> dependencies."tree-sitter") supports a known range of grammar ABIs.
     Every grammar we load must ship a parser.c whose LANGUAGE_VERSION falls
     inside that range. If a grammar bumps to an ABI the runtime cannot
     load, the grammar silently fails at require() time -- fallback paths
     kick in and test coverage can mask the degradation.

  2. Vendored upstream drift. vendor/tree-sitter-proto/ is a snapshot of
     coder3101/tree-sitter-proto's parser.c, regenerated against a specific
     tree-sitter-cli version. Upstream keeps moving. If upstream ships a
     grammar fix we care about, or cuts a new release, we want a human to
     notice -- not for the vendored copy to silently rot.

Invoked from .github/workflows/tree-sitter-drift-check.yml on a weekly
schedule. Runs locally too:

    python3 .github/scripts/check-tree-sitter-drift.py

Outputs Markdown to stdout. Exit 0 when everything is in range and upstream
matches. Exit 1 when drift is detected (the workflow uses this to open or
update an issue).

No external deps -- stdlib only, so it runs on any vanilla runner.
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
GITNEXUS_DIR = REPO_ROOT / "gitnexus"
VENDOR_PROTO_DIR = GITNEXUS_DIR / "vendor" / "tree-sitter-proto"

# Tree-sitter runtime -> (min_abi, max_abi) it can load. Extend when we bump
# the runtime and audit the new supported range from the runtime's release
# notes. Source of truth: tree-sitter/tree-sitter runtime release notes.
RUNTIME_ABI_RANGES: dict[str, tuple[int, int]] = {
    "0.21": (13, 14),
    "0.22": (13, 14),
    "0.23": (13, 14),
    "0.24": (13, 14),
    "0.25": (13, 15),
}

UPSTREAM_OWNER = "coder3101"
UPSTREAM_REPO = "tree-sitter-proto"
UPSTREAM_BRANCH = "main"


def read_runtime_minor() -> str:
    """Return the tree-sitter runtime minor series we pin (e.g. '0.21')."""
    pkg = json.loads((GITNEXUS_DIR / "package.json").read_text())
    raw = pkg["dependencies"]["tree-sitter"]
    # Strip semver prefixes (^, ~, >=, etc.) and trailing qualifiers.
    match = re.search(r"(\d+)\.(\d+)", raw)
    if not match:
        raise SystemExit(f"could not parse tree-sitter version: {raw!r}")
    return f"{match.group(1)}.{match.group(2)}"


def extract_language_version(parser_c: pathlib.Path) -> int | None:
    """Return the LANGUAGE_VERSION defined in a parser.c, or None if absent."""
    if not parser_c.is_file():
        return None
    # Scan only the first few KB; LANGUAGE_VERSION lives near the top.
    with parser_c.open("r", encoding="utf-8", errors="ignore") as fh:
        head = fh.read(4096)
    match = re.search(r"#define\s+LANGUAGE_VERSION\s+(\d+)", head)
    return int(match.group(1)) if match else None


def installed_grammars() -> list[pathlib.Path]:
    """Return parser.c paths for every installed tree-sitter-* grammar."""
    nm = GITNEXUS_DIR / "node_modules"
    if not nm.is_dir():
        return []
    out: list[pathlib.Path] = []
    for entry in sorted(nm.iterdir()):
        if not entry.name.startswith("tree-sitter-"):
            continue
        # Skip the runtime itself and the CLI; they have no parser.c.
        if entry.name in ("tree-sitter-cli",):
            continue
        parser_c = entry / "src" / "parser.c"
        if parser_c.is_file():
            out.append(parser_c)
    return out


def fetch_upstream_parser_c() -> str | None:
    """Fetch coder3101/tree-sitter-proto's current parser.c as text."""
    url = (
        f"https://raw.githubusercontent.com/{UPSTREAM_OWNER}/"
        f"{UPSTREAM_REPO}/{UPSTREAM_BRANCH}/src/parser.c"
    )
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"WARN: could not fetch upstream parser.c: {exc}", file=sys.stderr)
        return None


def fetch_upstream_head_sha() -> str | None:
    """Return the short SHA of coder3101/tree-sitter-proto HEAD on main."""
    url = (
        f"https://api.github.com/repos/{UPSTREAM_OWNER}/"
        f"{UPSTREAM_REPO}/commits/{UPSTREAM_BRANCH}"
    )
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("sha", "")[:12] or None
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"WARN: could not fetch upstream HEAD: {exc}", file=sys.stderr)
        return None


def md_h(text: str, level: int = 2) -> str:
    return f"{'#' * level} {text}\n"


def main() -> int:
    drift_found = False
    lines: list[str] = []
    lines.append(md_h("Tree-sitter ecosystem drift report", 1))
    lines.append("")

    # --- ABI consistency --------------------------------------------------
    runtime_minor = read_runtime_minor()
    lines.append(md_h(f"Runtime: tree-sitter {runtime_minor}.x", 2))
    if runtime_minor not in RUNTIME_ABI_RANGES:
        lines.append(
            f"- UNKNOWN runtime ABI range for `{runtime_minor}`. "
            "Add it to `RUNTIME_ABI_RANGES` in this script after auditing "
            "the upstream release notes.\n"
        )
        drift_found = True
        abi_min, abi_max = (0, 0)
    else:
        abi_min, abi_max = RUNTIME_ABI_RANGES[runtime_minor]
        lines.append(f"- Supported grammar ABI range: **{abi_min}..{abi_max}**\n")

    grammars = installed_grammars()
    if not grammars:
        lines.append(
            "- No installed grammars found under `gitnexus/node_modules/`. "
            "Run `npm install` in `gitnexus/` before checking ABI consistency.\n"
        )
    else:
        lines.append(md_h("Installed grammar ABIs", 3))
        lines.append("| Grammar | ABI | In range? |")
        lines.append("|---|---|---|")
        for parser_c in grammars:
            name = parser_c.parents[1].name
            abi = extract_language_version(parser_c)
            if abi is None:
                lines.append(f"| `{name}` | (no LANGUAGE_VERSION found) | [warn] |")
                drift_found = True
                continue
            in_range = abi_min <= abi <= abi_max
            lines.append(
                f"| `{name}` | {abi} | {'[ok]' if in_range else '[FAIL] OUT OF RANGE'} |"
            )
            if not in_range:
                drift_found = True

    # Vendored proto must also be in range.
    vendored_abi = extract_language_version(VENDOR_PROTO_DIR / "src" / "parser.c")
    lines.append("")
    lines.append(md_h("Vendored tree-sitter-proto", 3))
    if vendored_abi is None:
        lines.append("- [warn] Could not read vendored parser.c LANGUAGE_VERSION.\n")
        drift_found = True
    else:
        in_range = abi_min <= vendored_abi <= abi_max
        lines.append(
            f"- Vendored ABI: **{vendored_abi}** -- "
            f"{'in range [ok]' if in_range else '**OUT OF RANGE** [FAIL]'}"
        )
        if not in_range:
            drift_found = True

    # --- Upstream drift ---------------------------------------------------
    lines.append("")
    lines.append(md_h("Upstream drift check", 2))
    upstream_parser_c = fetch_upstream_parser_c()
    if upstream_parser_c is None:
        lines.append("- [warn] Could not fetch upstream parser.c; skipping drift check.\n")
    else:
        upstream_abi_match = re.search(
            r"#define\s+LANGUAGE_VERSION\s+(\d+)", upstream_parser_c[:4096]
        )
        upstream_abi = int(upstream_abi_match.group(1)) if upstream_abi_match else None
        upstream_size = len(upstream_parser_c)
        local_path = VENDOR_PROTO_DIR / "src" / "parser.c"
        local_parser_c = local_path.read_text(encoding="utf-8", errors="ignore") if local_path.is_file() else ""
        local_size = len(local_parser_c)
        size_match = local_size == upstream_size and local_parser_c == upstream_parser_c
        upstream_sha = fetch_upstream_head_sha() or "?"

        lines.append(f"- Upstream: `{UPSTREAM_OWNER}/{UPSTREAM_REPO}@{UPSTREAM_BRANCH}` (HEAD `{upstream_sha}`)")
        lines.append(f"- Upstream ABI: **{upstream_abi}**")
        lines.append(f"- Vendored ABI: **{vendored_abi}**")
        lines.append(
            f"- parser.c identical to upstream? "
            f"{'yes [ok]' if size_match else 'no -- upstream has moved'}"
        )
        if not size_match:
            lines.append("")
            lines.append(
                "**Action:** review the upstream changes. If the vendored ABI "
                "is still compatible with our runtime AND the change is worth "
                "picking up, regenerate `vendor/tree-sitter-proto/src/parser.c` "
                "via `tree-sitter-cli <version-that-emits-ABI-14>` against "
                f"upstream `{upstream_sha}` and update the description in "
                "`vendor/tree-sitter-proto/package.json`. If upstream's ABI is "
                "now outside our runtime range, document the skip and wait for "
                "the tree-sitter runtime upgrade."
            )
            drift_found = True

    lines.append("")
    lines.append(md_h("Result", 2))
    lines.append(f"- Drift detected: **{'yes' if drift_found else 'no'}**")

    print("\n".join(lines))
    return 1 if drift_found else 0


if __name__ == "__main__":
    sys.exit(main())
