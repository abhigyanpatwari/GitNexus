"""A scriptable stand-in for Anthropic and OpenAI, for running the harness offline.

Every defect this benchmark shipped in the last round was invisible to its own
tests for the same reason: the tests exercised a layer BELOW where the code
runs. The usage log was never written because the proxy is a subprocess with a
constructed environment. The callback could not be imported because LiteLLM
loads it by path. Failures went unrecorded because only the async hook was
overridden. Each was caught by CI or review, never by a unit test, because the
unit test called the function directly instead of driving the path that calls
it.

This closes that gap without spending money. It speaks the two wire protocols
the harness actually depends on, so a run can go through the real sandbox, the
real Claude Code CLI, the real gateway and the real usage callback, and only
the model is fake:

    POST /v1/messages   Anthropic Messages, streaming and non-streaming
    POST /v1/responses  OpenAI Responses, which the gateway translates into

Point the runner at it with ``--base-url http://127.0.0.1:<port>``, which is
the same supported path the free-model proxy documentation already uses, or
give it to LiteLLM as ``api_base`` to exercise the gateway.

Scripted, not simulated: replies are supplied by the caller, so a test decides
what the model "says", which tools it asks for, and exactly what usage it
reports. That last part is what makes provider-native accounting testable at
all - real cache hits are not reproducible on demand, but a declared
``cache_read`` of 44_000 is.
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Reply:
    """One scripted model turn.

    ``tools`` drives real tool execution: Claude Code runs what it is asked to
    run, so a reply carrying a Write block makes the CLI write that file inside
    the sandbox for real. That is how an artifact-producing cell can be
    exercised without a model deciding anything.
    """

    text: str = "ok"
    tools: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = "end_turn"
    # Anthropic accounting: input_tokens is the UNCACHED remainder and the
    # cache fields add to it. Defaults are deliberately non-zero so a test that
    # forgets to script usage still cannot mistake silence for a measurement.
    input_tokens: int = 11
    output_tokens: int = 7
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    status_code: int = 200
    error_body: dict[str, Any] | None = None


@dataclass
class Request:
    """What the harness actually sent, kept so a test can assert on it."""

    path: str
    headers: dict[str, str]
    body: dict[str, Any]


class _Handler(BaseHTTPRequestHandler):
    provider: MockProvider

    def log_message(self, *_args: Any) -> None:  # noqa: A003 - silence the default stderr spam
        return

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's interface
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {"_unparsed": raw.decode("utf-8", "replace")}
        self.provider.record(Request(self.path, dict(self.headers), body))
        reply = self.provider.next_reply()

        if reply.status_code != 200:
            self._send_json(reply.status_code, reply.error_body or {"error": {"message": "scripted failure"}})
            return
        if self.path.rstrip("/").endswith("/responses"):
            self._send_json(200, _openai_response(reply))
            return
        if body.get("stream"):
            self._send_anthropic_stream(reply)
            return
        self._send_json(200, _anthropic_message(reply))

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_anthropic_stream(self, reply: Reply) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event, data in _anthropic_stream_events(reply):
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()


def _content_blocks(reply: Reply) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [{"type": "text", "text": reply.text}]
    for index, tool in enumerate(reply.tools):
        blocks.append(
            {
                "type": "tool_use",
                "id": f"toolu_mock_{index}",
                "name": tool["name"],
                "input": tool.get("input", {}),
            }
        )
    return blocks


def _anthropic_usage(reply: Reply) -> dict[str, int]:
    return {
        "input_tokens": reply.input_tokens,
        "output_tokens": reply.output_tokens,
        "cache_read_input_tokens": reply.cache_read_input_tokens,
        "cache_creation_input_tokens": reply.cache_creation_input_tokens,
    }


def _anthropic_message(reply: Reply) -> dict[str, Any]:
    return {
        "id": "msg_mock",
        "type": "message",
        "role": "assistant",
        "model": "mock-model",
        "content": _content_blocks(reply),
        "stop_reason": "tool_use" if reply.tools else reply.stop_reason,
        "stop_sequence": None,
        "usage": _anthropic_usage(reply),
    }


def _anthropic_stream_events(reply: Reply) -> list[tuple[str, dict[str, Any]]]:
    """The SSE sequence a Messages consumer expects, in order."""

    message = _anthropic_message(reply)
    events: list[tuple[str, dict[str, Any]]] = [
        ("message_start", {"type": "message_start", "message": {**message, "content": [], "usage": _anthropic_usage(reply)}})
    ]
    for index, block in enumerate(message["content"]):
        if block["type"] == "text":
            events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": block["text"]}}))
        else:
            events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}}))
            events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}}))
        events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
    events.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": reply.output_tokens}}))
    events.append(("message_stop", {"type": "message_stop"}))
    return events


def _openai_response(reply: Reply) -> dict[str, Any]:
    """OpenAI Responses shape: input_tokens is the WHOLE, cache fields subsets."""

    total_input = reply.input_tokens + reply.cache_read_input_tokens + reply.cache_creation_input_tokens
    return {
        "id": "resp_mock",
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "model": "mock-model",
        "error": None,
        "output": [
            {
                "id": "msg_mock",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": reply.text, "annotations": []}],
            }
        ],
        "usage": {
            "input_tokens": total_input,
            "output_tokens": reply.output_tokens,
            "total_tokens": total_input + reply.output_tokens,
            "input_tokens_details": {
                "cached_tokens": reply.cache_read_input_tokens,
                "cache_write_tokens": reply.cache_creation_input_tokens,
            },
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }


class MockProvider:
    """Loopback-only provider stand-in. Use as a context manager."""

    def __init__(self, replies: list[Reply] | None = None, *, default: Reply | None = None) -> None:
        self._replies: deque[Reply] = deque(replies or [])
        # A run makes more requests than a test wants to script; the default
        # keeps it going rather than failing on the first unscripted turn.
        self._default = default or Reply()
        self._requests: list[Request] = []
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None

    def __enter__(self) -> MockProvider:
        handler = type("_BoundHandler", (_Handler,), {"provider": self})
        # Loopback only: this answers with no authentication at all.
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_exc: object) -> bool:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        return False

    @property
    def port(self) -> int:
        assert self._server is not None, "provider is not running"
        return self._server.server_port

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def record(self, request: Request) -> None:
        with self._lock:
            self._requests.append(request)

    def next_reply(self) -> Reply:
        with self._lock:
            return self._replies.popleft() if self._replies else self._default

    @property
    def requests(self) -> list[Request]:
        with self._lock:
            return list(self._requests)
