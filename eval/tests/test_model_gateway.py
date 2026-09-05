"""Credential routing for the OpenAI loopback gateway."""

from __future__ import annotations

import subprocess
import os
import json
import signal
import socket
import time
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import pytest
import yaml


from workflow_bench.model_gateway import (
    DEFAULT_GATEWAY_READY_TIMEOUT_S,
    GATEWAY_READY_TIMEOUT_ENV,
    GATEWAY_REQUEST_TIMEOUT_S,
    OpenAIGateway,
    gateway_ready_timeout_s,
    anthropic_api_key_from_environ,
    claude_gateway_model_env,
    is_openai_model,
    litellm_proxy_argv,
    openai_backend_model,
    openai_litellm_config,
    resolve_model_access,
    write_openai_litellm_config,
)


def test_supervisor_reports_proxy_failure_without_aborting_on_its_stdin_reader():
    supervisor = Path(__file__).resolve().parents[1] / "workflow_bench" / "gateway_supervisor.py"
    process = subprocess.Popen(
        [sys.executable, str(supervisor), sys.executable, "-c", "raise RuntimeError('proxy failed')"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Keep the owner pipe open: the proxy exits independently of its owner.
        process.wait(timeout=10)
        assert process.returncode == 1
        assert b"proxy failed" in process.stderr.read()
    finally:
        process.stdin.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


def test_locked_litellm_translates_messages_to_offline_responses(monkeypatch, tmp_path):
    from workflow_bench import model_gateway

    observed = []

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            observed.append((self.path, self.headers.get("Authorization"), body))
            response = {
                "id": "resp_offline",
                "object": "response",
                "created_at": int(time.time()),
                "status": "completed",
                "model": "gpt-4.1",
                "error": None,
                "output": [
                    {
                        "id": "msg_offline",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{"type": "output_text", "text": "offline pong", "annotations": []}],
                    }
                ],
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "total_tokens": 3,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0},
                },
            }
            payload = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    worker = threading.Thread(target=upstream.serve_forever, daemon=True)
    worker.start()
    original = model_gateway.write_openai_litellm_config

    def config(path, names):
        original(path, names)
        document = yaml.safe_load(path.read_text())
        for entry in document["model_list"]:
            entry["litellm_params"]["api_base"] = f"http://127.0.0.1:{upstream.server_port}/v1"
        path.write_text(yaml.safe_dump(document))
        return path

    monkeypatch.setattr(model_gateway, "write_openai_litellm_config", config)
    try:
        with OpenAIGateway(
            openai_api_key="offline-upstream-secret",
            model_names=["gpt-4.1"],
            work_dir=tmp_path / "gateway",
            ready_timeout_s=60,
        ) as gateway:
            port = gateway.port
            request = urllib.request.Request(
                gateway.base_url + "/v1/messages",
                data=json.dumps(
                    {
                        "model": "gpt-4.1",
                        "max_tokens": 32,
                        "messages": [{"role": "user", "content": "ping"}],
                    }
                ).encode(),
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": gateway.auth_token,
                    "anthropic-version": "2023-06-01",
                },
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                translated = json.load(response)
            assert "offline pong" in json.dumps(translated)
            assert len(observed) == 1 and observed[0][0] == "/v1/responses"
            assert observed[0][1] == "Bearer offline-upstream-secret"
            assert gateway.auth_token != "offline-upstream-secret"
        with socket.socket() as client:
            assert client.connect_ex(("127.0.0.1", port)) != 0
        gateway.close()  # ownership close is idempotent
    finally:
        upstream.shutdown()
        upstream.server_close()
        worker.join(timeout=5)


@pytest.mark.parametrize("termination", ["terminate", "kill"])
@pytest.mark.parametrize("phase", ["ready", "startup"])
def test_gateway_lifetime_ends_with_its_parent(tmp_path, termination, phase):
    ready = tmp_path / "ready.json"
    proxy_pid = tmp_path / "proxy-pid"
    proxy = tmp_path / "proxy.py"
    proxy.write_text(f"""import os,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response({200 if phase == "ready" else 503}); self.end_headers()
Path(sys.argv[2]).write_text(str(os.getpid()))
HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
""")
    parent_code = f"""
import json,os,sys,time,subprocess
from pathlib import Path
from workflow_bench import model_gateway
model_gateway.litellm_proxy_argv=lambda **kwargs: [sys.executable, {str(proxy)!r}, str(kwargs['port']), {str(proxy_pid)!r}]
gateway=model_gateway.OpenAIGateway(openai_api_key='offline-secret', model_names=['gpt-4.1'], work_dir=Path({str(tmp_path / "gateway")!r}), ready_timeout_s=10)
if {phase == "startup"!r}:
    Path({str(ready)!r}).write_text(json.dumps({{'port':gateway.port}}))
gateway.__enter__()
if gateway._process.stdin is not None:
    assert not os.get_inheritable(gateway._process.stdin.fileno())
Path({str(ready)!r}).write_text(json.dumps({{'port':gateway.port}}))
time.sleep(60)
"""
    parent = subprocess.Popen(
        [sys.executable, "-c", parent_code],
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 12
        while (not ready.exists() or not proxy_pid.exists()) and parent.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        if not ready.exists():
            _, stderr = parent.communicate(timeout=1)
            pytest.fail(stderr)
        port = json.loads(ready.read_text())["port"]
        getattr(parent, termination)()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with socket.socket() as client:
                if client.connect_ex(("127.0.0.1", port)) != 0:
                    break
            time.sleep(0.02)
        else:
            pytest.fail("gateway port survived abrupt parent death")
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if proxy_pid.exists():
            try:
                if os.name == "nt":
                    os.kill(int(proxy_pid.read_text()), signal.SIGTERM)
                else:
                    os.killpg(int(proxy_pid.read_text()), signal.SIGKILL)
            except OSError:
                # Successful ownership cleanup has already removed this process.
                pass


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("gpt-4.1", True),
        ("gpt-4o-mini", True),
        ("openai/gpt-4.1", True),
        ("o3", True),
        ("o4-mini", True),
        ("claude-sonnet-5", False),
        ("free-coder", False),
        ("pinned-model", False),
    ],
)
def test_is_openai_model(model: str, expected: bool) -> None:
    assert is_openai_model(model) is expected


