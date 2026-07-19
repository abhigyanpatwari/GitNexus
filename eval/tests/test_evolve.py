"""Unit tests for the pure evidence/apply/driver helpers of workflow_bench.evolve."""

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta

import pytest

from workflow_bench import evolve
from workflow_bench.runner_sessions import PARENT_EVENT_STREAM_SOURCE
from workflow_bench.evolve import (
    build_parser,
    build_proposer_prompt,
    generation_timeout_seconds,
    load_jsonl,
    proposer_evidence_entries,
    read_learnings,
    resolve_incumbent_arms,
    runner_argv,
    select_evidence,
    summarize_gate,
    validate_promotion_for_apply,
)
from workflow_bench.process_control import run_managed
from workflow_bench.proposer_sandbox import pid_namespace_command, preflight_bubblewrap


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
    rows = [
        row(task="harness-died", resolved=False, error_kind="infra-error"),
        row(task="session-died", resolved=False, error_kind="session-error"),
        row(
            task="missing-transcript",
            resolved=False,
            error_kind="evidence-unverified",
        ),
    ]
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
    rows = [{"skill": "gitnexus-work", "n": i} for i in range(10)] + [
        {"skill": "gitnexus-review", "n": 10},
        {"skill": "gitnexus-lfg", "n": 11},
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    assert read_learnings(path, cap=3) == [
        {"skill": "gitnexus-work", "n": 7},
        {"skill": "gitnexus-work", "n": 8},
        {"skill": "gitnexus-work", "n": 9},
    ]


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
    assert "1 row(s) in /evidence/learnings.json" in prompt
    assert "1 selected row(s) in /evidence/selected-rows.json" in prompt
    assert "1 decision(s) in /evidence/gate-summary.json" in prompt
    assert "budget blown on reruns" not in prompt
    assert "verify-failed" not in prompt
    assert "~/.claude/projects" not in prompt


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
    assert "none yet — use the incumbent skills and staged learning queue" in prompt


def test_proposer_reads_only_digest_bound_transcripts_below_results(tmp_path, monkeypatch):
    results = tmp_path / "results"
    transcripts = results / "transcripts"
    transcripts.mkdir(parents=True, mode=0o700)
    transcripts.chmod(0o700)
    payload = b'{"message":{"content":[{"type":"text","text":"bound transcript"}]}}\n'
    artifact = transcripts / "task-workflow-run0-session.jsonl"
    artifact.write_bytes(payload)
    artifact.chmod(0o600)
    metadata = {
        "path": "transcripts/task-workflow-run0-session.jsonl",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "source": PARENT_EVENT_STREAM_SOURCE,
    }
    foreign_home = tmp_path / "foreign-home"
    foreign = foreign_home / ".claude" / "projects" / "other" / "private.jsonl"
    foreign.parent.mkdir(parents=True)
    foreign.write_text("foreign host transcript")
    monkeypatch.setenv("HOME", str(foreign_home))

    entries = proposer_evidence_entries(
        results_dir=results,
        evidence=[row(session_ids=["**/*"], transcript_artifacts=[metadata])],
        learnings=[],
        gate_summary=[],
    )

    assert entries["transcript-0-0.jsonl"] == payload.decode()
    assert "foreign host transcript" not in json.dumps(entries)

    bad_digest = {**metadata, "sha256": "0" * 64}
    with pytest.raises(evolve.SandboxError, match="digest does not match"):
        proposer_evidence_entries(
            results_dir=results,
            evidence=[row(transcript_artifacts=[bad_digest])],
            learnings=[],
            gate_summary=[],
        )


@pytest.mark.skipif(os.name == "nt", reason="transcript symlink containment is POSIX-only")
def test_proposer_rejects_symlink_and_foreign_transcript_artifacts(tmp_path):
    results = tmp_path / "results"
    transcripts = results / "transcripts"
    transcripts.mkdir(parents=True, mode=0o700)
    transcripts.chmod(0o700)
    outside = tmp_path / "outside.jsonl"
    outside.write_text("outside")
    linked = transcripts / "linked.jsonl"
    linked.symlink_to(outside)
    link_metadata = {
        "path": "transcripts/linked.jsonl",
        "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
        "bytes": outside.stat().st_size,
        "source": PARENT_EVENT_STREAM_SOURCE,
    }

    with pytest.raises(evolve.SandboxError, match="regular non-symlink"):
        proposer_evidence_entries(
            results_dir=results,
            evidence=[row(transcript_artifacts=[link_metadata])],
            learnings=[],
            gate_summary=[],
        )
    with pytest.raises(evolve.SandboxError, match="unsafe results artifact path"):
        proposer_evidence_entries(
            results_dir=results,
            evidence=[
                row(
                    transcript_artifacts=[
                        {
                            "path": "../outside.jsonl",
                            "sha256": "0" * 64,
                            "bytes": 0,
                            "source": PARENT_EVENT_STREAM_SOURCE,
                        }
                    ]
                )
            ],
            learnings=[],
            gate_summary=[],
        )


def test_proposer_rejects_duplicate_transcript_metadata_before_materializing():
    metadata = {
        "path": "transcripts/repeated.jsonl",
        "sha256": "0" * 64,
        "bytes": 0,
        "source": PARENT_EVENT_STREAM_SOURCE,
    }

    with pytest.raises(evolve.SandboxError, match="duplicate transcript artifact path"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[
                row(
                    transcript_artifacts=[
                        metadata,
                        {**metadata, "path": "transcripts//repeated.jsonl"},
                    ]
                )
            ],
            learnings=[],
            gate_summary=[],
        )


def test_proposer_bounds_transcript_metadata_per_row_and_globally_before_materializing():
    def metadata(index):
        return {
            "path": f"transcripts/session-{index}.jsonl",
            "sha256": "0" * 64,
            "bytes": 0,
            "source": PARENT_EVENT_STREAM_SOURCE,
        }

    with pytest.raises(evolve.SandboxError, match="per-row session limit"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[row(transcript_artifacts=[metadata(index) for index in range(3)])],
            learnings=[],
            gate_summary=[],
        )

    rows = [
        row(
            run=index,
            transcript_artifacts=[metadata(2 * index), metadata(2 * index + 1)],
        )
        for index in range(evolve.MAX_EVIDENCE_ROWS + 1)
    ]
    with pytest.raises(evolve.SandboxError, match="global evidence limit"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=rows,
            learnings=[],
            gate_summary=[],
        )


def test_parser_defaults_match_the_gate_minimums():
    args = build_parser().parse_args(["--tasks", "t.yaml", "--model", "pinned"])
    assert args.runs == 3
    assert args.generations == 1
    assert args.arms is None
    assert args.apply is False
    assert args.learnings.name == "learnings.jsonl"


@pytest.mark.parametrize(
    "arguments",
    [
        ["--model", "Auto"],
        ["--model", "provider/latest"],
        ["--model", "pinned-model", "--proposer-model", "vendor@LATEST"],
    ],
)
def test_evolve_rejects_mutable_model_aliases(monkeypatch, tmp_path, capsys, arguments):
    monkeypatch.setattr(
        sys,
        "argv",
        ["workflow_bench.evolve", "--tasks", str(tmp_path / "missing.yaml"), *arguments],
    )
    with pytest.raises(SystemExit):
        evolve.main()
    assert "mutable auto/latest" in capsys.readouterr().err


def test_evolve_proposer_failure_returns_nonzero(monkeypatch, tmp_path):
    tasks = tmp_path / "tasks.yaml"
    tasks.write_text(
        """tasks:
  - id: demo
    class: test
    repo: .
    prompt: implement
    verify: "true"
    oracle:
      command: "true"
      files:
        - source: hidden.test.ts
          target: hidden.test.ts
"""
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "workflow_bench.evolve",
            "--tasks",
            str(tasks),
            "--model",
            "pinned-model",
            "--out-root",
            str(tmp_path / "out"),
        ],
    )
    monkeypatch.setattr(evolve.runner, "selected_task_bindings", lambda _tasks: [{"id": "demo"}])
    monkeypatch.setattr(evolve, "preflight_bubblewrap", lambda: tmp_path / "bwrap")
    monkeypatch.setattr(evolve, "require_claude_sandbox_helpers", lambda: None)
    monkeypatch.setattr(
        evolve,
        "run_proposer",
        lambda *args, **kwargs: {"ok": False, "error_detail": "proposer failed"},
    )

    assert evolve.main() == 1


