"""Credential routing for the OpenAI loopback gateway."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from workflow_bench.model_gateway import (
    anthropic_api_key_from_environ,
    claude_gateway_model_env,
    credential_secrets,
    is_openai_model,
    litellm_proxy_argv,
    openai_backend_model,
    openai_litellm_config,
    resolve_model_access,
    write_openai_litellm_config,
)
from workflow_bench.evolve import build_parser, runner_environment


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
    path = write_openai_litellm_config(tmp_path / "litellm.yaml", ["gpt-4.1"])
    assert yaml.safe_load(path.read_text())["model_list"][0]["model_name"] == "gpt-4.1"
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


def test_runner_environment_does_not_forward_the_openai_key() -> None:
    args = build_parser().parse_args(
        [
            "--tasks",
            "t.yaml",
            "--model",
            "gpt-4.1",
            "--anthropic-api-key",
            "loopback-master",
            "--openai-api-key",
            "sk-openai-secret",
        ]
    )
    env = runner_environment(args)
    assert env["GITNEXUS_BENCH_ANTHROPIC_API_KEY"] == "loopback-master"
    assert "GITNEXUS_BENCH_AUTH_TOKEN" not in env
    assert "OPENAI_API_KEY" not in env
    assert "GITNEXUS_BENCH_OPENAI_API_KEY" not in env
    assert "sk-openai-secret" not in env.values()
    assert credential_secrets(args) == ["loopback-master", "sk-openai-secret"]


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
    args = build_parser().parse_args(
        ["--tasks", "t.yaml", "--model", "pinned", "--auth-token", "alias-secret"]
    )
    assert args.auth_token == "alias-secret"
