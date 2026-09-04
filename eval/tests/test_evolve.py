"""Unit tests for the pure evidence/apply/driver helpers of workflow_bench.evolve."""

import hashlib
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from workflow_bench import evolve
from workflow_bench.runner_sessions import PARENT_EVENT_STREAM_SOURCE
from workflow_bench.evolve import (
    build_parser,
    build_proposer_prompt,
    executed_benchmark_arms,
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
from workflow_bench.process_control import ManagedProcessResult, run_managed
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
        {"skill": "gitnexus-work", "n": 8},
        {"skill": "gitnexus-work", "n": 9},
        {"skill": "gitnexus-review", "n": 10},
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
    assert "exact staged" in prompt
    assert "no full results.jsonl" in prompt
    assert "1 decision(s) in /evidence/gate-summary.json" in prompt
    assert "budget blown on reruns" not in prompt
    assert "verify-failed" not in prompt
    assert "~/.claude/projects" not in prompt


def test_build_proposer_prompt_points_at_the_rejected_prior_proposal(tmp_path):
    common = {
        "results_dir": tmp_path / "bench",
        "evidence": [],
        "learnings": [],
        "gate_summary": ["candidate_workflow: keep_incumbent — cost regressed"],
        "overlay_dir": tmp_path / "overlay",
        "proposal_path": tmp_path / "proposal.md",
        "incumbent_arms": ["workflow"],
    }
    # The gate summary alone says a candidate lost, never what it proposed —
    # so without this line the proposer can re-propose the same prose forever.
    assert "/evidence/prior-proposal.md" in build_proposer_prompt(**common, prior_proposal=True)
    assert "/evidence/prior-proposal.md" not in build_proposer_prompt(**common)


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
    patch = results / "demo-task-workflow-run0.patch"
    patch.write_text("diff --git a/a b/a\n")
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

    assert [json.loads(line) for line in entries["transcript-0-0.jsonl"].splitlines()] == [json.loads(payload)]
    assert entries["patch-0.diff"] == patch.read_text()
    staged_rows = entries["selected-rows.json"]
    assert staged_rows[0]["patch_file"] == "patch-0.diff"
    assert staged_rows[0]["transcript_files"] == ["transcript-0-0.jsonl"]
    assert "foreign host transcript" not in json.dumps(entries)

    bad_digest = {**metadata, "sha256": "0" * 64}
    with pytest.raises(evolve.SandboxError, match="digest does not match"):
        proposer_evidence_entries(
            results_dir=results,
            evidence=[row(transcript_artifacts=[bad_digest])],
            learnings=[],
            gate_summary=[],
        )


def test_proposer_compacts_transcripts_as_complete_json_events(tmp_path):
    results = tmp_path / "results"
    transcripts = results / "transcripts"
    transcripts.mkdir(parents=True, mode=0o700)
    events = [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "analysis-" + ("x" * 100_000),
                        "signature": "opaque-base64-signature",
                    }
                ]
            },
        },
        {
            "type": "result",
            "session_id": "session-1",
            "usage": {"input_tokens": 1, "output_tokens": 2},
        },
    ]
    payload = "".join(json.dumps(event) + "\n" for event in events).encode()
    artifact = transcripts / "session.jsonl"
    artifact.write_bytes(payload)
    artifact.chmod(0o600)

    entries = proposer_evidence_entries(
        results_dir=results,
        evidence=[
            row(
                transcript_artifacts=[
                    {
                        "path": "transcripts/session.jsonl",
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "bytes": len(payload),
                        "source": PARENT_EVENT_STREAM_SOURCE,
                    }
                ]
            )
        ],
        learnings=[],
        gate_summary=[],
        artifact_limit=8192,
    )

    staged = entries["transcript-0-0.jsonl"]
    parsed = [json.loads(line) for line in staged.splitlines()]
    assert len(staged.encode()) <= 8192
    assert parsed[-1]["type"] == "result"
    assert parsed[0]["message"]["content"][0]["signature"] == "[OMITTED]"
    assert "opaque-base64-signature" not in staged


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


