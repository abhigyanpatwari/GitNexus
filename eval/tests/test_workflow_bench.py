"""Unit tests for workflow benchmark aggregation, reporting, task, and CI contracts."""

import json
import os
import re
import shlex
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from typing import Any

from workflow_bench import runner
from workflow_bench.evolution import CANDIDATE_ARMS
from workflow_bench.process_control import _CANCELLATION, cancellation_scope
from workflow_bench.runner import (
    aggregate,
    GraphBuildEnv,
    arm_health,
    broken_incumbent_arms,
    unhealthy_arms,
    unmeasured_arms,
    build_parser,
    infra_error_record,
    next_graph_prefetch_target,
    normalized_model_identifier,
    parse_shortstat,
    prefetch_next_graph,
    render_report,
    savings,
    select_tasks,
    systemic_outage_streak,
    task_has_planned_paid_cells,
)


def record(**overrides):
    base = {
        "input_tokens": 1000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 5000,
        "output_tokens": 400,
        "cost_usd": 0.5,
        "duration_s": 60.0,
        "num_turns": 10,
        "diff_files": 2,
        "diff_insertions": 30,
        "diff_deletions": 5,
        "class": "demo",
        "resolved": True,
    }
    base.update(overrides)
    return base


def test_aggregate_takes_medians_and_counts_resolved():
    records = [
        record(input_tokens=1000, resolved=True),
        record(input_tokens=3000, resolved=False),
        record(input_tokens=2000, resolved=True),
    ]
    agg = aggregate(records)
    assert agg == {
        "input_tokens": 2000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 5000,
        "output_tokens": 400,
        "cost_usd": 0.5,
        "duration_s": 60.0,
        "num_turns": 10,
        "diff_files": 2,
        "diff_insertions": 30,
        "diff_deletions": 5,
        "class": "demo",
        "resolved": 2,
        # None of these are reused, so every resolution was measured this sweep.
        "resolved_fresh": 2,
        # Health is counted separately from resolution: all three executed and
        # produced usable evidence, including the one that resolved nothing.
        "fresh_attempts": 3,
        "admissible": 3,
        "execution_failures": 0,
        "evidence_failures": 0,
        "health_reasons": [],
        "runs": 3,
        "valid_runs": 3,
        "excluded_runs": 0,
        "transcripts_missing": 0,
        "error_kinds": {},
    }


def test_savings_is_positive_when_workflow_is_cheaper():
    baseline = aggregate([record(input_tokens=2000, output_tokens=800, cost_usd=1.0)])
    workflow = aggregate([record(input_tokens=1000, output_tokens=400, cost_usd=0.4)])
    s = savings(baseline, workflow)
    assert s["input_tokens"] == 50.0
    assert s["output_tokens"] == 50.0
    assert s["cost_usd"] == 60.0


def task_row(task_id: str, **overrides):
    task = {
        "id": task_id,
        "class": "demo",
        "repo": "/repo",
        "prompt": "do it",
        "verify": "true",
        "oracle": {
            "command": "true",
            "files": [
                {
                    "source": "trivial-status-json-alias.oracle.test.ts",
                    "target": "oracle.test.ts",
                }
            ],
        },
    }
    task.update(overrides)
    return task


def test_expensive_tasks_are_opt_in_and_reported_as_skipped():
    tasks = [task_row("default"), task_row("large", expensive=True)]
    selected, skipped = select_tasks(tasks, include_expensive=False)
    assert [task["id"] for task in selected] == ["default"]
    assert skipped == ["large"]

    selected, skipped = select_tasks(tasks, include_expensive=True)
    assert [task["id"] for task in selected] == ["default", "large"]
    assert skipped == []


@pytest.mark.parametrize("value", ["true", 1, None, [], {}])
def test_expensive_metadata_must_be_boolean(value):
    with pytest.raises(ValueError, match="expensive.*boolean"):
        select_tasks([task_row("bad", expensive=value)], include_expensive=False)


def test_task_selection_rejects_duplicate_ids_and_empty_selection():
    with pytest.raises(ValueError, match="duplicate task id"):
        select_tasks([task_row("same"), task_row("same")], include_expensive=True)
    with pytest.raises(ValueError, match="no tasks selected"):
        select_tasks([task_row("large", expensive=True)], include_expensive=False)


def test_runner_requires_a_named_model_and_supports_expensive_opt_in():
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--tasks", "tasks.yaml"])
    args = build_parser().parse_args(
        [
            "--tasks",
            "tasks.yaml",
            "--model",
            "claude-sonnet-4-20250514",
            "--include-expensive",
        ]
    )
    assert args.include_expensive is True
    with pytest.raises(ValueError, match="nonblank"):
        normalized_model_identifier("   ")


@pytest.mark.parametrize(
    "alias",
    ["Auto", "AUTO", "latest", "provider/latest", "provider:Latest", "provider@LATEST"],
)
def test_runner_rejects_mutable_model_aliases(alias):
    with pytest.raises(ValueError, match="mutable auto/latest"):
        normalized_model_identifier(alias)
    assert normalized_model_identifier("free-coder") == "free-coder"
    assert normalized_model_identifier("claude-sonnet-4-20250514") == "claude-sonnet-4-20250514"


