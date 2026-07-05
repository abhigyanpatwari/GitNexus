#!/usr/bin/env python3
"""Monitor tree-sitter 0.25 upgrade readiness — two things Dependabot can't see:

  1. Peer-dep compatibility: when every grammar's *latest npm release* accepts
     tree-sitter@0.25.0 (so we can upgrade without --legacy-peer-deps).
  2. Vendored upstream drift: whether a vendored grammar's upstream parser.c moved.

Invoked daily from tree-sitter-upgrade-readiness.yml; runs locally too. Outputs
Markdown to stdout; exit 1 when blockers remain (the workflow upserts a tracking
issue). stdlib-only — runs on any vanilla runner.
    python3 .github/scripts/check-tree-sitter-upgrade-readiness.py [--offline | --assert-current]
"""

from __future__ import annotations

import http.client
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
GITNEXUS_DIR = REPO_ROOT / "gitnexus"

# Offline mode (--offline flag or GITNEXUS_TS_READINESS_OFFLINE=1): skip ALL network
# so the script + tests run hermetically. npm columns render "n/a (offline)";
# vendored ABIs are still read from the repo. The read-path mirror of --assert-current.
OFFLINE = os.environ.get("GITNEXUS_TS_READINESS_OFFLINE", "") not in ("", "0", "false")

# ── Upgrade target ──────────────────────────────────────────────────────
# The runtime version we want to upgrade TO. Update this when the goal
# changes (e.g. once 0.25 lands and we target 0.26).
TARGET_RUNTIME = "0.25.0"
TARGET_RUNTIME_MAJOR_MINOR = ".".join(TARGET_RUNTIME.split(".")[:2])

# Tree-sitter runtime -> (min_abi, max_abi) it can load. Only the current
# and target entries matter; extend when changing TARGET_RUNTIME.
RUNTIME_ABI_RANGES: dict[str, tuple[int, int]] = {
    "0.21": (13, 14),
    "0.25": (13, 15),
}

assert TARGET_RUNTIME_MAJOR_MINOR in RUNTIME_ABI_RANGES, (
    f"RUNTIME_ABI_RANGES has no entry for {TARGET_RUNTIME_MAJOR_MINOR!r}. "
    f"Add the ABI range after auditing the upstream release notes."
)

# Grammars we use. Values are the upstream GitHub repos to check for
# unreleased ABI bumps (owner/repo, branch, parser.c path).
GRAMMARS: dict[str, tuple[str, str, str]] = {
    "tree-sitter-c":          ("tree-sitter/tree-sitter-c",          "master", "src/parser.c"),
    "tree-sitter-c-sharp":    ("tree-sitter/tree-sitter-c-sharp",    "master", "src/parser.c"),
    "tree-sitter-cpp":        ("tree-sitter/tree-sitter-cpp",        "master", "src/parser.c"),
    "tree-sitter-dart":       ("UserNobody14/tree-sitter-dart",      "master", "src/parser.c"),
    "tree-sitter-go":         ("tree-sitter/tree-sitter-go",         "master", "src/parser.c"),
    "tree-sitter-java":       ("tree-sitter/tree-sitter-java",       "master", "src/parser.c"),
    "tree-sitter-javascript": ("tree-sitter/tree-sitter-javascript", "master", "src/parser.c"),
    "tree-sitter-kotlin":     ("fwcd/tree-sitter-kotlin",            "main",   "src/parser.c"),
    "tree-sitter-php":        ("tree-sitter/tree-sitter-php",        "master", "php/src/parser.c"),
    "tree-sitter-python":     ("tree-sitter/tree-sitter-python",     "master", "src/parser.c"),
    "tree-sitter-ruby":       ("tree-sitter/tree-sitter-ruby",       "master", "src/parser.c"),
    "tree-sitter-rust":       ("tree-sitter/tree-sitter-rust",       "master", "src/parser.c"),
    "tree-sitter-swift":      ("alex-pinkus/tree-sitter-swift",      "main",   "src/parser.c"),
    "tree-sitter-typescript": ("tree-sitter/tree-sitter-typescript", "master",  "typescript/src/parser.c"),
    # Vendored parsers — kept here so the upstream coords for drift
    # detection are co-located with every other grammar's coords.
    "tree-sitter-proto":      ("coder3101/tree-sitter-proto",        "main",   "src/parser.c"),
}

# npm-installed grammars deliberately held below npm latest (surfaced so reviewers
# can tell intentional pins from drift). Add an entry when you pin an npm grammar.
# VENDORED grammars carry their hold in .github/vendored-grammars.json instead, so a
# vendored grammar's hold lives in one place — tree-sitter-c's is there, not here.
INTENTIONAL_PINS: dict[str, str] = {
    "tree-sitter-cpp": (
        "#1242 — last 0.23.x release before tree-sitter-cpp added a runtime "
        "dep on the broken-ABI tree-sitter-c@^0.23.1; pinning here removes "
        "the need for a transitive override"
    ),
}