def test_proposer_refuses_a_selected_row_with_no_transcript_reference():
    # Every selectable row comes from sum_sessions(), which always emits the
    # key, and select_evidence() drops the kinds a failed transcript
    # persistence produces (session-error, infra-error, evidence-unverified,
    # cleanup-failure). A selected row without a transcript is therefore
    # evidence lost between producer and proposer, not a row that had none.
    with pytest.raises(evolve.SandboxError, match="missing transcript_artifacts"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[row()],
            learnings=[],
            gate_summary=[],
        )
    with pytest.raises(evolve.SandboxError, match="carries no transcript artifact"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[row(transcript_artifacts=[])],
            learnings=[],
            gate_summary=[],
        )


def test_proposer_stages_the_bounded_prior_proposal(tmp_path):
    proposal = tmp_path / "proposal.md"
    proposal.write_text("# rejected candidate\n\nTightened the plan budget.\n")
    proposal.chmod(0o600)

    entries = proposer_evidence_entries(
        results_dir=None,
        evidence=[],
        learnings=[],
        gate_summary=[],
        prior_proposal=proposal,
    )

    assert entries["prior-proposal.md"] == proposal.read_text()

    oversized = tmp_path / "oversized.md"
    oversized.write_bytes(b"x" * (evolve.MAX_EVIDENCE_FILE_BYTES + 4096))
    oversized.chmod(0o600)
    bounded = proposer_evidence_entries(
        results_dir=None,
        evidence=[],
        learnings=[],
        gate_summary=[],
        prior_proposal=oversized,
    )
    assert len(bounded["prior-proposal.md"]) == evolve.MAX_EVIDENCE_FILE_BYTES


def test_stage_proposer_evidence_bundle_drops_prior_proposal_to_fit_budget(tmp_path, monkeypatch, capsys):
    # Per-file caps alone can still exceed the aggregate budget; the helper must
    # drop the prior proposal instead of aborting the generation.
    monkeypatch.setattr(evolve, "MAX_BUNDLE_BYTES", 2048)
    monkeypatch.setattr("workflow_bench.proposer_sandbox.MAX_BUNDLE_BYTES", 2048)

    prior = tmp_path / "proposal.md"
    prior.write_text("x" * 2500)
    prior.chmod(0o600)

    from workflow_bench.proposer_sandbox import SandboxError, stage_evidence_bundle

    oversized = evolve.proposer_evidence_entries(
        results_dir=None,
        evidence=[],
        learnings=[],
        gate_summary=[],
        prior_proposal=prior,
    )
    with pytest.raises(SandboxError, match="total byte limit"):
        stage_evidence_bundle(tmp_path / "raw", oversized)

    bundle = evolve.stage_proposer_evidence_bundle(
        tmp_path / "bundle",
        results_dir=None,
        evidence=[],
        learnings=[],
        gate_summary=[],
        prior_proposal=prior,
    )
    names = {path.name for path in bundle.iterdir()}
    assert "selected-rows.json" in names
    assert "prior-proposal.md" not in names
    logged = capsys.readouterr().out
    assert "trimmed proposer evidence" in logged
    assert "omitted prior proposal" in logged


def test_stage_proposer_evidence_bundle_compacts_artifacts_before_dropping_rows(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(evolve, "MAX_BUNDLE_BYTES", 150_000)
    monkeypatch.setattr("workflow_bench.proposer_sandbox.MAX_BUNDLE_BYTES", 150_000)
    results = tmp_path / "results"
    transcripts = results / "transcripts"
    transcripts.mkdir(parents=True, mode=0o700)
    rows = []
    for index in range(2):
        payload = (
            json.dumps(
                {
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "x" * 100_000}]},
                }
            )
            + "\n"
            + json.dumps({"type": "result", "session_id": f"session-{index}"})
            + "\n"
        ).encode()
        transcript = transcripts / f"session-{index}.jsonl"
        transcript.write_bytes(payload)
        transcript.chmod(0o600)
        (results / f"task-{index}-workflow-run0.patch").write_bytes(b"p" * 100_000)
        rows.append(
            row(
                task=f"task-{index}",
                transcript_artifacts=[
                    {
                        "path": f"transcripts/session-{index}.jsonl",
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "bytes": len(payload),
                        "source": PARENT_EVENT_STREAM_SOURCE,
                    }
                ],
            )
        )

    bundle = evolve.stage_proposer_evidence_bundle(
        tmp_path / "bundle",
        results_dir=results,
        evidence=rows,
        learnings=[],
        gate_summary=[],
    )

    staged_rows = json.loads((bundle / "selected-rows.json").read_text())
    assert len(staged_rows) == 2
    assert all((bundle / staged["patch_file"]).is_file() for staged in staged_rows)
    logged = capsys.readouterr().out
    assert "artifact cap" in logged
    assert "dropped 0 row(s)" in logged


