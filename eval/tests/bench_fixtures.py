"""Shared row shapes for the sweep tests.

Building the finalization tests turned up what a real scored review row must
carry: the report renders the whole review metric set, so an incomplete row
fails in string formatting rather than in the logic under test. That is a
property of the fixture, not of production - the shape lives here once so each
test does not rediscover it.
"""

from __future__ import annotations

from typing import Any


def scored_review_row(**overrides: Any) -> dict[str, Any]:
    """One admissible review cell, with zero-valued metrics written out."""

    row: dict[str, Any] = {
        "ok": True,
        "error_kind": None,
        "error_detail": None,
        "resolved": True,
        "review_evidence_valid": True,
        "review_score": {"weighted_f1": 0.5},
        "review_weighted_f1": 0.5,
        "review_true_positives": 1,
        "review_false_positives": 0,
        "review_false_negatives": 0,
        "review_precision": 0.5,
        "review_recall": 0.5,
        "review_f1": 0.5,
        "review_weighted_precision": 0.5,
        "review_weighted_recall": 0.5,
        "review_blocker_recall": 1.0,
        "review_severity_accuracy": 1.0,
        "review_category_accuracy": 1.0,
        "review_grounded_evidence": 1.0,
        "review_verdict_correct": True,
        "review_clean_control": True,
        "review_clean_pass": True,
        "transcript_missing": False,
        "transcript_artifacts": [],
        "num_turns": 3,
        "duration_s": 1.0,
        "cost_usd": 0.5,
        "input_tokens": 1,
        "output_tokens": 1,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "diff_files": 0,
        "diff_insertions": 0,
        "diff_deletions": 0,
    }
    row.update(overrides)
    return row


def unusable_review_row(**overrides: Any) -> dict[str, Any]:
    """A cell that ran but produced evidence nothing can be scored from."""

    # Merged into one mapping rather than passed as explicit keywords beside
    # **overrides: Python rejects a duplicate keyword in the call expression
    # itself, so unusable_review_row(error_kind=...) raised TypeError before
    # scored_review_row could apply the override this helper advertises.
    return scored_review_row(
        **{
            "ok": False,
            "resolved": False,
            "review_evidence_valid": False,
            "error_kind": "review-evidence-invalid",
            "review_score": None,
            "review_weighted_f1": None,
            **overrides,
        }
    )
