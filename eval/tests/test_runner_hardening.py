"""Regression tests for benchmark evidence and phase-boundary hardening."""

import hashlib
import json

import pytest

from workflow_bench import runner, runner_artifacts, runner_sessions
from workflow_bench.evolution import skill_fingerprint
from workflow_bench.process_control import ManagedProcessError, ManagedProcessResult


def _report(**overrides) -> str:
    payload = {
        "type": "result",
        "session_id": "s",
        "num_turns": 3,
        "total_cost_usd": 0.1,
        "duration_ms": 1000,
        "usage": {
            "input_tokens": 1,
            "cache_creation_input_tokens": 2,
            "cache_read_input_tokens": 3,
            "output_tokens": 4,
        },
    }
    payload.update(overrides)
    return json.dumps(payload)


def _stream(*, secret: str = "", **report_overrides: object) -> str:
    events = []
    if secret:
        events.append(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": secret}]},
            }
        )
    events.append(json.loads(_report(**report_overrides)))
    return "\n".join(json.dumps(event) for event in events) + "\n"


def test_sandboxed_verifier_does_not_execute_candidate_login_profile(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    profile_sentinel = tmp_path / "profile-ran"
    (home / ".profile").write_text(f"touch '{profile_sentinel}'\nexit 97\n")

    passed, output = runner_artifacts.run_verify(
        "printf verified",
        tmp_path,
        5,
        command_prefix=["/usr/bin/env"],
        env={"HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )

    assert passed is True
    assert output.strip() == "verified"
    assert not profile_sentinel.exists()


@pytest.mark.parametrize(
    "state",
    [
        "input-failure",
        "timeout",
        "forced-kill",
        "ownership-failure",
        "spawn-failure",
        "reap-failure",
        "cleanup-failure",
    ],
)
def test_verifier_infrastructure_states_are_not_candidate_quality(state):
    process = ManagedProcessResult(
        state=state,
        returncode=None,
        stdout_tail="",
        stderr_tail="hidden oracle secret",
        duration_s=0.1,
    )
    result = runner_artifacts.VerificationResult(
        command=["verify"],
        process=process,
        output="hidden oracle secret",
    )

    with pytest.raises(ManagedProcessError) as caught:
        runner._verification_outcome(result)
    assert "hidden oracle secret" not in str(caught.value)


def test_verifier_normal_nonzero_exit_remains_candidate_quality():
    process = ManagedProcessResult(
        state="exited",
        returncode=1,
        stdout_tail="",
        stderr_tail="assertion failed",
        duration_s=0.1,
    )
    result = runner_artifacts.VerificationResult(
        command=["verify"],
        process=process,
        output="assertion failed",
    )

    assert runner._verification_outcome(result) == (False, "assertion failed")


def test_review_skill_fingerprint_rejects_setup_and_review_phase_replacement(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "gitnexus-review" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("trusted review prompt")
    expected = skill_fingerprint(tmp_path, "review")
    assert expected is not None

    skill.write_text("replaced during task setup")
    with pytest.raises(ValueError, match="task setup changed the evaluated skill fingerprint"):
        runner_artifacts.require_skill_fingerprint(tmp_path, "review", expected, phase="task setup")

    skill.write_text("trusted review prompt")
    expected = skill_fingerprint(tmp_path, "review")
    skill.write_text("replaced during review")
    with pytest.raises(ValueError, match="review changed the evaluated skill fingerprint"):
        runner_artifacts.require_skill_fingerprint(tmp_path, "review", expected, phase="review")


@pytest.mark.parametrize(
    ("state", "returncode", "report_overrides"),
    [
        ("exited", 1, {}),
        ("timeout", None, {}),
        ("exited", 0, {"is_error": True}),
    ],
)
def test_failed_session_still_persists_redacted_transcript(
    monkeypatch,
    tmp_path,
    state,
    returncode,
    report_overrides,
):
    secret = "sk-ant-postmortem-secret"
    output = tmp_path / "output"
    output.mkdir()
    stream = _stream(secret=secret, **report_overrides)
    result = ManagedProcessResult(
        state=state,
        returncode=returncode,
        stdout_tail=stream,
        stderr_tail="primary failure",
        duration_s=0.1,
        timed_out=state == "timeout",
        stdout_capture=stream.encode(),
    )
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *args, **kwargs: result)

    record = runner_sessions.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        transcript_output_dir=output,
        transcript_output_prefix="failed-run",
        transcript_secrets=(secret,),
    )

    artifact = output / record["transcript_artifact"]["path"]
    assert record["ok"] is False
    assert record["error_kind"] == "session-error"
    assert record["error_detail"]["process_state"] == state
    assert artifact.is_file()
    assert secret not in artifact.read_text()
    assert record["transcript_artifact"]["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()


def test_failed_session_keeps_primary_error_when_transcript_persistence_fails(monkeypatch, tmp_path):
    stream = _stream()
    result = ManagedProcessResult(
        state="exited",
        returncode=1,
        stdout_tail=stream,
        stderr_tail="primary failure",
        duration_s=0.1,
        stdout_capture=stream.encode(),
    )
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *args, **kwargs: result)

    record = runner_sessions.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        transcript_output_dir=tmp_path / "missing-output-root",
    )

    assert record["error_kind"] == "session-error"
    assert record["error_detail"]["stderr_tail"] == "primary failure"
    assert any("event-stream persistence" in item for item in record["evidence_diagnostics"])


def test_timed_out_session_never_trusts_writable_home_without_parent_result(monkeypatch, tmp_path):
    projects = tmp_path / "projects"
    output = tmp_path / "output"
    output.mkdir()

    def timeout_after_writing_transcript(*args, **kwargs):
        forged = projects / "some-slug" / "timeout-session.jsonl"
        forged.parent.mkdir(parents=True)
        forged.write_text(_stream())
        return ManagedProcessResult(
            state="timeout",
            returncode=None,
            stdout_tail="",
            stderr_tail="timed out",
            duration_s=5.0,
            timed_out=True,
            stdout_capture=b"",
        )

    monkeypatch.setattr(runner_sessions, "run_managed", timeout_after_writing_transcript)
    record = runner_sessions.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        transcript_projects=projects,
        transcript_output_dir=output,
        transcript_output_prefix="timeout-run",
    )

    assert record["error_kind"] == "session-error"
    assert record["session_id"] is None
    assert "transcript_artifact" not in record
    assert record["transcript_missing"] is True


