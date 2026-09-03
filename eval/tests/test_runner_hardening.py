"""Regression tests for benchmark evidence and phase-boundary hardening."""

import hashlib
import json
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench import runner, runner_artifacts, runner_sessions
from workflow_bench.evolution import skill_fingerprint
from workflow_bench.process_control import ManagedProcessError, ManagedProcessResult
from workflow_bench.proposer_sandbox import SandboxError


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


def _cell_context(tmp_path, **overrides):
    """A TaskCellContext whose per-task inputs are all present and valid."""
    snapshot = SimpleNamespace(
        digest="asset-digest",
        manifest_digest="asset-manifest",
        dependency_content_digest="dep-content",
        dependency_manifest_digest="dep-manifest",
    )
    graph = SimpleNamespace(
        digest="graph-digest",
        manifest_digest="graph-manifest",
        materialize=lambda *_a, **_k: None,
    )
    oracle = SimpleNamespace(
        digest="oracle-digest",
        command_digest="oracle-command",
        manifest_digest="oracle-manifest",
    )
    fields = {
        "task": {"id": "task-a", "class": "demo", "prompt": "do the thing"},
        "oracle_snapshot": oracle,
        "repo": tmp_path / "repo",
        "task_sha": "a" * 40,
        "graph_snapshot": graph,
        "graph_snapshot_error": None,
        "asset_snapshot": snapshot,
        "asset_snapshot_error": None,
        "args": SimpleNamespace(
            claude_bin="claude",
            model="pinned-model",
            proposer_model=None,
            effort="xhigh",
            auth_token=None,
        ),
        "out_dir": tmp_path / "out",
        "oracle_mask": tmp_path / "mask",
        "ce_plugin_snapshot": None,
        "trees_dir": tmp_path / "trees",
        "bwrap_bin": tmp_path / "bwrap",
        "runtime_mounts": (),
        "candidate_overlay": None,
        "overlay_digest": None,
    }
    fields.update(overrides)
    fields["out_dir"].mkdir(parents=True, exist_ok=True)
    return runner.TaskCellContext(**fields)


def _stub_cell_dependencies(monkeypatch, tmp_path):
    """Replace everything a cell shells out to, so only its own logic runs.

    Returns the clone it will hand out and the list its teardown appends to.
    """
    removed: list[Path] = []
    worktree = tmp_path / "clone"
    worktree.mkdir()
    monkeypatch.setattr(runner, "make_worktree", lambda *_a, **_k: worktree)
    monkeypatch.setattr(runner, "sanitize_clone_for_hidden_oracles", lambda *_a, **_k: "b" * 40)
    monkeypatch.setattr(runner, "stage_task_assets", lambda *_a, **_k: [])
    monkeypatch.setattr(runner, "isolated_gitnexus_registry_mount", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "ce_plugin_mounts_for_arm", lambda *_a, **_k: [])
    monkeypatch.setattr(runner, "ce_plugin_dir_for_arm", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "prepare_sandbox", lambda **_k: nullcontext(SimpleNamespace(run=None)))
    monkeypatch.setattr(runner, "skill_fingerprint", lambda *_a, **_k: "skill-digest")
    monkeypatch.setattr(runner, "require_skill_fingerprint", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "_sandbox_git", lambda *_a, **_k: "c" * 40)
    monkeypatch.setattr(runner, "implementation_diff_digest", lambda *_a, **_k: "")
    monkeypatch.setattr(runner, "_prepare_untracked_for_diff", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "diff_churn", lambda *_a, **_k: {})
    monkeypatch.setattr(runner, "enforce_work_evidence", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "capture_patch", lambda *_a, **_k: b"diff")
    monkeypatch.setattr(runner, "run_arm", lambda *_a, **_k: {"resolved": True, "ok": True, "error_kind": None})
    monkeypatch.setattr(runner, "remove_clone", lambda path: removed.append(path))
    return worktree, removed


def test_run_cell_returns_a_row_bound_to_its_task_and_snapshots(monkeypatch, tmp_path):
    _, removed = _stub_cell_dependencies(monkeypatch, tmp_path)

    record = runner.run_cell(_cell_context(tmp_path), 2, "workflow")

    assert record["resolved"] is True
    assert record["error_kind"] is None
    # The row has to carry its own coordinates: once cells stop running in a
    # predictable order, position in results.jsonl identifies nothing.
    assert record["task"] == "task-a"
    assert record["arm"] == "workflow"
    assert record["run"] == 2
    assert record["task_asset_snapshot_digest"] == "asset-digest"
    assert record["sanitized_graph_snapshot_digest"] == "graph-digest"
    assert record["oracle_digest"] == "oracle-digest"
    assert removed == [tmp_path / "clone"]