def test_openai_litellm_config_routes_each_id_to_openai_and_env_key(tmp_path: Path) -> None:
    config = openai_litellm_config(["gpt-4.1", "openai/gpt-4.1-mini", "gpt-4.1"])
    assert [row["model_name"] for row in config["model_list"]] == ["gpt-4.1", "openai/gpt-4.1-mini"]
    assert config["model_list"][0]["litellm_params"]["model"] == "openai/gpt-4.1"
    assert config["model_list"][1]["litellm_params"]["model"] == "openai/gpt-4.1-mini"
    assert all(row["litellm_params"]["api_key"] == "os.environ/OPENAI_API_KEY" for row in config["model_list"])
    assert all(row["model_info"] == {"mode": "responses"} for row in config["model_list"])
    assert all(row["litellm_params"]["timeout"] == GATEWAY_REQUEST_TIMEOUT_S for row in config["model_list"])
    assert config["litellm_settings"]["request_timeout"] == GATEWAY_REQUEST_TIMEOUT_S
    path = write_openai_litellm_config(tmp_path / "litellm.yaml", ["gpt-4.1"])
    assert yaml.safe_load(path.read_text())["model_list"][0]["model_name"] == "gpt-4.1"
    if os.name != "nt":
        # Windows chmod exposes a read-only flag, not POSIX access bits.
        assert path.stat().st_mode & 0o777 == 0o600


def test_resolve_model_access_starts_proxy_only_for_openai_ids() -> None:
    openai = resolve_model_access(
        auth_token=None,
        openai_api_key="sk-openai",
        base_url=None,
        models=["gpt-4.1", "gpt-4.1"],
    )
    assert openai.start_proxy is True
    assert openai.openai_api_key == "sk-openai"

    anthropic = resolve_model_access(
        auth_token="sk-ant",
        openai_api_key="sk-openai",
        base_url=None,
        models=["claude-sonnet-5"],
    )
    assert anthropic.start_proxy is False

    existing = resolve_model_access(
        auth_token="proxy-master",
        openai_api_key=None,
        base_url="http://127.0.0.1:4000",
        models=["free-coder"],
    )
    assert existing.start_proxy is False


def test_resolve_model_access_rejects_openai_ids_without_a_key_and_mixed_providers() -> None:
    with pytest.raises(ValueError, match="GITNEXUS_BENCH_OPENAI_API_KEY"):
        resolve_model_access(
            auth_token="sk-ant",
            openai_api_key=None,
            base_url=None,
            models=["gpt-4.1"],
        )
    with pytest.raises(ValueError, match="mix"):
        resolve_model_access(
            auth_token=None,
            openai_api_key="sk-openai",
            base_url=None,
            models=["gpt-4.1", "claude-sonnet-5"],
        )
    with pytest.raises(ValueError, match="--base-url"):
        resolve_model_access(
            auth_token=None,
            openai_api_key=None,
            base_url="http://127.0.0.1:4000",
            models=["free-coder"],
        )


def test_claude_gateway_aliases_pin_every_internal_tier_to_the_session_model() -> None:
    env = claude_gateway_model_env("gpt-4.1")
    assert env["ANTHROPIC_MODEL"] == "gpt-4.1"
    assert env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "gpt-4.1"
    assert env["CLAUDE_CODE_SUBAGENT_MODEL"] == "gpt-4.1"
    # High-effort reasoning outlives Claude Code's default client timeout.
    assert env["API_TIMEOUT_MS"] == str(GATEWAY_REQUEST_TIMEOUT_S * 1000)


