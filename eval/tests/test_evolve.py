"""Unit tests for the pure evidence/apply/driver helpers of workflow_bench.evolve."""

import json
from pathlib import PurePosixPath

import pytest

from workflow_bench.evolve import (
    apply_promoted_overlay,
    build_parser,
    build_proposer_prompt,
    load_jsonl,
    mirror_targets,
    promoted_decisions,
    read_learnings,
    runner_argv,
    select_evidence,
    summarize_gate,
)


def row(**overrides):
    base = {
        "task": "demo-task",
        "class": "trivial",
        "arm": "workflow",
        "run": 0,
        "resolved": True,
        "error_kind": None,
        "cost_usd": 1.0,
        "num_turns": 10,
        "output_tokens": 400,
        "session_ids": ["sess-1"],
        "verify_output": "ok",
    }
    base.update(overrides)
    return base


def test_select_evidence_puts_unresolved_before_expensive_resolved():
    rows = [
        row(task="cheap", resolved=True, cost_usd=0.5),
        row(task="fail", resolved=False, error_kind="verify-failed"),
        row(task="pricey", resolved=True, cost_usd=9.0),
    ]
    picked = select_evidence(rows)
    assert [r["task"] for r in picked] == ["fail", "pricey", "cheap"]


def test_select_evidence_excludes_infra_error_rows_and_caps():
    rows = [row(task="harness-died", resolved=False, error_kind="infra-error")]
    rows += [row(task=f"t{i}", cost_usd=float(i)) for i in range(20)]
    picked = select_evidence(rows, max_rows=5)
    assert len(picked) == 5
    assert all(r["error_kind"] != "infra-error" for r in picked)
    assert [r["task"] for r in picked] == ["t19", "t18", "t17", "t16", "t15"]


def test_select_evidence_tolerates_an_explicit_null_cost():
    # A foreign --seed-results row (e.g. hand-edited or from another tool)
    # can carry an explicit JSON null rather than omitting the key; .get's
    # default only covers the missing-key case, so this must not raise.
    rows = [row(task="no-cost", resolved=True, cost_usd=None), row(task="priced", cost_usd=5.0)]
    picked = select_evidence(rows)
    assert [r["task"] for r in picked] == ["priced", "no-cost"]


def test_load_jsonl_skips_blank_and_malformed_lines(tmp_path):
    path = tmp_path / "learnings.jsonl"
    path.write_text('{"skill": "gitnexus-plan"}\n\nnot json\n[1, 2]\n{"skill": "gitnexus-work"}\n')
    assert load_jsonl(path) == [{"skill": "gitnexus-plan"}, {"skill": "gitnexus-work"}]


def test_load_jsonl_missing_file_is_empty(tmp_path):
    assert load_jsonl(tmp_path / "absent.jsonl") == []


def test_read_learnings_keeps_the_most_recent_entries(tmp_path):
    path = tmp_path / "learnings.jsonl"
    path.write_text("\n".join(json.dumps({"n": i}) for i in range(10)) + "\n")
    assert read_learnings(path, cap=3) == [{"n": 7}, {"n": 8}, {"n": 9}]


def test_summarize_gate_one_line_per_decision():
    promotion = {
        "decisions": [
            {
                "candidate_arm": "candidate_workflow",
                "decision": "keep_incumbent",
                "reasons": ["a", "b", "c", "d"],
            }
        ]
    }
    lines = summarize_gate(promotion)
    assert lines == ["candidate_workflow: keep_incumbent — a; b; c"]