@pytest.mark.parametrize(
    "failure",
    [
        ManagedProcessError(
            ["setup"],
            ManagedProcessResult(
                state="timeout",
                returncode=-15,
                stdout_tail="",
                stderr_tail="",
                duration_s=1.0,
            ),
        ),
        SandboxError("sandbox refused"),
        OSError("disk went away"),
        RuntimeError("overlay drifted"),
        ValueError("bad binding"),
    ],
    ids=["managed-process", "sandbox", "os", "runtime", "value"],
)
def test_run_cell_records_an_expected_failure_and_still_removes_its_clone(monkeypatch, tmp_path, failure):
    _, removed = _stub_cell_dependencies(monkeypatch, tmp_path)

    def explode(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(runner, "run_arm", explode)
    record = runner.run_cell(_cell_context(tmp_path), 0, "workflow")

    assert record["error_kind"] == "infra-error"
    assert record["resolved"] is False
    # A cell owns its clone for its whole lifetime; the sweep has no other
    # chance to reclaim it, so the finally must survive every expected failure.
    assert removed == [tmp_path / "clone"]


def test_run_cell_redacts_the_auth_token_from_the_failure_it_prints(monkeypatch, tmp_path, capsys):
    _stub_cell_dependencies(monkeypatch, tmp_path)
    secret = "sk-ant-not-a-real-key"

    def explode(*_args, **_kwargs):
        raise ManagedProcessError(
            ["claude"],
            ManagedProcessResult(
                state="exited",
                returncode=1,
                stdout_tail="",
                stderr_tail=f"ANTHROPIC_API_KEY={secret}",
                duration_s=1.0,
            ),
        )

    monkeypatch.setattr(runner, "run_arm", explode)
    context = _cell_context(tmp_path)
    context.args.auth_token = secret
    # ManagedProcessError stringifies up to 1000 raw bytes of stderr_tail, and
    # this line streams live into the CI log now that the sweep's stdout is
    # echoed. results.jsonl already redacts the same field.
    runner.run_cell(context, 0, "workflow")

    assert secret not in capsys.readouterr().out


def test_run_cell_lets_an_unexpected_failure_escape_rather_than_scoring_it(monkeypatch, tmp_path):
    _, removed = _stub_cell_dependencies(monkeypatch, tmp_path)

    def explode(*_args, **_kwargs):
        raise KeyError("harness bug")

    monkeypatch.setattr(runner, "run_arm", explode)
    # A harness bug recorded as an ordinary infra-error would be averaged into
    # the evidence and counted toward the outage breaker. It must crash instead.
    with pytest.raises(KeyError):
        runner.run_cell(_cell_context(tmp_path), 0, "workflow")
    assert removed == [tmp_path / "clone"]


def test_run_cell_reports_a_cleanup_failure_over_its_primary_outcome(monkeypatch, tmp_path):
    _stub_cell_dependencies(monkeypatch, tmp_path)

    def refuse(_path):
        raise OSError("clone is busy")

    monkeypatch.setattr(runner, "remove_clone", refuse)
    record = runner.run_cell(_cell_context(tmp_path), 1, "workflow")

    assert record["error_kind"] == "cleanup-failure"
    assert record["resolved"] is False
    assert "primary=None" in record["error_detail"]
    assert "clone is busy" in record["error_detail"]


def test_run_cell_fails_closed_when_a_per_task_snapshot_never_materialized(tmp_path):
    # The snapshots are prepared once per task, before any cell. If that failed,
    # every cell of the task has to record it rather than run against nothing.
    context = _cell_context(tmp_path, asset_snapshot=None, asset_snapshot_error=OSError("no assets"))
    record = runner.run_cell(context, 0, "workflow")

    assert record["error_kind"] == "infra-error"
    assert "no assets" in str(record["error_detail"])


def _progress():
    """Collector for what a sweep started and kept, readable after it raises."""
    return SimpleNamespace(started=[], kept=[], streak=0, tripped=False)


def _sweep(cells, *, workers, run, outage_limit=5, streak=0, into=None):
    """Drive sweep_task_cells, recording what it started and kept.

    Pass ``into`` a ``_progress()`` when the sweep is expected to raise: the
    collector survives the exception, the return value does not.
    """
    result = _progress() if into is None else into
    result.streak, result.tripped = runner.sweep_task_cells(
        cells,
        workers=workers,
        run=run,
        on_start=lambda run_idx, arm: result.started.append((run_idx, arm)),
        on_record=lambda run_idx, arm, _record: result.kept.append((run_idx, arm)),
        outage_streak=streak,
        outage_limit=outage_limit,
    )
    return result


def _row(error_kind=None):
    return {"resolved": error_kind is None, "error_kind": error_kind}


CELLS = [(run_idx, arm) for run_idx in range(3) for arm in ("workflow", "candidate_workflow")]


def test_sweep_keeps_rows_in_submission_order_whatever_order_they_finish():
    # Cells finish in whatever order the machine allows, but a wave is folded
    # in submission order — the outage streak counts consecutive failures, and
    # "consecutive" in completion order would make the trip point flaky.
    import threading

    first_wave = CELLS[:3]
    rendezvous = threading.Barrier(3, timeout=10)
    release_first = threading.Event()
    fast_finished = threading.Event()
    finished: list[tuple[int, str]] = []
    result: list[SimpleNamespace] = []

    def run(run_idx, arm):
        cell = (run_idx, arm)
        if cell in first_wave:
            rendezvous.wait()
            if cell == first_wave[0]:
                release_first.wait(timeout=10)
            else:
                finished.append(cell)
                if len(finished) == 2:
                    fast_finished.set()
        return _row()

    sweep = threading.Thread(target=lambda: result.append(_sweep(CELLS, workers=3, run=run)))
    sweep.start()
    try:
        assert fast_finished.wait(timeout=10)
        assert first_wave[0] not in finished
        assert set(finished) == set(first_wave[1:])
    finally:
        release_first.set()
        sweep.join(timeout=10)

    assert not sweep.is_alive()
    assert result[0].kept == CELLS
    assert result[0].started == CELLS
    assert result[0].tripped is False


@pytest.mark.parametrize("workers", [1, 2, 3])
def test_sweep_trips_the_breaker_within_one_wave_of_the_serial_point(workers):
    # Serial stops after the 5th consecutive systemic failure. Cells already in
    # flight when the breaker trips cannot be recalled or erased from the
    # evidence, so the overrun is bounded by the wave and every completed row
    # is kept. Ten cells make the bound visible rather than hidden by the end.
    long_task = [(run_idx, arm) for run_idx in range(5) for arm in ("workflow", "candidate_workflow")]

    result = _sweep(long_task, workers=workers, run=lambda *_: _row("session-error"))

    assert result.tripped is True
    assert 5 <= len(result.started) <= 5 + workers - 1
    assert result.kept == result.started
    assert len(result.started) < len(long_task)


def test_sweep_reads_a_real_failure_as_signal_rather_than_an_outage():
    # resolved=False with no systemic error_kind is the benchmark working, not
    # the harness failing; it must reset the streak instead of tripping.
    result = _sweep(CELLS, workers=3, run=lambda *_: {"resolved": False, "error_kind": None})

    assert result.tripped is False
    assert result.streak == 0
    assert result.kept == CELLS


def test_sweep_surfaces_an_unexpected_worker_failure_instead_of_dropping_the_cell():
    def run(run_idx, arm):
        if (run_idx, arm) == (0, "candidate_workflow"):
            raise KeyError("harness bug")
        return _row()

    # A Future holds its exception until read. Unread, this cell would vanish
    # from the evidence with no crash and no row — fewer runs in an arm's
    # aggregate, silently.
    with pytest.raises(KeyError):
        _sweep(CELLS, workers=3, run=run)


def test_sweep_runs_cells_of_a_wave_at_the_same_time():
    import threading

    barrier = threading.Barrier(3, timeout=10)

    def run(run_idx, arm):
        # Deadlocks unless all three cells of the wave are genuinely in flight
        # together — a pool that serialised them would time out here.
        barrier.wait()
        return _row()

    result = _sweep(CELLS, workers=3, run=run)

    assert result.kept == CELLS


def test_sweep_of_one_worker_never_leaves_the_calling_thread():
    import threading

    caller = threading.current_thread()
    seen: list[threading.Thread] = []

    def run(run_idx, arm):
        seen.append(threading.current_thread())
        return _row()

    # Ctrl-C reaches only the main thread, so the serial default has to stay on
    # it: a cell on a worker thread is outside the reach of the cleanup that
    # kills its sandboxed process tree.
    _sweep(CELLS, workers=1, run=run)

    assert seen == [caller] * len(CELLS)


@pytest.mark.parametrize("failure", [KeyError("harness bug"), SystemExit(97)])
def test_sweep_keeps_the_rows_of_cells_that_finished_beside_a_failing_one(failure):
    def run(run_idx, arm):
        if (run_idx, arm) == (0, "candidate_workflow"):
            raise failure
        return _row()

    progress = _progress()
    # The failing cell's two siblings completed and spent their budget before
    # the harness bug surfaced. Reading the futures in order and raising on the
    # first failure would drop their rows: money spent, no evidence written.
    with pytest.raises(type(failure)):
        _sweep(CELLS, workers=3, run=run, into=progress)

    assert progress.kept == [(0, "workflow"), (1, "workflow")]


def test_sweep_hands_a_ctrl_c_back_without_waiting_for_the_running_cells(monkeypatch):
    import threading

    in_flight = threading.Barrier(3, timeout=10)
    release = threading.Event()
    finished: list[tuple[int, str]] = []

    def run(run_idx, arm):
        in_flight.wait()
        release.wait(timeout=10)
        finished.append((run_idx, arm))
        return _row()

    def interrupt_once_the_wave_is_running(_futures, *_args, **_kwargs):
        # Stands in for the Ctrl-C an operator types mid-wave: an async
        # KeyboardInterrupt is delivered to the main thread, which is the one
        # blocked here waiting on the wave.
        in_flight.wait()
        raise KeyboardInterrupt

    monkeypatch.setattr(runner, "wait", interrupt_once_the_wave_is_running)
    try:
        with pytest.raises(KeyboardInterrupt):
            _sweep(CELLS, workers=2, run=run)

        # Both cells are still parked on `release`, so the abort could not have
        # joined them — an executor shut down through its context manager waits
        # for exactly that, which is what made Ctrl-C look ignored.
        assert finished == []
    finally:
        release.set()


def test_workers_is_bounded_at_both_ends_before_the_sweep_starts():
    base = ["--tasks", "tasks.yaml", "--model", "pinned-model"]

    assert runner.build_parser().parse_args(base).workers == 1
    at_max = runner.build_parser().parse_args([*base, "--workers", str(runner.MAX_WORKERS)])
    assert at_max.workers == runner.MAX_WORKERS

    # A mistyped worker count has to fail at the command line: hours later it
    # only shows up as timed-out sessions, which the promotion gate throws away.
    for rejected in ("0", "-1", str(runner.MAX_WORKERS + 1)):
        with pytest.raises(SystemExit):
            runner.build_parser().parse_args([*base, "--workers", rejected])


@pytest.mark.parametrize("error_kind", ["infra-error", "cleanup-failure"])
def test_progress_line_reports_an_unmeasured_failure_as_unmeasured_not_as_free(error_kind):
    dead = runner.infra_error_record(RuntimeError("bwrap died"))
    dead["error_kind"] = error_kind

    line = runner.cell_progress_line("task", "workflow", 0, dead)

    # The 0.0s are placeholders for numbers no session ever produced; printed
    # as numbers they read as a cell that ran instantly for free.
    assert "cost=n/a" in line
    assert "took=n/a" in line
    assert f"error_kind={error_kind}" in line
    # results.jsonl is promotion evidence — only the display changes.
    assert dead["cost_usd"] == 0.0
    assert dead["duration_s"] == 0.0


def test_progress_line_reports_the_numbers_a_real_run_measured():
    line = runner.cell_progress_line(
        "task",
        "workflow",
        1,
        {
            "resolved": True,
            "input_tokens": 10,
            "output_tokens": 2,
            "cost_usd": 0.5,
            "duration_s": 12.0,
            "error_kind": None,
        },
    )

    assert "cost=$0.5" in line
    assert "took=12.0s" in line
    assert "error_kind=none" in line
