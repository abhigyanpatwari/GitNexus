"""The baseline_cli arm's `gitnexus` shim: argument mapping, MCP round trip, containment."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from workflow_bench import proposer_sandbox
from workflow_bench.cli_shim import CLI_TOOLS, GITNEXUS_CLI_NOTE, shim_source
from workflow_bench.proposer_sandbox import (
    SANDBOX_GITNEXUS_CLI,
    SANDBOX_MCP_SOCKET,
    ReadOnlyMount,
    build_sandbox_environment,
    preflight_bubblewrap,
    prepare_sandbox,
)
from workflow_bench.runner_sessions import GITNEXUS_MUTATING_TOOLS, GITNEXUS_READ_ONLY_TOOLS

IMPACT = {
    "name": "impact",
    "description": "Analyze the blast radius of changing a code symbol. Long details follow.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "Symbol name."},
            "direction": {"type": "string", "description": "upstream or downstream."},
            "maxDepth": {"type": "integer", "description": "Traversal depth."},
            "includeTests": {"type": "boolean", "description": "Include tests."},
            "relationTypes": {"type": "array", "items": {"type": "string"}},
            "minConfidence": {"anyOf": [{"type": "number"}, {"type": "null"}]},
        },
        "required": ["target"],
    },
}
RENAME = {"name": "rename", "description": "Mutating.", "inputSchema": {"type": "object", "properties": {}}}


def _shim_namespace() -> dict:
    namespace: dict = {"__name__": "gitnexus_shim"}
    exec(compile(shim_source(), "gitnexus", "exec"), namespace)
    return namespace


def test_shim_binds_the_cell_socket_and_only_read_only_tools():
    source = shim_source()
    assert json.dumps(SANDBOX_MCP_SOCKET) in source
    assert list(CLI_TOOLS) == [tool.removeprefix("mcp__gitnexus__") for tool in GITNEXUS_READ_ONLY_TOOLS]
    assert not {tool.removeprefix("mcp__gitnexus__") for tool in GITNEXUS_MUTATING_TOOLS} & set(CLI_TOOLS)
    # The note is the arm's only fixed prompt cost; keep it far below a tool catalog.
    assert len(GITNEXUS_CLI_NOTE.encode()) < 1024


def test_shim_maps_positionals_and_flags_to_the_tool_schema():
    parse = _shim_namespace()["parse"]
    assert parse(IMPACT, ["foo", "--direction", "upstream", "--max-depth", "2", "--include-tests"]) == {
        "target": "foo",
        "direction": "upstream",
        "maxDepth": 2,
        "includeTests": True,
    }
    assert parse(IMPACT, ["--target=bar", "--relation-types", "CALLS,IMPORTS", "--min-confidence", "0.5"]) == {
        "target": "bar",
        "relationTypes": ["CALLS", "IMPORTS"],
        "minConfidence": 0.5,
    }
    assert parse(IMPACT, ["baz", "--json", '{"maxDepth": 1}']) == {"target": "baz", "maxDepth": 1}
    # An explicit empty value is forwarded, not mistaken for a missing one.
    assert parse(IMPACT, ["--direction=", "qux"]) == {"direction": "", "target": "qux"}
    # The real impact schema requires only direction; the symbol is still positional.
    real_impact = {**IMPACT, "inputSchema": {**IMPACT["inputSchema"], "required": ["direction"]}}
    assert parse(real_impact, ["statusCommand", "--direction", "upstream"]) == {
        "target": "statusCommand", "direction": "upstream"}
    assert parse(real_impact, ["statusCommand", "upstream"]) == {"target": "statusCommand", "direction": "upstream"}
    # A boolean switch before the positional leaves the positional alone.
    assert parse(IMPACT, ["--include-tests", "foo"]) == {"includeTests": True, "target": "foo"}
    assert parse(IMPACT, ["--include-tests", "false", "foo"]) == {"includeTests": False, "target": "foo"}


def test_shim_rejects_unknown_options_and_extra_values():
    parse = _shim_namespace()["parse"]
    with pytest.raises(SystemExit, match="unknown option --bogus"):
        parse(IMPACT, ["foo", "--bogus", "1"])
    with pytest.raises(SystemExit, match="too many values"):
        parse(IMPACT, ["foo", "bar"])


def test_shim_help_is_on_demand_and_short_per_tool():
    describe = _shim_namespace()["describe"]
    text = describe(IMPACT)
    assert text.startswith("gitnexus impact")
    assert "--maxDepth <integer>" in text and "--target <string> (required)" in text
    assert "Positional values fill: target" in text


def test_sandbox_mounts_the_shim_instead_of_the_runtime_cli(tmp_path):
    clone = tmp_path / "clone"
    clone.mkdir()
    with prepare_sandbox(
        clone=clone, claude_bin=sys.executable, bwrap_bin=sys.executable,
        preflight=False, gitnexus_cli_available=False, gitnexus_cli_shim=True,
    ) as sandbox:
        mounts = {mount.target: mount.source for mount in sandbox.read_only_mounts}
        shim = Path(mounts[SANDBOX_GITNEXUS_CLI])
        assert shim.read_text() == shim_source()
        assert proposer_sandbox.SANDBOX_GITNEXUS + "/dist" not in shim.read_text()
        # Claude's Bash sandbox blocks AF_UNIX unless told otherwise; the shim needs it.
        assert json.loads(sandbox.settings_json)["sandbox"]["network"]["allowAllUnixSockets"] is True
    with prepare_sandbox(
        clone=clone, claude_bin=sys.executable, bwrap_bin=sys.executable,
        preflight=False, gitnexus_cli_available=False,
    ) as sandbox:
        assert json.loads(sandbox.settings_json)["sandbox"]["network"]["allowAllUnixSockets"] is False


class _FakeMcpServer:
    """Serve one MCP session per connection, like mcp_transport.serve_stdio."""

    def __init__(self, path: Path, tools: list[dict]) -> None:
        self.path, self.tools, self.calls = path, tools, []
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            with connection, connection.makefile("rwb") as stream:
                for line in stream:
                    message = json.loads(line)
                    if "id" not in message:
                        continue
                    method = message["method"]
                    if method == "initialize":
                        result = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake"}}
                    elif method == "tools/list":
                        result = {"tools": self.tools}
                    else:
                        self.calls.append(message["params"])
                        arguments = message["params"]["arguments"]
                        result = {"content": [{"type": "text", "text": json.dumps(arguments, sort_keys=True)}],
                                  "isError": arguments.get("target") == "broken"}
                    stream.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode() + b"\n")
                    stream.flush()

    def close(self) -> None:
        self.listener.close()


@pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="the shim speaks MCP over a Unix socket")
def test_shim_round_trips_through_a_fake_mcp_endpoint(tmp_path):
    endpoint = tmp_path / "mcp.sock"
    server = _FakeMcpServer(endpoint, [IMPACT, RENAME])
    shim = tmp_path / "gitnexus"
    shim.write_text(shim_source().replace(json.dumps(SANDBOX_MCP_SOCKET), json.dumps(str(endpoint))))

    def run(*argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(shim), *argv], capture_output=True, text=True, timeout=30)

    try:
        listing = run("help")
        assert listing.returncode == 0, listing.stderr
        assert "impact" in listing.stdout and "Analyze the blast radius" in listing.stdout
        assert "rename" not in listing.stdout and "Long details" not in listing.stdout

        call = run("impact", "foo", "--direction", "upstream")
        assert call.returncode == 0, call.stderr
        assert json.loads(call.stdout) == {"direction": "upstream", "target": "foo"}

        failed = run("impact", "broken")
        assert failed.returncode == 1 and "broken" in failed.stderr

        assert run("rename", "x").returncode != 0
        assert len(server.calls) == 2
    finally:
        server.close()


def test_cli_arm_report_compares_arms_and_counts_shell_calls(tmp_path):
    from workflow_bench.cli_arm_report import build_report, render_markdown

    def row(arm: str, run: int, cost: float, **extra) -> dict:
        exposure = "none" if arm == "baseline_nomcp" else "stdio-only"
        return {"task": "t", "run": run, "arm": arm, "ok": True, "sandbox_backend": "bwrap",
                "runtime_exposure": exposure, "error_kind": None, "resolved": True,
                "transcript_missing": False, "cost_usd": cost, "duration_s": 10.0, "num_turns": 4,
                "cache_read_input_tokens": 1000, "output_tokens": 50, **extra}

    paired, cli = tmp_path / "raw/results.jsonl", tmp_path / "cli-raw/results.jsonl"
    paired.parent.mkdir()
    cli.parent.mkdir()
    paired.write_text("\n".join(json.dumps(r) for r in [
        row("baseline_nomcp", 0, 1.0), row("baseline", 0, 1.3, gitnexus_tool_uses=3)]) + "\n")
    (cli.parent / "transcripts").mkdir()
    event = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": "gitnexus impact foo && gitnexus help"}},
        {"type": "tool_use", "name": "Bash", "input": {"command": "npm --prefix gitnexus test -- --run x"}}]}}
    (cli.parent / "transcripts/t-cli.jsonl").write_text(json.dumps(event) + "\n")
    cli.write_text(json.dumps(row("baseline_cli", 0, 1.1, transcript_artifacts=["transcripts/t-cli.jsonl"])) + "\n")

    report = build_report(paired, cli)
    assert not report["problems"]
    assert report["arms"]["baseline_cli"]["gitnexus_commands"] == {"impact": 1, "help": 1}
    assert round(report["changes"]["baseline_cli vs baseline_nomcp: cost_usd"], 1) == 10.0
    assert round(report["changes"]["baseline_cli vs baseline: cost_usd"], 1) == -15.4
    assert "| baseline_cli | 1/1 | $1.1000" in render_markdown(report)


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_cli_shim_reaches_isolated_mcp_without_exposing_the_runtime(tmp_path):
    from workflow_bench.mcp_transport import isolated_mcp

    clone = tmp_path / "clone"
    clone.mkdir()
    runtime = tmp_path / "runtime"
    entrypoint = runtime / "dist/cli/index.js"
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text("""
const readline = require('readline');
const tool = TOOL;
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize' ? {protocolVersion: '2025-06-18', capabilities: {}}
    : message.method === 'tools/list' ? {tools: [tool]}
    : {content: [{type: 'text', text: 'impact of ' + message.params.arguments.target}]};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\\n');
});
""".replace("TOOL", json.dumps(IMPACT)))
    bwrap = preflight_bubblewrap()
    mounts = [ReadOnlyMount(runtime, proposer_sandbox.SANDBOX_GITNEXUS)]
    with isolated_mcp(clone=clone, mounts=mounts, bwrap_bin=bwrap) as endpoint:
        with prepare_sandbox(
            clone=clone, claude_bin=sys.executable, bwrap_bin=bwrap, read_only_mounts=[endpoint],
            preflight=False, gitnexus_cli_available=False, gitnexus_cli_shim=True,
        ) as sandbox:
            script = (
                "test ! -e /opt/gitnexus && test ! -e /opt/gitnexus-registry && "
                "gitnexus help | grep -q impact && gitnexus impact parseFile && gitnexus impact second"
            )
            result = sandbox.run(["/bin/bash", "-c", script], timeout=60, env=build_sandbox_environment())
            assert result.ok, result.stderr_tail
            assert "impact of parseFile" in result.stdout_tail and "impact of second" in result.stdout_tail