def test_eval_ci_uses_locked_uv_and_blocking_native_containment_jobs():
    repo_root = Path(__file__).resolve().parents[2]
    workflow = (repo_root / ".github" / "workflows" / "ci-tests.yml").read_text()
    workflow_document = yaml.safe_load(workflow)
    containment = workflow_document["jobs"]["eval-containment-linux"]
    containment_steps = {step.get("name"): step for step in containment["steps"] if "name" in step}
    containment_node_setup = next(
        step for step in containment["steps"] if str(step.get("uses", "")).startswith("actions/setup-node@")
    )
    claude_lock = json.loads((repo_root / ".github" / "claude-canary-runtime" / "package-lock.json").read_text())
    setup_uv = "astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990"
    assert workflow.count(setup_uv) >= 3
    assert workflow.count("version: '0.11.23'") >= 3
    assert workflow.count("uv run --locked --extra dev python -m pytest") >= 3
    assert "eval-containment-linux:" in workflow
    assert "GITNEXUS_REQUIRE_BWRAP_CANARY: '1'" in workflow
    assert "GITNEXUS_REQUIRE_CLAUDE_CANARY: '1'" in workflow
    assert containment["env"] == {
        "GITNEXUS_REQUIRE_BWRAP_CANARY": "1",
        "GITNEXUS_REQUIRE_CLAUDE_CANARY": "1",
    }
    assert containment["timeout-minutes"] == 20
    assert containment_node_setup["with"] == {
        "node-version": "22.18.0",
        "cache": "npm",
        "cache-dependency-path": "gitnexus/package-lock.json\ngitnexus-shared/package-lock.json\n",
    }
    assert (
        "CLAUDE_CANARY_BIN: ${{ runner.temp }}/claude-canary/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
        in workflow
    )
    assert ".github/claude-canary-runtime/package-lock.json" in workflow
    assert "npm ci" in workflow
    assert "--package-lock=false" not in workflow
    assert claude_lock["packages"]["node_modules/@anthropic-ai/claude-code"]["version"] == "2.1.214"
    assert claude_lock["packages"]["node_modules/@anthropic-ai/claude-code"]["integrity"].startswith("sha512-")
    assert "if(p.version!=='2.1.214') process.exit(1)" in workflow
    assert "'2.1.214 (Claude Code)'" in workflow
    # Shared is compiled by gitnexus `npm run build` (scripts/build.js runTsc).
    # A dedicated npm ci in gitnexus-shared pulls TypeScript 7 and stalls CI.
    assert "Build pinned shared runtime" not in containment_steps
    assert not any(
        step.get("working-directory") == "gitnexus-shared" and "npm ci" in str(step.get("run", ""))
        for step in containment["steps"]
    )
    assert containment_steps["Install and build pinned GitNexus runtime"]["working-directory"] == "gitnexus"
    assert containment_steps["Install and build pinned GitNexus runtime"]["run"].splitlines() == [
        "npm ci",
        "npm run build",
    ]
    selected_containment_tests = containment_steps["Prove process-tree and sandbox containment"]["run"].split()
    assert selected_containment_tests == [
        "uv",
        "run",
        "--locked",
        "--extra",
        "dev",
        "python",
        "-m",
        "pytest",
        "tests/test_process_control.py",
        "tests/test_proposer_sandbox.py",
        "tests/test_workflow_bench_sessions.py",
        "tests/test_ce_plugin_runtime.py",
        "-q",
    ]
    bwrap_canary_marker = re.compile(
        r'@pytest\.mark\.skipif\(\s*os\.environ\.get\("GITNEXUS_REQUIRE_BWRAP_CANARY"\)',
        re.MULTILINE,
    )
    bwrap_canary_files = sorted(
        path.name
        for path in (repo_root / "eval" / "tests").glob("test_*.py")
        if bwrap_canary_marker.search(path.read_text())
    )
    assert bwrap_canary_files == ["test_proposer_sandbox.py", "test_workflow_bench_sessions.py"]
    assert all(f"tests/{name}" in selected_containment_tests for name in bwrap_canary_files)
    assert "eval-containment-windows:" in workflow


def test_shipped_scenarios_opt_out_the_cross_module_cell_and_rebuild_graph_assets():
    task_file = Path(__file__).resolve().parents[1] / "workflow_bench" / "tasks.scenarios.yaml"
    tasks = yaml.safe_load(task_file.read_text())["tasks"]
    selected, skipped = select_tasks(tasks, include_expensive=False)
    assert [task["id"] for task in selected] == [
        "trivial-status-json-alias",
        "inv-bug-c-system-include",
        "inv-feature-list-repos-filter",
    ]
    assert skipped == ["cross-module-parse-retry"]
    assert all(not task.get("sandbox_copy") for task in tasks)
    assert all(task["sandbox_dependencies"] for task in tasks)
    assert all(
        any(dep.get("source") == "gitnexus-shared/dist" for dep in task["sandbox_dependencies"]) for task in tasks
    )
    assert all(task["oracle"]["command"] and task["oracle"]["files"] for task in tasks)
    assert all("./node_modules/.bin/vitest run" in task["oracle"]["command"] for task in tasks)
    assert all("npx vitest" not in task["oracle"]["command"] for task in tasks)
    assert all(
        '--config "$GITNEXUS_BENCH_ORACLE_ROOT/vitest.config.mts"' in task["oracle"]["command"] for task in tasks
    )
    assert all({item["target"] for item in task["oracle"]["files"]} >= {"vitest.config.mts"} for task in tasks)


