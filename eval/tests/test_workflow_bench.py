"""Unit tests for the pure aggregation/report helpers of workflow_bench."""

import argparse
import json
import subprocess
from pathlib import Path

import pytest

from workflow_bench import runner
from workflow_bench.evolution import (
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    unexercised_overlay_skills,
)
from workflow_bench.runner import (
    aggregate,
    build_parser,
    infra_error_record,
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
        "valid_runs": 3,
        "excluded_runs": 0,
        "transcripts_missing": 0,
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
    assert "subagent spend" in report  # token columns are main-loop-only


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
        metric="output_tokens",
    )

    assert decision["decision"] == "promote"
    assert decision["median_improvement_pct"] == 11.0
    assert "subagent" in decision["metric_warning"]


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
    assert any("at least 3 valid runs" in reason for reason in decision["reasons"])


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
        metric="output_tokens",
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
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: fake_cli_result(stdout))
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["ok"] is expected_ok


# ─── error_kind provenance on rows (#2431 review, finding 2/6) ───────────────


def report_variant(**extra):
    data = json.loads(VALID_REPORT)
    data.update(extra)
    return json.dumps(data)


def session_record(**overrides):
    base = {
        "input_tokens": 10,
        "cache_creation_input_tokens": 1,
        "cache_read_input_tokens": 2,
        "output_tokens": 5,
        "cost_usd": 0.1,
        "duration_s": 1.0,
        "num_turns": 2,
        "ok": True,
        "session_id": "sess",
        "error_kind": None,
        "error_detail": None,
    }
    base.update(overrides)
    return base


def bench_args(**overrides):
    base = {
        "claude_bin": "claude",
        "timeout": 5,
        "model": None,
        "base_url": None,
        "auth_token": None,
        "permission_mode": None,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


@pytest.mark.parametrize(
    ("proc", "expected_kind"),
    [
        (subprocess.CompletedProcess([], 0, VALID_REPORT, ""), None),
        (subprocess.CompletedProcess([], 1, VALID_REPORT, "boom"), "session-error"),
        (subprocess.CompletedProcess([], 0, report_variant(is_error=True), ""), "session-error"),
        (subprocess.CompletedProcess([], 0, report_variant(subtype="error_max_turns"), ""), "session-error"),
        (subprocess.CompletedProcess([], 0, "", ""), "session-error"),  # malformed report
    ],
)
def test_run_claude_records_error_kind(monkeypatch, tmp_path, proc, expected_kind):
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: proc)
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["error_kind"] == expected_kind


def test_run_claude_keeps_raw_subtype_and_stderr_tail(monkeypatch, tmp_path):
    proc = subprocess.CompletedProcess([], 1, VALID_REPORT, "rate limit hit")
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: proc)
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["error_detail"] == {
        "subtype": None,
        "returncode": 1,
        "stderr_tail": "rate limit hit",
    }


def test_run_arm_labels_completed_but_unverified_runs_verify_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: session_record())
    rec = runner.run_arm("baseline", {"prompt": "p", "verify": "exit 1"}, tmp_path, bench_args())
    assert rec["ok"] is True
    assert rec["resolved"] is False
    assert rec["error_kind"] == "verify-failed"


def test_run_arm_keeps_session_error_kind_over_verify(monkeypatch, tmp_path):
    dead = session_record(ok=False, error_kind="session-error", error_detail={"subtype": "error_max_turns"})
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: dict(dead))
    rec = runner.run_arm("baseline", {"prompt": "p", "verify": "exit 0"}, tmp_path, bench_args())
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "session-error"


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


# ─── promotion gate provenance and noise floor (#2431 review, 1/2/5) ─────────


def test_cli_promotion_metric_defaults_to_cost_usd():
    args = build_parser().parse_args(["--tasks", "tasks.yaml"])
    assert args.promotion_metric == "cost_usd"


def test_candidate_gate_defaults_to_cost_usd_without_a_warning():
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(cost_usd=1.0) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(cost_usd=0.5) for _ in range(3)]),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
    )
    assert decision["metric"] == "cost_usd"
    assert decision["metric_warning"] is None
    assert decision["decision"] == "promote"


