"""Strict review artifacts and deterministic hidden-label scoring."""

from __future__ import annotations

import json
import math
import posixpath
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .oracle_assets import TaskOracleSnapshot

REVIEW_OUTPUT = "review-output.json"
REVIEW_SCHEMA_VERSION = 1
MAX_REVIEW_BYTES = 256 * 1024
MAX_FINDINGS = 100
SEVERITIES = ("critical", "high", "medium", "low")
BLOCKING_SEVERITIES = frozenset({"critical", "high"})
SEVERITY_WEIGHT = {"critical": 8.0, "high": 5.0, "medium": 2.0, "low": 1.0}


@dataclass(frozen=True)
class ReviewFinding:
    finding_id: str
    severity: str
    path: str
    line: int
    end_line: int
    category: str
    scenario: str
    evidence: str
    recommendation: str
    blocking: bool


@dataclass(frozen=True)
class ExpectedFinding:
    finding_id: str
    severity: str
    path: str
    line_start: int
    line_end: int
    category: str


def _nonblank(value: Any, label: str, *, limit: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonblank string")
    text = value.strip()
    if len(text.encode()) > limit:
        raise ValueError(f"{label} exceeds {limit} bytes")
    return text


def _relative_path(value: Any, label: str) -> str:
    path = _nonblank(value, label, limit=512).replace("\\", "/")
    normalized = posixpath.normpath(path)
    if normalized.startswith("/") or normalized in {".", ".."} or normalized.startswith("../"):
        raise ValueError(f"{label} must be a repository-relative path")
    return normalized


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _severity(value: Any, label: str) -> str:
    severity = _nonblank(value, label, limit=16).casefold()
    if severity not in SEVERITIES:
        raise ValueError(f"{label} must be one of {', '.join(SEVERITIES)}")
    return severity


def _parse_review_finding(raw: Any, index: int) -> ReviewFinding:
    if not isinstance(raw, Mapping):
        raise ValueError(f"findings[{index}] must be an object")
    required = {
        "id",
        "severity",
        "path",
        "line",
        "end_line",
        "category",
        "scenario",
        "evidence",
        "recommendation",
        "blocking",
    }
    if set(raw) != required:
        raise ValueError(f"findings[{index}] requires exactly {sorted(required)}")
    line = _positive_int(raw["line"], f"findings[{index}].line")
    end_line = _positive_int(raw["end_line"], f"findings[{index}].end_line")
    if end_line < line:
        raise ValueError(f"findings[{index}].end_line precedes line")
    if not isinstance(raw["blocking"], bool):
        raise ValueError(f"findings[{index}].blocking must be boolean")
    return ReviewFinding(
        finding_id=_nonblank(raw["id"], f"findings[{index}].id", limit=128),
        severity=_severity(raw["severity"], f"findings[{index}].severity"),
        path=_relative_path(raw["path"], f"findings[{index}].path"),
        line=line,
        end_line=end_line,
        category=_nonblank(raw["category"], f"findings[{index}].category", limit=128).casefold(),
        scenario=_nonblank(raw["scenario"], f"findings[{index}].scenario"),
        evidence=_nonblank(raw["evidence"], f"findings[{index}].evidence"),
        recommendation=_nonblank(raw["recommendation"], f"findings[{index}].recommendation"),
        blocking=raw["blocking"],
    )


def parse_review_output(path: Path) -> tuple[str, tuple[ReviewFinding, ...]]:
    metadata = path.lstat()
    if path.is_symlink() or not path.is_file() or metadata.st_size > MAX_REVIEW_BYTES:
        raise ValueError("review output must be a bounded regular non-symlink file")
    try:
        raw = json.loads(path.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("review output is not valid UTF-8 JSON") from exc
    if not isinstance(raw, Mapping) or set(raw) != {"schema_version", "verdict", "findings"}:
        raise ValueError("review output requires exactly schema_version, verdict, and findings")
    if raw["schema_version"] != REVIEW_SCHEMA_VERSION:
        raise ValueError(f"review output schema_version must be {REVIEW_SCHEMA_VERSION}")
    verdict = _nonblank(raw["verdict"], "verdict", limit=32).casefold()
    if verdict not in {"approve", "comment", "request_changes"}:
        raise ValueError("verdict must be approve, comment, or request_changes")
    findings_raw = raw["findings"]
    if not isinstance(findings_raw, list) or len(findings_raw) > MAX_FINDINGS:
        raise ValueError(f"findings must be a list of at most {MAX_FINDINGS} items")
    findings = tuple(_parse_review_finding(item, index) for index, item in enumerate(findings_raw))
    ids = [item.finding_id for item in findings]
    if len(set(ids)) != len(ids):
        raise ValueError("review finding ids must be unique")
    if verdict == "approve" and findings:
        raise ValueError("approve verdict cannot contain findings")
    if verdict == "request_changes" and not any(item.blocking for item in findings):
        raise ValueError("request_changes requires at least one blocking finding")
    return verdict, findings


def expected_findings(snapshot: TaskOracleSnapshot) -> tuple[ExpectedFinding, ...]:
    matches = [item for item in snapshot.files if item.target == "review-labels.json"]
    if len(matches) != 1:
        raise ValueError("review task oracle requires exactly one review-labels.json")
    try:
        raw = json.loads(matches[0].payload)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("hidden review labels are malformed") from exc
    if not isinstance(raw, Mapping) or set(raw) != {"schema_version", "findings"}:
        raise ValueError("hidden review labels require schema_version and findings")
    if raw["schema_version"] != REVIEW_SCHEMA_VERSION or not isinstance(raw["findings"], list):
        raise ValueError("hidden review labels have an unsupported schema")
    labels: list[ExpectedFinding] = []
    for index, item in enumerate(raw["findings"]):
        if not isinstance(item, Mapping):
            raise ValueError(f"hidden findings[{index}] must be an object")
        required = {"id", "severity", "path", "line_start", "line_end", "category"}
        if set(item) != required:
            raise ValueError(f"hidden findings[{index}] requires exactly {sorted(required)}")
        start = _positive_int(item["line_start"], f"hidden findings[{index}].line_start")
        end = _positive_int(item["line_end"], f"hidden findings[{index}].line_end")
        if end < start:
            raise ValueError(f"hidden findings[{index}] has an inverted range")
        labels.append(
            ExpectedFinding(
                finding_id=_nonblank(item["id"], f"hidden findings[{index}].id", limit=128),
                severity=_severity(item["severity"], f"hidden findings[{index}].severity"),
                path=_relative_path(item["path"], f"hidden findings[{index}].path"),
                line_start=start,
                line_end=end,
                category=_nonblank(item["category"], f"hidden findings[{index}].category", limit=128).casefold(),
            )
        )
    if len({item.finding_id for item in labels}) != len(labels):
        raise ValueError("hidden review finding ids must be unique")
    return tuple(labels)


def _overlaps(actual: ReviewFinding, expected: ExpectedFinding) -> bool:
    return actual.line <= expected.line_end and actual.end_line >= expected.line_start


def _match_score(actual: ReviewFinding, expected: ExpectedFinding) -> tuple[int, int, int] | None:
    if actual.path != expected.path or not _overlaps(actual, expected):
        return None
    category = int(actual.category == expected.category)
    severity = int(actual.severity == expected.severity)
    distance = abs(actual.line - expected.line_start)
    return category, severity, -distance


def _greedy_pairs(
    candidates: list[tuple[tuple[int, int, int, int, str, str, int], int, int]],
) -> list[tuple[int, int]]:
    matched_actual: set[int] = set()
    matched_expected: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _score, actual_index, expected_index in candidates:
        if actual_index in matched_actual or expected_index in matched_expected:
            continue
        matched_actual.add(actual_index)
        matched_expected.add(expected_index)
        pairs.append((actual_index, expected_index))
    return pairs


def _assign_pairs(
    candidates: list[tuple[tuple[int, int, int, int, str, str, int], int, int]],
) -> list[tuple[int, int]]:
    """Maximum-cardinality assignment; remaining ties follow candidate rank."""

    if not candidates:
        return []
    actual_ids = sorted({actual_index for _score, actual_index, _expected_index in candidates})
    expected_ids = sorted({expected_index for _score, _actual_index, expected_index in candidates})
    if len(actual_ids) > 16 or len(expected_ids) > 16:
        return _greedy_pairs(candidates)

    actual_pos = {actual_index: index for index, actual_index in enumerate(actual_ids)}
    expected_pos = {expected_index: index for index, expected_index in enumerate(expected_ids)}
    edges: dict[int, list[tuple[tuple[int, int, int, int, str, str, int], int]]] = {}
    for score, actual_index, expected_index in candidates:
        edges.setdefault(actual_pos[actual_index], []).append((score, expected_pos[expected_index]))

    memo: dict[tuple[int, int], tuple[int, tuple, tuple[tuple[int, int], ...]]] = {}

    def search(index: int, mask: int) -> tuple[int, tuple, tuple[tuple[int, int], ...]]:
        key = (index, mask)
        cached = memo.get(key)
        if cached is not None:
            return cached
        if index == len(actual_ids):
            empty: tuple[int, tuple, tuple[tuple[int, int], ...]] = (0, (), ())
            memo[key] = empty
            return empty
        best = search(index + 1, mask)
        for score, expected_pos_index in edges.get(index, ()):
            bit = 1 << expected_pos_index
            if mask & bit:
                continue
            card, scores, pairs = search(index + 1, mask | bit)
            candidate = (
                card + 1,
                (score, *scores),
                ((actual_ids[index], expected_ids[expected_pos_index]), *pairs),
            )
            if candidate[0] > best[0] or (candidate[0] == best[0] and candidate[1] > best[1]):
                best = candidate
        memo[key] = best
        return best

    return list(search(0, 0)[2])


def score_review(
    verdict: str,
    actual: Sequence[ReviewFinding],
    expected: Sequence[ExpectedFinding],
) -> dict[str, Any]:
    candidates: list[tuple[tuple[int, int, int, int, str, str, int], int, int]] = []
    for actual_index, finding in enumerate(actual):
        for expected_index, label in enumerate(expected):
            score = _match_score(finding, label)
            if score is not None:
                # Content keys, not list indices: JSON finding order must not
                # change which pairs a greedy match commits.
                expected_span = label.line_end - label.line_start
                candidates.append(
                    (
                        (*score, -expected_span, finding.path, finding.category, finding.line),
                        actual_index,
                        expected_index,
                    )
                )
    candidates.sort(reverse=True)
    pairs = _assign_pairs(candidates)
    matched_actual = {actual_index for actual_index, _expected_index in pairs}
    matched_expected = {expected_index for _actual_index, expected_index in pairs}

    tp = len(pairs)
    fp = len(actual) - tp
    fn = len(expected) - tp
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    expected_weight = sum(SEVERITY_WEIGHT[item.severity] for item in expected)
    matched_weight = sum(SEVERITY_WEIGHT[expected[e].severity] for _, e in pairs)
    fp_weight = sum(SEVERITY_WEIGHT[actual[a].severity] for a in range(len(actual)) if a not in matched_actual)
    weighted_precision = matched_weight / (matched_weight + fp_weight) if matched_weight + fp_weight else None
    weighted_recall = matched_weight / expected_weight if expected_weight else None
    weighted_f1 = (
        2 * weighted_precision * weighted_recall / (weighted_precision + weighted_recall)
        if weighted_precision is not None
        and weighted_recall is not None
        and weighted_precision + weighted_recall
        else None
    )
    blockers = [index for index, item in enumerate(expected) if item.severity in BLOCKING_SEVERITIES]
    blocker_recall = sum(index in matched_expected for index in blockers) / len(blockers) if blockers else None
    severity_accuracy = (
        sum(actual[a].severity == expected[e].severity for a, e in pairs) / tp if tp else None
    )
    category_accuracy = (
        sum(actual[a].category == expected[e].category for a, e in pairs) / tp if tp else None
    )
    grounded = (
        sum(bool(item.path and item.line > 0 and item.evidence.strip()) for item in actual) / len(actual)
        if actual
        else None
    )
    correct_verdict = (not expected and verdict == "approve") or (
        bool(expected)
        and verdict == ("request_changes" if any(item.severity in BLOCKING_SEVERITIES for item in expected) else "comment")
    )
    def rounded(value: float | None) -> float | None:
        return None if value is None else round(value, 6)
    return {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": rounded(precision),
        "recall": rounded(recall),
        "f1": rounded(f1),
        "weighted_precision": rounded(weighted_precision),
        "weighted_recall": rounded(weighted_recall),
        "weighted_f1": rounded(weighted_f1),
        "blocker_recall": rounded(blocker_recall),
        "severity_accuracy": rounded(severity_accuracy),
        "category_accuracy": rounded(category_accuracy),
        "grounded_evidence": rounded(grounded),
        "verdict_correct": correct_verdict,
        "clean_control": not expected,
        "clean_pass": not expected and not actual and verdict == "approve",
        "score_finite": all(
            value is None or math.isfinite(float(value))
            for key, value in {
                "precision": precision,
                "recall": recall,
                "weighted_f1": weighted_f1,
            }.items()
        ),
    }
