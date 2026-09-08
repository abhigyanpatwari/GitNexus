"""A session end to end with only the model faked.

The layers between the CLI and the row are where this harness has actually
shipped bugs - the artifact that could not be written, the usage that was never
recorded, the evidence that was scored from the wrong directory. Every one of
them sat below the level its tests exercised. These run the real session path
against a scripted provider, so the only thing not real is what the model says.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from workflow_bench.mock_provider import MockProvider, Reply
from workflow_bench.proposer_sandbox import prepare_sandbox, prepare_review_workspace
from workflow_bench.review_scoring import REVIEW_OUTPUT, parse_review_output
from workflow_bench.runner_sessions import run_claude

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude.py"
REVIEW_JSON = '{"schema_version": 1, "verdict": "approve", "findings": []}'


def _session(clone: Path, provider: MockProvider, **overrides):
    return run_claude(
        "review the change",
        clone,
        claude_bin=str(FAKE_CLI),
        timeout=60,
        env={
            "ANTHROPIC_BASE_URL": provider.base_url,
            "ANTHROPIC_API_KEY": "offline",
            "PATH": "/usr/bin:/bin",
        },
        **overrides,
    )


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    workspace = tmp_path / "clone"
    workspace.mkdir()
    (workspace / "source.ts").write_text("export const answer = 42;\n")
    return workspace


def test_a_session_records_the_usage_the_provider_reported(clone: Path) -> None:
    """Token counts must survive the CLI boundary, not be invented after it."""

    reply = Reply(input_tokens=2_000, output_tokens=300, cache_read_input_tokens=7_000, cache_creation_input_tokens=1_000)
    with MockProvider(default=reply) as provider:
        record = _session(clone, provider)

    assert record["ok"] is True, record.get("error_detail")
    assert record["input_tokens"] == 2_000
    assert record["cache_read_input_tokens"] == 7_000
    assert record["cache_creation_input_tokens"] == 1_000
    assert record["output_tokens"] == 300
    # A measured zero would be indistinguishable from an unmeasured one.
    assert record["cost_usd"] == 0.42
    assert record["num_turns"] == 1


def test_a_scripted_write_produces_a_review_artifact_the_scorer_accepts(clone: Path, tmp_path: Path) -> None:
    """The full artifact path: model asks, CLI writes atomically, scorer reads.

    This is the operation that shipped empty for a whole run. Nothing here
    fakes the write, the directory, or the parse - only the decision to write.
    """

    with prepare_sandbox(
        clone=clone, claude_bin=Path(sys.executable), backend="host-unsafe", preflight=False
    ) as sandbox:
        artifact = prepare_review_workspace(sandbox, REVIEW_OUTPUT)
        write = {"name": "Write", "input": {"file_path": str(artifact), "content": REVIEW_JSON}}
        with MockProvider(default=Reply(text="reviewing", tools=[write])) as provider:
            record = _session(clone, provider)
            assert record["ok"] is True, record.get("error_detail")
            # Read inside the scope: prepare_sandbox removes the private root on exit.
            verdict, findings = parse_review_output(artifact)

    assert verdict == "approve"
    assert findings == ()


def test_the_provider_saw_the_prompt_the_harness_meant_to_send(clone: Path) -> None:
    """A run that measures the wrong prompt measures nothing."""

    with MockProvider() as provider:
        _session(clone, provider)

    assert provider.requests, "the session never reached the provider"
    sent = provider.requests[0].body["messages"][0]["content"]
    assert "review the change" in sent


def test_a_provider_failure_surfaces_as_a_failed_session_not_a_silent_pass(clone: Path) -> None:
    """An upstream 529 must not be recorded as a usable measurement."""

    failing = Reply(status_code=529, error_body={"error": {"type": "overloaded_error"}})
    with MockProvider(default=failing) as provider:
        record = _session(clone, provider)

    assert record["ok"] is False
    assert record["error_kind"] is not None
