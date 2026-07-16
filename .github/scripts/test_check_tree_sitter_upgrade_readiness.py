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
import http.client
import importlib.util
import io
import json
import pathlib
import re
from unittest import TestCase, main, mock

# ── Load the hyphenated script as a module ───────────────────────────────
_SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
_SCRIPT = _SCRIPTS_DIR / "check-tree-sitter-upgrade-readiness.py"
_REPO_ROOT = _SCRIPTS_DIR.parents[1]
_MANIFEST = _REPO_ROOT / ".github" / "vendored-grammars.json"

_spec = importlib.util.spec_from_file_location("readiness_under_test", _SCRIPT)
readiness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(readiness)  # type: ignore[union-attr]

# The exact row-diff regex the workflow's change-detection bot uses
# (.github/workflows/tree-sitter-upgrade-readiness.yml) — byte-identical so a matrix
# format change that would silently break change-detection fails here. Group 2 is
# ONLY the Status cell ([^|]+? before the final `|$`).
_ROW_DIFF_RE = re.compile(r"\| `(tree-sitter-[^`]+)` \|.*\| ([^|]+?) \|$", re.M)
# Mirrors the scheduled issue-update summary extraction in
# tree-sitter-upgrade-readiness.yml. If the report prose changes again, the issue
# comment should not silently degrade to "?/? ready. ? blocker(s)".
_ISSUE_READY_RE = re.compile(
    r"- (\d+)/(\d+) npm-installed grammars already accept tree-sitter@"
)
_ISSUE_BLOCKER_RE = re.compile(r"\*\*Blocked\*\* — (\d+) grammars? ")


def _physical_vendor_grammars() -> set[str]:
    vendor = _REPO_ROOT / "gitnexus" / "vendor"
    return {
        p.name
        for p in vendor.iterdir()
        if p.is_dir() and p.name.startswith("tree-sitter-")
    }


def _render_report() -> tuple[str, int]:
    """Run main() with network mocked to mirror PRODUCTION; return (md, exit_code).

    - npm grammars resolve to a permissive "Ready" peer dep, so the only blockers
      left are the held vendored grammars (tree-sitter-c, tree-sitter-kotlin) plus
      the intentionally-pinned tree-sitter-cpp — letting us assert holds are
      load-bearing (exit code stays non-zero because of them).
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
            # swift's upstream parser.c is generated at build time → unreachable;
            # the others ship a committed parser.c.
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


class ManifestClassification(TestCase):
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

    def test_vendored_names_are_a_subset_of_GRAMMARS(self):
        # The report + --assert-current iterate the hardcoded GRAMMARS dict for
        # upstream-drift coords. A vendored grammar present in the manifest but
        # missing from GRAMMARS would be silently dropped from both — re-creating
        # the cross-workflow divergence the manifest exists to kill (#858). Guard it.
        missing = set(readiness.VENDORED_NAMES) - set(readiness.GRAMMARS)
        self.assertEqual(missing, set(), f"manifest grammars missing from GRAMMARS: {missing}")

    def test_missing_manifest_raises_a_clear_error(self):
        import pathlib
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(readiness, "REPO_ROOT", pathlib.Path(d)):
                with self.assertRaises(SystemExit) as ctx:
                    readiness.load_vendored_manifest()
        self.assertIn("vendored-grammars manifest", str(ctx.exception))

    def test_malformed_manifest_raises_a_clear_error(self):
        import pathlib
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            gh = pathlib.Path(d) / ".github"
            gh.mkdir()
            (gh / "vendored-grammars.json").write_text("{ not valid json", encoding="utf-8")
            with mock.patch.object(readiness, "REPO_ROOT", pathlib.Path(d)):
                with self.assertRaises(SystemExit) as ctx:
                    readiness.load_vendored_manifest()
        self.assertIn("not valid JSON", str(ctx.exception))

    def test_path_traversal_grammar_name_is_rejected(self):
        import pathlib
        import tempfile

        bad = '{"grammars": {"evil": {"name": "../etc"}}}'
        with tempfile.TemporaryDirectory() as d:
            gh = pathlib.Path(d) / ".github"
            gh.mkdir()
            (gh / "vendored-grammars.json").write_text(bad, encoding="utf-8")
            with mock.patch.object(readiness, "REPO_ROOT", pathlib.Path(d)):
                with self.assertRaises(SystemExit) as ctx:
                    readiness.load_vendored_manifest()
        self.assertIn("invalid grammar name", str(ctx.exception))


class AssertCurrent(TestCase):
    """The offline #1922 ABI gate (--assert-current) must stay hermetic — it reads
    vendored ABIs from the repo, never the network. (Regression guard: a prior
    revision routed vendored grammars through vendored_drift_summary, which fetches
    upstream parser.c + commit sha, silently breaking the 'hermetic and offline'
    contract — #858 review.)"""

    def _run_assert_current(self):
        import urllib.request

        def explode(*a, **k):
            raise AssertionError("--assert-current attempted a network call")

        buf = io.StringIO()
        with mock.patch.object(urllib.request, "urlopen", side_effect=explode), \
             contextlib.redirect_stdout(buf):
            code = readiness.assert_current()
        return buf.getvalue(), code

    def test_assert_current_is_network_free_and_passes(self):
        report, code = self._run_assert_current()  # raises if any urlopen fires
        self.assertEqual(code, 0)
        # All 5 vendored grammars are introspected from the repo (ABI 14), not skipped.
        for name in readiness.VENDORED_NAMES:
            self.assertIn(f"{name}: vendored ABI", report)

    def test_assert_current_fails_an_out_of_range_vendored_abi(self):
        # vendored_abi_from_repo is the local-read injection point: force one
        # grammar out of the current runtime's ABI window and assert the gate trips.
        real = readiness.vendored_abi_from_repo

        def fake(name, parser_path):
            return 99 if name == "tree-sitter-dart" else real(name, parser_path)

        import urllib.request
        buf = io.StringIO()
        with mock.patch.object(readiness, "vendored_abi_from_repo", side_effect=fake), \
             mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("network")), \
             contextlib.redirect_stdout(buf):
            code = readiness.assert_current()
        self.assertEqual(code, 1)
        self.assertIn("tree-sitter-dart", buf.getvalue())
        self.assertIn("outside current runtime range", buf.getvalue())