def test_runner_argv_pairs_each_incumbent_with_its_candidate(tmp_path):
    args = build_parser().parse_args(
        [
            "--tasks",
            "t.yaml",
            "--model",
            "pinned",
            "--arms",
            "workflow",
            "--include-expensive",
        ]
    )
    overlay = tmp_path / "overlay"
    skill = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate")
    task_bindings = [{"id": "task", "resolved_sha": "a" * 40}]
    target_bases = {".claude/skills/gitnexus-plan/SKILL.md": "b" * 64}
    argv = runner_argv(
        args,
        tmp_path / "bench",
        overlay,
        task_bindings=task_bindings,
        target_base_digests=target_bases,
        proposer_model="pinned",
    )
    arms = argv[argv.index("--arms") + 1 : argv.index("--promotion-metric")]
    assert arms == ["workflow", "candidate_workflow"]
    assert str(overlay) in argv
    assert str(tmp_path / "bench") in argv
    assert "pinned" in argv
    assert argv[argv.index("--proposer-model") + 1] == "pinned"
    assert "--include-expensive" in argv
    assert json.loads(argv[argv.index("--task-bindings-json") + 1]) == task_bindings
    assert json.loads(argv[argv.index("--promotion-target-bases-json") + 1]) == target_bases


def test_runner_argv_omits_proposer_for_manual_overlay(tmp_path):
    args = build_parser().parse_args(["--tasks", "t.yaml", "--model", "pinned"])
    overlay = tmp_path / "overlay"
    skill = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate")

    argv = runner_argv(
        args,
        tmp_path / "bench",
        overlay,
        task_bindings=[{"id": "task"}],
        target_base_digests={},
        proposer_model=None,
    )

    assert "--proposer-model" not in argv