@pytest.mark.skipif(os.name == "nt", reason="proposal containment checks are POSIX-only")
def test_proposer_refuses_a_prior_proposal_that_lost_its_trust_boundary(tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("attacker-controlled prose")
    linked = tmp_path / "linked-proposal.md"
    linked.symlink_to(outside)

    with pytest.raises(evolve.SandboxError, match="regular non-symlink"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[],
            learnings=[],
            gate_summary=[],
            prior_proposal=linked,
        )

    # run_proposer copies the proposal out 0600; anything looser means the
    # bytes are no longer only the ones this driver wrote.
    shared = tmp_path / "shared-proposal.md"
    shared.write_text("proposal")
    shared.chmod(0o644)
    with pytest.raises(evolve.SandboxError, match="owner-only"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[],
            learnings=[],
            gate_summary=[],
            prior_proposal=shared,
        )

    with pytest.raises(evolve.SandboxError, match="unavailable"):
        proposer_evidence_entries(
            results_dir=None,
            evidence=[],
            learnings=[],
            gate_summary=[],
            prior_proposal=tmp_path / "absent.md",
        )


def test_run_proposer_hides_the_hidden_harness_and_keeps_the_full_tool_surface(monkeypatch, tmp_path):
    """The proposer writes the artifact the arms are scored with.

    So its clone must be sanitized before the session starts — a proposer that
    can read eval/workflow_bench reads the task prompts and hidden oracles it
    is about to be graded against, and can encode the answers into the skill.
    """

    evidence = tmp_path / "evidence"
    evidence.mkdir()
    transcript_projects = tmp_path / "transcript-projects"
    transcript_projects.mkdir()
    captured: dict[str, object] = {}
    sanitized: list[Path] = []
    events: list[str] = []

    def fake_make_worktree(_repo, _ref, destination):
        clone = destination / "clone"
        clone.mkdir()
        return clone

    def fake_sanitize(clone):
        events.append("sanitize")
        sanitized.append(clone)
        return "0" * 40

    class FakeSandbox:
        claude_bin = "claude"
        command_prefix: list[str] = []
        settings_json = '{"permissions":{"allow":["Read"]}}'

        @property
        def transcript_projects(self):
            return transcript_projects

    @contextmanager
    def fake_prepare_sandbox(**_kwargs):
        events.append("prepare")
        yield FakeSandbox()

    def fake_run_claude(*_args, **kwargs):
        captured.update(kwargs)
        return {"ok": False, "error_kind": "session-error"}

    monkeypatch.setattr(evolve.runner, "make_worktree", fake_make_worktree)
    monkeypatch.setattr(evolve.runner, "remove_clone", lambda _clone: None)
    monkeypatch.setattr(evolve, "sanitize_clone_for_hidden_oracles", fake_sanitize)
    monkeypatch.setattr(evolve, "prepare_sandbox", fake_prepare_sandbox)
    monkeypatch.setattr(evolve.runner, "run_claude", fake_run_claude)
    args = build_parser().parse_args(["--tasks", "tasks.yaml", "--model", "model"])

    record = evolve.run_proposer(
        "prompt",
        args,
        overlay_dir=tmp_path / "overlay",
        proposal_path=tmp_path / "proposal.md",
        evidence_bundle=evidence,
        bwrap_bin=tmp_path / "bwrap",
    )

    assert record["ok"] is False
    # Sanitization has to happen on the clone the session actually runs in,
    # and before the sandbox is prepared around it.
    assert events[:2] == ["sanitize", "prepare"]
    assert [clone.name for clone in sanitized] == ["clone"]
    # Not --bare: bare ignores --tools and would cost the proposer Grep/Glob.
    assert captured.get("bare", False) is False
    assert captured["allowed_tools"] == evolve.PROPOSER_ALLOWED_TOOLS
    assert captured["settings_json"] == FakeSandbox.settings_json


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


def test_proposer_session_record_is_redacted_before_upload(monkeypatch, tmp_path, capsys):
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
    literal_token = "secret-LITERAL-XYZ"
    pattern_token = "sk-ant-FAKEEXAMPLE0000"
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
            "--anthropic-api-key",
            literal_token,
        ],
    )
    monkeypatch.setattr(evolve.runner, "selected_task_bindings", lambda _tasks: [{"id": "demo"}])
    monkeypatch.setattr(evolve, "preflight_bubblewrap", lambda: tmp_path / "bwrap")
    monkeypatch.setattr(evolve, "require_claude_sandbox_helpers", lambda: None)
    # A session error whose stderr echoed both the literal API key and an
    # sk-ant-shaped token into the record that gets written to the artifact.
    monkeypatch.setattr(
        evolve,
        "run_proposer",
        lambda *args, **kwargs: {
            "ok": False,
            "error_detail": {"stderr_tail": f"boom {literal_token} {pattern_token}"},
        },
    )

    assert evolve.main() == 1

    written = (tmp_path / "out" / "gen-0" / "proposer-session.json").read_text()
    assert literal_token not in written
    assert pattern_token not in written
    assert "[REDACTED]" in written

    # The same record is printed one line later, and the driver's stdout is a
    # live CI log now that the sweep echoes it — same bar as the artifact.
    printed = capsys.readouterr().out
    assert "proposer session failed" in printed
    assert literal_token not in printed
    assert pattern_token not in printed
    assert "[REDACTED]" in printed


