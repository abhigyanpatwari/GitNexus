"""What the proxy writes must outlive the translation that follows it.

Claude Code receives an Anthropic-shaped response, which has nowhere to put
OpenAI's cached_tokens, cache_write_tokens or reasoning_tokens. If those are not
captured before the translation, the only remaining record of them is a bill.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench.litellm_usage_callback import USAGE_LOG_ENV_VAR, ProviderUsageLogger
from workflow_bench.model_gateway import (
    USAGE_CALLBACK_MODULE,
    openai_litellm_config,
    write_openai_litellm_config,
)
from workflow_bench.provider_usage import OPENAI_RESPONSES, normalize_usage


class _Usage:
    """Stands in for the provider usage model LiteLLM hands the callback."""

    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def model_dump(self) -> dict:
        return self._payload


def _openai_response(usage: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id="resp_68f2c1",
        # The model that actually answered, which is not the role the caller asked for.
        model="gpt-5.6-sol-2026-08-01",
        usage=_Usage(usage),
    )


NATIVE = {
    "input_tokens": 48_000,
    "input_tokens_details": {"cached_tokens": 44_000, "cache_write_tokens": 1_000},
    "output_tokens": 900,
    "output_tokens_details": {"reasoning_tokens": 640},
}


@pytest.fixture
def logged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    log = tmp_path / "provider_usage.jsonl"
    monkeypatch.setenv(USAGE_LOG_ENV_VAR, str(log))
    monkeypatch.setenv("GITNEXUS_BENCH_CELL_ID", "review-pr-2718-defect:review:0")

    def emit(usage: dict) -> dict:
        ProviderUsageLogger()._append(
            "success",
            {"model": "claude-sonnet-4-5", "custom_llm_provider": "openai", "call_type": "responses"},
            _openai_response(usage),
            0.0,
            1.0,
        )
        return json.loads(log.read_text().splitlines()[-1])

    return emit


def test_native_openai_usage_survives_the_anthropic_translation(logged) -> None:
    event = logged(NATIVE)
    native = event["native_usage"]
    # Verbatim: the fields an Anthropic-shaped response cannot carry.
    assert native["input_tokens_details"]["cached_tokens"] == 44_000
    assert native["input_tokens_details"]["cache_write_tokens"] == 1_000
    assert native["output_tokens_details"]["reasoning_tokens"] == 640
    assert event["response_id"] == "resp_68f2c1"


def test_the_actual_model_is_recorded_separately_from_the_requested_role(logged) -> None:
    """Pricing must follow what answered, not what the caller named."""

    event = logged(NATIVE)
    assert event["requested_model"] == "claude-sonnet-4-5"
    assert event["actual_model"] == "gpt-5.6-sol-2026-08-01"
    assert event["cell_id"] == "review-pr-2718-defect:review:0"


def test_the_captured_event_normalizes_with_openai_arithmetic(logged) -> None:
    """Capture and normalization must agree end to end, not just in isolation."""

    usage = normalize_usage(OPENAI_RESPONSES, logged(NATIVE)["native_usage"])
    assert usage.total_input_tokens == 48_000
    assert usage.ordinary_input_tokens == 3_000
    assert usage.cache_read_input_tokens == 44_000
    assert usage.complete


def test_usage_without_details_normalizes_to_unknown_rather_than_zero(logged) -> None:
    """The mutation the accounting must not survive: dropped details, silent zeros."""

    stripped = {k: v for k, v in NATIVE.items() if k != "input_tokens_details"}
    usage = normalize_usage(OPENAI_RESPONSES, logged(stripped)["native_usage"])
    assert usage.cache_read_input_tokens is None
    assert usage.ordinary_input_tokens is None
    assert not usage.complete


def test_a_failed_request_is_still_accounted_for(logged, tmp_path: Path) -> None:
    """The money was spent whether or not the cell produced an artifact."""

    ProviderUsageLogger()._append(
        "failure", {"model": "claude-sonnet-4-5"}, _openai_response(NATIVE), 0.0, 1.0
    )
    events = [json.loads(line) for line in (tmp_path / "provider_usage.jsonl").read_text().splitlines()]
    assert events[-1]["status"] == "failure"


def test_the_logger_never_raises_into_the_proxy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Accounting is evidence, not control flow."""

    monkeypatch.setenv(USAGE_LOG_ENV_VAR, str(tmp_path / "missing-dir" / "usage.jsonl"))
    ProviderUsageLogger()._append("success", {}, object(), 0.0, 1.0)


def test_no_log_is_written_when_the_destination_is_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(USAGE_LOG_ENV_VAR, raising=False)
    ProviderUsageLogger()._append("success", {}, _openai_response(NATIVE), 0.0, 1.0)
    assert not list(tmp_path.iterdir())


def test_the_generated_config_loads_the_callback_from_beside_itself(tmp_path: Path) -> None:
    """LiteLLM resolves the dotted path relative to the config directory."""

    config = write_openai_litellm_config(tmp_path / "litellm.yaml", ["gpt-5.6-sol"])
    assert openai_litellm_config(["gpt-5.6-sol"])["litellm_settings"]["callbacks"] == [
        f"{USAGE_CALLBACK_MODULE}.handler"
    ]
    installed = config.parent / f"{USAGE_CALLBACK_MODULE}.py"
    assert installed.is_file(), "the proxy cannot import a callback that was never placed"
    assert "class ProviderUsageLogger" in installed.read_text()