def test_runner_argv_keeps_task_commit_pinned_when_ref_moves(tmp_path):
    repo = tmp_path / "task-repo"
    repo.mkdir()

    def git(*arguments):
        return subprocess.run(
            ["git", "-C", str(repo), *arguments],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-b", "main")
    git("config", "user.name", "Workflow Bench Test")
    git("config", "user.email", "workflow-bench@example.invalid")
    tracked = repo / "tracked.txt"
    tracked.write_text("one")
    git("add", "tracked.txt")
    git("commit", "-m", "first")
    first_sha = git("rev-parse", "HEAD")
    task = {
        "id": "moving-ref",
        "class": "test",
        "repo": str(repo),
        "ref": "main",
        "prompt": "test prompt",
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
    bindings = evolve.runner.selected_task_bindings([task])

    tracked.write_text("two")
    git("commit", "-am", "second")
    assert git("rev-parse", "main") != first_sha

    args = build_parser().parse_args(["--tasks", "t.yaml", "--model", "pinned"])
    overlay = tmp_path / "overlay"
    skill = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate")
    argv = runner_argv(
        args,
        tmp_path / "bench",
        overlay,
        task_bindings=bindings,
        target_base_digests={},
    )
    forwarded = json.loads(argv[argv.index("--task-bindings-json") + 1])

    assert forwarded[0]["resolved_sha"] == first_sha
    assert evolve.runner.resolve_task_bindings([task], forwarded)[0]["resolved_sha"] == first_sha


def test_generation_timeout_budgets_three_task_workflow_pair():
    timeout = generation_timeout_seconds(
        task_count=3,
        runs=3,
        session_timeout=3600,
        incumbent_arms=["workflow"],
    )

    per_task_preparation = (
        evolve.TASK_BINDING_GIT_PHASES * evolve.GIT_COMMAND_TIMEOUT_SECONDS
        + 2 * evolve.TASK_SNAPSHOT_TIMEOUT_SECONDS
        + evolve.WORKTREE_PREPARATION_TIMEOUT_SECONDS
        + evolve.GRAPH_SOURCE_PREPARATION_TIMEOUT_SECONDS
        + evolve.GRAPH_BUILD_TIMEOUT_SECONDS
        + 2 * evolve.GRAPH_QUERY_TIMEOUT_SECONDS
        + evolve.CLEANUP_TIMEOUT_SECONDS
    )
    paired_arm_cells = 2
    session_slots = 4
    workspace_snapshot_slots = 4
    per_task_run = session_slots * (3600 + evolve.SESSION_FINALIZATION_TIMEOUT_SECONDS) + paired_arm_cells * (
        evolve.WORKTREE_PREPARATION_TIMEOUT_SECONDS
        + evolve.ARM_ASSET_MATERIALIZATION_PHASES * evolve.TASK_SNAPSHOT_TIMEOUT_SECONDS
        + evolve.SETUP_TIMEOUT_SECONDS
        + 2 * 3600
        + evolve.ARM_EVIDENCE_GIT_PHASES * evolve.GIT_COMMAND_TIMEOUT_SECONDS
        + evolve.CLEANUP_TIMEOUT_SECONDS
    )
    per_task_run += workspace_snapshot_slots * evolve.TASK_SNAPSHOT_TIMEOUT_SECONDS
    per_task_run += evolve.CANDIDATE_OVERLAY_GIT_PHASES * evolve.GIT_COMMAND_TIMEOUT_SECONDS

    assert timeout == (
        evolve.PROMOTION_BASE_TIMEOUT_SECONDS
        + 3 * (per_task_preparation + 3 * per_task_run)
        + evolve.DRIVER_OVERHEAD_SECONDS
    )
    # The old deadline omitted clone sanitization entirely. Every graph seed
    # and every paired arm cell must now receive the full bounded envelope.
    assert timeout >= 3 * (1 + 3 * paired_arm_cells) * evolve.WORKTREE_PREPARATION_TIMEOUT_SECONDS


@pytest.mark.skipif(sys.platform != "linux", reason="Bubblewrap PID namespaces require Linux")
def test_outer_runner_pid_namespace_kills_setsid_descendant(tmp_path):
    try:
        bwrap = preflight_bubblewrap()
    except evolve.SandboxError as exc:
        pytest.skip(str(exc))
        raise AssertionError("pytest.skip() returned unexpectedly")
    sentinel = tmp_path / "escaped"
    child = (
        "import os,subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(1);pathlib.Path({str(sentinel)!r}).touch()\"],preexec_fn=os.setsid); "
        "time.sleep(10)"
    )
    result = run_managed(
        pid_namespace_command([sys.executable, "-c", child], bwrap_bin=bwrap),
        timeout=0.15,
        terminate_grace=0.1,
        require_pid_namespace=True,
    )
    time.sleep(1.1)

    assert not result.ok
    assert result.state in {"timeout", "forced-kill"}
    assert not sentinel.exists()


def test_resolve_incumbent_arms_rejects_incomplete_and_extra_explicit_sets(tmp_path):
    plan = tmp_path / "plan"
    plan_skill = plan / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    plan_skill.parent.mkdir(parents=True)
    plan_skill.write_text("plan")
    assert resolve_incumbent_arms(plan, None) == ["workflow"]
    with pytest.raises(ValueError, match="exactly"):
        resolve_incumbent_arms(plan, ["workflow", "workflow_direct"])

    work = tmp_path / "work"
    work_skill = work / ".claude" / "skills" / "gitnexus-work" / "SKILL.md"
    work_skill.parent.mkdir(parents=True)
    work_skill.write_text("work")
    assert resolve_incumbent_arms(work, None) == ["workflow", "workflow_direct"]
    with pytest.raises(ValueError, match="exactly"):
        resolve_incumbent_arms(work, ["workflow"])


def bound_task_fixture():
    return {
        "id": "task",
        "prompt_digest": "prompt",
        "oracle_digest": "a" * 64,
        "oracle_command_digest": "b" * 64,
        "oracle_manifest_digest": "c" * 64,
        "sandbox_dependency_content_digest": "e" * 64,
        "sandbox_dependency_manifest_digest": "f" * 64,
        "oracle_files": [{"target": "oracle.test.ts", "sha256": "d" * 64, "size": 10}],
    }


def promotion_fixture(*, decisions=None, expires_delta=timedelta(days=1)):
    now = datetime.now(UTC)
    return {
        "schema_version": 3,
        "generated_at": now.isoformat(),
        "evidence_expires_at": (now + expires_delta).isoformat(),
        "benchmark_model": "bench-model",
        "proposer_model": "proposer-model",
        "candidate_origin": "model-proposer",
        "candidate_overlay_digest": "digest",
        "target_base_digests": {"path": "base"},
        "required_candidate_arms": ["candidate_workflow"],
        "selected_tasks": [bound_task_fixture()],
        "policy": {
            "metric": "cost_usd",
            "min_runs": 3,
            "min_improvement_pct": 5.0,
            "max_task_regression_pct": 20.0,
        },
        "decisions": (
            decisions
            if decisions is not None
            else [
                {
                    "incumbent_arm": "workflow",
                    "candidate_arm": "candidate_workflow",
                    "decision": "promote",
                    "metric": "cost_usd",
                }
            ]
        ),
    }


def validate_fixture(promotion):
    return validate_promotion_for_apply(
        promotion,
        overlay_digest="digest",
        benchmark_model="bench-model",
        proposer_model="proposer-model",
        selected_tasks=[bound_task_fixture()],
        target_base_digests={"path": "base"},
        required_candidate_arms=["candidate_workflow"],
        policy={
            "metric": "cost_usd",
            "min_runs": 3,
            "min_improvement_pct": 5.0,
            "max_task_regression_pct": 20.0,
        },
    )


def test_promotion_apply_requires_one_promote_for_every_bound_arm():
    assert [d["candidate_arm"] for d in validate_fixture(promotion_fixture())] == ["candidate_workflow"]

    for decisions in (
        [],
        [
            {
                "incumbent_arm": "workflow",
                "candidate_arm": "candidate_workflow",
                "decision": "keep_incumbent",
                "metric": "cost_usd",
            }
        ],
        [
            {
                "incumbent_arm": "workflow",
                "candidate_arm": "candidate_workflow",
                "decision": "promote",
                "metric": "cost_usd",
            },
            {
                "incumbent_arm": "workflow",
                "candidate_arm": "candidate_workflow",
                "decision": "promote",
                "metric": "cost_usd",
            },
        ],
        [
            {
                "incumbent_arm": "workflow_direct",
                "candidate_arm": "candidate_workflow_direct",
                "decision": "promote",
                "metric": "cost_usd",
            }
        ],
    ):
        with pytest.raises(ValueError):
            validate_fixture(promotion_fixture(decisions=decisions))


def test_manual_initial_overlay_has_no_fictitious_proposer_model():
    promotion = promotion_fixture()
    promotion["proposer_model"] = None
    promotion["candidate_origin"] = "manual-initial-overlay"

    decisions = validate_promotion_for_apply(
        promotion,
        overlay_digest="digest",
        benchmark_model="bench-model",
        proposer_model=None,
        selected_tasks=[bound_task_fixture()],
        target_base_digests={"path": "base"},
        required_candidate_arms=["candidate_workflow"],
        policy=promotion["policy"],
    )

    assert decisions[0]["decision"] == "promote"


def test_promotion_apply_rejects_pre_oracle_schema_and_missing_oracle_bindings():
    legacy = promotion_fixture()
    legacy["schema_version"] = 2
    with pytest.raises(ValueError, match="unsupported schema"):
        validate_fixture(legacy)

    weak_task = {"id": "task", "prompt_digest": "prompt"}
    weak = promotion_fixture()
    weak["selected_tasks"] = [weak_task]
    with pytest.raises(ValueError, match="hidden-oracle or dependency digests"):
        validate_promotion_for_apply(
            weak,
            overlay_digest="digest",
            benchmark_model="bench-model",
            proposer_model="proposer-model",
            selected_tasks=[weak_task],
            target_base_digests={"path": "base"},
            required_candidate_arms=["candidate_workflow"],
            policy={
                "metric": "cost_usd",
                "min_runs": 3,
                "min_improvement_pct": 5.0,
                "max_task_regression_pct": 20.0,
            },
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("benchmark_model", "other"),
        ("proposer_model", "other"),
        ("candidate_overlay_digest", "other"),
        ("target_base_digests", {"path": "other"}),
        ("required_candidate_arms", ["candidate_workflow_direct"]),
        ("selected_tasks", [{"id": "other", "prompt_digest": "prompt"}]),
        (
            "policy",
            {
                "metric": "cost_usd",
                "min_runs": 4,
                "min_improvement_pct": 5.0,
                "max_task_regression_pct": 20.0,
            },
        ),
    ],
)
def test_promotion_apply_rejects_mismatched_evidence_bindings(field, value):
    promotion = promotion_fixture()
    promotion[field] = value
    with pytest.raises(ValueError, match="binding"):
        validate_fixture(promotion)


def test_promotion_apply_rejects_expired_evidence():
    with pytest.raises(ValueError, match="expired"):
        validate_fixture(promotion_fixture(expires_delta=timedelta(seconds=-1)))


def test_promotion_apply_rejects_extended_or_future_dated_evidence():
    with pytest.raises(ValueError, match="expired"):
        validate_fixture(promotion_fixture(expires_delta=timedelta(days=91)))

    promotion = promotion_fixture()
    future = datetime.now(UTC) + timedelta(days=1)
    promotion["generated_at"] = future.isoformat()
    promotion["evidence_expires_at"] = (future + timedelta(days=1)).isoformat()
    with pytest.raises(ValueError, match="future"):
        validate_fixture(promotion)


def test_promotion_apply_rejects_decision_metric_mismatch():
    promotion = promotion_fixture()
    promotion["decisions"][0]["metric"] = "output_tokens"
    with pytest.raises(ValueError, match="metric mismatch"):
        validate_fixture(promotion)
