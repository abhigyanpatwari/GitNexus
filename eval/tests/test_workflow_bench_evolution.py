"""Unit tests for workflow benchmark candidate evolution and promotion gates."""

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench.evolution import (
    MAX_CANDIDATE_ENTRIES,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    required_candidate_arms,
    skill_fingerprint,
    unexercised_overlay_skills,
)
from workflow_bench.process_control import ManagedProcessResult
from workflow_bench.runner import aggregate, build_parser


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


def write_overlay_skill(overlay: Path, skill: str) -> None:
    path = overlay / ".claude" / "skills" / skill / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text(f"{skill} candidate\n")


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


def test_num_turns_metric_carries_main_loop_only_warning():
    # num_turns is a main-loop-only count like output_tokens, so selecting it
    # must warn that subagent turns are invisible.
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(num_turns=10) for _ in range(3)]),
            "candidate_workflow_direct": aggregate([record(num_turns=8) for _ in range(3)]),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
        metric="num_turns",
    )
    assert decision["metric"] == "num_turns"
    assert decision["metric_warning"] is not None
    assert "subagent" in decision["metric_warning"]
    cost_decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
        metric="duration_s",
    )
    assert cost_decision["metric_warning"] is None


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
    with pytest.raises(ValueError, match="plan,work"):
        candidate_overlay_digest(review_overlay)

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


@pytest.mark.skipif(os.name == "nt", reason="overlay symlink coverage is POSIX-only")
def test_candidate_overlay_rejects_a_linked_root(tmp_path):
    real_overlay = tmp_path / "real-overlay"
    write_overlay_skill(real_overlay, "gitnexus-work")
    linked_overlay = tmp_path / "linked-overlay"
    linked_overlay.symlink_to(real_overlay, target_is_directory=True)

    with pytest.raises(ValueError, match="cannot traverse symlinks"):
        candidate_overlay_digest(linked_overlay)


def test_candidate_overlay_bounds_directory_traversal(tmp_path):
    overlay = tmp_path / "candidate"
    write_overlay_skill(overlay, "gitnexus-work")
    padding = overlay / "padding"
    padding.mkdir()
    for index in range(MAX_CANDIDATE_ENTRIES):
        (padding / f"entry-{index}").mkdir()

    with pytest.raises(ValueError, match="entry limit"):
        candidate_overlay_digest(overlay)


def test_required_candidate_arms_are_minimal_for_touched_skills(tmp_path):
    plan = tmp_path / "plan"
    write_overlay_skill(plan, "gitnexus-plan")
    assert required_candidate_arms(plan) == ["candidate_workflow"]

    work = tmp_path / "work"
    write_overlay_skill(work, "gitnexus-work")
    assert required_candidate_arms(work) == [
        "candidate_workflow",
        "candidate_workflow_direct",
    ]


@pytest.mark.skipif(os.name == "nt", reason="candidate overlays require the Linux outer sandbox")
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
    hook_sentinel = tmp_path / "post-commit-ran"
    post_commit = repo / ".git" / "hooks" / "post-commit"
    post_commit.write_text(f"#!/bin/sh\ntouch '{hook_sentinel}'\n")
    post_commit.chmod(0o755)

    class LocalSandbox:
        def __init__(self):
            self.clone = repo
            self.commands: list[list[str]] = []

        def run(self, command, **kwargs):
            self.commands.append(list(command))
            if command[0] == "/bin/mkdir":
                return ManagedProcessResult(
                    state="exited",
                    returncode=0,
                    stdout_tail="",
                    stderr_tail="",
                    duration_s=0.0,
                )
            translated = [str(repo) if item == "/workspace" else item for item in command]
            completed = subprocess.run(
                translated,
                cwd=repo,
                env=dict(kwargs["env"]),
                capture_output=True,
                text=True,
                check=False,
            )
            return ManagedProcessResult(
                state="exited",
                returncode=completed.returncode,
                stdout_tail=completed.stdout,
                stderr_tail=completed.stderr,
                duration_s=0.0,
            )

    sandbox = LocalSandbox()
    assert apply_candidate_overlay(
        overlay,
        repo,
        sandbox=sandbox,
    ) == candidate_overlay_digest(overlay)
    assert incumbent.read_text() == "candidate\n"
    git_commands = [command for command in sandbox.commands if command[0] == "/usr/bin/git"]
    assert [command[-1] for command in git_commands[:2]] == [
        ".claude/skills/gitnexus-work/SKILL.md",
        "--",
    ]
    assert all("/workspace" in command for command in git_commands)
    assert all("core.fsmonitor=false" in command for command in git_commands)
    assert all("core.hooksPath=/tmp/wfbench-empty-hooks" in command for command in git_commands)
    assert not hook_sentinel.exists()
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert status.stdout == ""


@pytest.mark.skipif(os.name == "nt", reason="candidate overlays require the Linux outer sandbox")
def test_candidate_overlay_rejects_linked_destination_parents(tmp_path):
    repo = tmp_path / "repo"
    outside = tmp_path / "outside"
    (repo / ".claude").mkdir(parents=True)
    outside.mkdir()
    (repo / ".claude" / "skills").symlink_to(outside, target_is_directory=True)
    overlay = tmp_path / "candidate"
    write_overlay_skill(overlay, "gitnexus-work")
    sandbox = SimpleNamespace(
        clone=repo,
        run=lambda *args, **kwargs: pytest.fail("sandbox git must not run"),
    )

    with pytest.raises(ValueError, match="destination parent"):
        apply_candidate_overlay(overlay, repo, sandbox=sandbox)


