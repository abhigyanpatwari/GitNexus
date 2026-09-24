"""A row the runner actually emits must satisfy the reuse reader.

Every existing comparator-reuse test builds its rows by hand. That proves the
predicate's logic and nothing about the producer: a fixture can satisfy
eligibility while a real emitted row never does, and the audit that counts key
names cannot tell the difference. These tests carry one record through the
production path instead:

    real run_cell -> production JSONL writer -> load_result_rows
        -> row_is_reusable_comparator

Only the expensive dependencies are replaced - the model session, sandbox
launch, repository acquisition, graph preparation. The digest fields the reuse
binding compares are assembled by run_cell itself from its TaskCellContext, so
they stay real: they are the subject of the test, not scaffolding around it.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from workflow_bench import runner
from workflow_bench.proposer_sandbox import redact_text
from workflow_bench.model_gateway import credential_secrets
from workflow_bench.runner_sessions import PARENT_EVENT_STREAM_SOURCE
from workflow_bench.comparator_reuse import (
    ComparatorReuseExpectation,
    TaskReuseBinding,
    load_result_rows,
    row_is_reusable_comparator,
)

TASK_ID = "review-pr-2718-defect"
SHA = "a" * 40


def _snapshot(prefix: str) -> SimpleNamespace:
    return SimpleNamespace(
        digest=f"{prefix}-content",
        manifest_digest=f"{prefix}-manifest",
        dependency_content_digest=f"{prefix}-dep-content",
        dependency_manifest_digest=f"{prefix}-dep-manifest",
        command_digest=f"{prefix}-command",
        materialize=lambda *a, **k: None,
    )


def _write_like_the_sweep(tmp_path: Path, row: dict[str, Any]) -> Path:
    """Serialize exactly as ``keep`` does in _run_sweep, redaction included.

    json.dumps + write_text would skip the redaction the real writer applies,
    so a change there could break reusable rows without failing this test - and
    redaction is not cosmetic here, since it rewrites the row's own bytes.
    """

    results = tmp_path / "results.jsonl"
    secrets = credential_secrets(
        SimpleNamespace(auth_token="sk-ant-should-never-appear", base_url=None)
    )
    with results.open("a") as handle:
        handle.write(redact_text(json.dumps(row), secrets) + "\n")
    return results


@pytest.fixture
def emitted_row(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """One record from the real run_cell, with only expensive work replaced."""

    worktree = tmp_path / "clone"
    worktree.mkdir()

    # The session is what costs money; everything it returns is scripted. The
    # record's binding fields are NOT set here - run_cell derives them.
    def fake_run_arm(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {
            "ok": True,
            "error_kind": None,
            "error_detail": None,
            "resolved": True,
            "review_evidence_valid": True,
            "review_score": {"weighted_f1": 0.5},
            "review_weighted_f1": 0.5,
            "skill_invoked": True,
            "skill_digest": "skill-digest",
            "transcript_missing": False,
            "transcript_artifacts": [
                {
                    "path": "transcripts/session-1.jsonl",
                    "sha256": __import__("hashlib").sha256(b'{"type":"ok"}\n').hexdigest(),
                    "bytes": 14,
                    "source": PARENT_EVENT_STREAM_SOURCE,
                }
            ],
            "session_ids": ["s1"],
            "num_turns": 3,
            "duration_s": 1.0,
            "cost_usd": 0.5,
            "input_tokens": 1,
            "output_tokens": 1,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        }

    for name, value in {
        "run_arm": fake_run_arm,
        "copy_isolated_tree": lambda *a, **k: worktree,
        "make_worktree": lambda *a, **k: worktree,
        "sanitize_clone_for_hidden_oracles": lambda *a, **k: SHA,
        "stage_task_assets": lambda *a, **k: (),
        "isolated_gitnexus_registry_mount": lambda *a, **k: None,
        "seed_evaluated_skills": lambda *a, **k: None,
        "apply_candidate_overlay": lambda *a, **k: None,
        "require_hidden_harness_absent": lambda *a, **k: None,
        "require_skill_fingerprint": lambda *a, **k: None,
        "enforce_work_evidence": lambda *a, **k: None,
        "skill_fingerprint": lambda *a, **k: "skill-digest",
        "capture_patch": lambda *a, **k: b"",
        "implementation_diff_digest": lambda *a, **k: "",
        "diff_churn": lambda *a, **k: {},
        "_prepare_untracked_for_diff": lambda *a, **k: None,
        "remove_clone": lambda *a, **k: None,
        "ce_plugin_dir_for_arm": lambda *a, **k: None,
        "ce_plugin_mounts_for_arm": lambda *a, **k: (),
        "current_runtime_digest": lambda: "runtime-digest",
        "build_sandbox_environment": lambda *a, **k: {},
        "credential_secrets": lambda *a, **k: (),
        # run_cell requires an immutable base commit before it will record a
        # cell; the git plumbing is expensive setup, the SHA it returns is not
        # part of the reuse binding under test.
        "_sandbox_git": lambda *a, **k: SHA,
        # The artifact copy is real; only the read of the agent-written file is
        # replaced, since no agent ran to write one.
        "_bounded_regular_bytes": lambda *a, **k: b'{"schema_version":1}',
    }.items():
        monkeypatch.setattr(runner, name, value)

    class _Sandbox:
        clone = worktree
        private_root = tmp_path / "private"
        backend = "test-double"
        settings_json = "{}"
        require_pid_namespace = False

        def __enter__(self) -> _Sandbox:
            return self

        def __exit__(self, *_exc: Any) -> bool:
            return False

        def command_prefix_for(self, **_k: Any) -> list[str]:
            return []

        def run(self, *_a: Any, **_k: Any) -> SimpleNamespace:
            return SimpleNamespace(ok=True, returncode=0, stdout_tail="", stderr_tail="")

        def environment(self, **_k: Any) -> dict[str, str]:
            return {}

        def host_text(self, value: str) -> str:
            return value

    monkeypatch.setattr(runner, "prepare_sandbox", lambda **_k: _Sandbox())

    ctx = runner.TaskCellContext(
        task={"id": TASK_ID, "prompt": "review it", "verify": "true"},
        oracle_snapshot=_snapshot("oracle"),
        repo=tmp_path / "repo",
        task_sha=SHA,
        graph_snapshot=_snapshot("graph"),
        graph_snapshot_error=None,
        asset_snapshot=_snapshot("asset"),
        asset_snapshot_error=None,
        args=SimpleNamespace(
            model="gpt-5.6-sol", effort="xhigh", timeout=60, claude_bin="claude",
            base_url=None, auth_token=None, permission_mode=None, arms=["review"],
            proposer_model=None, outage_streak=5, runs=1, workers=1,
        ),
        out_dir=tmp_path / "out",
        ce_plugin_snapshot=None,
        trees_dir=tmp_path / "trees",
        bwrap_bin=Path("/bin/true"),
        runtime_mounts=(),
        candidate_overlay=None,
        overlay_digest=None,
        sandbox_backend="test-double",
        clone_template=None,
        sanitized_head=SHA,
    )
    (tmp_path / "out").mkdir(exist_ok=True)
    (tmp_path / "trees").mkdir(exist_ok=True)
    (tmp_path / "private").mkdir(exist_ok=True)
    # run_cell records review_artifact only when the review source exists, and
    # reuse now requires it - a scored review with no artifact is a claim about
    # evidence rather than the evidence. Production writes this file; the
    # fixture has to as well, or the emitted row is one production never emits.
    review_dir = tmp_path / "private" / "review-output"
    review_dir.mkdir(exist_ok=True)
    (review_dir / "review-output.json").write_text('{"schema_version": 1, "verdict": "approve", "findings": []}')
    return runner.run_cell(ctx, 0, "review")


def _expectation(**overrides: Any) -> ComparatorReuseExpectation:
    """Bindings from the sweep's own configuration, not copied out of the row.

    Copying the emitted values back in would make producer and consumer agree
    because the test arranged it, which is the blind spot being closed.
    """

    binding = TaskReuseBinding(
        task_base_sha=SHA,
        task_prompt_digest=runner.hashlib.sha256(b"review it").hexdigest(),
        oracle_digest="oracle-content",
        oracle_command_digest="oracle-command",
        oracle_manifest_digest="oracle-manifest",
        task_asset_manifest_digest="asset-manifest",
        sandbox_dependency_manifest_digest="asset-dep-manifest",
    )
    values: dict[str, Any] = dict(
        model="gpt-5.6-sol",
        effort="xhigh",
        sandbox_backend="test-double",
        runtime_digest="runtime-digest",
        now=datetime.now(UTC),
        max_age=timedelta(days=90),
        tasks={TASK_ID: binding},
        skill_digests={"review": "skill-digest"},
        ce_plugin_version=None,
        ce_plugin_manifest_digest=None,
    )
    values.update(overrides)
    return ComparatorReuseExpectation(**values)


def test_a_row_the_runner_emitted_survives_serialization_and_qualifies(
    emitted_row: dict[str, Any], tmp_path: Path
) -> None:
    """The producer/consumer contract, end to end through the real writer."""

    results = _write_like_the_sweep(tmp_path, emitted_row)
    rows = load_result_rows(results)
    assert len(rows) == 1, "the production row must survive the reader"

    assert row_is_reusable_comparator(rows[0], _expectation()) is True


def test_a_changed_binding_rejects_the_same_emitted_row(
    emitted_row: dict[str, Any], tmp_path: Path
) -> None:
    """Fails closed on drift, so the positive case is not vacuous."""

    row = load_result_rows(_write_like_the_sweep(tmp_path, emitted_row))[0]

    binding = TaskReuseBinding(
        task_base_sha=SHA,
        task_prompt_digest=runner.hashlib.sha256(b"review it").hexdigest(),
        oracle_digest="oracle-content",
        oracle_command_digest="oracle-command",
        oracle_manifest_digest="oracle-manifest",
        task_asset_manifest_digest="asset-manifest",
        sandbox_dependency_manifest_digest="DIFFERENT-dependencies",
    )
    assert row_is_reusable_comparator(row, _expectation(tasks={TASK_ID: binding})) is False