def load_vendored_manifest() -> dict[str, dict]:
    """Load the shared vendored-grammar manifest (.github/vendored-grammars.json).

    The single source of truth — shared with update-vendored-grammars.mjs — for
    which grammars are *vendored* (shipped from gitnexus/vendor/<name>, not npm)
    and any policy ``hold`` (e.g. tree-sitter-c, #1242/#858). Membership routes a
    grammar to the vendored branch, which reads its ABI from the repo instead of
    node_modules (the #858 source of the old bare ``?``). Returns
    ``{ name: {"hold": str | None} }``; upstream-drift coords stay in ``GRAMMARS``.
    """
    manifest_path = REPO_ROOT / ".github" / "vendored-grammars.json"
    # Fail loud with a pointer, not a bare traceback: this runs at module import,
    # so a missing/corrupt manifest would otherwise crash both the script and any
    # test that imports it with an opaque FileNotFoundError/JSONDecodeError.
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(
            f"vendored-grammars manifest not found at {manifest_path}. "
            f"It is the shared source of truth for vendored grammars "
            f"(see CONTRIBUTING.md → CI automation contracts)."
        ) from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"vendored-grammars manifest at {manifest_path} is not valid JSON: {exc}."
        ) from exc
    out: dict[str, dict] = {}
    for key, g in (data.get("grammars") or {}).items():
        name = g.get("name")
        if not name:
            raise SystemExit(
                f"vendored-grammars manifest entry {key!r} is missing a 'name' field "
                f"({manifest_path})."
            )
        # Defense-in-depth (#2187): `name` is joined into gitnexus/vendor/<name>, so
        # reject anything not a plain grammar name before it can traverse ("../etc").
        if not re.fullmatch(r"tree-sitter-[a-z0-9-]+", name):
            raise SystemExit(
                f"vendored-grammars manifest entry {key!r} has an invalid grammar "
                f"name {name!r} (must match tree-sitter-[a-z0-9-]+)."
            )
        out[name] = {"hold": g.get("hold")}
    return out


# Vendored set + holds, keyed by full grammar name (e.g. "tree-sitter-c").
VENDORED: dict[str, dict] = load_vendored_manifest()
VENDORED_NAMES: frozenset[str] = frozenset(VENDORED)


# ── Helpers ─────────────────────────────────────────────────────────────

def _load_package_json() -> dict:
    return json.loads((GITNEXUS_DIR / "package.json").read_text())


def read_current_runtime() -> str:
    """Return the tree-sitter runtime version pinned in package.json (e.g. '0.21')."""
    pkg = _load_package_json()
    raw = pkg["dependencies"]["tree-sitter"]
    match = re.search(r"(\d+)\.(\d+)", raw)
    if not match:
        raise SystemExit(f"could not parse tree-sitter version: {raw!r}")
    return f"{match.group(1)}.{match.group(2)}"


def read_pinned_grammar_versions() -> dict[str, str]:
    """Return the grammar version range pinned in gitnexus/package.json.

    Looks at both runtime and optional dependencies. Returns the raw range
    string (e.g. '0.21.4', '^0.23.0', 'file:./vendor/...') so the report can
    expose how flexible each pin is.
    """
    pkg = _load_package_json()
    pinned: dict[str, str] = {}
    for section in ("dependencies", "optionalDependencies"):
        for name, spec in (pkg.get(section) or {}).items():
            if name.startswith("tree-sitter-"):
                pinned[name] = spec
    return pinned


def npm_view_json(pkg: str) -> dict | None:
    """Fetch package metadata from the npm registry via HTTPS.

    Uses the registry API directly so we don't depend on the npm CLI
    being available (it's a batch file on Windows which complicates
    subprocess calls).
    """
    if OFFLINE:
        return None
    url = f"https://registry.npmjs.org/{pkg}/latest"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    # OSError covers read-phase transport failures (ConnectionResetError,
    # ssl.SSLError, socket.timeout) that escape resp.read() AFTER urlopen
    # returns — urllib only wraps connect-phase OSErrors into URLError, so these
    # are not URLError subclasses. http.client.IncompleteRead is an HTTPException,
    # not an OSError, so it must be named explicitly. Returning None routes the
    # grammar to the fetch_failed blocker bucket (a complete report) instead of
    # crashing main() to empty stdout.
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        OSError,
        http.client.IncompleteRead,
        json.JSONDecodeError,
    ):
        return None


def satisfies_target(peer_range: str | None, target: str) -> bool:
    """Check if a semver range like '^0.22.4' or '^0.25.0' satisfies the target.

    Simple heuristic: extract the minimum version from the range and check
    if target >= min. For caret ranges (^X.Y.Z), the upper bound is the
    next major (for X>0) or next minor (for X==0). We check both bounds.
    """
    if peer_range is None:
        # No peer dep declared = no constraint = compatible.
        return True
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", peer_range)
    if not match:
        return False
    min_major, min_minor, min_patch = int(match.group(1)), int(match.group(2)), int(match.group(3))

    t_match = re.search(r"(\d+)\.(\d+)\.(\d+)", target)
    if not t_match:
        return False
    t_major, t_minor, t_patch = int(t_match.group(1)), int(t_match.group(2)), int(t_match.group(3))

    # Target must be >= minimum.
    target_tuple = (t_major, t_minor, t_patch)
    min_tuple = (min_major, min_minor, min_patch)
    if target_tuple < min_tuple:
        return False

    # For caret ranges with major 0: ^0.X.Y allows [0.X.Y, 0.(X+1).0).
    if peer_range.startswith("^") and min_major == 0:
        if t_major != 0 or t_minor >= min_minor + 1:
            return False
    # For caret ranges with major >0: ^X.Y.Z allows [X.Y.Z, (X+1).0.0).
    elif peer_range.startswith("^") and min_major > 0:
        if t_major >= min_major + 1:
            return False

    return True


_GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")


