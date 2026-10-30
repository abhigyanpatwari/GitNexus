"""CLI-only arm: a `gitnexus` command that forwards to the isolated MCP endpoint.

The `baseline_cli` arm measures how much of the MCP arm's cost is the tool
catalog itself. Its agent has no MCP tools, so no tool schema enters the model
context; it reaches the same read-only tools through a shell command that
speaks MCP over the per-cell socket. Results are the server's own text, so the
two arms receive identical tool output and differ only in how tools are
described: always (MCP) or on demand (`gitnexus help`).

The candidate runtime stays in the sibling server sandbox, exactly as for the
MCP arm; the agent's filesystem holds only this standard-library script.
"""

from __future__ import annotations

import json
from pathlib import Path

from .proposer_sandbox import SANDBOX_MCP_SOCKET
from .runner_sessions import GITNEXUS_READ_ONLY_TOOLS

_MCP_PREFIX = "mcp__gitnexus__"
CLI_TOOLS = tuple(tool.removeprefix(_MCP_PREFIX) for tool in GITNEXUS_READ_ONLY_TOOLS)

GITNEXUS_CLI_NOTE = (
    "GitNexus is available in this arm only as the `gitnexus` shell command (there are no "
    "GitNexus MCP tools). It queries a prebuilt code knowledge graph of this repository. "
    "Commands include query, context, impact, detect_changes and trace; run `gitnexus help` "
    "for the full list and `gitnexus help <command>` for its options. Example: "
    "`gitnexus impact parseFile --direction upstream`. GitNexus MCP tool names in repository "
    "docs map to these commands; `npx gitnexus` and `.gitnexus/run.cjs` are not available.\n"
)

