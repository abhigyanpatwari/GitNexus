import hashlib
import json
from pathlib import Path

import yaml


BENCH_ROOT = Path(__file__).parents[1] / "workflow_bench"


def test_review_corpus_is_immutable_and_task_bound():
    manifest = json.loads((BENCH_ROOT / "review_cases" / "manifest.json").read_text())
    tasks = yaml.safe_load((BENCH_ROOT / "tasks.review.scenarios.yaml").read_text())["tasks"]
    by_id = {task["id"]: task for task in tasks}

    assert len(manifest["cases"]) >= 6
    assert sum(case["id"].endswith("-defect") for case in manifest["cases"]) >= 4
    assert sum(case["id"].endswith("-clean") for case in manifest["cases"]) >= 2
    assert set(by_id) == {case["id"] for case in manifest["cases"]}

    for case in manifest["cases"]:
        assert len(case["base_sha"]) == len(case["head_sha"]) == 40
        assert len(case["human_verification_commit"]) == 40
        patch = BENCH_ROOT / "review_cases" / f"{case['id'].removeprefix('review-')}.patch"
        assert hashlib.sha256(patch.read_bytes()).hexdigest() == case["patch_sha256"]
        task = by_id[case["id"]]
        assert task["ref"] == case["base_sha"]
        assert task["sandbox_copy"] == [f"eval/workflow_bench/review_cases/{patch.name}"]


def test_hidden_labels_are_not_recoverable_from_visible_task_input():
    tasks_path = BENCH_ROOT / "tasks.review.scenarios.yaml"
    tasks = yaml.safe_load(tasks_path.read_text())["tasks"]

    for task in tasks:
        visible = json.dumps(
            {
                "prompt": task["prompt"],
                "setup": task["setup"],
                "sandbox_copy": task["sandbox_copy"],
            },
            sort_keys=True,
        )
        assert "review-labels.json" not in visible
        for oracle_file in task["oracle"]["files"]:
            assert oracle_file["source"] not in visible
            assert oracle_file["target"] == "review-labels.json"
