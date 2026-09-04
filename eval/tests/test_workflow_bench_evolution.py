"""Unit tests for workflow benchmark candidate evolution and promotion gates."""

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench.evolution import (
    CANDIDATE_SKILLS,
    MAX_CANDIDATE_ENTRIES,
    apply_candidate_overlay,
    candidate_overlay_digest,
    evaluate_candidate,
    evaluate_review_candidate,
    required_candidate_arms,
    skill_fingerprint,
    unexercised_overlay_skills,
)
from workflow_bench.promotion_apply import MIRROR_SKILL_ROOTS
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

    review = tmp_path / "review"
    write_overlay_skill(review, "gitnexus-review")
    assert required_candidate_arms(review) == ["candidate_review"]


def test_review_gate_is_quality_first_and_requires_repeated_evidence():
    def arm(score, blocker=1.0, false_positives=0, runs=3):
        return {
            "runs": runs,
            "valid_runs": runs,
            "excluded_runs": 0,
            "class": "review-defect",
            "review_weighted_f1": score,
            "review_blocker_recall": blocker,
            "review_false_positives": false_positives,
            "review_clean_control": False,
        }

    decision = evaluate_review_candidate(
        {
            "case-a": {
                "review": arm(0.6),
                "candidate_review": arm(0.8),
            }
        },
        incumbent_arm="review",
        candidate_arm="candidate_review",
        model="pinned-model",
    )
    assert decision["decision"] == "promote"

    regression = evaluate_review_candidate(
        {
            "case-a": {
                "review": arm(0.6, blocker=1.0),
                "candidate_review": arm(0.8, blocker=0.0),
            }
        },
        incumbent_arm="review",
        candidate_arm="candidate_review",
        model="pinned-model",
    )
    assert regression["decision"] == "keep_incumbent"
    assert any("blocker recall" in reason for reason in regression["reasons"])


def test_review_gate_rejects_added_false_positives_on_clean_controls():
    base = {
        "runs": 3,
        "valid_runs": 3,
        "excluded_runs": 0,
        "class": "review-clean",
        "review_weighted_f1": 1.0,
        "review_blocker_recall": 1.0,
        "review_clean_control": True,
        "review_clean_pass": True,
    }
    decision = evaluate_review_candidate(
        {
            "clean": {
                "review": {**base, "review_false_positives": 0},
                "candidate_review": {**base, "review_false_positives": 1, "review_clean_pass": False},
            }
        },
        incumbent_arm="review",
        candidate_arm="candidate_review",
        model="pinned-model",
    )
    assert decision["decision"] == "keep_incumbent"
    assert any("clean control" in reason for reason in decision["reasons"])


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
            "candidate_workflow_direct": aggregate([record(cost_usd=0.1), record(cost_usd=None), record(cost_usd=0.1)]),
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


@pytest.mark.parametrize(
    ("resolved", "expected_decision", "expected_reason"),
    [
        # Nothing resolved anywhere: the task is ungated, which leaves the
        # generation with no quality signal at all — refuse outright rather
        # than rank a 100x cost win across runs that all failed the oracle.
        (0, "insufficient_evidence", "no task supplied quality signal"),
        # Partial success on a task the incumbent also partly resolves stays a
        # quality-floor rejection: the candidate has to be reliable, not lucky.
        (2, "keep_incumbent", "oracle-backed quality floor"),
    ],
)
def test_candidate_gate_never_promotes_zero_or_partial_success_for_efficiency(
    resolved,
    expected_decision,
    expected_reason,
):
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

    assert decision["decision"] == expected_decision
    assert decision["tasks"][0]["candidate_quality_floor_met"] is False
    assert any(expected_reason in reason for reason in decision["reasons"])