def test_openai_gateway_never_leaves_proxy_output_on_an_undrained_pipe(tmp_path: Path) -> None:
    # Nothing reads the proxy's output after startup, so a pipe would block the
    # proxy once its request logs filled the buffer and hang every session.
    gateway = OpenAIGateway(
        openai_api_key="sk-openai-secret",
        model_names=["gpt-4.1"],
        work_dir=tmp_path / "gw",
        ready_timeout_s=0.1,
    )
    captured: dict[str, object] = {}

    def fake_popen(argv, **kwargs):
        captured.update(kwargs)
        raise OSError("no proxy in this test")

    with mock.patch.object(subprocess, "Popen", fake_popen):
        with pytest.raises(RuntimeError, match="failed to start the OpenAI LiteLLM gateway"):
            gateway.__enter__()

    assert captured["stderr"] is subprocess.STDOUT
    assert captured["stdout"] is not subprocess.PIPE
    assert getattr(captured["stdout"], "name", "") == str(gateway.log_path)
    if os.name != "nt":
        assert gateway.log_path.stat().st_mode & 0o777 == 0o600


def test_gateway_startup_budget_outlives_a_cold_litellm_import(monkeypatch, tmp_path: Path) -> None:
    # Importing LiteLLM takes ~17s on a cold container filesystem and the proxy
    # binds its port only afterwards, so a sub-20s budget fails as "connection
    # refused" on a proxy that was merely still starting.
    monkeypatch.delenv(GATEWAY_READY_TIMEOUT_ENV, raising=False)
    assert DEFAULT_GATEWAY_READY_TIMEOUT_S >= 60
    assert gateway_ready_timeout_s() == DEFAULT_GATEWAY_READY_TIMEOUT_S
    assert (
        OpenAIGateway(
            openai_api_key="sk-openai-secret",
            model_names=["gpt-4.1"],
            work_dir=tmp_path / "gw",
        ).ready_timeout_s
        == DEFAULT_GATEWAY_READY_TIMEOUT_S
    )

    monkeypatch.setenv(GATEWAY_READY_TIMEOUT_ENV, "42.5")
    assert gateway_ready_timeout_s() == 42.5

    for bad in ("0", "-1", "soon"):
        monkeypatch.setenv(GATEWAY_READY_TIMEOUT_ENV, bad)
        with pytest.raises(ValueError, match=GATEWAY_READY_TIMEOUT_ENV):
            gateway_ready_timeout_s()


def test_gateway_readiness_timeout_reports_the_proxy_log_and_the_override(tmp_path: Path) -> None:
    gateway = OpenAIGateway(
        openai_api_key="sk-openai-secret",
        model_names=["gpt-4.1"],
        work_dir=tmp_path / "gw",
        ready_timeout_s=0.1,
    )
    gateway.work_dir.mkdir(parents=True)
    gateway.log_path.write_text("ImportError: litellm proxy extras missing")

    with pytest.raises(RuntimeError) as excinfo:
        gateway._wait_until_ready()

    message = str(excinfo.value)
    assert "ImportError: litellm proxy extras missing" in message
    assert GATEWAY_READY_TIMEOUT_ENV in message


def test_openai_backend_model_preserves_openai_prefix() -> None:
    assert openai_backend_model("gpt-4.1") == "openai/gpt-4.1"
    assert openai_backend_model("openai/gpt-4.1") == "openai/gpt-4.1"


def test_litellm_proxy_argv_uses_console_script_not_python_module(tmp_path: Path, monkeypatch) -> None:
    # litellm 1.87 ships a console script and no litellm.__main__, so
    # `python -m litellm` dies before the health check. Pin the supported argv.
    # Under `uv run`, sys.executable is the base CPython — the script lives in
    # VIRTUAL_ENV/bin instead.
    python = tmp_path / "base" / "python"
    venv_bin = tmp_path / "venv" / "bin"
    python.parent.mkdir(parents=True)
    venv_bin.mkdir(parents=True)
    litellm = venv_bin / "litellm"
    python.write_text("#!/bin/sh\n")
    litellm.write_text("#!/bin/sh\n")
    python.chmod(0o755)
    litellm.chmod(0o755)
    monkeypatch.setenv("VIRTUAL_ENV", str(tmp_path / "venv"))
    monkeypatch.delenv("PATH", raising=False)
    config = tmp_path / "litellm.yaml"
    config.write_text("model_list: []\n")
    argv = litellm_proxy_argv(
        config=config,
        host="127.0.0.1",
        port=4010,
        python_executable=str(python),
    )
    assert argv[0] == str(litellm.resolve())
    assert "-m" not in argv
    assert argv[1:] == ["--config", str(config), "--host", "127.0.0.1", "--port", "4010"]


def test_anthropic_api_key_prefers_the_named_env_and_keeps_the_legacy_alias(monkeypatch) -> None:
    monkeypatch.delenv("GITNEXUS_BENCH_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("GITNEXUS_BENCH_AUTH_TOKEN", "legacy-secret")
    assert anthropic_api_key_from_environ() == "legacy-secret"
    monkeypatch.setenv("GITNEXUS_BENCH_ANTHROPIC_API_KEY", "named-secret")
    assert anthropic_api_key_from_environ() == "named-secret"
