"""Prove selective discovery at the provider boundary before paid experiments."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from workflow_bench import model_gateway, runner, runner_sessions
from workflow_bench.mock_provider import MockProvider, Reply
from tests.test_workflow_bench_sessions import _probe_cell_provisioning, bench_args, fake_sandbox, session_record


@pytest.mark.parametrize("mode", ["eager", "deferred"])
@pytest.mark.parametrize("arm", ["baseline", "baseline_nomcp", "baseline_cli", "workflow_direct"])
def test_loading_switch_reaches_only_the_baseline_session(monkeypatch, tmp_path, mode, arm):
    captured = []
    monkeypatch.setenv("ENABLE_TOOL_SEARCH", "ambient-value-must-not-leak")
    monkeypatch.setattr(runner, "run_claude", lambda *a, **kw: captured.append(kw) or session_record())
    monkeypatch.setattr(runner, "run_verify", lambda *a, **kw: (True, "ok"))
    runner.run_arm(arm, {"prompt": "Fix foo", "verify": "true"}, tmp_path,
                   bench_args(mcp_tool_loading=mode), sandbox=fake_sandbox(tmp_path))
    session = captured[0]
    if arm == "baseline":
        assert session["env"]["ENABLE_TOOL_SEARCH"] == ("true" if mode == "deferred" else "false")
        assert session["allowed_tools"] == [
            *runner_sessions.allowed_agent_tools(implementation=True),
            *(["ToolSearch"] if mode == "deferred" else []),
        ]
    else:
        assert "ENABLE_TOOL_SEARCH" not in session["env"]
        assert "ToolSearch" not in session["allowed_tools"]
        if arm in ("baseline_cli", "baseline_nomcp"):
            assert json.loads(session["mcp_config_json"]) == {"mcpServers": {}}


def test_loading_default_preserves_eager_catalog():
    parser = runner.build_parser()
    assert parser.parse_args(["--tasks", "tasks.yaml", "--model", "gpt-5.6-sol"]).mcp_tool_loading == "eager"


@pytest.mark.parametrize("arm, expected", [("baseline", "deferred"), ("baseline_nomcp", "none")])
def test_host_receipts_survive_failed_provisioning(monkeypatch, tmp_path, arm, expected):
    ctx, *_ = _probe_cell_provisioning(monkeypatch, tmp_path)
    ctx.args.mcp_tool_loading = "deferred"
    ctx.args.measurement_revisions = {"runtime_sha": "a" * 40, "harness_sha": "b" * 40}
    row = runner.run_cell(ctx, 0, arm)
    assert row["ok"] is False
    assert row["mcp_tool_loading"] == expected
    assert row["runtime_sha"] == "a" * 40 and row["harness_sha"] == "b" * 40


@pytest.mark.parametrize("mode", ["eager", "deferred"])
def test_pinned_cli_discovers_only_selected_mcp_tool_through_gateway(tmp_path, monkeypatch, mode):
    cli = os.environ.get("CLAUDE_CANARY_BIN")
    if not cli or not Path(cli).is_file():
        if os.environ.get("GITNEXUS_REQUIRE_CLAUDE_CANARY") == "1":
            pytest.fail("the required pinned Claude CLI is missing")
        pytest.skip("CLAUDE_CANARY_BIN supplies the pinned real client")
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / ".github/claude-canary-runtime/package.json").read_text())
    version = manifest["dependencies"]["@anthropic-ai/claude-code"]
    actual_version = subprocess.check_output([cli, "--version"], text=True).strip()
    assert actual_version == f"{version} (Claude Code)"
    mcp = tmp_path / "mcp.py"
    mcp.write_text('''import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'offline-probe', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [
            {'name': name, 'description': marker * 200,
             'inputSchema': {'type': 'object', 'properties': {'name': {'type': 'string'}}, 'required': ['name']}}
            for name, marker in [('context', 'SELECTED_DESCRIPTION '), ('unused', 'UNUSED_DESCRIPTION ')]
        ]}
    elif method == 'tools/call':
        result = {'content': [{'type': 'text', 'text': 'FOUND_' + request['params']['name']}]}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
''')

    class ScriptedProvider(MockProvider):
        def next_reply(self):
            # The Responses mock returns JSON, so the CLI may retry a streaming
            # request as non-streaming. Identical requests need identical steps.
            called = {item.get("name") for item in self.requests[-1].body.get("input", [])
                      if isinstance(item, dict) and item.get("type") == "function_call"}
            if mode == "deferred" and "ToolSearch" not in called:
                return Reply(tools=[{"name": "ToolSearch", "input": {"query": "select:mcp__gitnexus__context"}}])
            if "mcp__gitnexus__context" not in called:
                return Reply(tools=[{"name": "mcp__gitnexus__context", "input": {"name": "foo"}}])
            return Reply(text="Finished.")

    with ScriptedProvider() as provider:
        original = model_gateway.write_openai_litellm_config

        def config(path, names):
            original(path, names)
            document = yaml.safe_load(path.read_text())
            for entry in document["model_list"]:
                entry["litellm_params"]["api_base"] = provider.base_url + "/v1"
            path.write_text(yaml.safe_dump(document))
            return path

        monkeypatch.setattr(model_gateway, "write_openai_litellm_config", config)
        with model_gateway.OpenAIGateway(
            openai_api_key="offline-key", model_names=["gpt-5.6-sol"],
            work_dir=tmp_path / "gateway", ready_timeout_s=60,
        ) as gateway:
            env = {
                "PATH": os.environ["PATH"], "HOME": str(tmp_path),
                "CLAUDE_CONFIG_DIR": str(tmp_path / ".claude"),
                "ANTHROPIC_API_KEY": gateway.auth_token, "ANTHROPIC_BASE_URL": gateway.base_url,
                "ENABLE_TOOL_SEARCH": "true" if mode == "deferred" else "false",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1",
                "HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9",
                "NO_PROXY": "127.0.0.1,localhost",
            }
            tools = ["Read", "mcp__gitnexus__context", "mcp__gitnexus__unused"]
            if mode == "deferred":
                tools.append("ToolSearch")
            mcp_config = json.dumps({"mcpServers": {"gitnexus": {
                "type": "stdio", "command": sys.executable, "args": [str(mcp)],
            }}})
            completed = subprocess.run(
                [cli, "-p", "Inspect foo", "--model", "gpt-5.6-sol", "--output-format", "stream-json",
                 "--verbose", "--max-turns", "5", "--strict-mcp-config", "--mcp-config", mcp_config,
                 "--tools", *tools, "--allowedTools", *tools],
                cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
            )
    events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert completed.returncode == 0, completed.stdout[-2000:]
    assert events[-1]["type"] == "result" and events[-1]["is_error"] is False
    assert any("FOUND_context" in json.dumps(event.get("tool_use_result")) for event in events)
    bodies = [request.body for request in provider.requests]
    assert bodies and all(request.path.endswith("/responses") for request in provider.requests)
    first = json.dumps(bodies[0])
    if mode == "deferred":
        assert "SELECTED_DESCRIPTION" not in first
        assert "UNUSED_DESCRIPTION" not in json.dumps(bodies)
        assert any("SELECTED_DESCRIPTION" in json.dumps(body) for body in bodies[1:])
    else:
        assert "SELECTED_DESCRIPTION" in first and "UNUSED_DESCRIPTION" in first