def fetch_text(url: str, timeout: int = 8) -> str | None:
    """Fetch a URL and return its text, or None on failure.

    Adds an Authorization header for github.com URLs when GITHUB_TOKEN is
    set (raises the rate limit from 60 to 5 000 requests/hour).
    """
    if OFFLINE:
        return None
    headers: dict[str, str] = {}
    # Parse the URL and check the hostname rather than substring-matching
    # on the full URL string (CodeQL py/incomplete-url-substring-sanitization).
    # `https://evil.com/?u=github.com` would have passed the substring check.
    try:
        parsed_host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        parsed_host = ""
    is_github_host = parsed_host == "github.com" or parsed_host.endswith(
        (".github.com", ".githubusercontent.com")
    ) or parsed_host == "githubusercontent.com"
    if _GITHUB_TOKEN and is_github_host:
        headers["Authorization"] = f"Bearer {_GITHUB_TOKEN}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    # See npm_view_json: OSError + http.client.IncompleteRead catch read-phase
    # transport failures that escape resp.read() and are not URLError subclasses,
    # so a transient network blip yields None (→ fetch_failed) rather than
    # crashing the report to empty stdout.
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        OSError,
        http.client.IncompleteRead,
    ):
        return None


def extract_abi_from_text(text: str) -> int | None:
    """Extract LANGUAGE_VERSION from parser.c text."""
    match = re.search(r"#define\s+LANGUAGE_VERSION\s+(\d+)", text[:4096])
    return int(match.group(1)) if match else None


def extract_language_version(parser_c: pathlib.Path) -> int | None:
    """Return the LANGUAGE_VERSION defined in a parser.c, or None if absent."""
    if not parser_c.is_file():
        return None
    with parser_c.open("r", encoding="utf-8", errors="ignore") as fh:
        head = fh.read(4096)
    return extract_abi_from_text(head)


def md_h(text: str, level: int = 2) -> str:
    return f"{'#' * level} {text}\n"


def _first_sentence(text: str) -> str:
    """Return the leading sentence of a `_vendoredBy` rationale (the rest tails off
    into install-script breadcrumbs); fall back to the whole string."""
    text = text.strip()
    match = re.search(r"\.\s+[A-Z]", text)
    return text[: match.start() + 1] if match else text


def range_includes(spec: str | None, version: str) -> bool:
    """Return True if pinned-range `spec` accepts the concrete `version`.

    Handles the spec shapes we actually use in package.json:
      - exact pins  ('0.21.4')
      - caret / tilde ranges ('^0.23.0', '~0.23.5')
      - non-registry pins ('file:./vendor/...', 'git+...') — always False,
        because there's no meaningful "behind npm latest" comparison.
    """
    if not spec or spec == "—":
        return False
    if spec.startswith(("file:", "git", "http")):
        return False
    if spec.startswith(("^", "~")):
        return satisfies_target(spec, version)
    return spec.strip() == version.strip()


def vendored_abi_from_repo(name: str, parser_path: str) -> int | None:
    """Read a vendored grammar's ABI directly from gitnexus/vendor/<name>.

    Local-only (no network) — the offline half of ``vendored_drift_summary``,
    factored out so the hermetic ``--assert-current`` gate can introspect vendored
    ABIs without triggering the upstream-drift fetches it never uses (#858 review).
    """
    vendor_dir = GITNEXUS_DIR / "vendor" / name
    vendored_parser = vendor_dir / parser_path
    if not vendored_parser.is_file():
        vendored_parser = vendor_dir / "src" / "parser.c"
    return extract_language_version(vendored_parser)


def vendored_drift_summary(
    name: str, upstream_repo: str, upstream_branch: str, parser_path: str
) -> dict:
    """Inspect a vendored grammar under gitnexus/vendor/<name>: returns its
    package.json ``version`` + ``_vendoredBy`` (the rationale, kept next to the
    sources), the vendored ABI, and a comparison against upstream main.
    """
    vendor_dir = GITNEXUS_DIR / "vendor" / name
    pkg: dict = {}
    pkg_path = vendor_dir / "package.json"
    if pkg_path.is_file():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8", errors="ignore"))
        except json.JSONDecodeError:
            pass

    vendored_parser = vendor_dir / parser_path
    if not vendored_parser.is_file():
        vendored_parser = vendor_dir / "src" / "parser.c"
    vendored_abi = vendored_abi_from_repo(name, parser_path)

    upstream_url = (
        f"https://raw.githubusercontent.com/{upstream_repo}/"
        f"{upstream_branch}/{parser_path}"
    )
    upstream_text = fetch_text(upstream_url)
    upstream_abi = extract_abi_from_text(upstream_text) if upstream_text else None

    sha_text = fetch_text(
        f"https://api.github.com/repos/{upstream_repo}/commits/{upstream_branch}"
    )
    # Labeled fallback rather than a bare "?": in CI this fetch succeeds, but
    # offline (or on a transient API miss) the report should say *why* it's
    # blank instead of leaving a placeholder (#858).
    upstream_sha = "unknown"
    if sha_text:
        try:
            upstream_sha = json.loads(sha_text).get("sha", "unknown")[:12]
        except json.JSONDecodeError:
            pass

    local_text = (
        vendored_parser.read_text(encoding="utf-8", errors="ignore")
        if vendored_parser.is_file()
        else ""
    )
    in_sync = bool(
        upstream_text
        and local_text.replace("\r\n", "\n") == upstream_text.replace("\r\n", "\n")
    )

    return {
        "name": name,
        # Labeled fallback, never a bare "?": a vendor package.json should always
        # carry a version, but if one is missing the report says so plainly (#858).
        "vendored_version": pkg.get("version") or "unknown",
        "vendored_by": pkg.get("_vendoredBy"),
        "vendored_abi": vendored_abi,
        "upstream_repo": upstream_repo,
        "upstream_branch": upstream_branch,
        "upstream_sha": upstream_sha,
        "upstream_abi": upstream_abi,
        "in_sync": in_sync,
    }