def test_build_proposer_prompt_carries_evidence_constraints_and_paths(tmp_path):
    prompt = build_proposer_prompt(
        results_dir=tmp_path / "bench",
        evidence=[row(task="fail", resolved=False, error_kind="verify-failed")],
        learnings=[{"skill": "gitnexus-work", "friction": "budget blown on reruns"}],
        gate_summary=["candidate_workflow: keep_incumbent — quality regressed"],
        overlay_dir=tmp_path / "overlay",
        proposal_path=tmp_path / "proposal.md",
        incumbent_arms=["workflow"],
    )
    assert str(tmp_path / "overlay") in prompt
    assert str(tmp_path / "proposal.md") in prompt
    assert "gitnexus-plan, gitnexus-work" in prompt
    assert "node .gitnexus/run.cjs analyze" in prompt
    assert "budget blown on reruns" in prompt
    assert "verify-failed" in prompt
    assert "keep_incumbent — quality regressed" in prompt
    assert "~/.claude/projects" in prompt


def test_build_proposer_prompt_first_generation_has_no_results_dir(tmp_path):
    prompt = build_proposer_prompt(
        results_dir=None,
        evidence=[],
        learnings=[],
        gate_summary=[],
        overlay_dir=tmp_path / "overlay",
        proposal_path=tmp_path / "proposal.md",
        incumbent_arms=["workflow_direct"],
    )
    assert "none (first generation)" in prompt
    assert "none yet — propose from the learning queue" in prompt


def test_mirror_targets_cover_canonical_and_shipped_copies():
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    assert targets == [
        PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"),
        PurePosixPath("gitnexus/skills/gitnexus-plan/SKILL.md"),
        PurePosixPath("gitnexus-claude-plugin/skills/gitnexus-plan/SKILL.md"),
    ]


def test_mirror_targets_review_also_lands_in_the_cursor_tree():
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-review/SKILL.md"))
    assert PurePosixPath("gitnexus-cursor-integration/skills/gitnexus-review/SKILL.md") in targets


def test_apply_promoted_overlay_writes_all_mirrors(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("evolved plan skill")
    repo = tmp_path / "repo"

    written = apply_promoted_overlay(overlay, repo_root=repo)

    assert written == [
        ".claude/skills/gitnexus-plan/SKILL.md",
        "gitnexus/skills/gitnexus-plan/SKILL.md",
        "gitnexus-claude-plugin/skills/gitnexus-plan/SKILL.md",
    ]
    contents = {(repo / path).read_text() for path in written}
    assert contents == {"evolved plan skill"}


def test_apply_promoted_overlay_rejects_out_of_boundary_files(tmp_path):
    overlay = tmp_path / "overlay"
    rogue = overlay / ".claude" / "skills" / "not-a-family-skill" / "SKILL.md"
    rogue.parent.mkdir(parents=True)
    rogue.write_text("smuggled")

    with pytest.raises(ValueError, match="may only contain Markdown files"):
        apply_promoted_overlay(overlay, repo_root=tmp_path / "repo")


def test_parser_defaults_match_the_gate_minimums():
    args = build_parser().parse_args(["--tasks", "t.yaml", "--model", "pinned"])
    assert args.runs == 3
    assert args.generations == 1
    assert args.arms == ["workflow", "workflow_direct"]
    assert args.apply is False
    assert args.learnings.name == "learnings.jsonl"


def test_runner_argv_pairs_each_incumbent_with_its_candidate(tmp_path):
    args = build_parser().parse_args(["--tasks", "t.yaml", "--model", "pinned", "--arms", "workflow"])
    argv = runner_argv(args, tmp_path / "bench", tmp_path / "overlay")
    arms = argv[argv.index("--arms") + 1 : argv.index("--promotion-metric")]
    assert arms == ["workflow", "candidate_workflow"]
    assert str(tmp_path / "overlay") in argv
    assert str(tmp_path / "bench") in argv
    assert "pinned" in argv


def test_promoted_decisions_filters_on_decision():
    promotion = {
        "decisions": [
            {"candidate_arm": "candidate_workflow", "decision": "promote"},
            {"candidate_arm": "candidate_workflow_direct", "decision": "keep_incumbent"},
        ]
    }
    assert [d["candidate_arm"] for d in promoted_decisions(promotion)] == ["candidate_workflow"]
