"""Score fixed source anchors against recorded retrievals, without an LLM judge.

These are partial relevance judgments: unjudged results are not false positives.
The score is anchor coverage, not end-to-end task success or search precision.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def score_retrieval(cases: dict[str, Any], recordings: dict[str, Any]) -> dict[str, Any]:
    if recordings.get("source_sha") != cases.get("source_sha") or not cases.get("source_sha"):
        raise ValueError("retrieval recordings must match the fixture source SHA")
    if recordings.get("index_complete") is not True or recordings.get("index_staleness") != "current":
        raise ValueError("retrieval recordings require a complete current index receipt")
    if recordings.get("sanitized_graph") is not True or not re.fullmatch(r"[0-9a-f]{40}", str(recordings.get("runtime_sha", ""))):
        raise ValueError("record the sanitized graph and runtime identity")
    if recordings.get("query_options") != cases.get("query_options") or not cases.get("query_options"):
        raise ValueError("record the fixed query options from the fixture")
    rows = recordings.get("cases", [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("recorded cases must be a list")
    by_id = {row.get("id"): row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError("duplicate retrieval case ID")
    expected_ids = {case["id"] for case in cases["cases"]}
    if not set(by_id) <= expected_ids:
        raise ValueError("unknown retrieval case ID")
    scores = []
    for case in cases["cases"]:
        row = by_id.get(case["id"])
        if row is None:
            scores.append({"id": case["id"], "status": "missing", "anchor_recall": None})
            continue
        if row.get("query") != case["query"]:
            raise ValueError(f"query differs for case {case['id']}")
        body = row.get("response")
        if not isinstance(body, dict):
            raise ValueError("record parsed query response objects")
        symbols = [*body.get("process_symbols", []), *body.get("definitions", [])]
        anchors = []
        for symbol in symbols:
            if isinstance(symbol, dict) and isinstance(symbol.get("filePath"), str):
                anchor = (symbol["filePath"], symbol.get("name"))
                if anchor not in anchors:
                    anchors.append(anchor)
        matched = []
        for expected in case["anchors"]:
            positions = [i + 1 for i, (path, name) in enumerate(anchors)
                         if path == expected["file"] and ("name" not in expected or name == expected["name"])]
            matched.append(min(positions) if positions else None)
        failed = bool(body.get("error"))
        scores.append({
            "id": case["id"], "status": "error" if failed else "observed",
            "expected_anchors": len(matched), "found_anchors": sum(p is not None for p in matched),
            "anchor_recall": sum(p is not None for p in matched) / len(matched) if matched and not failed else None,
            "first_anchor_position": min((p for p in matched if p is not None), default=None),
            "returned_anchors": len(anchors), "response_bytes": len(json.dumps(body, ensure_ascii=True).encode()),
            "truncated": body.get("truncated") is True or body.get("partial") is True,
        })
    return {
        "schema": "gitnexus.retrieval-diagnostics/v1", "source_sha": cases["source_sha"],
        "runtime_sha": recordings["runtime_sha"], "cases": scores,
        "complete": all(row["status"] == "observed" and not row.get("truncated") for row in scores),
        "limitations": [
            "Source anchors are partial judgments; no precision or false-positive rate is inferred.",
            "Position is flattened process_symbols then definitions order, not a calibrated relevance rank.",
            "Coverage is conditional on the recorded query limits and index layers; preserve the capture receipt.",
            "The scorer checks declared provenance; the capture must verify it against the sanitized index.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("retrieval_cases.json"))
    parser.add_argument("--recordings", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = score_retrieval(json.loads(args.cases.read_text()), json.loads(args.recordings.read_text()))
    with args.out.open("x") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