# ── Assert mode (CI gate) ─────────────────────────────────────────────────


def assert_current() -> int:
    """Assert every grammar's compiled ABI loads on the CURRENT runtime.

    The hermetic/offline static half of the #1922 ABI gate (the runtime
    load-smoke is the dynamic half): reads only local files — npm ABIs from
    node_modules/<name>, vendored ABIs from gitnexus/vendor/<name> via
    ``vendored_abi_from_repo`` (no network). A prebuilt-only vendor (no
    parser.c) is skipped; INTENTIONAL_PINS are asserted like any other grammar.
    Returns 0 when every introspectable grammar is in range, 1 otherwise.
    """
    current_runtime = read_current_runtime()
    abi_range = RUNTIME_ABI_RANGES.get(current_runtime)
    if abi_range is None:
        print(
            f"FAIL: RUNTIME_ABI_RANGES has no entry for current runtime "
            f"{current_runtime!r}; add it before asserting.",
        )
        return 1
    lo, hi = abi_range
    pinned_versions = read_pinned_grammar_versions()

    print(
        f"Asserting all grammar ABIs load on tree-sitter@{current_runtime}.x "
        f"(ABI {lo}–{hi})."
    )

    failures: list[str] = []
    checked = 0
    skipped: list[str] = []

    for name, (upstream_repo, upstream_branch, parser_path) in sorted(GRAMMARS.items()):
        pinned_spec = pinned_versions.get(name, "—")
        if name in VENDORED_NAMES and VENDORED[name].get("hold"):
            pin_note = " [vendored, held]"
        elif name in INTENTIONAL_PINS:
            pin_note = f" [intentional pin: {pinned_spec}]"
        else:
            pin_note = ""

        # Vendored grammars: ABI read locally from the repo via vendored_abi_from_repo
        # (NOT vendored_drift_summary, which fetches upstream — this gate is hermetic),
        # so the offline #1922 gate covers them instead of skipping them (#858/#2187).
        if name in VENDORED_NAMES:
            abi = vendored_abi_from_repo(name, parser_path)
            if abi is None:
                # Prebuilt-only vendor (e.g. a binary-only grammar): no parser.c to
                # introspect. The runtime load-smoke covers it instead.
                skipped.append(f"{name} (vendored, prebuilt — covered by load-smoke)")
                continue
            checked += 1
            if lo <= abi <= hi:
                print(f"  OK   {name}: vendored ABI {abi} in range{pin_note}")
            else:
                msg = (
                    f"{name}: vendored ABI {abi} outside current runtime range "
                    f"{lo}..{hi}{pin_note}"
                )
                print(f"  FAIL {msg}")
                failures.append(msg)
            continue

        installed_parser = GITNEXUS_DIR / "node_modules" / name / parser_path
        if not installed_parser.is_file():
            installed_parser = GITNEXUS_DIR / "node_modules" / name / "src" / "parser.c"
        abi = extract_language_version(installed_parser)
        if abi is None:
            skipped.append(f"{name} (not installed / no parser.c — covered by load-smoke)")
            continue
        checked += 1
        if lo <= abi <= hi:
            print(f"  OK   {name}: installed ABI {abi} in range{pin_note}")
        else:
            msg = (
                f"{name}: installed ABI {abi} outside current runtime range "
                f"{lo}..{hi}{pin_note}"
            )
            print(f"  FAIL {msg}")
            failures.append(msg)

    print("")
    if skipped:
        print("Not statically introspectable (asserted via runtime load-smoke):")
        for s in skipped:
            print(f"  - {s}")
        print("")

    if failures:
        print(f"RESULT: FAIL — {len(failures)} grammar(s) out of range, {checked} checked.")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(f"RESULT: OK — all {checked} introspectable grammar ABIs in range.")
    return 0


# ── Main ────────────────────────────────────────────────────────────────


def _classify_grammar(
    *,
    name: str,
    pinned_spec: str | None,
    npm_version: str,
    peer_range: str | None,
    fetch_failed: bool,
    target_compat: bool,
    current_compat: bool,
    upstream_progress: str | None,
) -> dict:
    """Decide a single primary disposition + a separate bump-now hint.

    Mutually-exclusive buckets, ordered by reviewer priority: ``fetch_failed``
    (npm fetch failed — surfaced apart from upstream blocks), ``intentional``
    (in INTENTIONAL_PINS), ``ready`` (npm-latest peer accepts the target),
    ``waiting`` (a fix on main, unpublished), ``blocked`` (peer too tight on
    both). ``bump_now`` is independent: True only when npm-latest's peer also
    accepts our *current* runtime (else the bump would break ``npm install``).
    """
    # Only npm-path grammars reach this function — vendored grammars are routed
    # to the vendored branch in main() and `continue` before classification.
    behind_latest = npm_version != "?" and not range_includes(pinned_spec, npm_version)
    # Intentional pins are never actionable bumps (held on purpose; lifted only by
    # editing INTENTIONAL_PINS + package.json together).
    bump_now = behind_latest and current_compat and name not in INTENTIONAL_PINS

    if fetch_failed:
        bucket = "fetch_failed"
    elif name in INTENTIONAL_PINS:
        bucket = "intentional"
    elif target_compat:
        bucket = "ready"
    elif upstream_progress:
        bucket = "waiting"
    else:
        bucket = "blocked"

    return {
        "name": name,
        "pinned_spec": pinned_spec or "—",
        "npm_version": npm_version,
        # Display form for the disposition prose, laundering a "?" (a malformed 200
        # npm response lacking `version`) so it never shows bare, like the matrix cell.
        "npm_version_label": "unknown" if npm_version == "?" else npm_version,
        "peer_range": peer_range,
        "target_compat": target_compat,
        "current_compat": current_compat,
        "upstream_progress": upstream_progress,
        "behind_latest": behind_latest,
        "bump_now": bump_now,
        "bucket": bucket,
    }