def test_benchmark_failure_print_is_redacted(monkeypatch, tmp_path, capsys):
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
    overlay = tmp_path / "overlay"
    skill = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate")
    literal_token = "secret-LITERAL-XYZ"
    pattern_token = "sk-ant-FAKEEXAMPLE0000"
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
            "--initial-overlay",
            str(overlay),
            "--anthropic-api-key",
            literal_token,
        ],
    )
    monkeypatch.setattr(evolve.runner, "selected_task_bindings", lambda _tasks: [{"id": "demo"}])
    monkeypatch.setattr(evolve, "preflight_bubblewrap", lambda: tmp_path / "bwrap")
    monkeypatch.setattr(evolve, "require_claude_sandbox_helpers", lambda: None)
    monkeypatch.setattr(evolve, "resolve_incumbent_arms", lambda *_args, **_kwargs: ["workflow"])
    monkeypatch.setattr(evolve, "freeze_overlay", lambda _source, _destination: "d" * 64)
    monkeypatch.setattr(evolve, "committed_destination_base_digests", lambda _overlay: {})
    monkeypatch.setattr(evolve, "destination_base_digests", lambda _overlay: {})
    # The sweep is launched with GITNEXUS_BENCH_ANTHROPIC_API_KEY in its environment,
    # so its detail/stderr tail is as token-bearing as any session record.
    monkeypatch.setattr(
        evolve,
        "run_managed",
        lambda *_args, **_kwargs: ManagedProcessResult(
            state="exited",
            returncode=2,
            stdout_tail="",
            stderr_tail=f"ANTHROPIC_API_KEY={pattern_token}",
            duration_s=1.0,
            detail=f"sweep died with {literal_token}",
        ),
    )

    assert evolve.main() == 1

    printed = capsys.readouterr().out
    assert "benchmark run failed" in printed
    assert literal_token not in printed
    assert pattern_token not in printed
    assert "[REDACTED]" in printed


