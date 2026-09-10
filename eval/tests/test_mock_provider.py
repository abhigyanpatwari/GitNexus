"""The mock has to be right about the wire, or every test built on it lies."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

import pytest

from workflow_bench.mock_provider import MockProvider, Reply
from workflow_bench.provider_usage import (
    ANTHROPIC,
    LITELLM_NORMALIZED,
    OPENAI_RESPONSES,
    normalize_usage,
)


def _post(url: str, payload: dict) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, response.read()


def test_anthropic_messages_returns_a_usable_message() -> None:
    with MockProvider([Reply(text="reviewed")]) as provider:
        _status, raw = _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
    body = json.loads(raw)
    assert body["role"] == "assistant"
    assert body["content"][0]["text"] == "reviewed"
    assert body["stop_reason"] == "end_turn"


def test_a_scripted_tool_call_is_carried_as_a_tool_use_block() -> None:
    """Tool blocks are how a mocked run produces real artifacts.

    The CLI executes what it is asked to run, so a Write block makes it write
    that file for real inside the sandbox - which is how an artifact-producing
    cell can be exercised with no model involved.
    """

    write = {"name": "Write", "input": {"file_path": "/review-output/review-output.json", "content": "{}"}}
    with MockProvider([Reply(text="writing", tools=[write])]) as provider:
        _status, raw = _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
    body = json.loads(raw)
    block = body["content"][1]
    assert block["type"] == "tool_use" and block["name"] == "Write"
    assert block["input"]["file_path"] == "/review-output/review-output.json"
    assert body["stop_reason"] == "tool_use", "a turn ending in a tool call must say so"


def test_streaming_emits_the_event_sequence_a_consumer_expects() -> None:
    with MockProvider([Reply(text="hi")]) as provider:
        request = urllib.request.Request(
            provider.base_url + "/v1/messages",
            data=json.dumps({"model": "m", "messages": [], "stream": True}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.headers["Content-Type"] == "text/event-stream"
            body = response.read().decode()

    events = [line[len("event: ") :] for line in body.splitlines() if line.startswith("event: ")]
    assert events[0] == "message_start"
    assert events[-1] == "message_stop"
    assert "content_block_delta" in events
    # message_delta carries the final usage, which is where output tokens land.
    assert events[-2] == "message_delta"


def test_each_protocol_reports_usage_in_its_own_arithmetic() -> None:
    """The whole point: the two providers count the same numbers differently.

    Anthropic's cache fields ADD to input_tokens; OpenAI's are SUBSETS of it.
    Scripting one Reply and serving it both ways is what makes that asymmetry
    testable without a paid request.
    """

    reply = Reply(input_tokens=2_000, output_tokens=300, cache_read_input_tokens=7_000, cache_creation_input_tokens=1_000)

    with MockProvider([reply, reply]) as provider:
        _s, anthropic_raw = _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
        _s, openai_raw = _post(provider.base_url + "/v1/responses", {"model": "m", "input": []})

    anthropic = normalize_usage(ANTHROPIC, json.loads(anthropic_raw)["usage"])
    openai = normalize_usage(OPENAI_RESPONSES, json.loads(openai_raw)["usage"])

    assert anthropic.total_input_tokens == 10_000
    assert openai.total_input_tokens == 10_000, "same billed work, stated as the whole"
    assert anthropic.ordinary_input_tokens == 2_000
    assert openai.ordinary_input_tokens == 2_000, "recovered by subtraction, not addition"
    assert openai.cache_read_input_tokens == 7_000


def test_a_scripted_failure_is_returned_as_one() -> None:
    """Billed failures are part of what the accounting must survive."""

    with MockProvider([Reply(status_code=529, error_body={"error": {"type": "overloaded_error"}})]) as provider:
        try:
            _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
            raise AssertionError("the scripted failure was not returned")
        except urllib.error.HTTPError as exc:
            assert exc.code == 529


def test_requests_are_recorded_for_assertions() -> None:
    with MockProvider() as provider:
        _post(provider.base_url + "/v1/messages", {"model": "claude-sonnet-4-5", "messages": [{"role": "user"}]})
    assert len(provider.requests) == 1
    assert provider.requests[0].body["model"] == "claude-sonnet-4-5"
    assert provider.requests[0].path.endswith("/v1/messages")


def test_an_unscripted_turn_gets_the_default_rather_than_stalling() -> None:
    """A real run makes more calls than a test wants to enumerate."""

    with MockProvider([Reply(text="first")], default=Reply(text="fallback")) as provider:
        _s, one = _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
        _s, two = _post(provider.base_url + "/v1/messages", {"model": "m", "messages": []})
    assert json.loads(one)["content"][0]["text"] == "first"
    assert json.loads(two)["content"][0]["text"] == "fallback"


def test_a_request_through_the_real_gateway_records_native_usage(tmp_path, monkeypatch) -> None:
    """The whole stack minus the model: proxy, translation, callback, log.

    This is the path that shipped three separate defects invisible to unit
    tests - the usage variable never reaching the proxy subprocess, the
    callback failing to import when loaded by path, and failures never
    recorded. All three live between the gateway and the provider, which is
    exactly the span this exercises.
    """


    import yaml

    from workflow_bench import model_gateway
    from workflow_bench.model_gateway import OpenAIGateway
    from workflow_bench.provider_usage import USAGE_LOG_ENV_VAR

    if shutil.which("litellm") is None:
        import pytest

        pytest.skip("litellm console script absent; the proxy cannot start here")

    usage_log = tmp_path / "provider_usage.jsonl"
    monkeypatch.setenv(USAGE_LOG_ENV_VAR, str(usage_log))

    reply = Reply(input_tokens=2_000, output_tokens=300, cache_read_input_tokens=7_000, cache_creation_input_tokens=1_000)
    with MockProvider(default=reply) as provider:
        original = model_gateway.write_openai_litellm_config

        def config(path, names):
            original(path, names)
            document = yaml.safe_load(path.read_text())
            for entry in document["model_list"]:
                entry["litellm_params"]["api_base"] = f"{provider.base_url}/v1"
            path.write_text(yaml.safe_dump(document))
            return path

        monkeypatch.setattr(model_gateway, "write_openai_litellm_config", config)
        with OpenAIGateway(
            openai_api_key="mock-key", model_names=["gpt-4.1"], work_dir=tmp_path / "gw", ready_timeout_s=60
        ) as gateway:
            request = urllib.request.Request(
                gateway.base_url + "/v1/messages",
                data=json.dumps({"model": "gpt-4.1", "max_tokens": 32, "messages": [{"role": "user", "content": "ping"}]}).encode(),
                headers={"Content-Type": "application/json", "x-api-key": gateway.auth_token, "anthropic-version": "2023-06-01"},
            )
            with urllib.request.urlopen(request, timeout=60):
                pass

    assert usage_log.exists(), "the callback never wrote - the env did not reach the proxy"
    events = [json.loads(line) for line in usage_log.read_text().splitlines()]
    assert events, "the proxy started but recorded nothing"
    event = events[-1]
    native = event["native_usage"]
    # LiteLLM hands a callback its OWN normalised object, not the upstream body:
    # an OpenAI Responses reply arrives as prompt_tokens / prompt_tokens_details.
    # Asserting the wire shape here is what proved the shipped adapter read keys
    # that are never present.
    assert native["prompt_tokens_details"]["cached_tokens"] == 7_000
    assert native["prompt_tokens_details"]["cache_write_tokens"] == 1_000
    assert event["provider"] == LITELLM_NORMALIZED
    assert event["call_type"] == "anthropic_messages", "the observed call type, not a Responses one"

    usage = normalize_usage(event["provider"], native)
    assert usage.total_input_tokens == 10_000
    assert usage.cache_read_input_tokens == 7_000
    assert usage.cache_write_input_tokens == 1_000
    assert usage.ordinary_input_tokens == 2_000
    assert usage.complete, "a run that cannot interpret its own usage measured nothing"


def test_probe_what_identity_the_real_cli_actually_sends(tmp_path: Path) -> None:
    """An experiment, not an assertion: which fields could correlate a request to a cell?

    Per-cell usage attribution is unbuilt because one proxy serves the whole
    sweep, so anything read from the proxy environment is identical for every
    request. Attribution needs something that travels WITH the request, and
    what the Claude Code CLI actually sends is not documented anywhere I can
    check - guessing it is how the last three accounting bugs happened.

    So this drives the REAL pinned CLI against the mock and prints the
    identity-bearing fields that arrive. It asserts only that a request was
    made; the value is the recorded evidence, which the job log preserves.
    """

    claude = os.environ.get("CLAUDE_CANARY_BIN")
    if not claude or not Path(claude).exists():
        pytest.skip("no pinned Claude CLI here; the containment job supplies CLAUDE_CANARY_BIN")

    with MockProvider(default=Reply(text="ok")) as provider:
        subprocess.run(
            [claude, "-p", "--input-format", "text", "--output-format", "stream-json", "--verbose"],
            input=b"say ok",
            capture_output=True,
            timeout=120,
            env={
                **os.environ,
                "ANTHROPIC_BASE_URL": provider.base_url,
                "ANTHROPIC_API_KEY": "offline-probe",
                "HOME": str(tmp_path),
            },
        )

    assert provider.requests, "the real CLI never reached the mock provider"
    request = provider.requests[0]
    interesting = {
        "header:" + name: value
        for name, value in request.headers.items()
        if any(k in name.lower() for k in ("session", "user", "trace", "request-id", "conversation", "metadata"))
    }
    interesting.update(
        {f"body:{key}": request.body[key] for key in ("metadata", "user", "session_id") if key in request.body}
    )
    print("\nIDENTITY FIELDS THE REAL CLI SENDS:")
    print("  body keys:", sorted(request.body))
    print("  candidate correlators:", interesting or "NONE — per-cell attribution needs another mechanism")


def test_scripted_tools_survive_the_responses_protocol_too() -> None:
    """The gateway uses Responses BECAUSE it carries tool use.

    Emitting only output_text there meant a scripted Write or Skill crossed the
    gateway with the tool dropped, so a mock claiming to serve both protocols
    was wrong about the one the gateway actually runs.
    """

    write = {"name": "Write", "input": {"file_path": "/review-output/review-output.json", "content": "{}"}}
    with MockProvider([Reply(text="writing", tools=[write])]) as provider:
        _status, raw = _post(provider.base_url + "/v1/responses", {"model": "m", "input": []})

    output = json.loads(raw)["output"]
    calls = [item for item in output if item["type"] == "function_call"]
    assert len(calls) == 1, "the scripted tool must cross the Responses path"
    assert calls[0]["name"] == "Write"
    assert json.loads(calls[0]["arguments"])["file_path"] == "/review-output/review-output.json"


def test_an_omitted_cache_field_stays_omitted_on_the_responses_wire_too() -> None:
    """Absence must survive both protocols, not just the Anthropic one.

    `_int_or_none` reads an absent detail key as unknown and a present 0 as a
    measured zero, so serializing 0 for a scripted None would claim a
    measurement the reply never made.
    """

    with MockProvider([Reply(input_tokens=2_000, cache_read_input_tokens=None)]) as provider:
        _status, raw = _post(provider.base_url + "/v1/responses", {"model": "m", "input": []})

    details = json.loads(raw)["usage"]["input_tokens_details"]
    assert "cached_tokens" not in details, "an omitted field must not serialize as a measured zero"
    assert details["cache_write_tokens"] == 0, "a scripted 0 is still a real measurement"