def test_phase_workspace_rejects_unchanged_preseeded_review_output(tmp_path):
    artifact = tmp_path / "review-output.md"
    artifact.write_text("preseeded output")
    before = runner_artifacts.workspace_snapshot(tmp_path)

    with pytest.raises(ValueError, match="did not create or change"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_rejects_symlink_review_output(tmp_path):
    before = runner_artifacts.workspace_snapshot(tmp_path)
    outside = tmp_path.parent / f"{tmp_path.name}-outside-review.md"
    outside.write_text("outside")
    artifact = tmp_path / "review-output.md"
    artifact.symlink_to(outside)

    with pytest.raises(ValueError, match="regular non-symlink"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_accepts_new_regular_review_output(tmp_path):
    before = runner_artifacts.workspace_snapshot(tmp_path)
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_ignores_claude_sandbox_bootstrap_noise(tmp_path):
    # Reproduced empirically: Claude Code's own enableWeakerNestedSandbox
    # bootstrap creates this exact set of paths on every session regardless
    # of task or model output (a trivial "say OK" prompt was enough). None
    # of it is something the model decided to write, so it must not read as
    # an unauthorized planning-phase change.
    before = runner_artifacts.workspace_snapshot(tmp_path)
    (tmp_path / ".claude" / "agents").mkdir(parents=True)
    (tmp_path / ".claude" / "commands").mkdir(parents=True)
    (tmp_path / ".claude" / ".cc-writes").write_text("{}")
    (tmp_path / ".env").write_text("")
    (tmp_path / ".env.development.local").write_text("")
    (tmp_path / ".npmrc").write_text("")
    (tmp_path / "package.json").write_text("{}")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / ".bin").mkdir()
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_still_rejects_a_genuinely_unauthorized_change(tmp_path):
    # The bootstrap-noise exclusion must stay narrow: an actual source-file
    # edit outside the allowed artifact still has to be caught.
    before = runner_artifacts.workspace_snapshot(tmp_path)
    (tmp_path / "src.py").write_text("changed")
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    with pytest.raises(ValueError, match="unauthorized workspace path"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_ignores_nested_claude_sandbox_bootstrap_noise(tmp_path):
    # Claude Code bootstraps into whatever directory it is running in, not just
    # the workspace root. The benchmark's task prompts cd into gitnexus/, so the
    # same noise lands one level down -- observed verbatim in skill-evolution run
    # 29861768554, where 13 of 18 sessions failed with
    # "phase changed unauthorized workspace path(s): gitnexus/.claude/.cc-writes".
    nested = tmp_path / "gitnexus" / ".claude"
    nested.mkdir(parents=True)
    (nested / "settings.local.json").write_text("{}")
    before = runner_artifacts.workspace_snapshot(tmp_path)
    (nested / ".cc-writes").write_text("{}")
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_does_not_descend_into_nested_bootstrap_directories(tmp_path):
    # The exclusion must skip an entry before it is queued for traversal, so
    # content created *inside* the ignored directory stays invisible too.
    nested = tmp_path / "gitnexus" / ".claude" / ".cc-writes"
    nested.mkdir(parents=True)
    before = runner_artifacts.workspace_snapshot(tmp_path)
    (nested / "pending.json").write_text('{"writes": 1}')
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_still_rejects_nested_real_claude_config(tmp_path):
    # gitnexus/.claude/settings.local.json is real tracked repository content.
    # Excluding ".claude" wholesale at depth would blind the check to it, so the
    # exclusion must name only the entries Claude Code itself creates.
    nested = tmp_path / "gitnexus" / ".claude"
    nested.mkdir(parents=True)
    settings = nested / "settings.local.json"
    settings.write_text("{}")
    before = runner_artifacts.workspace_snapshot(tmp_path)
    settings.write_text('{"permissions": "changed"}')
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    with pytest.raises(ValueError, match="unauthorized workspace path"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_still_rejects_nested_package_json(tmp_path):
    # package.json is in WORKSPACE_SNAPSHOT_BOOTSTRAP_NOISE, but only as a
    # workspace-root entry: gitnexus/package.json is real tracked content whose
    # edits must still be caught.
    nested = tmp_path / "gitnexus"
    nested.mkdir()
    manifest = nested / "package.json"
    manifest.write_text("{}")
    before = runner_artifacts.workspace_snapshot(tmp_path)
    manifest.write_text('{"version": "9.9.9"}')
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    with pytest.raises(ValueError, match="unauthorized workspace path"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)


def test_phase_workspace_still_sees_writes_under_a_pre_existing_nested_claude_dir(tmp_path):
    # Every excluded name is a blind spot. .claude/agents and .claude/commands
    # are deliberately NOT excluded at depth: once a .claude directory exists
    # (gitnexus/.claude/settings.local.json is tracked), anything written
    # underneath an excluded entry is invisible to this check, and Claude Code
    # loads .claude/agents relative to its cwd -- which these tasks point at
    # gitnexus/. A planning phase must not be able to plant a definition there
    # for the later work phase to read.
    nested = tmp_path / "gitnexus" / ".claude"
    nested.mkdir(parents=True)
    (nested / "settings.local.json").write_text("{}")
    before = runner_artifacts.workspace_snapshot(tmp_path)
    (nested / "agents").mkdir()
    (nested / "agents" / "planted.md").write_text("planted agent definition")
    artifact = tmp_path / "review-output.md"
    artifact.write_text("new review")

    with pytest.raises(ValueError, match="unauthorized workspace path"):
        runner_artifacts.enforce_phase_workspace(tmp_path, before, allowed_artifact=artifact)