def test_candidate_gate_requires_equal_valid_run_counts():
    results = {
        "task-a": {
            "workflow": aggregate([record() for _ in range(4)]),
            "candidate_workflow": aggregate(
                [
                    record(),
                    record(),
                    record(),
                    record(resolved=False, error_kind="session-error"),
                ]
            ),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )
    assert decision["decision"] == "insufficient_evidence"
    assert any("different valid run counts" in reason for reason in decision["reasons"])
    assert decision["tasks"][0]["candidate_excluded_runs"] == 1
    assert decision["tasks"][0]["incumbent_excluded_runs"] == 0


def test_candidate_gate_treats_a_one_run_resolution_edge_as_noise():
    results = {
        "task-a": {
            "workflow": aggregate([record(), record(resolved=False), record(resolved=False)]),
            "candidate_workflow": aggregate([record(), record(), record(resolved=False)]),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )
    assert decision["decision"] == "keep_incumbent"
    assert any("noise floor" in reason for reason in decision["reasons"])


def test_candidate_gate_promotes_on_a_two_run_resolution_margin():
    results = {
        "task-a": {
            "workflow": aggregate([record(), record(resolved=False), record(resolved=False)]),
            "candidate_workflow": aggregate([record() for _ in range(3)]),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )
    assert decision["decision"] == "promote"
    assert any("at least 2 required" in reason for reason in decision["reasons"])


# ─── overlay-arm consistency (#2431 review, finding 3) ───────────────────────


def write_overlay_skill(overlay: Path, skill: str) -> None:
    path = overlay / ".claude" / "skills" / skill / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text(f"{skill} candidate\n")


def test_overlay_skills_must_be_exercised_by_selected_candidate_arms(tmp_path):
    overlay = tmp_path / "overlay"
    write_overlay_skill(overlay, "gitnexus-lfg")
    write_overlay_skill(overlay, "gitnexus-work")
    assert unexercised_overlay_skills(overlay, ["candidate_workflow_direct"]) == ["gitnexus-lfg"]
    assert unexercised_overlay_skills(overlay, ["candidate_workflow"]) == ["gitnexus-lfg"]

    plan_overlay = tmp_path / "plan-overlay"
    write_overlay_skill(plan_overlay, "gitnexus-plan")
    assert unexercised_overlay_skills(plan_overlay, ["candidate_workflow_direct"]) == ["gitnexus-plan"]
    assert unexercised_overlay_skills(plan_overlay, ["candidate_workflow"]) == []


# ─── skill-invocation verification (#2431 review, finding 4) ─────────────────


def write_transcript(home: Path, session_id: str, blocks) -> Path:
    path = home / ".claude" / "projects" / "some-slug" / f"{session_id}.jsonl"
    path.parent.mkdir(parents=True)
    events = [
        {"type": "assistant", "message": {"id": "m1", "content": [block]}}
        for block in blocks
    ]
    path.write_text("\n".join(json.dumps(event) for event in events) + "\n")
    return path


def set_fake_home(monkeypatch, home: Path) -> None:
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


def test_skill_invocation_is_detected_from_the_transcript(monkeypatch, tmp_path):
    set_fake_home(monkeypatch, tmp_path)
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: fake_cli_result(VALID_REPORT))
    write_transcript(
        tmp_path, "s", [{"type": "tool_use", "name": "Skill", "input": {"command": "gitnexus-work"}}]
    )
    rec = runner.run_claude(
        "task", tmp_path, claude_bin="claude", timeout=5, expected_skill="gitnexus-work"
    )
    assert rec["ok"] is True
    assert rec["skill_invoked"] is True
    assert rec["error_kind"] is None


def test_missing_skill_invocation_fails_closed(monkeypatch, tmp_path):
    set_fake_home(monkeypatch, tmp_path)
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: fake_cli_result(VALID_REPORT))
    write_transcript(
        tmp_path, "s", [{"type": "tool_use", "name": "Read", "input": {"file_path": "x"}}]
    )
    rec = runner.run_claude(
        "task", tmp_path, claude_bin="claude", timeout=5, expected_skill="gitnexus-work"
    )
    assert rec["ok"] is False
    assert rec["skill_invoked"] is False
    assert rec["error_kind"] == "skill-not-invoked"


def test_unlocatable_transcript_records_null_without_failing(monkeypatch, tmp_path):
    set_fake_home(monkeypatch, tmp_path)
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: fake_cli_result(VALID_REPORT))
    rec = runner.run_claude(
        "task", tmp_path, claude_bin="claude", timeout=5, expected_skill="gitnexus-work"
    )
    assert rec["ok"] is True
    assert rec["skill_invoked"] is None
    assert rec["error_kind"] is None