def test_savings_handles_zero_baseline_without_dividing():
    baseline = aggregate([record(cost_usd=0.0)])
    workflow = aggregate([record(cost_usd=0.0)])
    assert savings(baseline, workflow)["cost_usd"] == 0.0


def test_parse_shortstat_full_and_empty():
    full = parse_shortstat(" 3 files changed, 120 insertions(+), 7 deletions(-)")
    assert full == {"diff_files": 3, "diff_insertions": 120, "diff_deletions": 7}
    assert parse_shortstat("") == {
        "diff_files": 0,
        "diff_insertions": 0,
        "diff_deletions": 0,
    }
    singular = parse_shortstat(" 1 file changed, 1 insertion(+)")
    assert singular == {"diff_files": 1, "diff_insertions": 1, "diff_deletions": 0}


def test_render_report_emits_arm_rows_and_per_arm_savings_rows():
    results = {
        "demo-task": {
            "workflow": aggregate([record(input_tokens=1000)]),
            "workflow_direct": aggregate([record(input_tokens=1500)]),
            "baseline": aggregate([record(input_tokens=2000)]),
        }
    }
    report = render_report(results)
    assert "| demo-task | demo | workflow | 1/1 | 1000 |" in report
    assert "| demo-task | demo | baseline | 1/1 | 2000 |" in report
    assert "| demo-task | demo | **workflow savings %** | — | 50.0 |" in report
    assert "| demo-task | demo | **workflow_direct savings %** | — | 25.0 |" in report
    assert "2/+30/−5" in report
    assert "results.jsonl" in report
    assert "subagent spend" in report  # token columns are main-loop-only


def test_aggregate_excludes_session_error_rows_from_medians():
    records = [
        record(cost_usd=1.0),
        record(cost_usd=3.0, transcript_missing=True),
        record(cost_usd=100.0, resolved=False, error_kind="session-error"),
    ]
    agg = aggregate(records)
    assert agg["cost_usd"] == 2.0
    assert agg["runs"] == 3
    assert agg["valid_runs"] == 2
    assert agg["excluded_runs"] == 1
    assert agg["transcripts_missing"] == 1
    assert agg["resolved"] == 2


def test_aggregate_excludes_unverified_transcript_evidence():
    agg = aggregate(
        [
            record(cost_usd=1.0),
            record(
                cost_usd=100.0,
                resolved=False,
                error_kind="evidence-unverified",
                transcript_missing=True,
            ),
        ]
    )
    assert agg["cost_usd"] == 1.0
    assert agg["valid_runs"] == 1
    assert agg["excluded_runs"] == 1


def test_aggregate_excludes_invalid_review_artifacts_from_quality_metrics():
    scored = record(
        cost_usd=1.0,
        review_weighted_f1=0.8,
        review_true_positives=2,
        review_false_positives=0,
        review_false_negatives=1,
        review_precision=1.0,
        review_recall=0.67,
        review_f1=0.8,
        review_weighted_precision=0.8,
        review_weighted_recall=0.8,
        review_blocker_recall=1.0,
        review_severity_accuracy=1.0,
        review_category_accuracy=1.0,
        review_grounded_evidence=1.0,
        review_clean_control=False,
    )
    agg = aggregate(
        [
            scored,
            record(cost_usd=2.0, resolved=False, error_kind="review-evidence-invalid"),
        ]
    )
    assert agg["valid_runs"] == 1
    assert agg["excluded_runs"] == 1
    assert agg["review_weighted_f1"] == 0.8
    assert agg["review_true_positives"] == 2


def test_render_report_surfaces_excluded_and_unverified_runs():
    results = {
        "t": {
            "workflow": aggregate(
                [
                    record(transcript_missing=True),
                    record(resolved=False, error_kind="session-error"),
                ]
            )
        }
    }
    report = render_report(results)
    assert "| t | demo | workflow | 1/1 (1 excluded) |" in report
    assert "session/infra errors" in report
    assert "no locatable session transcript" in report


def test_render_report_surfaces_why_each_row_failed():
    results = {
        "t": {
            "workflow": aggregate(
                [record(resolved=False, error_kind="plan-evidence-invalid")],
            ),
        }
    }
    report = render_report(results)
    assert "plan-evidence-invalid×1" in report


def test_broken_incumbent_arms_flags_an_incumbent_that_resolved_nothing():
    results = {
        "t1": {"workflow": aggregate([record(resolved=False, error_kind="plan-evidence-invalid")])},
        "t2": {"workflow": aggregate([record(resolved=False, error_kind="plan-evidence-invalid")])},
    }
    assert broken_incumbent_arms(results, {"workflow"}) == ["workflow"]


