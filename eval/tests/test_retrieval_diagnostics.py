"""Partial retrieval judgments must not turn unjudged code into false positives."""

import copy
import json
from pathlib import Path

import pytest

from workflow_bench.retrieval_diagnostics import score_retrieval

CASES = {"source_sha": "a" * 40, "query_options": {"limit": 5, "max_symbols": 10, "include_content": False}, "cases": [
    {"id": "case", "query": "find handler", "anchors": [{"file": "src/a.ts", "name": "handle"}]},
    {"id": "missing", "query": "another query", "anchors": [{"file": "src/b.ts"}]},
]}


def recordings():
    return {"source_sha": "a" * 40, "runtime_sha": "b" * 40, "index_complete": True,
            "index_staleness": "current", "sanitized_graph": True,
            "query_options": CASES["query_options"],
            "cases": [{"id": "case", "query": "find handler", "response": {
                "process_symbols": [{"filePath": "src/unjudged.ts", "name": "other"}],
                "definitions": [{"filePath": "src/a.ts", "name": "handle"}],
            }}]}


def test_partial_relevance_and_missing_cases_do_not_become_precision_or_zero():
    report = score_retrieval(CASES, recordings())
    assert report["cases"][0]["anchor_recall"] == 1
    assert report["cases"][0]["first_anchor_position"] == 2
    assert report["cases"][1]["anchor_recall"] is None
    assert not report["complete"]
    assert "precision" not in report["cases"][0]


@pytest.mark.parametrize("change", [{"source_sha": "c" * 40}, {"index_staleness": "behind"},
                                   {"index_complete": False}, {"sanitized_graph": False},
                                   {"sanitized_graph": "false"}, {"runtime_sha": "main"}, {"query_options": {"limit": 1}}])
def test_unmatched_or_incomplete_index_is_not_scored(change):
    with pytest.raises(ValueError):
        score_retrieval(CASES, recordings() | change)


def test_changed_query_duplicate_case_and_missing_symbol_are_distinct():
    recorded = recordings()
    recorded["cases"][0]["query"] = "different question"
    with pytest.raises(ValueError, match="query differs"):
        score_retrieval(CASES, recorded)
    recorded = recordings()
    recorded["cases"].append(copy.deepcopy(recorded["cases"][0]))
    with pytest.raises(ValueError, match="duplicate"):
        score_retrieval(CASES, recorded)
    recorded = recordings()
    recorded["cases"][0]["response"] = {"process_symbols": [], "definitions": []}
    assert score_retrieval(CASES, recorded)["cases"][0]["anchor_recall"] == 0


def test_committed_cases_cover_each_current_scenario_with_pinned_source():
    import yaml

    root = Path(__file__).resolve().parents[1] / "workflow_bench"
    cases = json.loads((root / "retrieval_cases.json").read_text())
    tasks = yaml.safe_load((root / "tasks.scenarios.yaml").read_text())["tasks"]
    assert {c["id"] for c in cases["cases"]} == {t["id"] for t in tasks}
    assert {t["ref"] for t in tasks} == {cases["source_sha"]}
