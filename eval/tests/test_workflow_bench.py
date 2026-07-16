"""Unit tests for the pure aggregation/report helpers of workflow_bench."""

import subprocess

import pytest

from workflow_bench.evolution import (
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
)
from workflow_bench.runner import (
    aggregate,
    parse_shortstat,
    render_report,
    savings,
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
    }


def test_savings_is_positive_when_workflow_is_cheaper():
    baseline = aggregate([record(input_tokens=2000, output_tokens=800, cost_usd=1.0)])
    workflow = aggregate([record(input_tokens=1000, output_tokens=400, cost_usd=0.4)])
    s = savings(baseline, workflow)
    assert s["input_tokens"] == 50.0
    assert s["output_tokens"] == 50.0
    assert s["cost_usd"] == 60.0


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


def test_candidate_gate_promotes_quality_preserving_efficiency_gain():
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(output_tokens=1000) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(output_tokens=880) for _ in range(3)]),
        },
        "task-b": {
            "workflow_direct": aggregate([record(output_tokens=800) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(output_tokens=720) for _ in range(3)]),
        },
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
    )

    assert decision["decision"] == "promote"
    assert decision["median_improvement_pct"] == 11.0


def test_candidate_gate_never_trades_resolution_for_lower_cost():
    results = {
        "task-a": {
            "workflow": aggregate([record() for _ in range(3)]),
            "candidate_workflow": aggregate(
                [
                    record(cost_usd=0.1),
                    record(cost_usd=0.1),
                    record(cost_usd=0.1, resolved=False),
                ]
            ),
        }
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
        metric="cost_usd",
    )

    assert decision["decision"] == "keep_incumbent"
    assert any("resolution regressed" in reason for reason in decision["reasons"])


def test_candidate_gate_requires_repeated_runs_and_a_named_model():
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(output_tokens=1000)]),
            "candidate_workflow_direct": aggregate([record(output_tokens=800)]),
        }
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model=None,
    )

    assert decision["decision"] == "insufficient_evidence"
    assert any("named --model" in reason for reason in decision["reasons"])
    assert any("at least 3 runs" in reason for reason in decision["reasons"])


def test_candidate_gate_caps_large_per_task_efficiency_regressions():
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(output_tokens=1000) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(output_tokens=500) for _ in range(3)]),
        },
        "task-b": {
            "workflow_direct": aggregate([record(output_tokens=1000) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(output_tokens=1250) for _ in range(3)]),
        },
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
    )

    assert decision["decision"] == "keep_incumbent"
    assert any("task cap" in reason for reason in decision["reasons"])


def test_candidate_overlay_is_skill_only_and_content_addressed(tmp_path):
    overlay = tmp_path / "candidate"
    skill = overlay / ".claude" / "skills" / "gitnexus-work" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate one\n")

    first = candidate_overlay_digest(overlay)
    skill.write_text("candidate two\n")
    second = candidate_overlay_digest(overlay)

    assert first != second

    review_overlay = tmp_path / "review-candidate"
    review_skill = review_overlay / ".claude" / "skills" / "gitnexus-review" / "SKILL.md"
    review_skill.parent.mkdir(parents=True)
    review_skill.write_text("review candidate\n")
    assert candidate_overlay_digest(review_overlay)

    invalid = tmp_path / "invalid"
    source = invalid / "gitnexus" / "src" / "cli" / "index.ts"
    source.parent.mkdir(parents=True)
    source.write_text("gaming the verifier\n")
    with pytest.raises(ValueError, match="may only contain Markdown files"):
        candidate_overlay_digest(invalid)

    config_overlay = tmp_path / "config-overlay"
    config = config_overlay / ".claude" / "skills" / "gitnexus-work" / "mcp.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}\n")
    with pytest.raises(ValueError, match="may only contain Markdown files"):
        candidate_overlay_digest(config_overlay)


def test_apply_candidate_overlay_creates_a_clean_ephemeral_commit(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    incumbent = repo / ".claude" / "skills" / "gitnexus-work" / "SKILL.md"
    incumbent.parent.mkdir(parents=True)
    incumbent.write_text("incumbent\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "--quiet",
            "-m",
            "incumbent",
        ],
        check=True,
    )

    overlay = tmp_path / "candidate"
    candidate = overlay / ".claude" / "skills" / "gitnexus-work" / "SKILL.md"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("candidate\n")

    assert apply_candidate_overlay(overlay, repo) == candidate_overlay_digest(overlay)
    assert incumbent.read_text() == "candidate\n"
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert status.stdout == ""


# ─── run_claude fail-closed on malformed session reports (#2431 review) ─────


def fake_cli_result(stdout: str):
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


VALID_REPORT = (
    '{"session_id": "s", "num_turns": 3, "total_cost_usd": 0.1, "duration_ms": 1000,'
    ' "usage": {"input_tokens": 1, "cache_creation_input_tokens": 2,'
    ' "cache_read_input_tokens": 3, "output_tokens": 4}}'
)


@pytest.mark.parametrize(
    ("stdout", "expected_ok"),
    [
        (VALID_REPORT, True),
        ("", False),  # empty output
        ("not json", False),  # malformed JSON
        ('{"session_id": "s", "num_turns": 3}', False),  # missing usage entirely
        ('{"usage": {"input_tokens": 1}}', False),  # usage missing required fields
    ],
)
def test_run_claude_fails_closed_on_bad_reports(monkeypatch, tmp_path, stdout, expected_ok):
    from workflow_bench import runner

    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: fake_cli_result(stdout))
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["ok"] is expected_ok