def test_runner_argv_pairs_each_incumbent_with_its_candidate(tmp_path):
    args = build_parser().parse_args(
        [
            "--tasks",
            "t.yaml",
            "--model",
            "pinned",
            "--arms",
            "workflow",
            "--workers",
            "3",
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
    assert argv[argv.index("--effort") + 1] == "xhigh"
    assert argv[argv.index("--workers") + 1] == "3"
    assert "--include-expensive" in argv
    assert json.loads(argv[argv.index("--task-bindings-json") + 1]) == task_bindings
    assert json.loads(argv[argv.index("--promotion-target-bases-json") + 1]) == target_bases


def test_runner_argv_inserts_ce_review_for_review_overlay(tmp_path):
    args = build_parser().parse_args(
        ["--tasks", "t.yaml", "--model", "pinned", "--arms", "review"]
    )
    overlay = tmp_path / "overlay"
    skill = overlay / ".claude" / "skills" / "gitnexus-review" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("candidate")
    argv = runner_argv(
        args,
        tmp_path / "bench",
        overlay,
        task_bindings=[{"id": "task"}],
        target_base_digests={},
    )
    arms = argv[argv.index("--arms") + 1 : argv.index("--promotion-metric")]
    assert arms == ["ce_review", "review", "candidate_review"]


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


def test_runner_argv_forwards_explicit_unsafe_backend(tmp_path):
    args = build_parser().parse_args(
        ["--tasks", "t.yaml", "--model", "pinned", "--unsafe-no-bwrap"]
    )
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
    )

    assert "--unsafe-no-bwrap" in argv


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
                    "source": "trivial-status-json-alias.oracle.test.ts",
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


def test_executed_benchmark_arms_inserts_review_comparator() -> None:
    assert executed_benchmark_arms(["workflow"]) == ["workflow", "candidate_workflow"]
    assert executed_benchmark_arms(["review"]) == ["ce_review", "review", "candidate_review"]


def test_generation_timeout_budgets_review_pair_plus_ce_comparator() -> None:
    timeout = generation_timeout_seconds(
        task_count=6,
        runs=1,
        session_timeout=3600,
        incumbent_arms=["review"],
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
    paired_arm_cells = 3
    session_slots = 3
    workspace_snapshot_slots = 3
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
        + 6 * (per_task_preparation + per_task_run)
        + evolve.DRIVER_OVERHEAD_SECONDS
    )


def test_generation_timeout_rejects_unknown_arm() -> None:
    with pytest.raises(ValueError, match="unsupported evolution arm: mystery"):
        generation_timeout_seconds(
            task_count=1,
            runs=1,
            session_timeout=60,
            incumbent_arms=["mystery"],
        )


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


def bound_task_fixture(task_id="task-a"):
    return {
        "id": task_id,
        "prompt_digest": "prompt",
        "oracle_digest": "a" * 64,
        "oracle_command_digest": "b" * 64,
        "oracle_manifest_digest": "c" * 64,
        "sandbox_dependency_content_digest": "e" * 64,
        "sandbox_dependency_manifest_digest": "f" * 64,
        "oracle_files": [{"target": "oracle.test.ts", "sha256": "d" * 64, "size": 10}],
    }


def bound_task_fixtures():
    return [bound_task_fixture("task-a"), bound_task_fixture("task-impossible")]


def promote_decision(**overrides):
    """A schema 5 decision: a verdict plus the gated evidence base behind it."""
    decision = {
        "incumbent_arm": "workflow",
        "candidate_arm": "candidate_workflow",
        "decision": "promote",
        "metric": "cost_usd",
        "ungated_tasks": ["task-impossible"],
        "tasks": [
            {"task": "task-a", "gated": True},
            {"task": "task-impossible", "gated": False},
        ],
    }
    decision.update(overrides)
    return decision


def promotion_fixture(*, decisions=None, expires_delta=timedelta(days=1)):
    now = datetime.now(UTC)
    return {
        "schema_version": 5,
        "generated_at": now.isoformat(),
        "evidence_expires_at": (now + expires_delta).isoformat(),
        "benchmark_model": "bench-model",
        "proposer_model": "proposer-model",
        "effort": "xhigh",
        "candidate_origin": "model-proposer",
        "candidate_overlay_digest": "digest",
        "target_base_digests": {"path": "base"},
        "required_candidate_arms": ["candidate_workflow"],
        "selected_tasks": bound_task_fixtures(),
        "policy": {
            "metric": "cost_usd",
            "min_runs": 3,
            "min_improvement_pct": 5.0,
            "max_task_regression_pct": 20.0,
        },
        "decisions": decisions if decisions is not None else [promote_decision()],
    }


def validate_fixture(promotion):
    return validate_promotion_for_apply(
        promotion,
        overlay_digest="digest",
        benchmark_model="bench-model",
        proposer_model="proposer-model",
        effort="xhigh",
        selected_tasks=bound_task_fixtures(),
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
        [promote_decision(decision="keep_incumbent")],
        [promote_decision(), promote_decision()],
        [promote_decision(incumbent_arm="workflow_direct", candidate_arm="candidate_workflow_direct")],
    ):
        with pytest.raises(ValueError):
            validate_fixture(promotion_fixture(decisions=decisions))


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        # An older decision relabeled as schema 5: the verdict without the
        # gated evidence base schema 5 promotes on.
        ({"tasks": None, "ungated_tasks": None}, "no per-task gate evidence"),
        ({"tasks": [{"task": "task-a"}]}, "malformed per-task gate evidence"),
        ({"tasks": [{"task": "task-a", "gated": "yes"}]}, "malformed per-task gate evidence"),
        (
            {"tasks": [{"task": "task-a", "gated": True}, {"task": "task-a", "gated": False}]},
            "repeats a task",
        ),
        (
            {"ungated_tasks": [], "tasks": [{"task": "fabricated", "gated": True}]},
            "does not match selected tasks",
        ),
        ({"ungated_tasks": None}, "missing its ungated task list"),
        # The verdict claims a full gate; the per-task rows say a task sat
        # outside it.
        ({"ungated_tasks": []}, "disagree with its per-task evidence"),
        (
            {
                "ungated_tasks": ["task-a", "task-impossible"],
                "tasks": [
                    {"task": "task-a", "gated": False},
                    {"task": "task-impossible", "gated": False},
                ],
            },
            "no gated task",
        ),
    ],
)
def test_promotion_apply_binds_the_schema_5_gate_evidence(overrides, match):
    decision = promote_decision()
    for field, value in overrides.items():
        if value is None:
            decision.pop(field)
        else:
            decision[field] = value

    with pytest.raises(ValueError, match=match):
        validate_fixture(promotion_fixture(decisions=[decision]))


