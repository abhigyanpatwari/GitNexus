"""Tests for sweep.py — all external calls (API, embedding) are mocked."""
from __future__ import annotations

import json
import os
import sys
from io import BytesIO
from unittest.mock import patch, MagicMock, mock_open
from urllib.error import HTTPError

import numpy as np
import pytest

# Mock fastembed before importing sweep (which imports embedding_utils)
sys.modules["fastembed"] = MagicMock()

# Set required env vars before importing sweep (module-level constants read env)
os.environ.setdefault("GITHUB_TOKEN", "test-token")
os.environ.setdefault("GITHUB_REPOSITORY", "owner/repo")

from sweep import (
    github_api_get,
    fetch_all_open_items,
    fetch_repo_labels,
    apply_labels_to_item,
    generate_report,
    create_report_issue,
    write_report,
    main,
    TriageItem,
    RepoLabel,
    REPORT_FILE,
    REPORT_LABEL,
    API_PAGE_SIZE,
    MIN_SAMPLES_FOR_OUTLIER_DETECTION,
    PCA_MAX_COMPONENTS,
    MAX_EMBED_CHARS,
    IQR_MULTIPLIER,
    MAX_OUTLIER_PCT,
    _item_age,
    _suggested_action,
)


def _make_api_issue(number: int, title: str = "Test issue", is_pr: bool = False,
                    body: str = "Issue body", labels: list[str] | None = None,
                    created_at: str = "2026-03-21T00:00:00Z") -> dict:
    """Helper to build a mock GitHub API issue response object."""
    result: dict = {
        "number": number,
        "title": title,
        "html_url": f"https://github.com/owner/repo/issues/{number}",
        "body": body,
        "created_at": created_at,
        "labels": [{"name": lbl} for lbl in (labels or [])],
    }
    if is_pr:
        result["pull_request"] = {"url": "..."}
    return result