def _render_vendored_section(
    vendored_grammars: list[dict],
    target_abi_range: tuple[int, int],
    blockers: dict[str, str],
) -> list[str]:
    """Render the 'Vendored parsers' prose block. Appends any runtime-side blocker
    (upstream ABI beyond the target range) to ``blockers`` in place; returns the
    markdown lines (empty when nothing is vendored). Extracted from main() so that
    function coordinates named render phases rather than inlining them (#2187)."""
    if not vendored_grammars:
        return []
    # Hoisted out of the list literal below: an implicit string concatenation
    # inside a list display trips CodeQL py/implicit-string-concatenation-in-list
    # (it reads as a possibly-missing comma between elements).
    intro = (
        "These grammars ship from `gitnexus/vendor/` rather than the npm "
        "registry. Their compatibility is governed by the **vendored "
        "ABI** (must lie in the target runtime's range), not by a peer-"
        "dep negotiation. The rationale for each vendored copy lives in "
        "its own `package.json` `_vendoredBy` field."
    )
    lines = [md_h(f"Vendored parsers ({len(vendored_grammars)})", 2), intro, ""]
    for v in sorted(vendored_grammars, key=lambda v: v["name"]):
        sync_label = "in sync with upstream" if v["in_sync"] else "diverged from upstream"
        if v["abi_state"] == "in_range":
            abi_label = f"ABI `{v['vendored_abi']}` (in target range)"
        elif v["abi_state"] == "prebuilt":
            abi_label = "ABI `prebuilt` (binary-only vendor, source not introspectable)"
        else:
            abi_label = (
                f"ABI `{v['vendored_abi']}` (**outside** target range "
                f"{target_abi_range[0]}..{target_abi_range[1]})"
            )
        # Never a bare "?": when upstream parser.c can't be read (generated at build,
        # or a transient fetch miss), use the neutral `n/a` token (#858).
        upstream_abi_str = (
            f"ABI `{v['upstream_abi']}`" if v["upstream_abi"] is not None else "ABI `n/a`"
        )
        lines.append(
            f"- **`{v['name']}`** `{v['vendored_version']}` — {abi_label}, "
            f"upstream `{v['upstream_repo']}@{v['upstream_sha']}` "
            f"{upstream_abi_str} · {sync_label}"
        )
        if v.get("hold"):
            lines.append(f"  - **Held:** {v['hold']}")
        if v["vendored_by"]:
            # First sentence only — vendor _vendoredBy fields tail off into noise.
            lines.append(f"  - **Why vendored:** {_first_sentence(v['vendored_by'])}")
        # Action: regen iff upstream ABI exceeds vendored AND stays within target;
        # beyond target is a runtime-side blocker. Prebuilt-only vendors get a
        # manual-refresh action driven by the in-sync flag instead.
        if v["abi_state"] == "prebuilt":
            if not v["in_sync"]:
                lines.append(
                    "  - **Action:** check whether upstream has shipped a new "
                    "prebuilt release; this vendor ships binary-only artefacts."
                )
        elif v["upstream_abi"] and v["vendored_abi"] and v["upstream_abi"] > v["vendored_abi"]:
            if v["upstream_abi"] <= target_abi_range[1]:
                lines.append(
                    f"  - **Action:** after upgrading to tree-sitter@{TARGET_RUNTIME}, "
                    f"regenerate `parser.c` from upstream `{v['upstream_sha']}`."
                )
            else:
                lines.append(
                    f"  - **Action:** wait for a runtime supporting ABI "
                    f"{v['upstream_abi']}; current target ({TARGET_RUNTIME}) only "
                    f"goes up to ABI {target_abi_range[1]}."
                )
                blockers[f"vendored-{v['name']}-abi"] = (
                    f"vendored {v['name']}: upstream ABI {v['upstream_abi']} outside target range"
                )
        elif not v["in_sync"]:
            lines.append(
                "  - **Action:** review upstream changes; vendored copy may "
                "need a refresh (no ABI bump required)."
            )
    lines.append("")
    return lines


