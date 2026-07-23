"""Unit tests for workflow benchmark aggregation, reporting, task, and CI contracts."""

import json
import re
import subprocess
from pathlib import Path

import pytest
import yaml

from workflow_bench.runner import (
    aggregate,
    broken_incumbent_arms,
    build_parser,
    infra_error_record,
    normalized_model_identifier,
    parse_shortstat,
    render_report,
    savings,
    select_tasks,
    systemic_outage_streak,
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
                    "source": "trivial-version-alias.oracle.test.ts",
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
    assert containment_steps["Build pinned shared runtime"]["working-directory"] == "gitnexus-shared"
    assert containment_steps["Build pinned shared runtime"]["run"].splitlines() == [
        "npm ci",
        "npm run build",
    ]
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
        "trivial-version-alias",
        "inv-bug-pdg-note",
        "inv-feature-list-repos-filter",
    ]
    assert skipped == ["cross-module-parse-retry"]
    assert all(not task.get("sandbox_copy") for task in tasks)
    assert all(task["sandbox_dependencies"] for task in tasks)
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