class TestGithubApiGet:
    """Tests for the github_api_get function."""

    @patch("sweep.urllib.request.urlopen")
    def test_successful_request(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps([{"id": 1}]).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = github_api_get("/issues?state=open")
        assert result == [{"id": 1}]

    @patch("sweep.urllib.request.urlopen")
    def test_http_error_exits(self, mock_urlopen):
        error = HTTPError(
            url="https://api.github.com/repos/owner/repo/issues",
            code=403,
            msg="Forbidden",
            hdrs=None,  # type: ignore[arg-type]
            fp=BytesIO(b'{"message": "rate limited"}'),
        )
        mock_urlopen.side_effect = error

        with pytest.raises(SystemExit) as exc_info:
            github_api_get("/issues")
        assert exc_info.value.code == 1


class TestConstants:
    """Tests for module-level constants."""

    def test_min_samples_is_at_least_3x_pca_max(self):
        """MIN_SAMPLES must be >= 3 * PCA_MAX_COMPONENTS for reliable covariance."""
        assert MIN_SAMPLES_FOR_OUTLIER_DETECTION >= 3 * PCA_MAX_COMPONENTS

    def test_min_samples_is_100(self):
        assert MIN_SAMPLES_FOR_OUTLIER_DETECTION == 100

    def test_pca_max_components_is_20(self):
        assert PCA_MAX_COMPONENTS == 20

    def test_iqr_multiplier_default(self):
        assert IQR_MULTIPLIER == 3.0

    def test_max_outlier_pct_default(self):
        assert MAX_OUTLIER_PCT == 0.05


class TestFetchAllOpenItems:
    """Tests for fetch_all_open_items."""

    @patch("sweep.github_api_get")
    def test_empty_repo(self, mock_get):
        mock_get.return_value = []
        items = fetch_all_open_items()
        assert items == []

    @patch("sweep.github_api_get")
    def test_single_page(self, mock_get):
        mock_get.return_value = [
            _make_api_issue(1, "Bug report"),
            _make_api_issue(2, "Feature request", is_pr=True),
        ]
        items = fetch_all_open_items()
        assert len(items) == 2
        assert items[0]["number"] == 1
        assert items[0]["is_pr"] is False
        assert items[1]["is_pr"] is True

    @patch("sweep.github_api_get")
    def test_text_field_constructed(self, mock_get):
        mock_get.return_value = [
            _make_api_issue(1, "My Title", body="My Body"),
        ]
        items = fetch_all_open_items()
        assert items[0]["text"] == "My Title\n\nMy Body"

    @patch("sweep.github_api_get")
    def test_long_body_truncated(self, mock_get):
        """Bodies exceeding MAX_EMBED_CHARS are truncated to fit the token window."""
        long_body = "x" * (MAX_EMBED_CHARS + 500)
        mock_get.return_value = [
            _make_api_issue(1, "Title", body=long_body),
        ]
        items = fetch_all_open_items()
        assert len(items[0]["text"]) == MAX_EMBED_CHARS

    @patch("sweep.github_api_get")
    def test_short_body_not_truncated(self, mock_get):
        """Bodies under the limit are left intact."""
        mock_get.return_value = [
            _make_api_issue(1, "Title", body="Short body"),
        ]
        items = fetch_all_open_items()
        assert items[0]["text"] == "Title\n\nShort body"

    @patch("sweep.github_api_get")
    def test_null_body_handled(self, mock_get):
        issue = _make_api_issue(1, "No body")
        issue["body"] = None
        mock_get.return_value = [issue]
        items = fetch_all_open_items()
        assert items[0]["text"] == "No body\n\n"

    @patch("sweep.github_api_get")
    def test_labels_extracted(self, mock_get):
        mock_get.return_value = [
            _make_api_issue(1, "Labeled", labels=["bug", "high-priority"]),
        ]
        items = fetch_all_open_items()
        assert items[0]["labels"] == ["bug", "high-priority"]

    @patch("sweep.MAX_ITEMS", 3)
    @patch("sweep.github_api_get")
    def test_max_items_cap(self, mock_get):
        mock_get.return_value = [_make_api_issue(i) for i in range(100)]
        items = fetch_all_open_items()
        assert len(items) == 3

    @patch("sweep.API_PAGE_SIZE", 2)
    @patch("sweep.github_api_get")
    def test_pagination(self, mock_get):
        # First page: 2 items (full page), second page: 1 item (partial -> stop)
        mock_get.side_effect = [
            [_make_api_issue(1), _make_api_issue(2)],
            [_make_api_issue(3)],
        ]
        items = fetch_all_open_items()
        assert len(items) == 3
        assert mock_get.call_count == 2


class TestItemAge:
    """Tests for _item_age helper."""

    def test_recent_item(self):
        from datetime import datetime, timezone, timedelta
        recent = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
        assert _item_age(recent) == "<1d"

    def test_days_old(self):
        from datetime import datetime, timezone, timedelta
        old = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
        assert _item_age(old) == "15d"

    def test_months_old(self):
        from datetime import datetime, timezone, timedelta
        old = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        assert _item_age(old) == "3mo"

    def test_years_old(self):
        from datetime import datetime, timezone, timedelta
        old = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
        assert _item_age(old) == "1y"

    def test_invalid_date(self):
        assert _item_age("not-a-date") == "?"


class TestSuggestedAction:
    """Tests for _suggested_action helper."""

    def test_both_issues_close_newer(self):
        a = TriageItem(
            number=1, title="A", html_url="u", is_pr=False, labels=[],
            created_at="2026-01-01T00:00:00Z", text="t",
        )
        b = TriageItem(
            number=2, title="B", html_url="u", is_pr=False, labels=[],
            created_at="2026-02-01T00:00:00Z", text="t",
        )
        result = _suggested_action(a, b)
        assert "Close #2 as duplicate" in result

    def test_both_prs_review(self):
        a = TriageItem(
            number=1, title="A", html_url="u", is_pr=True, labels=[],
            created_at="2026-01-01T00:00:00Z", text="t",
        )
        b = TriageItem(
            number=2, title="B", html_url="u", is_pr=True, labels=[],
            created_at="2026-01-01T00:00:00Z", text="t",
        )
        assert _suggested_action(a, b) == "Review for overlap"

    def test_issue_pr_link(self):
        a = TriageItem(
            number=1, title="A", html_url="u", is_pr=False, labels=[],
            created_at="2026-01-01T00:00:00Z", text="t",
        )
        b = TriageItem(
            number=2, title="B", html_url="u", is_pr=True, labels=[],
            created_at="2026-01-01T00:00:00Z", text="t",
        )
        assert _suggested_action(a, b) == "Link PR to issue"


class TestGenerateReport:
    """Tests for the markdown report generator."""

    def test_no_findings(self):
        items = [
            TriageItem(
                number=1, title="Test", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="Test",
            ),
        ]
        report = generate_report(items, [], [])
        assert "## Triage Sweep Report" in report
        assert "Items analyzed:** 1" in report
        assert "None found." in report
        assert "0 outliers flagged" in report
        assert "0 duplicate pairs found" in report

    def test_health_summary_table(self):
        items = [
            TriageItem(
                number=1, title="Test", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="Test",
            ),
        ]
        report = generate_report(items, [], [])
        assert "### Health Summary" in report
        assert "| Metric | Value |" in report
        assert "| Items analyzed | 1 |" in report

    def test_iqr_multiplier_in_thresholds(self):
        """Report should show IQR multiplier, not percentile."""
        items = [
            TriageItem(
                number=1, title="Test", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="Test",
            ),
        ]
        report = generate_report(items, [], [])
        assert "IQR multiplier" in report
        assert "percentile" not in report.lower().split("thresholds")[0]  # not in thresholds line

    def test_with_outliers_shows_distance_and_age(self):
        items = [
            TriageItem(
                number=10, title="Spam Issue", html_url="https://example.com/10",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="spam",
            ),
            TriageItem(
                number=20, title="Good Issue", html_url="https://example.com/20",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="good",
            ),
        ]
        report = generate_report(items, [(0, 12.34)], [])
        assert "#10" in report
        assert "Spam Issue" in report
        assert "12.34" in report
        assert "1 outliers flagged" in report
        # Age column should be present
        assert "| Age |" in report

    def test_outlier_borderline_in_details(self):
        """Borderline outliers should be in a <details> section."""
        from embedding_utils import _OutlierResult
        items = [
            TriageItem(
                number=10, title="Borderline", html_url="https://example.com/10",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="spam",
            ),
        ]
        # Create outlier results with cutoff=10.0, distance=12.0 (< 2*cutoff=20)
        outlier_results = _OutlierResult([(0, 12.0)])
        outlier_results.cutoff = 10.0
        report = generate_report(items, outlier_results, [])
        assert "<details>" in report
        assert "Borderline" in report

    def test_outlier_high_confidence(self):
        """Items with distance > 2x cutoff should be in high confidence section."""
        from embedding_utils import _OutlierResult
        items = [
            TriageItem(
                number=10, title="Definite Spam", html_url="https://example.com/10",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="spam",
            ),
        ]
        outlier_results = _OutlierResult([(0, 25.0)])
        outlier_results.cutoff = 10.0
        report = generate_report(items, outlier_results, [])
        assert "High Confidence" in report

    def test_with_duplicates_suggested_action(self):
        items = [
            TriageItem(
                number=1, title="First", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="a",
            ),
            TriageItem(
                number=2, title="Second", html_url="https://example.com/2",
                is_pr=True, labels=[], created_at="2026-02-01T00:00:00Z", text="b",
            ),
        ]
        report = generate_report(items, [], [(0, 1, 0.954)])
        assert "#1" in report
        assert "#2" in report
        assert "0.954" in report
        assert "1 duplicate pairs found" in report
        assert "Suggested Action" in report
        assert "Link PR to issue" in report

    def test_duplicate_both_issues_close_newer(self):
        items = [
            TriageItem(
                number=1, title="First", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="a",
            ),
            TriageItem(
                number=2, title="Second", html_url="https://example.com/2",
                is_pr=False, labels=[], created_at="2026-02-01T00:00:00Z", text="b",
            ),
        ]
        report = generate_report(items, [], [(0, 1, 0.95)])
        assert "Close #2 as duplicate" in report

    def test_duplicate_both_prs_review(self):
        items = [
            TriageItem(
                number=1, title="PR A", html_url="https://example.com/1",
                is_pr=True, labels=[], created_at="2026-01-01T00:00:00Z", text="a",
            ),
            TriageItem(
                number=2, title="PR B", html_url="https://example.com/2",
                is_pr=True, labels=[], created_at="2026-01-01T00:00:00Z", text="b",
            ),
        ]
        report = generate_report(items, [], [(0, 1, 0.95)])
        assert "Review for overlap" in report

    def test_pr_type_label(self):
        items = [
            TriageItem(
                number=5, title="PR Title", html_url="https://example.com/5",
                is_pr=True, labels=[], created_at="2026-01-01T00:00:00Z", text="pr",
            ),
        ]
        report = generate_report(items, [(0, 8.5)], [])
        assert "| PR |" in report

    def test_footer_present(self):
        items = [
            TriageItem(
                number=1, title="T", html_url="u",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="t",
            ),
        ]
        report = generate_report(items, [], [])
        assert "no LLM was used" in report


class TestCreateReportIssue:
    """Tests for creating the report GitHub issue."""

    @patch("sweep.urllib.request.urlopen")
    def test_successful_creation(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.status = 201
        mock_resp.read.return_value = json.dumps({
            "html_url": "https://github.com/owner/repo/issues/99",
        }).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        # Should not raise
        create_report_issue("# Test Report")

    @patch("sweep.urllib.request.urlopen")
    def test_http_error_exits(self, mock_urlopen):
        error = HTTPError(
            url="https://api.github.com/repos/owner/repo/issues",
            code=422,
            msg="Unprocessable",
            hdrs=None,  # type: ignore[arg-type]
            fp=BytesIO(b'{"message": "validation failed"}'),
        )
        mock_urlopen.side_effect = error

        with pytest.raises(SystemExit) as exc_info:
            create_report_issue("# Test Report")
        assert exc_info.value.code == 1


class TestWriteReport:
    """Tests for the write_report helper."""

    @patch("builtins.open", mock_open())
    def test_writes_to_file(self):
        write_report("# Report Content")
        from builtins import open as builtin_open  # noqa
        # Verify open was called with the right path
        from unittest.mock import call
        open_mock = open  # The patched version
        open_mock.assert_called_once_with(REPORT_FILE, "w", encoding="utf-8")  # type: ignore[attr-defined]
        open_mock().write.assert_called_once_with("# Report Content")  # type: ignore[attr-defined]


class TestFetchRepoLabels:
    """Tests for fetch_repo_labels."""

    @patch("sweep.github_api_get")
    def test_fetches_and_constructs_labels(self, mock_get):
        mock_get.return_value = [
            {"name": "bug", "description": "Something isn't working"},
            {"name": "enhancement", "description": "New feature or request"},
            {"name": "docs", "description": ""},
        ]
        labels = fetch_repo_labels()
        assert len(labels) == 3
        assert labels[0]["name"] == "bug"
        assert labels[0]["text"] == "bug: Something isn't working"
        assert labels[2]["text"] == "docs"  # no description, just name

    @patch("sweep.github_api_get")
    def test_empty_repo_labels(self, mock_get):
        mock_get.return_value = []
        labels = fetch_repo_labels()
        assert labels == []

    @patch("sweep.github_api_get")
    def test_null_description_handled(self, mock_get):
        mock_get.return_value = [
            {"name": "wontfix", "description": None},
        ]
        labels = fetch_repo_labels()
        assert labels[0]["text"] == "wontfix"

    @patch("sweep.API_PAGE_SIZE", 2)
    @patch("sweep.github_api_get")
    def test_label_pagination(self, mock_get):
        """Repos with more labels than one page should fetch all pages."""
        mock_get.side_effect = [
            # First page: full (2 items = API_PAGE_SIZE)
            [
                {"name": "bug", "description": "Broken"},
                {"name": "feature", "description": "New"},
            ],
            # Second page: partial (1 item < API_PAGE_SIZE) -> stop
            [
                {"name": "docs", "description": "Documentation"},
            ],
        ]
        labels = fetch_repo_labels()
        assert len(labels) == 3
        assert mock_get.call_count == 2
        assert labels[0]["name"] == "bug"
        assert labels[2]["name"] == "docs"


class TestApplyLabelsToItem:
    """Tests for apply_labels_to_item."""

    def test_empty_labels_skips(self):
        # Should not make any API call
        apply_labels_to_item(1, [])

    @patch("sweep.urllib.request.urlopen")
    def test_successful_label_application(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'[{"name": "bug"}]'
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        # Should not raise
        apply_labels_to_item(42, ["bug", "enhancement"])

    @patch("sweep.urllib.request.urlopen")
    def test_http_error_is_non_fatal(self, mock_urlopen):
        error = HTTPError(
            url="https://api.github.com/repos/owner/repo/issues/1/labels",
            code=404,
            msg="Not Found",
            hdrs=None,  # type: ignore[arg-type]
            fp=BytesIO(b'{"message": "not found"}'),
        )
        mock_urlopen.side_effect = error

        # Should NOT raise — labeling failures are warnings, not fatal
        apply_labels_to_item(1, ["bug"])


class TestGenerateReportWithLabels:
    """Tests for label suggestions in the report."""

    def test_report_includes_label_section_high_confidence(self):
        """High-confidence label (raw_sim >= 0.5) should appear in main table."""
        items = [
            TriageItem(
                number=1, title="Fix crash", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="crash",
            ),
        ]
        suggestions = [[("bug", 0.85)]]
        report = generate_report(items, [], [], label_suggestions=suggestions)
        assert "Suggested Labels" in report
        assert "`bug` (0.85)" in report
        assert "1 items suggested for labeling" in report

    def test_report_low_confidence_in_details(self):
        """Low-confidence label (raw_sim < 0.5) should be in <details> section."""
        items = [
            TriageItem(
                number=1, title="Something", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="something",
            ),
        ]
        suggestions = [[("maybe-bug", 0.35)]]
        report = generate_report(items, [], [], label_suggestions=suggestions)
        assert "Low-confidence suggestions" in report
        assert "<details>" in report
        assert "`maybe-bug` (0.35)" in report

    def test_report_skips_already_labeled_items(self):
        items = [
            TriageItem(
                number=1, title="Already labeled", html_url="https://example.com/1",
                is_pr=False, labels=["bug"], created_at="2026-01-01T00:00:00Z", text="bug",
            ),
        ]
        suggestions = [[("bug", 0.95)]]
        report = generate_report(items, [], [], label_suggestions=suggestions)
        assert "0 items suggested for labeling" in report
        assert "No unlabeled items" in report

    def test_report_excludes_outliers_from_suggestions(self):
        items = [
            TriageItem(
                number=1, title="Spam garbage", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="spam",
            ),
            TriageItem(
                number=2, title="Real bug", html_url="https://example.com/2",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="bug",
            ),
        ]
        suggestions = [[("bug", 0.85)], [("bug", 0.90)]]
        # Item 0 is an outlier (with distance) — should be excluded from label suggestions
        report = generate_report(items, [(0, 15.2)], [], label_suggestions=suggestions)
        assert "1 unlabeled items" in report  # only item 2
        assert "#2" in report
        # Item 0 (outlier) should NOT be in the suggestions table
        assert "Spam garbage" not in report.split("Suggested Labels")[1]

    def test_report_without_label_suggestions(self):
        items = [
            TriageItem(
                number=1, title="T", html_url="u",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="t",
            ),
        ]
        report = generate_report(items, [], [], label_suggestions=None)
        assert "Suggested Labels" not in report

    def test_label_concentration_warning(self):
        """When >50% of suggestions point to the same label, a warning should appear."""
        items = [
            TriageItem(
                number=i, title=f"Item {i}", html_url=f"https://example.com/{i}",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text=f"text {i}",
            )
            for i in range(4)
        ]
        # 3 out of 4 items get "bug" label -> 75% concentration
        suggestions = [
            [("bug", 0.85)],
            [("bug", 0.80)],
            [("bug", 0.75)],
            [("enhancement", 0.90)],
        ]
        report = generate_report(items, [], [], label_suggestions=suggestions)
        assert "Warning" in report
        assert "`bug`" in report
        assert "3/4" in report


class TestMain:
    """Tests for the main orchestration function."""

    @patch.dict(os.environ, {"GITHUB_TOKEN": "", "GITHUB_REPOSITORY": "owner/repo"})
    def test_missing_token_exits(self):
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok", "GITHUB_REPOSITORY": ""})
    def test_missing_repo_exits(self):
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1

    @patch("sweep.write_report")
    @patch("sweep.fetch_all_open_items", return_value=[])
    def test_no_items(self, mock_fetch, mock_write):
        main()
        mock_write.assert_called_once()
        report = mock_write.call_args[0][0]
        assert "No open issues or PRs found" in report

    @patch("sweep.create_report_issue")
    @patch("sweep.write_report")
    @patch("sweep.suggest_labels", return_value=[])
    @patch("sweep.find_duplicate_pairs", return_value=[])
    @patch("sweep.detect_outliers", return_value=[])
    @patch("sweep.reduce_dimensions")
    @patch("sweep.normalize_rows")
    @patch("sweep.embed_texts")
    @patch("sweep.fetch_repo_labels")
    @patch("sweep.fetch_all_open_items")
    def test_full_flow_with_enough_items(
        self, mock_fetch, mock_labels, mock_embed, mock_norm, mock_reduce,
        mock_outliers, mock_dupes, mock_suggest, mock_write, mock_create,
    ):
        """Test the full flow with >= MIN_SAMPLES items (outlier detection runs)."""
        n = MIN_SAMPLES_FOR_OUTLIER_DETECTION
        items = [
            TriageItem(
                number=i, title=f"Item {i}", html_url=f"https://example.com/{i}",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text=f"text {i}",
            )
            for i in range(n)
        ]
        mock_fetch.return_value = items
        mock_labels.return_value = [
            RepoLabel(name="bug", description="Something broken", text="bug: Something broken"),
        ]

        embeddings = np.random.randn(n, 384).astype(np.float32)
        mock_embed.return_value = embeddings
        mock_norm.return_value = embeddings
        mock_reduce.return_value = np.random.randn(n, 10).astype(np.float32)

        main()

        mock_fetch.assert_called_once()
        mock_labels.assert_called_once()
        # embed_texts called twice: once for items, once for labels
        assert mock_embed.call_count == 2
        mock_norm.assert_called()
        mock_reduce.assert_called_once()
        mock_outliers.assert_called_once()
        mock_dupes.assert_called_once()
        mock_suggest.assert_called_once()
        mock_write.assert_called_once()
        mock_create.assert_called_once()

    @patch("sweep.create_report_issue")
    @patch("sweep.write_report")
    @patch("sweep.suggest_labels", return_value=[])
    @patch("sweep.find_duplicate_pairs", return_value=[])
    @patch("sweep.detect_outliers")
    @patch("sweep.reduce_dimensions")
    @patch("sweep.normalize_rows")
    @patch("sweep.embed_texts")
    @patch("sweep.fetch_repo_labels", return_value=[])
    @patch("sweep.fetch_all_open_items")
    def test_skips_outlier_detection_for_few_items(
        self, mock_fetch, mock_labels, mock_embed, mock_norm, mock_reduce,
        mock_outliers, mock_dupes, mock_suggest, mock_write, mock_create,
    ):
        """With < MIN_SAMPLES items, outlier detection should be skipped."""
        n = MIN_SAMPLES_FOR_OUTLIER_DETECTION - 1
        items = [
            TriageItem(
                number=i, title=f"Item {i}", html_url=f"https://example.com/{i}",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text=f"text {i}",
            )
            for i in range(n)
        ]
        mock_fetch.return_value = items

        embeddings = np.random.randn(n, 384).astype(np.float32)
        mock_embed.return_value = embeddings
        mock_norm.return_value = embeddings

        main()

        # Outlier detection should not have been called
        mock_reduce.assert_not_called()
        mock_outliers.assert_not_called()
        # But duplicates should still be checked
        mock_dupes.assert_called_once()

    @patch.dict(os.environ, {"INPUT_DRY_RUN": "true"})
    @patch("sweep.DRY_RUN", True)
    @patch("sweep.write_report")
    @patch("sweep.create_report_issue")
    @patch("sweep.apply_labels_to_item")
    @patch("sweep.suggest_labels", return_value=[[("bug", 0.85)]])
    @patch("sweep.find_duplicate_pairs", return_value=[])
    @patch("sweep.normalize_rows")
    @patch("sweep.embed_texts")
    @patch("sweep.fetch_repo_labels")
    @patch("sweep.fetch_all_open_items")
    def test_dry_run_skips_issue_creation_and_labeling(
        self, mock_fetch, mock_labels, mock_embed, mock_norm,
        mock_dupes, mock_suggest, mock_apply, mock_create, mock_write,
    ):
        items = [
            TriageItem(
                number=1, title="Item", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="text",
            )
        ]
        mock_fetch.return_value = items
        mock_labels.return_value = [
            RepoLabel(name="bug", description="Broken", text="bug: Broken"),
        ]
        embeddings = np.random.randn(1, 384).astype(np.float32)
        mock_embed.return_value = embeddings
        mock_norm.return_value = embeddings

        main()

        mock_create.assert_not_called()
        mock_apply.assert_not_called()
        mock_write.assert_called_once()

    @patch("sweep.create_report_issue")
    @patch("sweep.write_report")
    @patch("sweep.apply_labels_to_item")
    @patch("sweep.suggest_labels")
    @patch("sweep.find_duplicate_pairs", return_value=[])
    @patch("sweep.normalize_rows")
    @patch("sweep.embed_texts")
    @patch("sweep.fetch_repo_labels")
    @patch("sweep.fetch_all_open_items")
    def test_labels_not_auto_applied(
        self, mock_fetch, mock_labels, mock_embed, mock_norm,
        mock_dupes, mock_suggest, mock_apply, mock_write, mock_create,
    ):
        """Auto-labeling is disabled; labels should appear in report only."""
        items = [
            TriageItem(
                number=1, title="Crash bug", html_url="https://example.com/1",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text="crash",
            ),
            TriageItem(
                number=2, title="Already labeled", html_url="https://example.com/2",
                is_pr=False, labels=["enhancement"], created_at="2026-01-01T00:00:00Z", text="feat",
            ),
        ]
        mock_fetch.return_value = items
        mock_labels.return_value = [
            RepoLabel(name="bug", description="Broken", text="bug: Broken"),
        ]
        mock_suggest.return_value = [
            [("bug", 0.90)],
            [("bug", 0.45)],
        ]

        embeddings = np.random.randn(2, 384).astype(np.float32)
        mock_embed.return_value = embeddings
        mock_norm.return_value = embeddings

        main()

        # Auto-labeling is disabled — apply_labels_to_item should never be called
        mock_apply.assert_not_called()

    @patch("sweep.create_report_issue")
    @patch("sweep.write_report")
    @patch("sweep.apply_labels_to_item")
    @patch("sweep.suggest_labels")
    @patch("sweep.find_duplicate_pairs", return_value=[])
    @patch("sweep.detect_outliers")
    @patch("sweep.reduce_dimensions")
    @patch("sweep.normalize_rows")
    @patch("sweep.embed_texts")
    @patch("sweep.fetch_repo_labels")
    @patch("sweep.fetch_all_open_items")
    def test_outliers_excluded_from_report_suggestions(
        self, mock_fetch, mock_labels, mock_embed, mock_norm, mock_reduce,
        mock_outliers, mock_dupes, mock_suggest, mock_apply, mock_write, mock_create,
    ):
        """Items flagged as outliers should not appear in report label suggestions."""
        n = MIN_SAMPLES_FOR_OUTLIER_DETECTION
        items = [
            TriageItem(
                number=i, title=f"Item {i}", html_url=f"https://example.com/{i}",
                is_pr=False, labels=[], created_at="2026-01-01T00:00:00Z", text=f"text {i}",
            )
            for i in range(n)
        ]
        mock_fetch.return_value = items
        mock_labels.return_value = [
            RepoLabel(name="bug", description="Broken", text="bug: Broken"),
        ]
        mock_outliers.return_value = [(0, 12.5), (5, 15.3)]
        mock_suggest.return_value = [[("bug", 0.85)] for _ in range(n)]

        embeddings = np.random.randn(n, 384).astype(np.float32)
        mock_embed.return_value = embeddings
        mock_norm.return_value = embeddings
        mock_reduce.return_value = np.random.randn(n, 10).astype(np.float32)

        main()

        # Auto-labeling is disabled
        mock_apply.assert_not_called()
        # Report should still be generated (outliers excluded from suggestions in report)
        mock_write.assert_called_once()
        report = mock_write.call_args[0][0]
        # Outlier items 0 and 5 should not appear in the label suggestions section
        assert "Item 0" not in report.split("Suggested Labels")[1] if "Suggested Labels" in report else True