@pytest.mark.skipif(os.name == "nt", reason="skill links are rejected by the Linux sandbox harness")
def test_skill_fingerprint_rejects_linked_skill_roots(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("outside\n")
    skills = tmp_path / "repo" / ".claude" / "skills"
    skills.mkdir(parents=True)
    (skills / "gitnexus-work").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="non-symlink directory"):
        skill_fingerprint(tmp_path / "repo", "workflow_direct")


def test_cleanup_failures_do_not_count_toward_candidate_evidence():
    incumbent = aggregate([record(cost_usd=1.0) for _ in range(3)])
    candidate = aggregate(
        [
            record(cost_usd=0.5),
            record(cost_usd=0.7),
            record(cost_usd=100.0, resolved=False, error_kind="cleanup-failure"),
        ]
    )

    assert candidate["cost_usd"] == 0.6
    assert candidate["valid_runs"] == 2
    assert candidate["excluded_runs"] == 1
    decision = evaluate_candidate(
        {"task": {"workflow": incumbent, "candidate_workflow": candidate}},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )
    assert decision["decision"] == "insufficient_evidence"
    assert any("needs at least 3 valid runs" in reason for reason in decision["reasons"])
    assert any("different valid run counts" in reason for reason in decision["reasons"])


def test_cli_promotion_metric_defaults_to_cost_usd():
    args = build_parser().parse_args(["--tasks", "tasks.yaml", "--model", "pinned-model"])
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


def test_aggregate_cost_unavailable_when_any_run_unmeasured():
    # One otherwise-valid run whose cost was never measured makes the whole
    # aggregate cost unavailable, rather than collapsing to a real median.
    agg = aggregate([record(cost_usd=0.5), record(cost_usd=None), record(cost_usd=0.5)])
    assert agg["cost_usd"] is None
    measured = aggregate([record(cost_usd=0.5) for _ in range(3)])
    assert measured["cost_usd"] == 0.5


def test_candidate_gate_refuses_promotion_on_unmeasured_cost():
    # Candidate looks cheapest only because one run reported no cost — the gate
    # must refuse to rank on cost_usd instead of promoting a phantom saving.
    results = {
        "task-a": {
            "workflow_direct": aggregate([record(cost_usd=1.0) for _ in range(3)]),
            "candidate_workflow_direct": aggregate(
                [record(cost_usd=0.1), record(cost_usd=None), record(cost_usd=0.1)]
            ),
        }
    }
    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow_direct",
        candidate_arm="candidate_workflow_direct",
        model="pinned-model",
    )
    assert decision["metric"] == "cost_usd"
    assert decision["decision"] == "insufficient_evidence"
    assert any("was not measured on every run" in reason for reason in decision["reasons"])


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


def test_candidate_gate_rejects_any_excluded_candidate_evidence_even_with_three_clean_successes():
    incumbent = aggregate([record(cost_usd=1.0) for _ in range(3)])
    candidate = aggregate(
        [record(cost_usd=0.01) for _ in range(3)]
        + [
            record(
                cost_usd=0.0,
                resolved=False,
                error_kind="evidence-unverified",
            )
            for _ in range(7)
        ]
    )

    decision = evaluate_candidate(
        {"task-a": {"workflow": incumbent, "candidate_workflow": candidate}},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert candidate["valid_runs"] == 3
    assert candidate["resolved"] == 3
    assert decision["decision"] == "insufficient_evidence"
    assert any("zero excluded runs" in reason for reason in decision["reasons"])


def test_candidate_gate_rejects_a_partial_candidate_even_with_a_resolution_edge():
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
    assert any("oracle-backed quality floor" in reason for reason in decision["reasons"])


@pytest.mark.parametrize("resolved", [0, 2])
def test_candidate_gate_never_promotes_zero_or_partial_success_for_efficiency(resolved):
    incumbent_records = [record(cost_usd=1.0, resolved=index < resolved) for index in range(3)]
    candidate_records = [record(cost_usd=0.01, resolved=index < resolved) for index in range(3)]
    decision = evaluate_candidate(
        {
            "task-a": {
                "workflow": aggregate(incumbent_records),
                "candidate_workflow": aggregate(candidate_records),
            }
        },
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["decision"] == "keep_incumbent"
    assert decision["tasks"][0]["candidate_quality_floor_met"] is False
    assert any("oracle-backed quality floor" in reason for reason in decision["reasons"])


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


def test_overlay_skills_must_be_exercised_by_selected_candidate_arms(tmp_path):
    plan_overlay = tmp_path / "plan-overlay"
    write_overlay_skill(plan_overlay, "gitnexus-plan")
    assert unexercised_overlay_skills(plan_overlay, ["candidate_workflow_direct"]) == ["gitnexus-plan"]
    assert unexercised_overlay_skills(plan_overlay, ["candidate_workflow"]) == []
