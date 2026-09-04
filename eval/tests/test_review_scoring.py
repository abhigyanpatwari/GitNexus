import json
from pathlib import Path

import pytest

from workflow_bench.oracle_assets import OracleFileSnapshot, TaskOracleSnapshot
from workflow_bench.review_scoring import (
    ExpectedFinding,
    ReviewFinding,
    expected_findings,
    parse_review_output,
    score_review,
)


def finding(**overrides):
    values = {
        "id": "actual-1",
        "severity": "high",
        "path": "src/api.ts",
        "line": 20,
        "end_line": 24,
        "category": "correctness",
        "scenario": "A missing guard lets an invalid request reach the sink.",
        "evidence": "The changed call at line 20 bypasses validate().",
        "recommendation": "Restore validation before the call.",
        "blocking": True,
    }
    values.update(overrides)
    return values


def expected(**overrides):
    values = {
        "finding_id": "expected-1",
        "severity": "high",
        "path": "src/api.ts",
        "line_start": 18,
        "line_end": 22,
        "category": "correctness",
    }
    values.update(overrides)
    return ExpectedFinding(**values)


def test_parse_review_output_requires_the_strict_schema(tmp_path: Path):
    output = tmp_path / "review-output.json"
    output.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "verdict": "request_changes",
                "findings": [finding()],
            }
        )
    )

    verdict, findings = parse_review_output(output)

    assert verdict == "request_changes"
    assert findings[0].path == "src/api.ts"
    assert findings[0].blocking is True


@pytest.mark.parametrize(
    "document, message",
    [
        ({"schema_version": 1, "verdict": "approve", "findings": [finding()]}, "approve"),
        (
            {
                "schema_version": 1,
                "verdict": "request_changes",
                "findings": [finding(blocking=False)],
            },
            "blocking",
        ),
        (
            {
                "schema_version": 1,
                "verdict": "comment",
                "findings": [finding(path="../escape.ts")],
            },
            "repository-relative",
        ),
    ],
)
def test_parse_review_output_rejects_incoherent_or_unsafe_documents(tmp_path: Path, document, message):
    output = tmp_path / "review-output.json"
    output.write_text(json.dumps(document))
    with pytest.raises(ValueError, match=message):
        parse_review_output(output)


def test_expected_findings_are_loaded_from_hidden_snapshot_only():
    payload = json.dumps(
        {
            "schema_version": 1,
            "findings": [
                {
                    "id": "hidden-1",
                    "severity": "critical",
                    "path": "src/auth.ts",
                    "line_start": 40,
                    "line_end": 44,
                    "category": "security",
                }
            ],
        }
    ).encode()
    snapshot = TaskOracleSnapshot(
        command="true",
        command_digest="command",
        manifest_digest="manifest",
        digest="all",
        files=(
            OracleFileSnapshot(
                target="review-labels.json",
                payload=payload,
                sha256="payload",
            ),
        ),
    )

    assert expected_findings(snapshot)[0].finding_id == "hidden-1"


def test_score_review_matches_by_path_and_overlapping_range():
    actual = (
        ReviewFinding(
            finding_id="actual-1",
            severity="high",
            path="src/api.ts",
            line=20,
            end_line=24,
            category="correctness",
            scenario="scenario",
            evidence="evidence",
            recommendation="fix",
            blocking=True,
        ),
        ReviewFinding(
            finding_id="noise",
            severity="low",
            path="src/other.ts",
            line=1,
            end_line=1,
            category="style",
            scenario="noise",
            evidence="noise",
            recommendation="noise",
            blocking=False,
        ),
    )

    score = score_review("request_changes", actual, (expected(),))

    assert score["true_positives"] == 1
    assert score["false_positives"] == 1
    assert score["false_negatives"] == 0
    assert score["recall"] == 1
    assert score["precision"] == 0.5
    assert score["blocker_recall"] == 1
    assert score["verdict_correct"] is True


def test_score_review_is_independent_of_finding_list_order():
    expected_labels = (
        expected(finding_id="broad", line_start=1, line_end=10, category="a"),
        expected(finding_id="tight", line_start=5, line_end=5, category="b"),
    )
    first = ReviewFinding(
        finding_id="a",
        severity="high",
        path="src/api.ts",
        line=5,
        end_line=5,
        category="a",
        scenario="s",
        evidence="e",
        recommendation="r",
        blocking=True,
    )
    second = ReviewFinding(
        finding_id="b",
        severity="high",
        path="src/api.ts",
        line=1,
        end_line=1,
        category="b",
        scenario="s",
        evidence="e",
        recommendation="r",
        blocking=True,
    )
    forward = score_review("request_changes", (first, second), expected_labels)
    reverse = score_review("request_changes", (second, first), expected_labels)
    assert forward["true_positives"] == reverse["true_positives"]
    assert forward["false_positives"] == reverse["false_positives"]
    assert forward["false_negatives"] == reverse["false_negatives"]
    assert forward["weighted_f1"] == reverse["weighted_f1"]


def test_score_review_prefers_maximum_cardinality_over_greedy_category_match():
    expected_labels = (
        expected(finding_id="broad", line_start=1, line_end=10, category="a"),
        expected(finding_id="tight", line_start=1, line_end=1, category="b"),
    )
    actual = (
        ReviewFinding(
            finding_id="actual-1",
            severity="high",
            path="src/api.ts",
            line=1,
            end_line=1,
            category="a",
            scenario="s",
            evidence="e",
            recommendation="r",
            blocking=True,
        ),
        ReviewFinding(
            finding_id="actual-2",
            severity="high",
            path="src/api.ts",
            line=10,
            end_line=10,
            category="b",
            scenario="s",
            evidence="e",
            recommendation="r",
            blocking=True,
        ),
    )

    score = score_review("request_changes", actual, expected_labels)

    assert score["true_positives"] == 2
    assert score["false_positives"] == 0
    assert score["false_negatives"] == 0


def test_clean_control_rewards_an_empty_approval_and_penalizes_noise():
    clean = score_review("approve", (), ())
    noisy = score_review(
        "comment",
        (
            ReviewFinding(
                finding_id="noise",
                severity="medium",
                path="src/ok.ts",
                line=1,
                end_line=1,
                category="correctness",
                scenario="noise",
                evidence="noise",
                recommendation="noise",
                blocking=False,
            ),
        ),
        (),
    )

    assert clean["weighted_f1"] is None
    assert clean["precision"] is None
    assert clean["recall"] is None
    assert clean["clean_pass"] is True
    assert clean["verdict_correct"] is True
    assert noisy["false_positives"] == 1
    assert noisy["weighted_precision"] == 0
    assert noisy["recall"] is None
    assert noisy["clean_pass"] is False
    assert noisy["verdict_correct"] is False
