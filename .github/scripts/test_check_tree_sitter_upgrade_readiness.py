#!/usr/bin/env python3
"""Tests for check-tree-sitter-upgrade-readiness.py.

Stdlib-only (``unittest`` + ``unittest.mock``) to match the script under test,
which is deliberately dependency-free so it runs on any vanilla runner. Run with:

    python3 -m unittest .github/scripts/test_check_tree_sitter_upgrade_readiness.py

(pytest also discovers ``unittest.TestCase`` classes, so a future pytest CI job
picks these up unchanged.)

These tests lock in the #858 fix: the 5 vendored grammars
(c/swift/kotlin/dart/proto) are classified from the shared manifest
(.github/vendored-grammars.json), their ABI is read from gitnexus/vendor/<name>,
and the report never renders a bare ``?`` placeholder. All network is mocked.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import re
import unittest
from unittest import mock

# ── Load the hyphenated script as a module ───────────────────────────────
_SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
_SCRIPT = _SCRIPTS_DIR / "check-tree-sitter-upgrade-readiness.py"
_REPO_ROOT = _SCRIPTS_DIR.parents[1]
_MANIFEST = _REPO_ROOT / ".github" / "vendored-grammars.json"

_spec = importlib.util.spec_from_file_location("readiness_under_test", _SCRIPT)
readiness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(readiness)  # type: ignore[union-attr]

# The exact row-diff regex the workflow's change-detection bot uses
# (.github/workflows/tree-sitter-upgrade-readiness.yml). Kept in lockstep so a
# matrix format change that would silently break change-detection fails here.
_ROW_DIFF_RE = re.compile(
    r"\| `(tree-sitter-[^`]+)` \|.*?\| (\S+(?:\s\S+)*?) \|$", re.M
)


def _physical_vendor_grammars() -> set[str]:
    vendor = _REPO_ROOT / "gitnexus" / "vendor"
    return {
        p.name
        for p in vendor.iterdir()
        if p.is_dir() and p.name.startswith("tree-sitter-")
    }


def _render_report() -> tuple[str, int]:
    """Run main() with network mocked to mirror PRODUCTION; return (md, exit_code).

    - npm grammars resolve to a permissive "Ready" peer dep, so the ONLY blocker
      left is the held vendored tree-sitter-c — letting us assert the hold is
      load-bearing (exit code stays non-zero because of it).
    - npm_view_json records its calls so we can prove vendored grammars are never
      npm-queried.
    - fetch_text mirrors the real workflow: upstream parser.c resolves to a real
      ABI (committed upstream), commit endpoints return a sha — EXCEPT swift's
      upstream, whose parser.c is generated at build time and so is unreachable
      (None). That single miss exercises the labeled-sentinel path; every other
      cell must be a real value, never a bare '?'.
    """
    npm_calls: list[str] = []

    def fake_npm_view_json(pkg: str):
        npm_calls.append(pkg)
        return {"version": "9.9.9", "peerDependencies": {"tree-sitter": "^0.25.0"}}

    def fake_fetch_text(url: str, timeout: int = 8):
        if "parser.c" in url:
            # swift's upstream parser.c is generated at build time → unreachable.
            if "alex-pinkus" in url:
                return None
            return "#define LANGUAGE_VERSION 14\n#define STATE_COUNT 1\n"
        if "/commits/" in url:
            return json.dumps({"sha": "0123456789abcdef"})
        # package.json (relaxed-peer probe) etc. — not needed for these assertions.
        return None

    buf = io.StringIO()
    with mock.patch.object(readiness, "npm_view_json", side_effect=fake_npm_view_json), \
         mock.patch.object(readiness, "fetch_text", side_effect=fake_fetch_text), \
         contextlib.redirect_stdout(buf):
        code = readiness.main()
    report = buf.getvalue()
    _render_report.last_npm_calls = npm_calls  # type: ignore[attr-defined]
    return report, code


class ManifestClassification(unittest.TestCase):
    def test_manifest_matches_physical_vendor_dirs(self):
        """Consistency guard: the manifest set == the gitnexus/vendor/tree-sitter-*
        dirs. Vendoring a grammar without a manifest entry (or vice-versa) fails —
        this is what keeps the two tree-sitter workflows aligned (#858)."""
        manifest_names = {
            g["name"]
            for g in json.loads(_MANIFEST.read_text())["grammars"].values()
        }
        self.assertEqual(manifest_names, _physical_vendor_grammars())

    def test_vendored_names_loaded_from_manifest(self):
        self.assertEqual(set(readiness.VENDORED_NAMES), _physical_vendor_grammars())
        # npm-installed grammars must NOT be classified vendored.
        self.assertNotIn("tree-sitter-cpp", readiness.VENDORED_NAMES)
        self.assertNotIn("tree-sitter-go", readiness.VENDORED_NAMES)

    def test_c_carries_a_hold_cpp_does_not(self):
        self.assertTrue(readiness.VENDORED["tree-sitter-c"]["hold"])
        self.assertNotIn("tree-sitter-c", readiness.INTENTIONAL_PINS)
        # cpp stays an npm intentional pin.
        self.assertIn("tree-sitter-cpp", readiness.INTENTIONAL_PINS)


class ReportRendering(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report, cls.code = _render_report()
        cls.rows = dict(_ROW_DIFF_RE.findall(cls.report))

    def test_no_bare_question_mark_anywhere(self):
        # The only legitimate '?' is the "Satisfies 0.25?" column header.
        sanitized = self.report.replace("Satisfies 0.25?", "Satisfies 0.25")
        self.assertNotIn("?", sanitized, "report still contains a bare '?' placeholder")

    def test_every_vendored_grammar_shows_numeric_abi_not_question_mark(self):
        for name in readiness.VENDORED_NAMES:
            row = self._matrix_row(name)
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            abi_cell = cells[5]  # Grammar|Pinned|npm|Peer|Satisfies|ABI|UpstreamABI|Status
            self.assertRegex(
                abi_cell, r"^\d+$",
                f"{name} ABI cell is '{abi_cell}', expected a number (read from vendor/)",
            )

    def test_proto_is_never_npm_queried(self):
        # github-only vendored grammars must skip the npm peer-dep path entirely,
        # which is what removes the old "? (fetch failed)" for tree-sitter-proto.
        self.assertNotIn("tree-sitter-proto", _render_report.last_npm_calls)
        self.assertNotIn("tree-sitter-dart", _render_report.last_npm_calls)
        self.assertNotIn("Could not check", self.report)
        self.assertNotIn("fetch failed", self.report)

    def test_held_c_renders_held_and_keeps_exit_nonzero(self):
        # Status is the last matrix cell (the row-diff regex captures the whole
        # tail, not just status, so read the cell directly).
        cells = [c.strip() for c in self._matrix_row("tree-sitter-c").strip().strip("|").split("|")]
        self.assertEqual(cells[-1], "Vendored — held")
        self.assertIn("**Held:**", self.report)
        # With every npm grammar mocked to "Ready", the ONLY remaining blocker is
        # the held c — so a non-zero exit proves the hold is treated as a blocker.
        self.assertEqual(self.code, 1)

    def test_upstream_abi_miss_uses_labeled_sentinel(self):
        # fetch_text → None for all upstreams, so every vendored upstream-ABI cell
        # is the labeled token, never a bare '?'.
        self.assertIn("n/a (generated at build)", self.report)

    def test_row_diff_regex_captures_all_fifteen_grammars(self):
        # The change-detection bot keys on the row regex (group 1 = grammar name).
        # It must still match every row after the format change (vendored rows use
        # '(vendored)' sentinels + real ABI) so status transitions keep being
        # detected. self.rows maps name -> full row tail (the bot's group 2).
        self.assertEqual(len(self.rows), 15)
        for name in readiness.VENDORED_NAMES:
            self.assertIn(name, self.rows)

    def _matrix_row(self, name: str) -> str:
        for line in self.report.splitlines():
            if line.startswith(f"| `{name}` |"):
                return line
        self.fail(f"no matrix row for {name}")


if __name__ == "__main__":
    unittest.main()