def test_broken_incumbent_arms_ignores_a_merely_underperforming_candidate():
    # The incumbent works fine; only the candidate arm fails. That's a normal,
    # expected "bad candidate" outcome and must not read as a broken harness.
    results = {
        "t1": {
            "workflow": aggregate([record(resolved=True)]),
            "candidate_workflow": aggregate([record(resolved=False, error_kind="verify-failed")]),
        },
    }
    assert broken_incumbent_arms(results, {"workflow"}) == []


def test_broken_incumbent_arms_flags_an_incumbent_with_zero_valid_runs():
    # Every run excluded via an excluded-but-non-systemic error_kind
    # ("evidence-unverified"): valid_runs == 0 for every task, which the old
    # `valid_runs > 0` guard let sail through silently, and which the outage
    # streak breaker also doesn't catch (it resets rather than accumulates
    # on this exact error_kind -- see test_systemic_outage_streak_resets_on_non_outage).
    results = {
        "t1": {"workflow": aggregate([record(resolved=False, error_kind="evidence-unverified")])},
        "t2": {"workflow": aggregate([record(resolved=False, error_kind="evidence-unverified")])},
    }
    assert results["t1"]["workflow"]["valid_runs"] == 0
    assert broken_incumbent_arms(results, {"workflow"}) == ["workflow"]


def test_broken_incumbent_arms_ignores_partial_incumbent_failure():
    # Resolved in at least one task — struggling, not broken.
    results = {
        "t1": {"workflow": aggregate([record(resolved=False, error_kind="verify-failed")])},
        "t2": {"workflow": aggregate([record(resolved=True)])},
    }
    assert broken_incumbent_arms(results, {"workflow"}) == []


def test_infra_error_record_captures_the_failure_and_is_excluded():
    exc = subprocess.TimeoutExpired(cmd="claude -p", timeout=5)
    rec = infra_error_record(exc)
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "infra-error"
    assert "TimeoutExpired" in rec["error_detail"]
    assert rec["output_tokens"] == 0
    agg = aggregate([record(cost_usd=2.0), rec])
    assert agg["cost_usd"] == 2.0
    assert agg["valid_runs"] == 1
    assert agg["excluded_runs"] == 1


def test_systemic_outage_streak_counts_consecutive_systemic_failures():
    # session/infra/cleanup failures accumulate; a cleanup-failure that masked a
    # session-error still counts toward the streak.
    streak = 0
    for kind in ("session-error", "infra-error", "cleanup-failure"):
        streak = systemic_outage_streak(kind, streak)
    assert streak == 3
    assert systemic_outage_streak("cleanup-failure", 4) == 5


def test_systemic_outage_streak_resets_on_non_outage():
    # A real task failure (resolved=False → error_kind None) or an unverifiable
    # evidence run is not an outage and resets the streak.
    assert systemic_outage_streak(None, 4) == 0
    assert systemic_outage_streak("evidence-unverified", 4) == 0


def test_outage_streak_flag_defaults_and_disables():
    base = ["--tasks", "tasks.yaml", "--model", "claude-sonnet-4-20250514"]
    assert build_parser().parse_args(base).outage_streak == 5
    assert build_parser().parse_args([*base, "--outage-streak", "0"]).outage_streak == 0