def test_a_task_no_arm_can_resolve_is_reported_but_does_not_veto_promotion():
    # inv-feature-list-repos-filter fails its hidden oracle on every run of
    # both arms. Gating on it made promotion unreachable for as long as it
    # stayed in the set, while saying nothing about the candidate.
    solvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=index > 1) for index in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=1.0) for _ in range(3)]),
    }
    unsolvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=1.3, resolved=False) for _ in range(3)]),
    }
    decision = evaluate_candidate(
        {"task-a": solvable, "task-impossible": unsolvable},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["decision"] == "promote"
    assert decision["ungated_tasks"] == ["task-impossible"]
    assert decision["gated_tasks"] == ["task-a"]
    assert [row["gated"] for row in decision["tasks"]] == [True, False]
    # The ungated task's 30% cost regression stays under the failed-task cap
    # but must not reach the median or the (tighter) gated per-task cap.
    assert decision["median_improvement_pct"] == 0.0
    assert not any("above the" in reason for reason in decision["reasons"])
    # One aggregate line, so a growing set of unsolvable tasks cannot crowd the
    # real verdict out of the three reasons the proposer is shown — and it
    # discloses how much of the set the verdict actually rests on.
    assert [reason for reason in decision["reasons"] if "not gated on" in reason] == [
        "not gated on 1 task(s) neither arm resolved: task-impossible (evidence base: 1/2 paired tasks gated)"
    ]


def test_an_ungated_task_still_ranks_against_the_failed_task_cost_cap():
    # Leaving the quality gate is not leaving the spend gate: burning 9x the
    # incumbent's cost to fail the same oracle is a regression the gate has to
    # see, or a candidate can hide unbounded waste inside "task health".
    solvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=index > 1) for index in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=1.0) for _ in range(3)]),
    }
    unsolvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=9.0, resolved=False) for _ in range(3)]),
    }

    decision = evaluate_candidate(
        {"task-a": solvable, "task-impossible": unsolvable},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["decision"] == "keep_incumbent"
    assert decision["ungated_tasks"] == ["task-impossible"]
    assert any("failed-task cap" in reason for reason in decision["reasons"])


def test_a_mutually_failed_task_stays_gated_when_the_skill_never_loaded():
    # skill-not-invoked is prompt evidence, not task health: the skill under
    # test never ran, so the task cannot be written off as beyond both arms.
    results = {
        "task-a": {
            "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
            "candidate_workflow": aggregate(
                [record(cost_usd=0.01, resolved=False, error_kind="skill-not-invoked") for _ in range(3)]
            ),
        }
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["ungated_tasks"] == []
    assert decision["tasks"][0]["gated"] is True
    assert decision["tasks"][0]["skill_attributable_failure"] is True
    # Gated with teeth: the 99% cost "win" must not carry a candidate whose
    # skill never loaded.
    assert decision["decision"] == "keep_incumbent"
    assert any("never invoked the skill under test" in reason for reason in decision["reasons"])


def test_a_mutually_failed_task_stays_gated_when_its_metric_was_never_measured():
    # Ungating is a claim about spend as well as quality. With no measured
    # cost there is nothing to claim, so the task stays in the gate and the
    # missing measurement is named instead of silently skipped.
    results = {
        "task-a": {
            "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
            "candidate_workflow": aggregate(
                [record(cost_usd=None, resolved=False), *(record(cost_usd=0.1, resolved=False) for _ in range(2))]
            ),
        }
    }

    decision = evaluate_candidate(
        results,
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["ungated_tasks"] == []
    assert decision["decision"] == "insufficient_evidence"
    assert any("was not measured on every run" in reason for reason in decision["reasons"])


def test_partial_progress_on_a_task_the_incumbent_never_resolves_is_not_punished():
    # Resolving 1 of 3 runs where the incumbent resolves none is strictly
    # better than resolving none — which the gate ungates and forgives. Holding
    # the partial run to the quality floor made improvement score worse than
    # inaction.
    def outcome(candidate_resolved: int) -> dict[str, object]:
        return evaluate_candidate(
            {
                "task-a": {
                    "workflow": aggregate([record(cost_usd=1.0) for _ in range(3)]),
                    "candidate_workflow": aggregate([record(cost_usd=0.5) for _ in range(3)]),
                },
                "task-hard": {
                    "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
                    "candidate_workflow": aggregate(
                        [record(cost_usd=1.0, resolved=index < candidate_resolved) for index in range(3)]
                    ),
                },
            },
            incumbent_arm="workflow",
            candidate_arm="candidate_workflow",
            model="pinned-model",
        )

    no_progress = outcome(0)
    some_progress = outcome(1)

    assert no_progress["decision"] == "promote"
    assert no_progress["ungated_tasks"] == ["task-hard"]
    # The partial run gives the task quality signal, so it is gated — but as
    # improvement, not as a floor failure the zero-progress candidate escapes.
    assert some_progress["decision"] == "promote"
    assert some_progress["ungated_tasks"] == []
    assert some_progress["tasks"][1]["quality_floor_enforced"] is False
    assert not any("quality floor" in reason for reason in some_progress["reasons"])


def test_promotion_requires_a_gated_majority_of_the_paired_tasks():
    # Two of three tasks written off as task health leaves one task deciding
    # the whole promotion. Ungating keeps promotion reachable; it must not
    # hollow out the evidence base that makes a promotion mean anything.
    solvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=index > 1) for index in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=0.1) for _ in range(3)]),
    }
    unsolvable = {
        "workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
        "candidate_workflow": aggregate([record(cost_usd=1.0, resolved=False) for _ in range(3)]),
    }

    decision = evaluate_candidate(
        {"task-a": solvable, "task-impossible": unsolvable, "task-impossible-2": dict(unsolvable)},
        incumbent_arm="workflow",
        candidate_arm="candidate_workflow",
        model="pinned-model",
    )

    assert decision["decision"] == "insufficient_evidence"
    assert decision["gated_tasks"] == ["task-a"]
    assert any("evidence base is too thin" in reason for reason in decision["reasons"])


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


@pytest.mark.parametrize("skill", sorted(CANDIDATE_SKILLS))
def test_a_promoted_skill_is_visible_to_git_status_in_every_shipped_tree(skill):
    """A promotion the repository cannot see is a promotion that never happens.

    The workflow detects an applied promotion with `git status --porcelain`,
    which is blind to ignored paths, and `.claude/skills/*` is ignored with a
    hand-maintained per-skill allowlist. A candidate skill missing from that
    allowlist would leave the run reporting "No promotion this run" after the
    gate had already said promote — silently, and only after a full generation
    of benchmark spend.
    """
    repo_root = Path(__file__).resolve().parents[2]
    targets = [f".claude/skills/{skill}"] + [f"{root}/{skill}" for root in MIRROR_SKILL_ROOTS]
    ignored = [
        target
        for target in targets
        if subprocess.run(
            ["git", "check-ignore", "-q", f"{target}/SKILL.md"],
            cwd=repo_root,
            check=False,
        ).returncode
        == 0
    ]
    assert ignored == []
