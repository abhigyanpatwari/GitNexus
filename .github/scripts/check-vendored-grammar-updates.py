#!/usr/bin/env python3
"""Monitor upstream updates for GitNexus's VENDORED tree-sitter grammars.

The npm-dependency grammars (tree-sitter-c, -python, -rust, ...) are tracked by
Dependabot — when upstream publishes a new version, a PR shows up. The VENDORED
grammars (gitnexus/vendor/tree-sitter-*) are off the dependency graph: GitNexus
ships its own snapshot, so nothing tells us when their upstream moves. This
closes that blind spot — it gives the vendored grammars the same daily
"you're behind upstream" visibility Dependabot gives the npm ones.

Per upstream source:
  - npm-published grammars (swift, kotlin): compare the vendored package.json
    `version` against the npm registry's latest.
  - GitHub-only grammars (dart, proto): compare the vendored snapshot against the
    upstream default branch — by recorded commit (parsed from `_vendoredBy`) when
    available, else by byte-comparing the vendored `src/parser.c`.

Companion to check-tree-sitter-upgrade-readiness.py, which tracks a different
thing (tree-sitter RUNTIME 0.25 upgrade readiness / ABI), not version drift.

Outputs Markdown to stdout. Exit 0 = every vendored grammar is current. Exit 1 =
at least one is behind (the workflow uses this to open/update a tracking issue).

Stdlib only — runs on any vanilla runner.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
VENDOR_DIR = REPO_ROOT / "gitnexus" / "vendor"

# Upstream source of truth per vendored grammar. Co-located here (mirrors the
# GRAMMARS table in check-tree-sitter-upgrade-readiness.py) so a new vendored
# grammar is monitored by adding one row. `source` selects the drift strategy.
UPSTREAM: dict[str, dict[str, str]] = {
    "tree-sitter-swift": {"source": "npm", "name": "tree-sitter-swift"},
    "tree-sitter-kotlin": {"source": "npm", "name": "tree-sitter-kotlin"},
    "tree-sitter-dart": {
        "source": "github",
        "repo": "UserNobody14/tree-sitter-dart",
        "branch": "master",
    },
    "tree-sitter-proto": {
        "source": "github",
        "repo": "coder3101/tree-sitter-proto",
        "branch": "main",
    },
}

_GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")


# ── Fetch helpers (stdlib only) ─────────────────────────────────────────────


def _fetch(url: str, *, accept: str = "application/json", timeout: int = 10) -> str | None:
    headers = {"Accept": accept, "User-Agent": "gitnexus-vendored-monitor"}
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        host = ""
    is_github = host == "api.github.com" or host.endswith(".githubusercontent.com")
    if _GITHUB_TOKEN and is_github:
        headers["Authorization"] = f"Bearer {_GITHUB_TOKEN}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None


def npm_latest(pkg: str) -> str | None:
    text = _fetch(f"https://registry.npmjs.org/{urllib.parse.quote(pkg)}/latest")
    if not text:
        return None
    try:
        return json.loads(text).get("version")
    except json.JSONDecodeError:
        return None


def github_head_sha(repo: str, branch: str) -> str | None:
    text = _fetch(f"https://api.github.com/repos/{repo}/commits/{branch}")
    if not text:
        return None
    try:
        return json.loads(text).get("sha")
    except json.JSONDecodeError:
        return None


def github_raw(repo: str, branch: str, path: str) -> str | None:
    return _fetch(
        f"https://raw.githubusercontent.com/{repo}/{branch}/{path}",
        accept="text/plain",
    )


# ── Version comparison ──────────────────────────────────────────────────────


def semver_tuple(v: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", v or "")
    return tuple(int(n) for n in nums[:3]) if nums else ()


# ── Per-grammar drift ───────────────────────────────────────────────────────


def vendored_version(name: str) -> str | None:
    pkg = VENDOR_DIR / name / "package.json"
    if not pkg.is_file():
        return None
    try:
        return json.loads(pkg.read_text(encoding="utf-8", errors="ignore")).get("version")
    except json.JSONDecodeError:
        return None


def vendored_commit(name: str) -> str | None:
    pkg = VENDOR_DIR / name / "package.json"
    if not pkg.is_file():
        return None
    try:
        by = json.loads(pkg.read_text(encoding="utf-8", errors="ignore")).get("_vendoredBy", "")
    except json.JSONDecodeError:
        return None
    m = re.search(r"\b([0-9a-f]{40})\b", by)
    return m.group(1) if m else None


def check_npm(name: str, cfg: dict) -> dict:
    current = vendored_version(name)
    latest = npm_latest(cfg["name"])
    if latest is None:
        return {"name": name, "state": "unknown", "detail": "npm registry fetch failed"}
    behind = bool(current) and semver_tuple(latest) > semver_tuple(current)
    return {
        "name": name,
        "state": "behind" if behind else "current",
        "current": current or "?",
        "latest": latest,
        "source": f"npm:{cfg['name']}",
    }


def check_github(name: str, cfg: dict) -> dict:
    repo, branch = cfg["repo"], cfg["branch"]
    head = github_head_sha(repo, branch)
    if head is None:
        return {"name": name, "state": "unknown", "detail": f"GitHub fetch failed ({repo})"}
    pinned = vendored_commit(name)
    if pinned:
        behind = pinned != head
        return {
            "name": name,
            "state": "behind" if behind else "current",
            "current": pinned[:12],
            "latest": head[:12],
            "source": f"github:{repo}@{branch}",
        }
    # No recorded commit — fall back to byte-comparing the vendored parser.c.
    local = VENDOR_DIR / name / "src" / "parser.c"
    if not local.is_file():
        return {
            "name": name,
            "state": "unknown",
            "detail": "no recorded commit and no vendored src/parser.c to compare",
        }
    upstream = github_raw(repo, branch, "src/parser.c")
    if upstream is None:
        return {"name": name, "state": "unknown", "detail": f"could not fetch upstream parser.c ({repo})"}
    same = local.read_text(encoding="utf-8", errors="ignore").replace("\r\n", "\n") == upstream.replace(
        "\r\n", "\n"
    )
    return {
        "name": name,
        "state": "current" if same else "behind",
        "current": "vendored parser.c",
        "latest": f"{repo}@{branch} HEAD ({head[:12]})",
        "source": f"github:{repo}@{branch} (parser.c byte-compare)",
    }


def main() -> int:
    vendored = sorted(d.name for d in VENDOR_DIR.iterdir() if d.is_dir() and d.name.startswith("tree-sitter-")) if VENDOR_DIR.is_dir() else []

    results: list[dict] = []
    for name in vendored:
        cfg = UPSTREAM.get(name)
        if cfg is None:
            results.append({"name": name, "state": "unconfigured", "detail": "add an UPSTREAM entry to monitor this grammar"})
            continue
        results.append(check_npm(name, cfg) if cfg["source"] == "npm" else check_github(name, cfg))

    behind = [r for r in results if r["state"] == "behind"]
    unknown = [r for r in results if r["state"] in ("unknown", "unconfigured")]
    current = [r for r in results if r["state"] == "current"]

    out: list[str] = ["# Vendored tree-sitter grammar updates", ""]
    if not vendored:
        out.append("No vendored grammars found under `gitnexus/vendor/`.")
        print("\n".join(out))
        return 0

    if behind:
        out.append(f"**{len(behind)} vendored grammar(s) behind upstream.** Refresh the vendor snapshot and re-run the `build-tree-sitter-prebuilds` workflow.")
    else:
        out.append("**All vendored grammars are current with upstream.**")
    out.append("")
    out.append("| Grammar | Vendored | Upstream latest | Source | Status |")
    out.append("|---|---|---|---|---|")
    for r in results:
        if r["state"] in ("unknown", "unconfigured"):
            out.append(f"| `{r['name']}` | — | — | — | ⚠️ {r.get('detail', r['state'])} |")
        else:
            icon = "🔴 behind" if r["state"] == "behind" else "✅ current"
            out.append(f"| `{r['name']}` | `{r['current']}` | `{r['latest']}` | {r['source']} | {icon} |")
    out.append("")
    out.append("_npm grammars are tracked by Dependabot; this covers the vendored ones. "
               "Companion: the tree-sitter 0.25 runtime upgrade readiness tracker._")
    print("\n".join(out))

    # Exit 1 only on real drift — `unknown` (transient fetch failure) must not
    # flap the tracking issue open/closed on a network blip.
    return 1 if behind else 0


if __name__ == "__main__":
    raise SystemExit(main())