def test_run_evolution_script_is_the_shared_ci_and_local_entrypoint():
    eval_dir = Path(__file__).resolve().parents[1]
    script = eval_dir / "workflow_bench" / "run-evolution.sh"
    workflow = eval_dir.parent / ".github" / "workflows" / "gitnexus-skill-evolution.yml"
    assert script.is_file()
    assert script.stat().st_mode & 0o111
    workflow_text = workflow.read_text()
    assert "./workflow_bench/run-evolution.sh --apply" in workflow_text
    assert "python -m workflow_bench.evolve" not in workflow_text

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin"),
        "MODEL": "claude-sonnet-5",
        "PROPOSER_MODEL": "claude-opus-4-8",
        "EFFORT": "xhigh",
        "GENERATIONS": "1",
        "RUNS": "3",
        "WORKERS": "2",
        "PROVIDER": "openai",
        "INCLUDE_EXPENSIVE": "1",
        "SEED_RESULTS": "/tmp/seed-bench",
        "CLAUDE_BIN": "/opt/claude",
        "OUT_ROOT": "/tmp/wfevolve",
        "CE_PLUGIN_DIR": "/tmp/ce-plugin",
        "CE_PLUGIN_VERSION": "3.24.0",
        "HOME": os.environ.get("HOME", "/tmp"),
    }
    printed = subprocess.run(
        [str(script), "--dry-run", "--apply"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    argv = shlex.split(printed.stdout)
    assert argv[:7] == ["uv", "run", "--locked", "--extra", "dev", "python", "-m"]
    assert argv[7] == "workflow_bench.evolve"
    assert argv[argv.index("--tasks") + 1] == "workflow_bench/tasks.review.scenarios.yaml"
    assert argv[argv.index("--arms") + 1] == "review"
    assert argv[argv.index("--ce-plugin-version") + 1] == "3.24.0"
    assert argv[argv.index("--model") + 1] == "gpt-5.6-sol"
    assert argv[argv.index("--proposer-model") + 1] == "gpt-5.6-sol"
    assert argv[argv.index("--effort") + 1] == "xhigh"
    assert argv[argv.index("--workers") + 1] == "2"
    assert argv[argv.index("--claude-bin") + 1] == "/opt/claude"
    assert argv[argv.index("--out-root") + 1] == "/tmp/wfevolve"
    assert argv[argv.index("--seed-results") + 1] == "/tmp/seed-bench"
    assert "--apply" in argv
    assert "--include-expensive" in argv
    assert "claude-sonnet-5" not in argv
    assert printed.stderr  # rewrite notice goes to stderr


def test_planned_paid_cells_treat_missing_reuse_as_paid():
    task = {"id": "review-pr-2718-defect"}
    assert task_has_planned_paid_cells(
        task,
        arms=["ce_review", "review", "candidate_review"],
        runs=3,
        reusable_rows={},
        reuse_source=None,
    )
    reuse_source = Path("/tmp/seed")
    rows = {
        (task["id"], arm, run_idx): {}
        for run_idx in range(3)
        for arm in ("ce_review", "review", "candidate_review")
    }
    assert not task_has_planned_paid_cells(
        task,
        arms=["ce_review", "review", "candidate_review"],
        runs=3,
        reusable_rows=rows,
        reuse_source=reuse_source,
    )
    del rows[(task["id"], "candidate_review", 0)]
    assert task_has_planned_paid_cells(
        task,
        arms=["ce_review", "review", "candidate_review"],
        runs=3,
        reusable_rows=rows,
        reuse_source=reuse_source,
    )


def test_next_graph_prefetch_skips_ready_shas_and_fully_reused_tasks(tmp_path: Path):
    first = {"id": "review-a"}
    second = {"id": "review-b"}
    third = {"id": "review-c"}
    reuse_source = tmp_path / "seed"
    reused_second = {
        (second["id"], arm, 0): {} for arm in ("ce_review", "review", "candidate_review")
    }
    target = next_graph_prefetch_target(
        [
            (first, {"repo_identity": "/repo", "resolved_sha": "aaa"}),
            (second, {"repo_identity": "/repo", "resolved_sha": "bbb"}),
            (third, {"repo_identity": "/repo", "resolved_sha": "ccc"}),
        ],
        arms=["ce_review", "review", "candidate_review"],
        runs=1,
        reusable_rows=reused_second,
        reuse_source=reuse_source,
        ready_keys={("/repo", "aaa")},
    )
    assert target is not None
    task, binding, key = target
    assert task["id"] == "review-c"
    assert key == ("/repo", "ccc")
    assert binding["resolved_sha"] == "ccc"


def test_prefetch_next_graph_runs_ensure_on_a_background_thread(monkeypatch):
    started = threading.Event()
    seen: list[tuple[str, str]] = []

    def fake_ensure(**kwargs):
        seen.append(kwargs["graph_key"])
        started.set()

    monkeypatch.setattr("workflow_bench.runner.ensure_task_graph", fake_ensure)
    cancel = threading.Event()
    job = prefetch_next_graph(
        task={"id": "review-b"},
        binding={"repo_identity": "/repo", "resolved_sha": "bbb"},
        graph_key=("/repo", "bbb"),
        env=GraphBuildEnv(
            trees=Path("/tmp"),
            task_asset_cache=None,
            claude_bin="claude",
            bwrap_bin="bwrap",
            sandbox_backend="bwrap",
            runtime_mounts=(),
            clone_templates={},
            clone_template_errors={},
            graph_snapshots={},
            graph_snapshot_errors={},
        ),
        cancel_event=cancel,
    )
    assert job.key == ("/repo", "bbb")
    assert started.wait(timeout=2)
    job.join()
    assert seen == [("/repo", "bbb")]


def test_a_reused_resolution_does_not_count_as_this_sweeps_health():
    """resolved counts evidence; resolved_fresh counts evidence measured today.

    broken_incumbent_arms reads resolved_fresh because a reused row proves last
    generation's environment worked. Counting it would make an arm whose cells
    were all reused look healthy in exactly the run where a broken environment
    should have been caught.
    """

    reused = [record(resolved=True, reused=True), record(resolved=True, reused=True)]
    agg = aggregate(reused)
    assert agg["resolved"] == 2
    assert agg["resolved_fresh"] == 0
    assert broken_incumbent_arms({"t": {"review": agg}}, {"review"}) == ["review"]

    mixed = aggregate([record(resolved=True, reused=True), record(resolved=True)])
    assert mixed["resolved_fresh"] == 1
    assert broken_incumbent_arms({"t": {"review": mixed}}, {"review"}) == []


def test_graph_build_env_ready_keys_covers_successes_and_failures():
    """A key that failed is attempted, not pending.

    next_graph_prefetch_target skips keys already in ready_keys. If a failed
    build were omitted, the sweep would prefetch it again every iteration and
    pay a full clone and offline index each time for a build that cannot
    succeed.
    """

    env = GraphBuildEnv(
        trees=Path("/tmp"),
        task_asset_cache=None,
        claude_bin="claude",
        bwrap_bin="bwrap",
        sandbox_backend="bwrap",
        runtime_mounts=(),
        clone_templates={("/repo", "aaa"): (Path("/tmp/a"), "aaa")},
        clone_template_errors={("/repo", "bbb"): OSError("clone failed")},
        graph_snapshots={("/repo", "ccc"): object()},
        graph_snapshot_errors={("/repo", "ddd"): OSError("index failed")},
    )
    assert env.ready_keys() == {
        ("/repo", "aaa"),
        ("/repo", "bbb"),
        ("/repo", "ccc"),
        ("/repo", "ddd"),
    }


def _cell(**overrides) -> dict[str, Any]:
    """One results.jsonl row, healthy unless told otherwise."""

    base = record(resolved=True)
    base.update({"error_kind": None, "review_evidence_valid": True, "transcript_missing": False})
    base.update(overrides)
    return base


def _arms(**by_arm) -> dict[str, dict[str, dict[str, Any]]]:
    return {"task0": {arm: aggregate(rows) for arm, rows in by_arm.items()}}


def test_a_reviewer_that_scores_badly_is_not_an_unhealthy_harness():
    """Reconstructed from Actions run 33962002890's logged observations.

    Every completed cell was resolved=False with error_kind=oracle-failed, at a
    median score of 0.212 — the reviews ran, wrote artifacts and were scored.
    That is a valid negative for the quality gate to judge. Diagnosing it as a
    broken environment is the confusion this classification exists to end.
    """

    scored_but_wrong = [_cell(resolved=False, error_kind="oracle-failed") for _ in range(3)]
    results = _arms(review=scored_but_wrong, ce_review=list(scored_but_wrong))
    assert unhealthy_arms(results, {"review", "ce_review"}) == []
    health = arm_health(results, {"review"})["review"]
    assert health.admissible == 3 and health.fresh_attempts == 3
    assert (health.execution_failures, health.evidence_failures) == (0, 0)


def test_an_all_zero_score_is_still_a_valid_negative():
    zeroed = [_cell(resolved=False, error_kind="oracle-failed", review_weighted_f1=0.0) for _ in range(3)]
    assert unhealthy_arms(_arms(review=zeroed), {"review"}) == []


def test_artifacts_that_were_never_written_are_an_unhealthy_harness():
    """Reconstructed from Actions run 33912693948.

    All 41 artifacts came back 0 bytes because the mount made an atomic write
    impossible. The reviews could not produce evidence at all — the opposite of
    the case above, and the one a health check must catch. The old caller
    excluded review arms entirely, so it could not have.
    """

    unwritable = [_cell(resolved=False, ok=False, error_kind="review-evidence-invalid") for _ in range(3)]
    flagged = unhealthy_arms(_arms(review=unwritable), {"review"})
    assert [h.arm for h in flagged] == ["review"]
    assert flagged[0].evidence_failures == 3
    assert "review-evidence-invalid" in flagged[0].reasons


def test_one_admissible_cell_leaves_an_arm_degraded_not_healthy():
    """Mixed outcomes are DEGRADED. One usable measurement does not erase two failures.

    Not fatal - the sweep still produced evidence - but calling it healthy is
    how a partly-broken environment passes review.
    """

    mixed = [
        _cell(resolved=False, error_kind="oracle-failed"),
        _cell(resolved=False, ok=False, error_kind="session-error"),
        _cell(resolved=False, ok=False, error_kind="infra-error"),
    ]
    results = _arms(review=mixed)
    health = arm_health(results, {"review"})["review"]
    assert health.status == "DEGRADED"
    assert unhealthy_arms(results, {"review"}) == [], "degraded is diagnostic, not fatal"
    assert health.execution_failures == 2, "failures must stay visible, not be erased"
    assert health.admissible == 1


def test_a_row_that_fails_both_ways_is_only_subtracted_once():
    """run_arm can produce a row that is an execution AND an evidence failure.

    It keeps the first error_kind — a session-error survives — and still sets
    review_evidence_valid=False when the artifact will not parse. Counting that
    row against admissible twice zeroed an arm that held a real measurement,
    which arm_health reports as UNUSABLE and the measurement gate then fails on.
    """

    both = _cell(resolved=False, ok=False, error_kind="session-error", review_evidence_valid=False)
    results = _arms(review=[both, _cell(resolved=True, error_kind="oracle-failed")])
    health = arm_health(results, {"review"})["review"]
    assert (health.execution_failures, health.evidence_failures) == (1, 1)
    assert health.fresh_attempts == 2
    assert health.admissible == 1
    assert health.status == "DEGRADED"
    assert unhealthy_arms(results, {"review"}) == []


def test_reused_rows_alone_leave_current_health_unknown():
    """Historical success cannot certify this sweep's environment."""

    reused = [_cell(reused=True) for _ in range(3)]
    results = _arms(review=reused)
    assert unmeasured_arms(results, {"review"}) == ["review"]
    assert unhealthy_arms(results, {"review"}) == []
    assert arm_health(results, {"review"})["review"].measured is False


def test_the_paid_canary_survives_a_prior_run_with_more_run_indices():
    """The canary counts planned cells, not every key reuse selection returned.

    Reuse selection accepts any non-negative prior `run`, so a results directory
    produced with --runs 5 leaves keys this sweep never plans. Comparing against
    those made the "arm is fully reused" test false exactly when it was true,
    and the incumbent went a whole sweep without one measured cell.
    """

    tasks = [{"id": "task0"}, {"id": "task1"}]
    reusable = {(task["id"], "review", run): {} for task in tasks for run in range(5)}

    dropped = runner.drop_canary_reuse_key(reusable, arm="review", tasks=tasks, runs=3)

    assert dropped == ("task0", "review", 0)
    assert dropped not in reusable
    # A second call is a no-op: the arm now has its paid cell.
    assert runner.drop_canary_reuse_key(reusable, arm="review", tasks=tasks, runs=3) is None


def test_an_arm_with_a_planned_paid_cell_keeps_every_reusable_row():
    tasks = [{"id": "task0"}]
    reusable = {("task0", "review", 0): {}}

    assert runner.drop_canary_reuse_key(reusable, arm="review", tasks=tasks, runs=2) is None
    assert len(reusable) == 1


def test_reused_successes_do_not_mask_fresh_execution_failures():
    rows = [_cell(reused=True), _cell(reused=True), _cell(ok=False, error_kind="session-error")]
    flagged = unhealthy_arms(_arms(review=rows), {"review"})
    assert [h.arm for h in flagged] == ["review"]
    assert flagged[0].fresh_attempts == 1 and flagged[0].execution_failures == 1


def test_a_parseable_artifact_does_not_excuse_a_failed_session():
    """Artifact parseability must not override an execution failure."""

    rows = [_cell(ok=False, error_kind="session-error", review_evidence_valid=True) for _ in range(2)]
    flagged = unhealthy_arms(_arms(review=rows), {"review"})
    assert [h.arm for h in flagged] == ["review"]
    assert flagged[0].execution_failures == 2


def test_a_single_unusable_review_is_caught_below_the_breaker_threshold():
    """The decisive regression for the finalization guard.

    A fixture of 41 empty artifacts would abort through the outage breaker -
    review-evidence-invalid is systemic and the limit is 5 - so it proves
    nothing about this path. One fresh unusable cell is under that threshold,
    which leaves the finalization check as the only thing that can catch it.
    """

    streak = 0
    for _ in range(1):
        streak = runner.systemic_outage_streak("review-evidence-invalid", streak)
    assert streak < runner.DEFAULT_OUTAGE_STREAK, "fixture must not reach the breaker"

    results = _arms(review=[_cell(resolved=False, ok=False, error_kind="review-evidence-invalid")])
    with pytest.raises(SystemExit) as exc:
        runner.enforce_measurement_health(results, {"review"})
    assert exc.value.code == 1


def test_finalization_reports_every_arm_and_names_no_cause(capsys):
    """Status for each arm; an empty artifact does not become an EROFS diagnosis."""

    results = _arms(
        review=[_cell(resolved=False, ok=False, error_kind="review-evidence-invalid")],
        ce_review=[_cell(resolved=False, error_kind="oracle-failed")],
    )
    with pytest.raises(SystemExit):
        runner.enforce_measurement_health(results, {"review", "ce_review"})
    out = capsys.readouterr().out
    assert "review: UNUSABLE" in out
    assert "ce_review: OBSERVED_OK" in out
    assert "cause=undetermined" in out
    assert "EROFS" not in out and "mount" not in out


def test_valid_negatives_do_not_abort_finalization(capsys):
    """The 16h run's shape must survive the real guard, not just the classifier."""

    scored_but_wrong = [_cell(resolved=False, error_kind="oracle-failed") for _ in range(3)]
    health = runner.enforce_measurement_health(
        _arms(review=scored_but_wrong, ce_review=list(scored_but_wrong)), {"review", "ce_review"}
    )
    assert {h.status for h in health.values()} == {"OBSERVED_OK"}
    assert "UNUSABLE" not in capsys.readouterr().out


def test_reused_only_arm_is_reported_unknown_by_finalization(capsys):
    runner.enforce_measurement_health(_arms(review=[_cell(reused=True)]), {"review"})
    assert "review: UNKNOWN" in capsys.readouterr().out


def test_run_sweep_calls_the_health_guard_and_not_the_legacy_helper():
    """Pins the wiring the caller correction exposed.

    Reads the compiled code object's global references rather than the source
    text: deleting the call removes the name and fails this test, which is the
    mutation check. It does NOT prove the guard runs end to end - _run_sweep
    needs bwrap and a sandbox, so no test here drives it.
    """

    referenced = runner._run_sweep.__code__.co_names
    assert "enforce_measurement_health" in referenced
    assert "broken_incumbent_arms" not in referenced


def test_ce_review_is_classified_even_though_it_is_not_a_candidate_arm():
    """ce_review is a comparator, absent from CANDIDATE_ARMS.

    Dropping the `- {"review"}` exclusion alone would have left it unchecked.
    """

    assert "ce_review" not in set(CANDIDATE_ARMS.values())
    health = arm_health(_arms(ce_review=[_cell()]), {"review", "ce_review"})
    assert "ce_review" in health


def _packed_cells(tasks: int, runs: int, arms: tuple[str, ...]) -> list[tuple[str, int, str]]:
    return [(f"t{t}", r, a) for t in range(tasks) for r in range(runs) for a in arms]


def test_packed_sweep_runs_every_cell_and_folds_in_submission_order():
    """Fold order is the contract the breaker rests on.

    Cells finish in whatever order the pool returns them, but the breaker counts
    CONSECUTIVE systemic failures, which only means something in a fixed order.
    """

    cells = _packed_cells(3, 2, ("review", "candidate_review"))
    folded: list[tuple[str, int, str]] = []
    streak, tripped = runner.sweep_packed_cells(
        cells,
        workers=4,
        run=lambda task, run_idx, arm: {"error_kind": None, "review_evidence_valid": True},
        on_start=lambda *_: None,
        on_record=lambda task, run_idx, arm, _rec: folded.append((task, run_idx, arm)),
        outage_streak=0,
        outage_limit=0,
    )
    assert folded == cells
    assert (streak, tripped) == (0, False)


def test_packed_sweep_trips_the_breaker_on_the_same_cell_waves_would():
    """Packing must not change WHEN a doomed run aborts, only how it is fed."""

    cells = _packed_cells(3, 3, ("review",))
    fail_from = 2
    folded: list[int] = []

    def run(task: str, run_idx: int, arm: str) -> dict[str, Any]:
        index = cells.index((task, run_idx, arm))
        systemic = index >= fail_from
        return {
            "error_kind": "session-error" if systemic else None,
            "review_evidence_valid": not systemic,
        }

    streak, tripped = runner.sweep_packed_cells(
        cells,
        workers=2,
        run=run,
        on_start=lambda *_: None,
        on_record=lambda t, r, a, _rec: folded.append(cells.index((t, r, a))),
        outage_streak=0,
        outage_limit=runner.DEFAULT_OUTAGE_STREAK,
    )
    assert tripped is True
    assert streak == runner.DEFAULT_OUTAGE_STREAK
    # Five consecutive systemic failures starting at index 2 -> trips on index 6.
    assert folded[-1] == fail_from + runner.DEFAULT_OUTAGE_STREAK - 1
    assert folded == sorted(folded), "records must fold in submission order"


def test_packed_sweep_skips_a_task_whose_assets_never_arrive():
    """A task that cannot be prepared is skipped, not run against nothing."""

    cells = _packed_cells(3, 2, ("review",))
    ran: list[str] = []
    runner.sweep_packed_cells(
        cells,
        workers=3,
        run=lambda task, run_idx, arm: ran.append(task)
        or {"error_kind": None, "review_evidence_valid": True},
        on_start=lambda *_: None,
        on_record=lambda *_: None,
        outage_streak=0,
        outage_limit=0,
        await_ready=lambda task: task != "t1",
    )
    assert set(ran) == {"t0", "t2"}
    assert "t1" not in ran


def test_packed_sweep_workers_inherit_the_runs_cancellation_event():
    """A worker that cannot see the event runs on after the sweep is cancelled.

    The cells are submitted from a producer THREAD, and a new thread starts with
    an empty context - so copying the context at submission copies the wrong one
    unless the caller's is captured first. run_managed falls back to
    _CANCELLATION when no event is passed, which is how a cell's subprocesses
    learn the run was cancelled at all.
    """

    seen: list[threading.Event | None] = []
    event = threading.Event()
    with cancellation_scope(event):
        runner.sweep_packed_cells(
            _packed_cells(2, 1, ("review",)),
            workers=2,
            run=lambda *_: seen.append(_CANCELLATION.get()) or {"error_kind": None},
            on_start=lambda *_: None,
            on_record=lambda *_: None,
            outage_streak=0,
            outage_limit=0,
        )
    assert seen and all(observed is event for observed in seen)


def test_packed_sweep_window_must_keep_the_pool_fed():
    with pytest.raises(ValueError, match="window must be at least workers"):
        runner.sweep_packed_cells(
            _packed_cells(1, 1, ("review",)),
            workers=4,
            run=lambda *_: {"error_kind": None},
            on_start=lambda *_: None,
            on_record=lambda *_: None,
            outage_streak=0,
            outage_limit=0,
            window=2,
        )


def test_a_raising_packed_cell_still_persists_its_settled_siblings():
    """A crash in one cell must not erase the evidence of cells that finished.

    run_cell deliberately lets unexpected harness exceptions propagate, and the
    wave scheduler answers that by folding every non-failing sibling before it
    re-raises. The packed scheduler has to hold the same contract: the later
    cells already ran and already cost money, so losing their rows would mean
    paying for evidence the sweep then throws away.
    """

    folded: list[tuple[int, str]] = []
    started = threading.Event()

    def run(task_id: str, run_idx: int, arm: str) -> dict[str, Any]:
        if run_idx == 0:
            # Let the later cell finish first, so there is settled evidence to
            # lose at the moment this one raises.
            started.wait(timeout=5)
            raise RuntimeError("harness bug in cell 0")
        started.set()
        return {"error_kind": None}

    with pytest.raises(RuntimeError, match="harness bug in cell 0"):
        runner.sweep_packed_cells(
            _packed_cells(1, 2, ("review",)),
            workers=2,
            run=run,
            on_start=lambda *_: None,
            on_record=lambda task_id, run_idx, arm, _rec: folded.append((run_idx, arm)),
            outage_streak=0,
            outage_limit=0,
        )

    assert (1, "review") in folded, "the sibling that completed was never recorded"