class FetchHelperReadPhaseErrors(TestCase):
    """Read-phase transport failures — raised by resp.read() AFTER urlopen has
    returned (ConnectionResetError, ssl.SSLError, socket.timeout,
    http.client.IncompleteRead) — are NOT urllib.error.URLError subclasses
    (urllib only wraps connect-phase OSErrors). A prior revision's narrow except
    tuple let them escape npm_view_json / fetch_text, crash main(), and empty
    stdout — which makes the workflow's requireMatch throw on a non-drift
    scheduled run. The helpers must swallow them to None so the grammar routes to
    the fetch_failed blocker bucket and the report still renders completely."""

    @staticmethod
    def _patch_urlopen(*, read_returns=None, read_raises=None):
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, *a, **k):
                if read_raises is not None:
                    raise read_raises
                return read_returns

        def _fake_urlopen(*a, **k):
            return _Resp()

        import urllib.request

        return mock.patch.object(urllib.request, "urlopen", side_effect=_fake_urlopen)

    def test_npm_view_json_swallows_read_phase_connection_reset(self):
        # ConnectionResetError is an OSError but NOT a URLError — the broadened
        # OSError clause must catch it so the helper returns None, not raises.
        with mock.patch.object(readiness, "OFFLINE", False), self._patch_urlopen(
            read_raises=ConnectionResetError("peer reset mid-body")
        ):
            self.assertIsNone(readiness.npm_view_json("tree-sitter-anything"))

    def test_fetch_text_swallows_read_phase_incomplete_read(self):
        # http.client.IncompleteRead is an HTTPException (not OSError), so it must
        # be named explicitly in the except tuple.
        with mock.patch.object(readiness, "OFFLINE", False), self._patch_urlopen(
            read_raises=http.client.IncompleteRead(partial=b"half")
        ):
            self.assertIsNone(readiness.fetch_text("https://example.com/parser.c"))

    def test_npm_view_json_still_swallows_bad_json(self):
        # JSONDecodeError is a ValueError, not an OSError — broadening the tuple
        # must not drop it. Non-JSON body still yields None.
        with mock.patch.object(readiness, "OFFLINE", False), self._patch_urlopen(
            read_returns=b"<<not json>>"
        ):
            self.assertIsNone(readiness.npm_view_json("tree-sitter-anything"))


