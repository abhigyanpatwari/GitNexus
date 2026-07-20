"""Unit tests for workflow benchmark sessions, arms, transcripts, and phase boundaries."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench import evolve, runner, runner_sessions, runtime_mounts
from workflow_bench.evolution import skill_fingerprint
from workflow_bench.process_control import ManagedProcessResult
from workflow_bench.runner import snapshot_plan_docs


def fake_cli_result(
    stdout: str,
    *,
    returncode: int = 0,
    stderr: str = "",
    overflow: bool = False,
):
    return ManagedProcessResult(
        state="exited",
        returncode=returncode,
        stdout_tail=stdout,
        stderr_tail=stderr,
        duration_s=0.1,
        stdout_capture=stdout.encode(),
        stdout_capture_overflow=overflow,
    )


VALID_REPORT = (
    '{"type": "result", "session_id": "s", "num_turns": 3, "total_cost_usd": 0.1, "duration_ms": 1000,'
    ' "usage": {"input_tokens": 1, "cache_creation_input_tokens": 2,'
    ' "cache_read_input_tokens": 3, "output_tokens": 4}}'
)


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


def event_stream(*events: dict, result_overrides: dict | None = None) -> str:
    result = json.loads(VALID_REPORT)
    result.update(result_overrides or {})
    return "\n".join(json.dumps(event) for event in (*events, result)) + "\n"


def skill_events(skill_input: dict, *, tool_id: str = "skill-1", is_error: bool = False) -> list[dict]:
    return [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": tool_id,
                        "name": "Skill",
                        "input": skill_input,
                    }
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "is_error": is_error,
                        "content": "loaded",
                    }
                ]
            },
        },
    ]


def fake_sandbox(root: Path) -> SimpleNamespace:
    return SimpleNamespace(
        claude_bin="claude",
        clone=root,
        private_root=root,
        command_prefix=[],
        command_prefix_for=lambda **_kwargs: [],
        settings_json="{}",
        transcript_projects=root / "transcripts",
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
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(stdout))
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["ok"] is expected_ok


def test_parent_event_stream_rejects_non_finite_json_constants():
    with pytest.raises(ValueError, match="malformed parent-captured event JSON"):
        runner_sessions._parse_parent_event_stream(b'{"type":"assistant","score":NaN}\n')


def test_run_claude_forwards_the_named_model_to_every_session(monkeypatch, tmp_path):
    captured: list[str] = []

    def fake_run(command, **kwargs):
        captured.extend(command)
        return fake_cli_result(VALID_REPORT)

    monkeypatch.setattr(runner_sessions, "run_managed", fake_run)
    runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        model="claude-sonnet-4-20250514",
    )
    assert captured[captured.index("--model") + 1] == "claude-sonnet-4-20250514"


@pytest.mark.parametrize(
    ("proc", "expected_kind"),
    [
        (fake_cli_result(VALID_REPORT), None),
        (fake_cli_result(VALID_REPORT, returncode=1, stderr="boom"), "session-error"),
        (fake_cli_result(report_variant(is_error=True)), "session-error"),
        (fake_cli_result(report_variant(subtype="error_max_turns")), "session-error"),
        (fake_cli_result(""), "session-error"),  # malformed report
    ],
)
def test_run_claude_records_error_kind(monkeypatch, tmp_path, proc, expected_kind):
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: proc)
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["error_kind"] == expected_kind


def test_run_claude_keeps_raw_subtype_and_stderr_tail(monkeypatch, tmp_path):
    proc = fake_cli_result(VALID_REPORT, returncode=1, stderr="rate limit hit")
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: proc)
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["error_detail"] == {
        "subtype": None,
        "returncode": 1,
        "process_state": "exited",
        "stderr_tail": "rate limit hit",
        "stdout_tail": VALID_REPORT,
        "process_detail": None,
        "event_stream_error": None,
    }


def test_run_claude_surfaces_stdout_tail_on_empty_stderr(monkeypatch, tmp_path):
    # A session can exit non-zero with an EMPTY stderr (e.g. a pre-flight
    # sandbox failure before any model turn ever runs) -- stdout_tail is then
    # the only place the actual event stream is visible, so it must not be
    # dropped just because stderr had nothing to say.
    proc = fake_cli_result(VALID_REPORT, returncode=1, stderr="")
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: proc)
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5)
    assert rec["error_detail"]["stderr_tail"] == ""
    assert rec["error_detail"]["stdout_tail"] == VALID_REPORT


def test_run_arm_labels_completed_but_unverified_runs_verify_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: session_record())
    monkeypatch.setattr(runner, "run_verify", lambda *a, **k: (False, "failed"))
    sandbox = fake_sandbox(tmp_path)
    rec = runner.run_arm(
        "baseline",
        {"prompt": "p", "verify": "exit 1"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
    )
    assert rec["ok"] is True
    assert rec["resolved"] is False
    assert rec["error_kind"] == "verify-failed"


def test_run_arm_keeps_session_error_kind_over_verify(monkeypatch, tmp_path):
    dead = session_record(ok=False, error_kind="session-error", error_detail={"subtype": "error_max_turns"})
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: dict(dead))
    monkeypatch.setattr(runner, "run_verify", lambda *a, **k: (True, "ok"))
    sandbox = fake_sandbox(tmp_path)
    rec = runner.run_arm(
        "baseline",
        {"prompt": "p", "verify": "exit 0"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
    )
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "session-error"


def test_agent_tool_grants_are_exact_and_nomcp_has_no_graph_tools(monkeypatch, tmp_path):
    read_only = runner.allowed_agent_tools(implementation=False)
    implementation = runner.allowed_agent_tools(implementation=True)
    no_mcp = runner.allowed_agent_tools(implementation=True, include_mcp=False)

    assert read_only == [*runner.BUILTIN_AGENT_TOOLS, *runner.GITNEXUS_READ_ONLY_TOOLS]
    assert implementation == [
        *runner.BUILTIN_AGENT_TOOLS,
        *runner.GITNEXUS_READ_ONLY_TOOLS,
        *runner.GITNEXUS_MUTATING_TOOLS,
    ]
    assert no_mcp == list(runner.BUILTIN_AGENT_TOOLS)
    assert not any(tool.startswith("mcp__") for tool in no_mcp)

    captured: list[dict[str, object]] = []

    def fake_run_claude(*args, **kwargs):
        captured.append(dict(kwargs))
        return session_record()

    monkeypatch.setattr(runner, "run_claude", fake_run_claude)
    monkeypatch.setattr(runner, "run_verify", lambda *args, **kwargs: (True, "ok"))
    sandbox = fake_sandbox(tmp_path)
    for arm in ("workflow", "review", "workflow_direct", "baseline_nomcp"):
        runner.run_arm(
            arm,
            {"prompt": "p", "verify": "true"},
            tmp_path,
            bench_args(),
            sandbox=sandbox,
        )

    assert captured[0]["allowed_tools"] == read_only  # planning
    assert captured[1]["allowed_tools"] == read_only  # review
    assert captured[2]["allowed_tools"] == implementation
    assert captured[3]["allowed_tools"] == list(runner.BUILTIN_AGENT_TOOLS)
    assert captured[3]["mcp_config_json"] == '{"mcpServers":{}}'
    assert captured[3]["disallowed_tools"] == ["Skill", "mcp__gitnexus"]


def test_mcp_config_uses_only_the_minimal_pinned_harness_runtime(monkeypatch, tmp_path):
    runtime = tmp_path / "gitnexus"
    shared = tmp_path / "gitnexus-shared"
    for directory in (
        runtime / "dist" / "cli",
        runtime / "node_modules",
        runtime / "vendor",
        shared / "dist",
    ):
        directory.mkdir(parents=True)
    (runtime / "dist" / "cli" / "index.js").write_text("")
    (runtime / "package.json").write_text(json.dumps({"version": runner.PINNED_GITNEXUS_VERSION}))
    (runtime / "node_modules" / "gitnexus-shared").symlink_to(shared, target_is_directory=True)
    (shared / "package.json").write_text(json.dumps({"name": "gitnexus-shared"}))
    monkeypatch.setattr(runtime_mounts, "HARNESS_ROOT", tmp_path)

    config = json.loads(runner.sandbox_mcp_config())
    server = config["mcpServers"]["gitnexus"]
    command_line = [server["command"], *server["args"]]

    assert runner.SANDBOX_GITNEXUS_ENTRYPOINT in command_line
    assert not any(value.startswith("/workspace/") for value in command_line)
    assert f"GITNEXUS_HOME={runner.SANDBOX_GITNEXUS_REGISTRY}" in command_line
    assert "GITNEXUS_MCP_ALLOWED_REPOS=/workspace" in command_line
    assert "GITNEXUS_MCP_DEFAULT_REPO=/workspace" in command_line
    mounts = runner.trusted_gitnexus_runtime_mounts()
    assert [(mount.source, mount.target) for mount in mounts] == [
        (runtime / "dist", f"{runner.SANDBOX_GITNEXUS}/dist"),
        (runtime / "package.json", f"{runner.SANDBOX_GITNEXUS}/package.json"),
        (runtime / "node_modules", f"{runner.SANDBOX_GITNEXUS}/node_modules"),
        (runtime / "vendor", f"{runner.SANDBOX_GITNEXUS}/vendor"),
        (shared / "dist", f"{runner.SANDBOX_GITNEXUS_SHARED}/dist"),
        (shared / "package.json", f"{runner.SANDBOX_GITNEXUS_SHARED}/package.json"),
    ]
    package = json.loads((runtime / "package.json").read_text())
    assert package["version"] == runner.PINNED_GITNEXUS_VERSION

    mounted_sources = {mount.source for mount in mounts}
    mounted_targets = {mount.target for mount in mounts}
    assert runtime not in mounted_sources
    assert shared not in mounted_sources
    for forbidden in (".env", ".env.example", ".npmrc", ".git", ".gitnexus", "src", "test", "tests", "skills"):
        assert runtime / forbidden not in mounted_sources
        assert f"{runner.SANDBOX_GITNEXUS}/{forbidden}" not in mounted_targets
        assert shared / forbidden not in mounted_sources
        assert f"{runner.SANDBOX_GITNEXUS_SHARED}/{forbidden}" not in mounted_targets


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_runtime_mount_imports_cli_without_exposing_checkout(tmp_path):
    clone = tmp_path / "clone"
    clone.mkdir()
    mounts = runner.trusted_gitnexus_runtime_mounts()

    required = [
        runner.SANDBOX_GITNEXUS_ENTRYPOINT,
        f"{runner.SANDBOX_GITNEXUS}/package.json",
        f"{runner.SANDBOX_GITNEXUS}/node_modules",
        f"{runner.SANDBOX_GITNEXUS}/vendor",
        f"{runner.SANDBOX_GITNEXUS_SHARED}/dist/index.js",
        f"{runner.SANDBOX_GITNEXUS_SHARED}/package.json",
    ]
    forbidden = [
        f"{runner.SANDBOX_GITNEXUS}/{relative}"
        for relative in (".env", ".env.example", ".npmrc", ".git", ".gitnexus", "src", "test", "tests", "skills")
    ] + [
        f"{runner.SANDBOX_GITNEXUS_SHARED}/{relative}"
        for relative in (".env", ".env.example", ".npmrc", ".git", ".gitnexus", "src", "test", "tests", "skills")
    ]
    visibility_script = (
        "const fs=require('fs');"
        f"for(const p of {json.dumps(required)}) fs.accessSync(p,fs.constants.R_OK);"
        f"for(const p of {json.dumps(forbidden)}) "
        "if(fs.existsSync(p))throw new Error('unexpected checkout path: '+p);"
    )

    with runner.prepare_sandbox(
        clone=clone,
        claude_bin=Path(sys.executable),
        read_only_mounts=mounts,
        preflight=True,
    ) as sandbox:
        visibility = sandbox.run(
            ["/usr/local/bin/node", "-e", visibility_script],
            timeout=10,
        )
        imported = sandbox.run(
            ["/usr/local/bin/node", runner.SANDBOX_GITNEXUS_ENTRYPOINT, "--version"],
            timeout=10,
        )

    assert visibility.ok, visibility.stderr_tail
    assert imported.ok, imported.stderr_tail
    assert imported.stdout_tail.strip() == runner.PINNED_GITNEXUS_VERSION


def test_isolated_mcp_registry_contains_only_the_sandbox_clone(tmp_path):
    worktree = tmp_path / "clone"
    metadata = worktree / ".gitnexus" / "gitnexus.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text(
        json.dumps(
            {
                "indexedAt": "2026-07-18T00:00:00Z",
                "lastCommit": "a" * 40,
                "stats": {"files": 1},
            }
        )
    )

    mount = runner.isolated_gitnexus_registry_mount(worktree, tmp_path)
    registry_file = mount.source / "registry.json"
    registry = json.loads(registry_file.read_text())

    assert mount.target == runner.SANDBOX_GITNEXUS_REGISTRY
    assert mount.source.stat().st_mode & 0o777 == 0o700
    assert registry_file.stat().st_mode & 0o777 == 0o600
    assert registry == [
        {
            "indexedAt": "2026-07-18T00:00:00Z",
            "lastCommit": "a" * 40,
            "name": "benchmark-target",
            "path": "/workspace",
            "stats": {"files": 1},
            "storagePath": "/workspace/.gitnexus",
        }
    ]


def test_resolved_implementation_without_repository_work_fails_closed():
    rec = {"resolved": True, "error_kind": None, "error_detail": None}
    runner.enforce_work_evidence(
        rec,
        arm="workflow_direct",
        before_digest="same",
        after_digest="same",
    )
    assert rec["resolved"] is False
    assert rec["error_kind"] == "no-work-produced"


@pytest.mark.skipif(os.name == "nt", reason="sandbox patch streaming uses POSIX executable paths")
def test_capture_patch_materializes_only_the_bounded_prefix(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    changed = repo / "changed.txt"
    changed.write_text("before\n")
    subprocess.run(["git", "-C", str(repo), "add", "changed.txt"], check=True)
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
            "base",
        ],
        check=True,
    )
    orig_sha = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    changed.write_text("changed line\n" * 100_000)

    class LocalSandbox:
        def run(self, command, **kwargs):
            translated = [
                str(repo) + item.removeprefix("/workspace") if item.startswith("/workspace/") else item
                for item in command
            ]
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

    patch = runner.capture_patch(LocalSandbox(), repo, orig_sha)

    assert len(patch) == runner.MAX_PATCH_BYTES
    materialized = next(repo.glob(".wfbench-artifact-*/final.patch"))
    assert materialized.stat().st_size == runner.MAX_PATCH_BYTES


def test_workflow_never_starts_work_after_failed_or_invalid_planning(monkeypatch, tmp_path):
    sandbox = fake_sandbox(tmp_path)
    calls: list[str] = []

    def failed_plan(prompt, *args, **kwargs):
        calls.append(prompt)
        return session_record(ok=False, error_kind="session-error", error_detail="planning failed")

    monkeypatch.setattr(runner, "run_claude", failed_plan)
    monkeypatch.setattr(runner, "run_verify", lambda *a, **k: (True, "ok"))
    failed = runner.run_arm(
        "workflow",
        {"prompt": "p", "verify": "exit 0"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
    )
    assert len(calls) == 1
    assert failed["resolved"] is False
    assert failed["plan_produced"] is False

    calls.clear()
    monkeypatch.setattr(
        runner,
        "run_claude",
        lambda prompt, *args, **kwargs: calls.append(prompt) or session_record(),
    )
    invalid = runner.run_arm(
        "workflow",
        {"prompt": "p", "verify": "exit 0"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
    )
    assert len(calls) == 1
    assert invalid["resolved"] is False
    assert invalid["error_kind"] == "plan-evidence-invalid"


def test_skill_invocation_is_detected_from_parent_event_stream(monkeypatch, tmp_path):
    stream = event_stream(*skill_events({"command": "gitnexus-work"}))
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(stream))

    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
    )

    assert rec["ok"] is True
    assert rec["skill_invoked"] is True
    assert rec["error_kind"] is None


@pytest.mark.parametrize(
    "skill_input",
    [
        {"skill": "gitnexus-work"},
        {"command": "/gitnexus-work execute the plan"},
        {"name": "gitnexus-work direct-mode"},
    ],
)
def test_skill_invocation_parses_supported_exact_identifier_fields(skill_input):
    assert (
        runner_sessions.skill_was_invoked_events(
            skill_events(skill_input),
            "gitnexus-work",
        )
        is True
    )


@pytest.mark.parametrize(
    "skill_input",
    [
        {"skill": "gitnexus-work-extra"},
        {"skill": "prefix-gitnexus-work"},
        {"command": "/gitnexus-work-extra execute"},
        {"command": "other-skill", "args": "please use gitnexus-work"},
        {"name": "other-skill", "description": "gitnexus-work"},
        {"args": "gitnexus-work"},
    ],
)
def test_skill_invocation_rejects_prefix_suffix_and_argument_mentions(skill_input):
    assert (
        runner_sessions.skill_was_invoked_events(
            skill_events(skill_input),
            "gitnexus-work",
        )
        is False
    )


def test_skill_invocation_scans_through_eof_and_rejects_later_malformed_json(monkeypatch, tmp_path):
    stream = event_stream(*skill_events({"skill": "gitnexus-work"})) + '{"truncated":'
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(stream))

    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
    )

    assert rec["ok"] is False
    assert rec["error_kind"] == "session-error"
    assert "malformed parent-captured event JSON" in rec["error_detail"]["event_stream_error"]


def test_matching_skill_requires_one_later_successful_result(monkeypatch, tmp_path):
    failed_stream = event_stream(*skill_events({"skill": "gitnexus-work"}, is_error=True))
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(failed_stream))
    failed = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
    )
    assert failed["skill_invoked"] is False
    assert failed["error_kind"] == "skill-not-invoked"

    missing_result = event_stream(skill_events({"skill": "gitnexus-work"})[0])
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(missing_result))
    missing = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
    )
    assert missing["skill_invoked"] is None
    assert missing["error_kind"] == "evidence-unverified"
    assert "no tool result" in missing["error_detail"]


def test_skill_evidence_rejects_duplicate_tool_use_and_result_ids():
    request, result = skill_events({"skill": "gitnexus-work"})
    duplicate_request = json.loads(json.dumps(request))
    with pytest.raises(ValueError, match="duplicate tool-use id"):
        runner_sessions.skill_was_invoked_events(
            [request, duplicate_request, result],
            "gitnexus-work",
        )

    error_result = json.loads(json.dumps(result))
    error_result["message"]["content"][0]["is_error"] = True
    with pytest.raises(ValueError, match="duplicate tool result"):
        runner_sessions.skill_was_invoked_events(
            [request, result, error_result],
            "gitnexus-work",
        )


def test_agent_writable_home_transcript_cannot_forge_skill_evidence(monkeypatch, tmp_path):
    forged = tmp_path / ".claude" / "projects" / "forged" / "s.jsonl"
    forged.parent.mkdir(parents=True)
    forged.write_text(event_stream(*skill_events({"skill": "gitnexus-work"})))
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(VALID_REPORT))

    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
        transcript_projects=tmp_path / ".claude" / "projects",
    )

    assert rec["skill_invoked"] is False
    assert rec["error_kind"] == "skill-not-invoked"


@pytest.mark.parametrize(
    "arm",
    ["workflow", "workflow_direct", "ce_workflow", "ce_workflow_direct"],
)
def test_every_skill_implementation_session_rechecks_fingerprint_immediately(
    monkeypatch,
    tmp_path,
    arm,
):
    plan = tmp_path / "docs" / "plans" / "plan.md"
    calls: list[tuple[str, str]] = []

    def fake_run(prompt, *args, **kwargs):
        if "deliverable" in prompt:
            plan.parent.mkdir(parents=True, exist_ok=True)
            plan.write_text("plan")
        return session_record()

    def fingerprint(*args, **kwargs):
        calls.append((args[1], kwargs["phase"]))
        raise ValueError("implementation changed the evaluated skill fingerprint")

    monkeypatch.setattr(runner, "run_claude", fake_run)
    monkeypatch.setattr(runner, "require_skill_fingerprint", fingerprint)
    monkeypatch.setattr(runner, "run_verify", lambda *args, **kwargs: (True, "ok"))
    rec = runner.run_arm(
        arm,
        {"prompt": "p", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=fake_sandbox(tmp_path),
        expected_skill_digest="trusted",
    )

    assert calls == [(arm, "implementation")]
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "implementation-evidence-invalid"


def test_direct_implementation_skill_mutation_fails_before_verification(monkeypatch, tmp_path):
    skill = tmp_path / ".claude" / "skills" / "gitnexus-work" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("trusted prompt")
    expected = skill_fingerprint(tmp_path, "workflow_direct")
    order: list[str] = []
    real_fingerprint_check = runner.require_skill_fingerprint

    def mutating_session(*args, **kwargs):
        order.append("session")
        skill.write_text("model replaced prompt")
        return session_record()

    def tracked_fingerprint(*args, **kwargs):
        order.append("fingerprint")
        return real_fingerprint_check(*args, **kwargs)

    def verify(*args, **kwargs):
        order.append("verify")
        return True, "ok"

    monkeypatch.setattr(runner, "run_claude", mutating_session)
    monkeypatch.setattr(runner, "require_skill_fingerprint", tracked_fingerprint)
    monkeypatch.setattr(runner, "run_verify", verify)
    rec = runner.run_arm(
        "workflow_direct",
        {"prompt": "p", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=fake_sandbox(tmp_path),
        expected_skill_digest=expected,
    )

    assert order == ["session", "fingerprint", "verify"]
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "implementation-evidence-invalid"


def test_parent_event_stream_is_persisted_private_redacted_and_digest_bound(monkeypatch, tmp_path):
    secret = "sk-ant-transcript-secret"
    bearer = "Authorization: Bearer bearer-postmortem-secret"
    structural_secret = "token-in-authorization-value"
    password = "password-in-structured-field"
    events = skill_events({"command": "gitnexus-work"})
    events.insert(
        1,
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": secret}]},
        },
    )
    events.insert(
        2,
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": bearer}]},
        },
    )
    events.insert(
        3,
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "metadata": {
                            "Authorization": f"Bearer {structural_secret}",
                            "password": password,
                        },
                    }
                ]
            },
        },
    )
    stream = event_stream(*events)
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(stream))
    output = tmp_path / "run-output"
    output.mkdir()

    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
        transcript_output_dir=output,
        transcript_output_prefix="task-workflow-run0",
        transcript_secrets=(secret,),
    )

    artifact_meta = rec["transcript_artifact"]
    artifact = output / artifact_meta["path"]
    assert artifact_meta["path"] == "transcripts/task-workflow-run0-s.jsonl"
    assert artifact.stat().st_mode & 0o777 == 0o600
    assert artifact.parent.stat().st_mode & 0o777 == 0o700
    assert secret not in artifact.read_text()
    assert "bearer-postmortem-secret" not in artifact.read_text()
    assert structural_secret not in artifact.read_text()
    assert password not in artifact.read_text()
    assert artifact.read_text().count("[REDACTED]") >= 4
    assert all(isinstance(json.loads(line), dict) for line in artifact.read_text().splitlines())
    assert artifact_meta["bytes"] == artifact.stat().st_size
    assert artifact_meta["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert artifact_meta["source"] == "parent-captured-stream-json"

    # PR #2566 P1 regression: sum_sessions forwards the producer's 4-key record
    # (including `source`) into transcript_artifacts, and a --seed-results / gen>=2
    # run JSON round-trips it through the proposer evidence preflight. That preflight
    # once required exactly {path, sha256, bytes} and aborted every seeded run with
    # SandboxError. Round-trip real producer output through the real preflight so the
    # producer/validator schema can never drift apart again.
    seeded = json.loads(json.dumps(runner_sessions.sum_sessions([rec])))
    evolve._preflight_transcript_artifacts([{"transcript_artifacts": seeded["transcript_artifacts"]}])


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0.0, 0.0),
        (1.25, 1.25),
        (3, 3.0),
        (None, None),
        ("free", None),
        (True, None),
        (-1.0, None),
        (float("nan"), None),
        (float("inf"), None),
    ],
)
def test_measured_cost_distinguishes_absent_from_zero(raw, expected):
    # A measured $0 stays 0.0; an absent/garbage cost becomes None so it can
    # never be scored as a real zero the promotion gate ranks on.
    assert runner_sessions.measured_cost(raw) == expected


def test_missing_skill_invocation_fails_closed(monkeypatch, tmp_path):
    read_events = skill_events({"skill": "other-skill"}, tool_id="read-1")
    monkeypatch.setattr(
        runner_sessions,
        "run_managed",
        lambda *a, **k: fake_cli_result(event_stream(*read_events)),
    )
    rec = runner.run_claude("task", tmp_path, claude_bin="claude", timeout=5, expected_skill="gitnexus-work")
    assert rec["ok"] is False
    assert rec["skill_invoked"] is False
    assert rec["error_kind"] == "skill-not-invoked"


def test_overflowed_parent_capture_is_ineligible_evidence(monkeypatch, tmp_path):
    monkeypatch.setattr(
        runner_sessions,
        "run_managed",
        lambda *a, **k: fake_cli_result(VALID_REPORT, overflow=True),
    )
    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
        expected_skill="gitnexus-work",
    )
    assert rec["ok"] is False
    assert rec["skill_invoked"] is None
    assert rec["error_kind"] == "session-error"
    assert "exceeds" in rec["error_detail"]["event_stream_error"]


def test_final_result_event_must_be_last(monkeypatch, tmp_path):
    stream = VALID_REPORT + "\n" + json.dumps({"type": "assistant", "message": {"content": []}}) + "\n"
    monkeypatch.setattr(runner_sessions, "run_managed", lambda *a, **k: fake_cli_result(stream))
    rec = runner.run_claude(
        "task",
        tmp_path,
        claude_bin="claude",
        timeout=5,
    )

    assert rec["ok"] is False
    assert rec["error_kind"] == "session-error"
    assert "not the last event" in rec["error_detail"]["event_stream_error"]


def test_snapshot_plan_docs_detects_one_modified_plan_and_rejects_ambiguous_output(tmp_path):
    plans = tmp_path / "docs" / "plans"
    plans.mkdir(parents=True)
    first = plans / "one.md"
    first.write_text("before")
    before = snapshot_plan_docs(tmp_path)
    first.write_text("after")
    assert runner.new_plan_doc(tmp_path, before) == first

    second = plans / "two.md"
    second.write_text("new")
    first.write_text("changed again")
    with pytest.raises(ValueError, match="exactly one"):
        runner.new_plan_doc(tmp_path, before)


def test_plan_output_rejects_unchanged_deleted_and_symlink_paths(tmp_path):
    plans = tmp_path / "docs" / "plans"
    plans.mkdir(parents=True)
    plan = plans / "one.md"
    plan.write_text("same")
    before = snapshot_plan_docs(tmp_path)
    with pytest.raises(ValueError, match="exactly one"):
        runner.new_plan_doc(tmp_path, before)

    plan.unlink()
    with pytest.raises(ValueError, match="deleted"):
        runner.new_plan_doc(tmp_path, before)

    target = tmp_path / "outside.md"
    target.write_text("outside")
    plan.symlink_to(target)
    with pytest.raises(ValueError, match="symlink"):
        runner.new_plan_doc(tmp_path, {})


def test_setup_skill_fingerprint_change_fails_closed(tmp_path):
    for skill in ("gitnexus-plan", "gitnexus-work"):
        path = tmp_path / ".claude" / "skills" / skill / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{skill} original")
    expected = skill_fingerprint(tmp_path, "workflow")
    (tmp_path / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md").write_text("replaced by setup")

    with pytest.raises(ValueError, match="task setup changed the evaluated skill fingerprint"):
        runner.require_skill_fingerprint(tmp_path, "workflow", expected, phase="task setup")


def test_planning_cannot_change_source_tests_or_downstream_skill(monkeypatch, tmp_path):
    for skill in ("gitnexus-plan", "gitnexus-work"):
        path = tmp_path / ".claude" / "skills" / skill / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{skill} original")
    source = tmp_path / "source.py"
    source.write_text("original")
    expected = skill_fingerprint(tmp_path, "workflow")
    calls: list[str] = []

    def adversarial_plan(prompt, *args, **kwargs):
        calls.append(prompt)
        plans = tmp_path / "docs" / "plans"
        plans.mkdir(parents=True)
        (plans / "authorized.md").write_text("plan")
        source.write_text("pre-implemented by planning")
        (tmp_path / ".claude" / "skills" / "gitnexus-work" / "SKILL.md").write_text("weakened")
        return session_record()

    monkeypatch.setattr(runner, "run_claude", adversarial_plan)
    monkeypatch.setattr(runner, "run_verify", lambda *a, **k: (True, "ok"))
    sandbox = fake_sandbox(tmp_path)

    rec = runner.run_arm(
        "workflow",
        {"prompt": "p", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
        expected_skill_digest=expected,
        enforce_phase_boundary=True,
    )

    assert len(calls) == 1
    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "plan-evidence-invalid"
    assert "unauthorized workspace path" in rec["error_detail"]


@pytest.mark.parametrize("arm", ["review", "ce_review"])
@pytest.mark.parametrize(
    ("attack", "expected_detail"),
    [
        ("workspace", "unauthorized workspace path"),
        ("skill", "changed the evaluated skill fingerprint"),
    ],
)
def test_review_phase_rejects_workspace_or_skill_mutation(
    monkeypatch,
    tmp_path,
    arm,
    attack,
    expected_detail,
):
    source = tmp_path / "source.py"
    source.write_text("original")
    expected_skill_digest = "expected-skill-fingerprint"

    def adversarial_review(prompt, *args, **kwargs):
        (tmp_path / "review-output.md").write_text("review findings")
        if attack == "workspace":
            source.write_text("review silently changed source")
        return session_record()

    observed_skill_digest = "tampered-skill-fingerprint" if attack == "skill" else expected_skill_digest
    monkeypatch.setattr(runner, "run_claude", adversarial_review)
    monkeypatch.setattr(
        runner,
        "skill_fingerprint",
        lambda worktree, checked_arm: observed_skill_digest,
    )
    monkeypatch.setattr(runner, "run_verify", lambda *a, **k: (True, "ok"))
    sandbox = fake_sandbox(tmp_path)

    rec = runner.run_arm(
        arm,
        {"prompt": "p", "verify": "true"},
        tmp_path,
        bench_args(),
        sandbox=sandbox,
        expected_skill_digest=expected_skill_digest,
        enforce_phase_boundary=True,
    )

    assert rec["ok"] is False
    assert rec["resolved"] is False
    assert rec["error_kind"] == "review-evidence-invalid"
    assert expected_detail in rec["error_detail"]


def _git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)


def _git_commit(repo, message):
    _git(
        repo,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
    )
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def test_make_worktree_clone_has_no_tags_but_keeps_all_branches(tmp_path):
    # oracle_assets.MAX_CLONE_REFS refuses to sanitize a clone with more than
    # 1024 refs; this repo's own history has 1000+ release-candidate tags, so
    # a plain `git clone` of it (inheriting every tag) trips that cap on every
    # benchmark session. make_worktree must not carry tags into its throwaway
    # clone, but callers pass a bare SHA or "HEAD" as `ref` (never a branch
    # name -- see evolve.py:476, runner.py:1037, sanitized_graph.py:345), so
    # branch-fetching itself must stay untouched: a commit reachable only from
    # a non-default branch must still resolve via the existing
    # checkout(ref) -> checkout(origin/{ref}) fallback.
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "--quiet")
    _git(repo, "checkout", "--quiet", "-b", "main")
    _git_commit(repo, "base")
    _git(repo, "tag", "v1.0.0-rc.1")

    _git(repo, "checkout", "--quiet", "-b", "other")
    other_sha = _git_commit(repo, "only on other")
    _git(repo, "checkout", "--quiet", "main")

    clones = tmp_path / "clones"
    clones.mkdir()
    target = runner.make_worktree(repo, other_sha, clones)

    tags = _git(target, "tag").stdout.split()
    assert tags == [], f"clone must carry no tags, found: {tags}"

    current = _git(target, "rev-parse", "HEAD").stdout.strip()
    assert current == other_sha