def test_promotion_apply_rejects_a_gate_with_only_one_of_three_selected_tasks():
    selected = [*bound_task_fixtures(), bound_task_fixture("task-impossible-2")]
    decision = promote_decision(
        ungated_tasks=["task-impossible", "task-impossible-2"],
        tasks=[
            {"task": "task-a", "gated": True},
            {"task": "task-impossible", "gated": False},
            {"task": "task-impossible-2", "gated": False},
        ],
    )
    promotion = promotion_fixture(decisions=[decision])
    promotion["selected_tasks"] = selected

    with pytest.raises(ValueError, match="too thin a gated evidence base"):
        validate_promotion_for_apply(
            promotion,
            overlay_digest="digest",
            benchmark_model="bench-model",
            proposer_model="proposer-model",
            effort="xhigh",
            selected_tasks=selected,
            target_base_digests={"path": "base"},
            required_candidate_arms=["candidate_workflow"],
            policy=promotion["policy"],
        )


def test_manual_initial_overlay_has_no_fictitious_proposer_model():
    promotion = promotion_fixture()
    promotion["proposer_model"] = None
    promotion["candidate_origin"] = "manual-initial-overlay"

    decisions = validate_promotion_for_apply(
        promotion,
        overlay_digest="digest",
        benchmark_model="bench-model",
        proposer_model=None,
        effort="xhigh",
        selected_tasks=bound_task_fixtures(),
        target_base_digests={"path": "base"},
        required_candidate_arms=["candidate_workflow"],
        policy=promotion["policy"],
    )

    assert decisions[0]["decision"] == "promote"


def test_promotion_apply_rejects_pre_oracle_schema_and_missing_oracle_bindings():
    legacy = promotion_fixture()
    legacy["schema_version"] = 3
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
            effort="xhigh",
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