_SHIM_TEMPLATE = r'''#!/usr/bin/python3
"""gitnexus: forward one read-only GitNexus tool call to the MCP endpoint."""
import json, socket, sys

SOCKET = __SOCKET__
TOOLS = __TOOLS__
USAGE = "usage: gitnexus <command> [value ...] [--option value] [--json '{...}']"


class Session:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(600)
        self.sock.connect(SOCKET)
        self.buffer = b""
        self.next_id = 0
        self.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "gitnexus-cli-shim", "version": "1"},
        })
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, message):
        self.sock.sendall(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    def read(self):
        while b"\n" not in self.buffer:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("gitnexus: the GitNexus server closed the connection")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line) if line.strip() else None

    def request(self, method, params):
        self.next_id += 1
        wanted = self.next_id
        self.send({"jsonrpc": "2.0", "id": wanted, "method": method, "params": params})
        while True:
            message = self.read()
            if not message:
                continue
            if "method" in message:
                if "id" in message:
                    self.send({"jsonrpc": "2.0", "id": message["id"],
                               "error": {"code": -32601, "message": "unsupported by gitnexus CLI"}})
                continue
            if message.get("id") != wanted:
                continue
            if "error" in message:
                raise SystemExit("gitnexus: " + str(message["error"].get("message", message["error"])))
            return message.get("result", {})

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_WR)
            while self.sock.recv(65536):
                pass
        except OSError:
            pass
        self.sock.close()


def key(name):
    return name.replace("-", "").replace("_", "").lower()


def types_of(spec):
    found = spec.get("type")
    if isinstance(found, list):
        return found
    if found:
        return [found]
    return [t for option in spec.get("anyOf", []) + spec.get("oneOf", []) for t in types_of(option)]


def coerce(name, raw, spec):
    kinds = types_of(spec)
    if raw is True:
        if "boolean" in kinds or not kinds:
            return True
        raise SystemExit(f"gitnexus: --{name} needs a value")
    if "boolean" in kinds and raw.lower() in ("true", "false"):
        return raw.lower() == "true"
    if "integer" in kinds:
        try:
            return int(raw)
        except ValueError:
            pass
    if "number" in kinds:
        try:
            return float(raw)
        except ValueError:
            pass
    if "array" in kinds:
        if raw.startswith("["):
            return json.loads(raw)
        items = spec.get("items", {})
        return [coerce(name, part.strip(), items) for part in raw.split(",") if part.strip()]
    if "object" in kinds:
        return json.loads(raw)
    return raw


def first_sentence(text):
    text = " ".join((text or "").split())
    end = text.find(". ")
    return text if end < 0 else text[: end + 1]


def describe(tool):
    lines = [f"gitnexus {tool['name']}", "", (tool.get("description") or "").strip(), "", "Options:"]
    schema = tool.get("inputSchema") or {}
    required = set(schema.get("required", []))
    for name, spec in (schema.get("properties") or {}).items():
        kinds = "|".join(types_of(spec)) or "value"
        mark = " (required)" if name in required else ""
        lines.append(f"  --{name} <{kinds}>{mark}  {first_sentence(spec.get('description', ''))}")
    positional = positional_names(schema)
    if positional:
        lines += ["", "Positional values fill: " + ", ".join(positional)]
    return "\n".join(lines)


def positional_names(schema):
    # The first property names the subject (target, name, search_query, from);
    # it comes first even when optional, as impact's target is, then required ones.
    properties = schema.get("properties") or {}
    subject = [name for name in list(properties)[:1] if "string" in types_of(properties[name])]
    required = [name for name in schema.get("required", []) if name in properties and name not in subject]
    return subject + required


def parse(tool, argv):
    schema = tool.get("inputSchema") or {}
    properties = schema.get("properties") or {}
    by_key = {key(name): name for name in properties}
    arguments, positional = {}, []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--json":
            index += 1
            if index >= len(argv):
                raise SystemExit("gitnexus: --json needs a JSON object")
            arguments.update(json.loads(argv[index]))
        elif token.startswith("--") and len(token) > 2:
            flag, separator, inline = token[2:].partition("=")
            name = by_key.get(key(flag))
            if name is None:
                raise SystemExit(f"gitnexus: unknown option --{flag} for {tool['name']}; "
                                 f"options: {', '.join('--' + n for n in properties)}")
            kinds = set(types_of(properties[name]))
            if separator:
                raw = inline
            elif "boolean" in kinds and kinds <= {"boolean", "null"}:
                # A switch takes only an explicit true/false, never the next positional.
                if index + 1 < len(argv) and argv[index + 1].lower() in ("true", "false"):
                    index += 1
                    raw = argv[index]
                else:
                    raw = True
            elif index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                index += 1
                raw = argv[index]
            else:
                raw = True
            arguments[name] = coerce(flag, raw, properties[name])
        else:
            positional.append(token)
        index += 1
    slots = [name for name in positional_names(schema) if name not in arguments]
    if len(positional) > len(slots):
        raise SystemExit(f"gitnexus: too many values for {tool['name']}; use --option value")
    for name, raw in zip(slots, positional):
        arguments[name] = coerce(name, raw, properties[name])
    return arguments


def main(argv):
    session = Session()
    try:
        listed = session.request("tools/list", {}).get("tools", [])
        tools = {tool["name"]: tool for tool in listed if tool["name"] in TOOLS}
        if not argv or argv[0] in ("help", "--help", "-h") and len(argv) == 1:
            print(USAGE + "\n\nCommands:")
            for name in TOOLS:
                if name in tools:
                    print(f"  {name:<16} {first_sentence(tools[name].get('description'))}")
            print("\nRun `gitnexus help <command>` for options.")
            return 0
        if argv[0] in ("help", "--help", "-h"):
            argv = [argv[1], "--help"]
        name = argv[0].replace("-", "_")
        if name not in tools:
            raise SystemExit(f"gitnexus: unknown command {argv[0]}; run `gitnexus help`")
        if any(token in ("--help", "-h") for token in argv[1:]):
            print(describe(tools[name]))
            return 0
        result = session.request("tools/call", {"name": name, "arguments": parse(tools[name], argv[1:])})
    finally:
        session.close()
    texts = [part.get("text", "") for part in result.get("content", []) if part.get("type") == "text"]
    output = "\n".join(texts) if texts else json.dumps(result.get("structuredContent", result), indent=2)
    stream = sys.stderr if result.get("isError") else sys.stdout
    stream.write(output + ("" if output.endswith("\n") else "\n"))
    return 1 if result.get("isError") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''


def shim_source() -> str:
    """Return the shim with its socket path and tool allowlist bound in."""

    return _SHIM_TEMPLATE.replace("__SOCKET__", json.dumps(SANDBOX_MCP_SOCKET)).replace(
        "__TOOLS__", json.dumps(list(CLI_TOOLS))
    )


def create_cli_shim(private_root: Path) -> Path:
    """Write the immutable shim the agent sandbox mounts as `gitnexus`."""

    shim = private_root / "gitnexus"
    shim.write_text(shim_source())
    shim.chmod(0o500)
    return shim