def main() -> int:
    blockers: dict[str, str] = {}
    lines: list[str] = []
    # Label for npm/upstream values we couldn't determine: in --offline mode the
    # fetch was deliberately skipped (not "failed"), so say so honestly.
    miss_label = "offline" if OFFLINE else "fetch failed"
    lines.append(md_h("Tree-sitter 0.25 upgrade readiness", 1))
    lines.append("")
    if OFFLINE:
        lines.append(
            "> **Offline mode** — npm registry + upstream GitHub checks were skipped. "
            "npm-installed grammars show as unverified; vendored-grammar ABIs are read "
            "from `gitnexus/vendor/`."
        )
        lines.append("")

    current_runtime = read_current_runtime()
    current_abi_range = RUNTIME_ABI_RANGES.get(current_runtime, (0, 0))
    target_abi_range = RUNTIME_ABI_RANGES.get(TARGET_RUNTIME_MAJOR_MINOR, (0, 0))
    pinned_versions = read_pinned_grammar_versions()

    lines.append(
        f"`tree-sitter@{current_runtime}.x` (ABI {current_abi_range[0]}–{current_abi_range[1]}) "
        f"→ target `tree-sitter@{TARGET_RUNTIME}` "
        f"(ABI {target_abi_range[0]}–{target_abi_range[1]})."
    )
    lines.append("")

    # First pass: gather + classify per grammar. Human buckets render first, then
    # the raw matrix in a <details> block (Status text preserved verbatim so the
    # workflow's row-diff change-detection keeps working).
    grammar_rows: list[dict] = []
    raw_matrix: list[str] = [
        "| Grammar | Pinned | npm latest | Peer dep | Satisfies 0.25? | ABI | Upstream ABI | Status |",
        "|---|---|---|---|---|---|---|---|",
    ]

    vendored_grammars: list[dict] = []

    for name, (upstream_repo, upstream_branch, parser_path) in sorted(GRAMMARS.items()):
        pinned_spec = pinned_versions.get(name, "—")

        # Vendored grammars are classified by manifest membership (NOT a file: pin
        # heuristic — they aren't in package.json at all, the #858 misrouting bug).
        # Their readiness is governed by the vendored ABI, read from the repo, not a
        # peer-dep negotiation. npm-latest columns get sentinels.
        if name in VENDORED_NAMES:
            v = vendored_drift_summary(name, upstream_repo, upstream_branch, parser_path)
            v["pinned_spec"] = pinned_spec
            hold = VENDORED[name].get("hold")
            v["hold"] = hold
            # Three-state ABI classification: in-range, out-of-range, or
            # not-introspectable (e.g. a prebuilt-only vendor with no parser.c).
            if v["vendored_abi"] is None:
                v["target_compat"] = True
                v["abi_state"] = "prebuilt"
                status = "Vendored (prebuilt — ABI not introspectable)"
            elif target_abi_range[0] <= v["vendored_abi"] <= target_abi_range[1]:
                v["target_compat"] = True
                v["abi_state"] = "in_range"
                status = "Vendored (ABI in target range)"
            else:
                v["target_compat"] = False
                v["abi_state"] = "out_of_range"
                status = "Vendored (ABI out of range)"
                blockers[name] = (
                    f"vendored `{name}`: ABI {v['vendored_abi']} outside target range "
                    f"{target_abi_range[0]}..{target_abi_range[1]}"
                )
            # A held vendored grammar (e.g. tree-sitter-c, #1242/#858) is frozen below
            # a runtime upgrade: in-range ABI or not, keep it a blocker until the hold
            # (from the manifest) is lifted — same treatment as npm INTENTIONAL_PINS.
            if hold:
                v["target_compat"] = False
                status = "Vendored — held"
                # Compose with any out-of-range reason rather than overwriting it:
                # both share the blockers[name] key, and the ABI-out-of-range
                # detail would otherwise be lost from the blockers summary.
                hold_reason = f"vendored `{name}` held: {hold}"
                prior = blockers.get(name)
                blockers[name] = f"{prior}; {hold_reason}" if prior else hold_reason
            # Cell sentinels: never emit a bare "?". A vendored grammar's ABI is
            # the real LANGUAGE_VERSION when introspectable, else a labeled token.
            vendored_abi_cell = (
                str(v["vendored_abi"]) if v["vendored_abi"] is not None else "prebuilt"
            )
            # A None upstream ABI means the upstream parser.c couldn't be read —
            # either it is generated at build time (e.g. swift) or the fetch
            # missed. We can't tell which here, so use a neutral label rather
            # than asserting "generated at build". Never a bare "?".
            upstream_abi_cell = (
                str(v["upstream_abi"]) if v["upstream_abi"] is not None else "n/a"
            )
            # Keep vendored grammars in the raw matrix so the workflow's
            # row-diff change-detection picks up status transitions on them too.
            # npm-only columns get sentinels.
            raw_matrix.append(
                f"| `{name}` | {pinned_spec} | (vendored) | (vendored) | "
                f"{'Yes' if v['target_compat'] else '**No**'} | "
                f"{vendored_abi_cell} | {upstream_abi_cell} | {status} |"
            )
            vendored_grammars.append(v)
            continue

        # Fetch latest npm metadata.
        info = npm_view_json(name)
        fetch_failed = info is None
        npm_version = "?"
        peer_range = None
        peer_optional = True
        if info:
            npm_version = info.get("version", "?")
            peers = info.get("peerDependencies") or {}
            peer_range = peers.get("tree-sitter")
            meta = info.get("peerDependenciesMeta") or {}
            ts_meta = meta.get("tree-sitter") or {}
            peer_optional = ts_meta.get("optional", False) if peer_range else True

        if fetch_failed:
            peer_display = f"n/a ({miss_label})"
            target_compat = False
            current_compat = False
        else:
            peer_display = peer_range or "none"
            if peer_range and not peer_optional:
                peer_display += " (required)"
            target_compat = satisfies_target(peer_range, TARGET_RUNTIME)
            current_compat = satisfies_target(peer_range, f"{current_runtime}.0")

        # Check installed ABI using the same parser_path from GRAMMARS.
        installed_parser = GITNEXUS_DIR / "node_modules" / name / parser_path
        if not installed_parser.is_file():
            # Fallback to default location.
            installed_parser = GITNEXUS_DIR / "node_modules" / name / "src" / "parser.c"
        installed_abi = extract_language_version(installed_parser)
        # Labeled sentinel, never a bare "?": CI's `npm ci` populates node_modules,
        # but if it's absent say so plainly rather than leaving a placeholder (#858).
        abi_display = str(installed_abi) if installed_abi else "n/a (not installed)"

        # Check upstream (main/master branch) ABI for unreleased work.
        upstream_url = (
            f"https://raw.githubusercontent.com/{upstream_repo}/"
            f"{upstream_branch}/{parser_path}"
        )
        upstream_text = fetch_text(upstream_url)
        upstream_abi = extract_abi_from_text(upstream_text) if upstream_text else None
        upstream_abi_display = str(upstream_abi) if upstream_abi else "n/a"

        # Status text + upstream-progress detection. The Status column
        # values are preserved as-is to keep the workflow's row-diff
        # change-detection working on the raw matrix below.
        upstream_progress: str | None = None
        if fetch_failed:
            status = f"Unknown ({miss_label})"
            reason = "checks skipped (offline)" if OFFLINE else "npm registry fetch failed"
            blockers[name] = f"`{name}`: {reason} — could not verify peer dep"
        elif name in INTENTIONAL_PINS:
            # A held-back grammar: treated as a blocker until the pin is lifted
            # (entry removed from INTENTIONAL_PINS), then reclassified next run.
            status = "Intentionally pinned"
            blockers[name] = (
                f"`{name}` intentionally pinned at `{pinned_spec}` "
                f"({INTENTIONAL_PINS[name]}) — pin must be lifted "
                f"before the {TARGET_RUNTIME} runtime upgrade"
            )
        elif target_compat:
            status = "Ready"
        elif upstream_abi and upstream_abi >= 15:
            status = "Unreleased (ABI 15 on main)"
            upstream_progress = f"ABI 15 on `{upstream_repo}@{upstream_branch}` not yet published"
            blockers[name] = f"`{name}`: ABI 15 on `{upstream_repo}` main but not published to npm"
        else:
            status = "Blocking"
            blockers[name] = f"`{name}@{npm_version}`: peer `{peer_display}` incompatible with 0.25"

        # Also check upstream package.json for relaxed peer dep — beats
        # the ABI-15 hint when both are true.
        if not target_compat and not fetch_failed:
            upstream_pkg_url = (
                f"https://raw.githubusercontent.com/{upstream_repo}/"
                f"{upstream_branch}/package.json"
            )
            upstream_pkg_text = fetch_text(upstream_pkg_url)
            if upstream_pkg_text:
                try:
                    upstream_pkg = json.loads(upstream_pkg_text)
                    upstream_peer = (upstream_pkg.get("peerDependencies") or {}).get("tree-sitter")
                    if upstream_peer and satisfies_target(upstream_peer, TARGET_RUNTIME):
                        status = "Unreleased (peer relaxed on main)"
                        upstream_progress = (
                            f"peer relaxed to `{upstream_peer}` on "
                            f"`{upstream_repo}@{upstream_branch}` not yet published"
                        )
                        blockers[name] = f"`{name}`: peer dep relaxed on `{upstream_repo}` main but not published to npm"
                except json.JSONDecodeError:
                    pass

        pinned_spec = pinned_versions.get(name, "—")
        compat_icon = "Yes" if target_compat else "**No**"
        # "?" stays the internal fetch-failed sentinel (compared above); render a
        # labeled token in the matrix so the report never shows a bare "?" (#858).
        npm_version_cell = f"n/a ({miss_label})" if npm_version == "?" else npm_version
        raw_matrix.append(
            f"| `{name}` | {pinned_spec} | {npm_version_cell} | {peer_display} | "
            f"{compat_icon} | {abi_display} | {upstream_abi_display} | {status} |"
        )

        grammar_rows.append(_classify_grammar(
            name=name,
            pinned_spec=pinned_spec,
            npm_version=npm_version,
            peer_range=peer_range,
            fetch_failed=fetch_failed,
            target_compat=target_compat,
            current_compat=current_compat,
            upstream_progress=upstream_progress,
        ))

    # ── Bucketize ────────────────────────────────────────────────────
    by_bucket: dict[str, list[dict]] = {
        k: [] for k in ("ready", "intentional", "waiting", "blocked", "fetch_failed")
    }
    for row in grammar_rows:
        by_bucket[row["bucket"]].append(row)
    bump_now = [r for r in grammar_rows if r["bump_now"]]
    ready_count = len(by_bucket["ready"])

    # ── TL;DR ────────────────────────────────────────────────────────
    npm_count = len(grammar_rows)
    vendored_count = len(vendored_grammars)
    vendored_ready = sum(1 for v in vendored_grammars if v["target_compat"])

    if not blockers:
        verdict = "**Ready** — all grammars are 0.25-compatible. The runtime upgrade can proceed."
    else:
        moved = "no" if not by_bucket["waiting"] else f"yes — {len(by_bucket['waiting'])} grammars have unreleased fixes on main"
        verdict = (
            f"**Blocked** — {len(blockers)} grammars are not yet 0.25-compatible. "
            f"Upstream movement: {moved}."
        )

    lines.append(md_h("TL;DR", 2))
    lines.append(verdict)
    lines.append("")
    lines.append(f"- {ready_count}/{npm_count} npm-installed grammars already accept tree-sitter@{TARGET_RUNTIME}")
    if vendored_count:
        lines.append(
            f"- {vendored_ready}/{vendored_count} vendored grammars at an ABI within the target runtime range"
        )
    lines.append(f"- {len(by_bucket['intentional'])} intentionally pinned (see below)")
    lines.append(f"- {len(by_bucket['waiting'])} waiting on an upstream npm release")
    lines.append(f"- {len(by_bucket['blocked'])} blocked on upstream (no fix even on main)")
    if by_bucket['fetch_failed']:
        why = "checks skipped in offline mode" if OFFLINE else "npm registry unreachable"
        lines.append(f"- {len(by_bucket['fetch_failed'])} could not be checked ({why})")
    if bump_now:
        lines.append(
            f"- **{len(bump_now)} bump candidate(s) you can take TODAY** (npm-latest "
            f"is newer than the pin AND its peer dep accepts our current runtime)"
        )
    lines.append("")

    # ── What you can do today ───────────────────────────────────────
    if bump_now:
        lines.append(md_h("What you can do today", 2))
        lines.append(
            "These pins lag npm latest and the latest version's peer dep already "
            "accepts our current `tree-sitter@" + current_runtime + ".x` runtime. "
            "Bumping is independent of the 0.25 upgrade and should be a quick PR."
        )
        lines.append("")
        for r in sorted(bump_now, key=lambda r: r["name"]):
            lines.append(
                f"- `{r['name']}`: `{r['pinned_spec']}` → `{r['npm_version_label']}` "
                f"(peer `{r['peer_range'] or 'none'}`)"
            )
        lines.append("")

    # ── Per-disposition sections ────────────────────────────────────
    def _emit_bucket(title: str, body_intro: str, rows: list[dict], render) -> None:
        if not rows:
            return
        lines.append(md_h(f"{title} ({len(rows)})", 3))
        lines.append(body_intro)
        lines.append("")
        for r in sorted(rows, key=lambda r: r["name"]):
            lines.append(render(r))
        lines.append("")

    lines.append(md_h("Disposition", 2))

    _emit_bucket(
        "Ready for 0.25",
        "These grammars' npm-latest peer dep already accepts the target runtime. No action needed for the upgrade.",
        by_bucket["ready"],
        lambda r: (
            f"- `{r['name']}` — pinned `{r['pinned_spec']}`, npm latest `{r['npm_version_label']}`"
            + ("  _(also a bump candidate — see above)_" if r["bump_now"] else "")
        ),
    )

    if by_bucket["intentional"]:
        lines.append(md_h(f"Intentionally pinned ({len(by_bucket['intentional'])})", 3))
        lines.append(
            "Deliberately held below npm latest. These are **not** drift — each entry "
            "lists the issue motivating the pin and the condition for unpinning."
        )
        lines.append("")
        for r in sorted(by_bucket["intentional"], key=lambda r: r["name"]):
            reason = INTENTIONAL_PINS.get(r["name"], "(no rationale recorded)")
            lines.append(
                f"- `{r['name']}` pinned at `{r['pinned_spec']}` "
                f"(npm latest `{r['npm_version_label']}`)\n  {reason}"
            )
        lines.append("")

    _emit_bucket(
        "Waiting on upstream npm release",
        "Fixes are merged on the upstream main branch but not yet published to npm. "
        "We can move forward as soon as upstream cuts a release.",
        by_bucket["waiting"],
        lambda r: (
            f"- `{r['name']}@{r['npm_version_label']}` — peer `{r['peer_range'] or 'none'}`. "
            f"_{r['upstream_progress']}_"
        ),
    )

    _emit_bucket(
        "Blocked on upstream",
        "Peer dep is too tight on both the latest npm release and on upstream main. "
        "These need an upstream issue/PR before we can proceed.",
        by_bucket["blocked"],
        lambda r: f"- `{r['name']}@{r['npm_version_label']}` — peer `{r['peer_range'] or 'none'}`",
    )

    _emit_bucket(
        "Could not check",
        (
            "Checks were skipped because the report ran in `--offline` mode. "
            "Re-run online to verify these grammars."
            if OFFLINE
            else "npm registry fetch failed for these grammars. Re-run the workflow to retry."
        ),
        by_bucket["fetch_failed"],
        lambda r: f"- `{r['name']}` (pinned `{r['pinned_spec']}`)",
    )

    # ── Vendored parsers ────────────────────────────────────────────
    lines.extend(_render_vendored_section(vendored_grammars, target_abi_range, blockers))

    # ── Raw matrix (for completeness + workflow row-diff) ────────────
    lines.append(md_h("Full grammar matrix", 2))
    lines.append(
        "<details><summary>Click to expand the raw per-grammar table "
        "(used by the workflow's change-detection bot).</summary>\n"
    )
    lines.extend(raw_matrix)
    lines.append("\n</details>")
    lines.append("")

    print("\n".join(lines))
    return 1 if blockers else 0


if __name__ == "__main__":
    # Force UTF-8 output: the report contains em-dashes and arrows that
    # Windows' default cp1252 codepage can't encode, while Linux runners
    # default to UTF-8 anyway.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    # `--offline` skips all network so the readiness report renders hermetically
    # (vendored ABIs from the repo; npm columns marked unverified). Useful for
    # air-gapped runs and deterministic tests.
    if "--offline" in sys.argv[1:]:
        OFFLINE = True
    # `--assert-current` is the offline CI gate (#1922): assert every grammar's
    # ABI loads on the CURRENT runtime. Bare invocation keeps the original
    # target-runtime readiness report behaviour.
    if "--assert-current" in sys.argv[1:]:
        sys.exit(assert_current())
    sys.exit(main())
