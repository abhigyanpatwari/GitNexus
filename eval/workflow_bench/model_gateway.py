"""Route Claude Code sessions at a non-Anthropic backend without leaking it.

Headless Claude Code speaks the Anthropic Messages API and authenticates with
``ANTHROPIC_API_KEY``. OpenAI keys are not a drop-in replacement. The documented
escape hatch is already in this package: an Anthropic-compatible loopback proxy
(LiteLLM) plus ``ANTHROPIC_BASE_URL``. This module starts that proxy for OpenAI,
mints a random master key for Claude, and keeps ``OPENAI_API_KEY`` on the host
proxy process — never in the sandboxed agent environment.
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ANTHROPIC_API_KEY_ENV = "GITNEXUS_BENCH_ANTHROPIC_API_KEY"
LEGACY_ANTHROPIC_API_KEY_ENV = "GITNEXUS_BENCH_AUTH_TOKEN"
OPENAI_API_KEY_ENV = "GITNEXUS_BENCH_OPENAI_API_KEY"
_OPENAI_MODEL = re.compile(
    r"^(?:openai/)?(?:gpt-|chatgpt-|o[0-9])",
    re.IGNORECASE,
)
# High reasoning effort on a full context window can leave a request without a
# first token for many minutes. Claude Code's default client timeout is far
# shorter than that, so both ends of the loopback hop get the same generous
# budget and the session fails on real errors instead of on the clock.
GATEWAY_REQUEST_TIMEOUT_S = 1800
# Importing LiteLLM alone costs ~17s on a cold container filesystem, and the
# proxy only binds its port after that. A budget tight enough to lose that race
# reads as "connection refused", which looks like a dead proxy rather than a
# slow import.
GATEWAY_READY_TIMEOUT_ENV = "GITNEXUS_BENCH_GATEWAY_READY_TIMEOUT_S"
DEFAULT_GATEWAY_READY_TIMEOUT_S = 180.0


def gateway_ready_timeout_s() -> float:
    """Startup budget for the loopback proxy, overridable for slow hosts."""

    raw = (os.environ.get(GATEWAY_READY_TIMEOUT_ENV) or "").strip()
    if not raw:
        return DEFAULT_GATEWAY_READY_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{GATEWAY_READY_TIMEOUT_ENV} must be a number of seconds, not {raw!r}") from exc
    if value <= 0:
        raise ValueError(f"{GATEWAY_READY_TIMEOUT_ENV} must be positive, not {raw!r}")
    return value


def is_openai_model(model: str) -> bool:
    return bool(_OPENAI_MODEL.match((model or "").strip()))


def openai_backend_model(model: str) -> str:
    name = model.strip()
    if name.lower().startswith("openai/"):
        return f"openai/{name.split('/', 1)[1]}"
    return f"openai/{name}"


def claude_gateway_model_env(model: str) -> dict[str, str]:
    """Stop Claude Code from spawning unpaid Anthropic-named subagent models."""

    return {
        "ANTHROPIC_MODEL": model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
        "CLAUDE_CODE_SUBAGENT_MODEL": model,
        "API_TIMEOUT_MS": str(GATEWAY_REQUEST_TIMEOUT_S * 1000),
    }


def model_session_environment(
    *,
    auth_token: str | None,
    base_url: str | None,
    model: str,
    build_sandbox_environment: Any,
) -> dict[str, str]:
    env = build_sandbox_environment(auth_token=auth_token, base_url=base_url)
    if base_url:
        env.update(claude_gateway_model_env(model))
    return env


def credential_secrets(args: argparse.Namespace) -> list[str]:
    return [
        secret
        for secret in (
            getattr(args, "auth_token", None),
            getattr(args, "openai_api_key", None),
        )
        if secret
    ]


def _first_nonblank_env(*names: str) -> str | None:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return None


def anthropic_api_key_from_environ() -> str | None:
    return _first_nonblank_env(ANTHROPIC_API_KEY_ENV, LEGACY_ANTHROPIC_API_KEY_ENV)


def openai_api_key_from_environ() -> str | None:
    return _first_nonblank_env(OPENAI_API_KEY_ENV, "OPENAI_API_KEY")


@dataclass(frozen=True)
class ModelAccess:
    start_proxy: bool
    openai_api_key: str | None = None


def resolve_model_access(
    *,
    auth_token: str | None,
    openai_api_key: str | None,
    base_url: str | None,
    models: Sequence[str],
) -> ModelAccess:
    token = (auth_token or "").strip() or None
    openai_key = (openai_api_key or "").strip() or None
    gateway = (base_url or "").strip() or None
    names = [name.strip() for name in models if name and name.strip()]
    openai_models = [name for name in names if is_openai_model(name)]
    other_models = [name for name in names if not is_openai_model(name)]

    if gateway:
        if not token:
            raise ValueError(
                "--base-url requires --anthropic-api-key / GITNEXUS_BENCH_ANTHROPIC_API_KEY "
                "(legacy --auth-token / GITNEXUS_BENCH_AUTH_TOKEN is still accepted)"
            )
        return ModelAccess(start_proxy=False)
    if openai_models and other_models:
        raise ValueError(
            "do not mix OpenAI model ids with Anthropic/other ids in one run; "
            f"openai={openai_models!r} other={other_models!r}"
        )
    if openai_models:
        if not openai_key:
            raise ValueError(
                "OpenAI model ids require GITNEXUS_BENCH_OPENAI_API_KEY "
                "(or OPENAI_API_KEY). Claude Code still speaks Anthropic "
                "protocol; the harness starts a loopback LiteLLM proxy."
            )
        return ModelAccess(start_proxy=True, openai_api_key=openai_key)
    return ModelAccess(start_proxy=False)


def openai_litellm_config(model_names: Sequence[str]) -> dict[str, Any]:
    seen: list[str] = []
    for name in model_names:
        trimmed = name.strip()
        if trimmed and trimmed not in seen:
            seen.append(trimmed)
    if not seen:
        raise ValueError("OpenAI gateway requires at least one model name")
    return {
        "model_list": [
            {
                "model_name": name,
                "litellm_params": {
                    "model": openai_backend_model(name),
                    "api_key": "os.environ/OPENAI_API_KEY",
                    "timeout": GATEWAY_REQUEST_TIMEOUT_S,
                },
                # GPT-5.6 tool use with active reasoning is supported through
                # OpenAI's Responses API, not Chat Completions.
                "model_info": {"mode": "responses"},
            }
            for name in seen
        ],
        "litellm_settings": {"request_timeout": GATEWAY_REQUEST_TIMEOUT_S},
        "general_settings": {"master_key": "os.environ/LITELLM_MASTER_KEY"},
    }


def write_openai_litellm_config(path: Path, model_names: Sequence[str]) -> Path:
    path.write_text(yaml.safe_dump(openai_litellm_config(model_names), sort_keys=False))
    path.chmod(0o600)
    return path


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def litellm_proxy_argv(
    *,
    config: Path,
    host: str,
    port: int,
    python_executable: str | None = None,
) -> list[str]:
    """Build the LiteLLM proxy argv for this interpreter.

    ``python -m litellm`` fails on current releases (no ``litellm.__main__``).
    Prefer the console script next to ``sys.executable``; under ``uv run`` that
    path is the base CPython, so also honor ``VIRTUAL_ENV`` and ``PATH``.
    """

    python = Path(python_executable or sys.executable).resolve()
    candidates: list[Path] = [python.with_name("litellm")]
    virtual_env = (os.environ.get("VIRTUAL_ENV") or "").strip()
    if virtual_env:
        candidates.append(Path(virtual_env) / "bin" / "litellm")
    which = shutil.which("litellm")
    if which:
        candidates.append(Path(which))
    litellm_bin: Path | None = None
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            litellm_bin = candidate.resolve()
            break
    if litellm_bin is None:
        raise RuntimeError(
            f"LiteLLM console script missing next to {python} "
            "(install litellm[proxy]; do not use python -m litellm)"
        )
    return [
        str(litellm_bin),
        "--config",
        str(config),
        "--host",
        host,
        "--port",
        str(port),
    ]


class OpenAIGateway(AbstractContextManager["OpenAIGateway"]):
    def __init__(
        self,
        *,
        openai_api_key: str,
        model_names: Sequence[str],
        work_dir: Path,
        ready_timeout_s: float | None = None,
    ) -> None:
        self.openai_api_key = openai_api_key
        self.model_names = tuple(model_names)
        self.work_dir = work_dir
        self.ready_timeout_s = gateway_ready_timeout_s() if ready_timeout_s is None else ready_timeout_s
        self.auth_token = secrets.token_hex(16)
        self.port = _free_loopback_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.log_path = work_dir / "litellm.log"
        self._process: subprocess.Popen[bytes] | None = None
        self._log: Any = None

    def log_tail(self, limit: int = 1000) -> str:
        try:
            return self.log_path.read_bytes()[-limit:].decode(errors="replace")
        except OSError:
            return ""

    def __enter__(self) -> OpenAIGateway:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        config = write_openai_litellm_config(self.work_dir / "litellm.yaml", self.model_names)
        env = {
            "HOME": str(self.work_dir),
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "OPENAI_API_KEY": self.openai_api_key,
            "LITELLM_MASTER_KEY": self.auth_token,
        }
        # Never hand the proxy a pipe: nothing drains it after startup, so the
        # proxy would block forever once its request logs fill the 64 KiB pipe
        # buffer, and every later session request would hang without a status.
        try:
            self._log = self.log_path.open("wb")
            self.log_path.chmod(0o600)
            self._process = subprocess.Popen(
                litellm_proxy_argv(
                    config=config,
                    host="127.0.0.1",
                    port=self.port,
                ),
                cwd=str(self.work_dir),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=self._log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            self.close()
            raise RuntimeError(f"failed to start the OpenAI LiteLLM gateway: {exc}") from exc
        try:
            self._wait_until_ready()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        process = self._process
        self._process = None
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            log, self._log = self._log, None
            if log is not None:
                log.close()

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + self.ready_timeout_s
        request = urllib.request.Request(
            f"{self.base_url}/health/liveliness",
            method="GET",
        )
        last_error = "gateway did not become ready"
        while time.monotonic() < deadline:
            process = self._process
            if process is not None and process.poll() is not None:
                detail = self.log_tail()
                raise RuntimeError(
                    "OpenAI LiteLLM gateway exited before becoming ready"
                    + (f": {detail}" if detail else "")
                )
            try:
                with urllib.request.urlopen(request, timeout=1) as response:
                    if 200 <= int(response.status) < 300:
                        return
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                last_error = str(exc)
            time.sleep(0.1)
        detail = self.log_tail()
        raise RuntimeError(
            f"OpenAI LiteLLM gateway was not ready on {self.base_url} after "
            f"{self.ready_timeout_s:.0f}s: {last_error}"
            + (f"; proxy log: {detail}" if detail else "; proxy wrote no output yet")
            + f" (raise {GATEWAY_READY_TIMEOUT_ENV} if this host is simply slow to import LiteLLM)"
        )


class attach_openai_gateway(AbstractContextManager[argparse.Namespace]):
    """Start a loopback OpenAI gateway when the selected models need one."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self._gateway: OpenAIGateway | None = None
        self._work_dir: Path | None = None

    def __enter__(self) -> argparse.Namespace:
        models = [self.args.model]
        proposer = getattr(self.args, "proposer_model", None)
        if proposer:
            models.append(proposer)
        access = resolve_model_access(
            auth_token=getattr(self.args, "auth_token", None),
            openai_api_key=getattr(self.args, "openai_api_key", None),
            base_url=getattr(self.args, "base_url", None),
            models=models,
        )
        if not access.start_proxy:
            return self.args
        assert access.openai_api_key is not None
        self._work_dir = Path(tempfile.mkdtemp(prefix="wfgateway-"))
        self._gateway = OpenAIGateway(
            openai_api_key=access.openai_api_key,
            model_names=models,
            work_dir=self._work_dir,
        )
        started = self._gateway.__enter__()
        self.args.base_url = started.base_url
        self.args.auth_token = started.auth_token
        return self.args

    def __exit__(self, *exc: object) -> None:
        if self._gateway is not None:
            self._gateway.__exit__(*exc)
            self._gateway = None
        if self._work_dir is not None:
            try:
                for child in self._work_dir.glob("*"):
                    child.unlink(missing_ok=True)
                self._work_dir.rmdir()
            except OSError:
                pass
            self._work_dir = None