class ReportRendering(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report, cls.code = _render_report()
        cls.rows = dict(_ROW_DIFF_RE.findall(cls.report))

    def test_no_bare_question_mark_anywhere(self):
        # The only legitimate '?' is the "Satisfies 0.25?" column header.
        sanitized = self.report.replace("Satisfies 0.25?", "Satisfies 0.25")
        self.assertNotIn("?", sanitized, "report still contains a bare '?' placeholder")

    def test_malformed_npm_version_renders_unknown_in_prose_not_bare_question(self):
        # A successful (200) npm /latest response that omits `version` leaves
        # npm_version == "?"; the grammar is still bucketed (fetch did not fail), so
        # its disposition PROSE line must show the labeled sentinel, never a bare '?'.
        def fake_npm(pkg: str):
            if pkg == "tree-sitter-go":
                return {"peerDependencies": {"tree-sitter": "^0.25.0"}}  # no 'version'
            return {"version": "9.9.9", "peerDependencies": {"tree-sitter": "^0.25.0"}}

        def fake_fetch(url: str, timeout: int = 8):
            if "parser.c" in url and "alex-pinkus" not in url:
                return "#define LANGUAGE_VERSION 14\n"
            if "/commits/" in url:
                return json.dumps({"sha": "0123456789abcdef"})
            return None

        buf = io.StringIO()
        with mock.patch.object(readiness, "npm_view_json", side_effect=fake_npm), \
             mock.patch.object(readiness, "fetch_text", side_effect=fake_fetch), \
             contextlib.redirect_stdout(buf):
            readiness.main()
        report = buf.getvalue()
        sanitized = report.replace("Satisfies 0.25?", "Satisfies 0.25")
        self.assertNotIn("?", sanitized)
        # The Ready bucket prose line for go shows the labeled 'unknown', not '?'.
        self.assertRegex(report, r"`tree-sitter-go`.*npm latest `unknown`")

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
        # swift's upstream parser.c is unreachable (mocked None), so its
        # upstream-ABI cell is the labeled 'n/a' token, never a bare '?'.
        cells = [c.strip() for c in self._matrix_row("tree-sitter-swift").strip().strip("|").split("|")]
        self.assertEqual(cells[6], "n/a")  # Upstream ABI column

    def test_row_diff_regex_captures_all_fifteen_grammar_statuses(self):
        # The change-detection bot keys on this regex: group 1 = grammar name,
        # group 2 = the Status cell ONLY (not the whole tail). It must match every
        # row after the format change so status transitions keep being detected.
        self.assertEqual(len(self.rows), 15)
        for name in readiness.VENDORED_NAMES:
            self.assertIn(name, self.rows)
        # group 2 is the Status cell — held c renders exactly "Vendored — held",
        # and no captured status contains a pipe (proves cell-scoped capture).
        self.assertEqual(self.rows["tree-sitter-c"], "Vendored — held")
        for status in self.rows.values():
            self.assertNotIn("|", status)

    def test_issue_update_summary_regex_matches_current_report(self):
        ready = _ISSUE_READY_RE.search(self.report)
        blockers = _ISSUE_BLOCKER_RE.search(self.report)
        self.assertIsNotNone(ready)
        self.assertIsNotNone(blockers)
        # Counts are derived from _render_report()'s mock corpus (all npm peer
        # deps mocked permissive): of the 10 npm-installed grammars, 9 render
        # Ready and 1 — tree-sitter-cpp — is the intentional pin (#1242), so it is
        # not counted ready. The 3 blockers are that same pinned tree-sitter-cpp
        # plus two held vendored grammars: ABI-held tree-sitter-c (#1242/#858) and
        # tree-sitter-kotlin (pinned to an unreleased fwcd main commit for `fun
        # interface` support — ABI 14 is in range, but a hold counts as a blocker
        # until it is lifted). If a grammar is added/removed or a pin/hold changes,
        # update _render_report()'s mock AND these expected counts together; a
        # mismatch here means the report prose drifted, not the regex.
        self.assertEqual(ready.groups(), ("9", "10"))
        self.assertEqual(blockers.group(1), "3")

    def _matrix_row(self, name: str) -> str:
        for line in self.report.splitlines():
            if line.startswith(f"| `{name}` |"):
                return line
        # Explicit terminating raise (not self.fail, which CodeQL doesn't model as
        # NoReturn) so the function has no implicit fall-through return (CodeQL 754).
        raise AssertionError(f"no matrix row for {name}")


class OfflineMode(TestCase):
    """--offline must render the report touching ZERO network — vendored ABIs come
    from the repo, npm columns are marked unverified. This is what makes the
    network-dependent report deterministically testable in air-gapped CI."""

    def _render_offline(self):
        import urllib.request

        def explode(*a, **k):
            raise AssertionError("network call attempted in --offline mode")

        buf = io.StringIO()
        with mock.patch.object(readiness, "OFFLINE", True), \
             mock.patch.object(urllib.request, "urlopen", side_effect=explode), \
             contextlib.redirect_stdout(buf):
            code = readiness.main()
        return buf.getvalue(), code

    def test_offline_touches_no_network_and_still_renders(self):
        report, code = self._render_offline()  # raises if any urlopen fires
        self.assertIn("Offline mode", report)
        # Vendored grammars are introspected from the repo → real ABI 14, not a miss.
        for name in readiness.VENDORED_NAMES:
            row = next(l for l in report.splitlines() if l.startswith(f"| `{name}` |"))
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            self.assertRegex(cells[5], r"^\d+$", f"{name} vendored ABI missing offline")

    def test_offline_marks_npm_grammars_offline_not_fetch_failed(self):
        report, _ = self._render_offline()
        self.assertIn("(offline)", report)
        self.assertNotIn("fetch failed", report)  # honest: skipped, not failed

    def test_offline_report_has_no_bare_question_mark(self):
        report, _ = self._render_offline()
        sanitized = report.replace("Satisfies 0.25?", "Satisfies 0.25")
        self.assertNotIn("?", sanitized)


class VendoredAbiBranches(TestCase):
    """main()'s vendored-ABI classification reads through vendored_abi_from_repo
    (the same local-read seam --assert-current uses), so a single patch drives the
    out-of-range and prebuilt-only branches that no real vendor dir can trigger
    today (all ship parser.c at ABI 14)."""

    def _render_with_vendored_abi(self, override):
        """Render main() with the standard production-faithful network mock plus a
        vendored_abi_from_repo override (dict: name -> int|None; others read real)."""
        real = readiness.vendored_abi_from_repo

        def abi_seam(name, parser_path):
            return override[name] if name in override else real(name, parser_path)

        def fake_npm(pkg):
            return {"version": "9.9.9", "peerDependencies": {"tree-sitter": "^0.25.0"}}

        def fake_fetch(url, timeout=8):
            if "parser.c" in url and "alex-pinkus" not in url:
                return "#define LANGUAGE_VERSION 14\n"
            if "/commits/" in url:
                return json.dumps({"sha": "0123456789abcdef"})
            return None

        buf = io.StringIO()
        with mock.patch.object(readiness, "vendored_abi_from_repo", side_effect=abi_seam), \
             mock.patch.object(readiness, "npm_view_json", side_effect=fake_npm), \
             mock.patch.object(readiness, "fetch_text", side_effect=fake_fetch), \
             contextlib.redirect_stdout(buf):
            code = readiness.main()
        return buf.getvalue(), code

    def _row(self, report, name):
        line = next(l for l in report.splitlines() if l.startswith(f"| `{name}` |"))
        return [c.strip() for c in line.strip().strip("|").split("|")]

    def test_out_of_range_vendored_abi_is_a_blocker(self):
        # Force tree-sitter-dart's vendored ABI outside the target range (13–15).
        report, code = self._render_with_vendored_abi({"tree-sitter-dart": 99})
        cells = self._row(report, "tree-sitter-dart")
        self.assertEqual(cells[-1], "Vendored (ABI out of range)")
        self.assertEqual(cells[5], "99")
        self.assertEqual(code, 1)  # out-of-range vendored grammar is a blocker

    def test_prebuilt_only_vendored_abi_renders_prebuilt_not_question(self):
        # vendored_abi None (a future binary-only vendor with no parser.c).
        report, _ = self._render_with_vendored_abi({"tree-sitter-dart": None})
        cells = self._row(report, "tree-sitter-dart")
        self.assertEqual(cells[5], "prebuilt")  # labeled, never a bare '?'
        self.assertEqual(cells[4], "Yes")  # prebuilt is assumed target-compatible


if __name__ == "__main__":
    main()
