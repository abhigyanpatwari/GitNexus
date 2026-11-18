"""Read a frozen checkout and submit one patch for the paired proposal evaluation."""

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path("/workspace")
PROPOSAL = Path("/proposal/change.patch")
MAX_TEXT = 1024 * 1024
MAX_PAGE = 120
TEXT = {"type": "string", "minLength": 1}
TOOLS = {
    "list_files": ("List tracked source paths containing the supplied text.", {"text": TEXT}),
    "read_file": (
        "Read at most 120 lines of a tracked text file, starting at line 1 or later.",
        {"path": TEXT, "start": {"type": "integer", "minimum": 1}},
    ),
    "search": ("Find a literal string in tracked text files. Returns the first 40 matching lines.", {"text": TEXT}),
    "submit_patch": ("Submit or replace the unified Git diff that the evaluator will grade.", {"patch": TEXT}),
}


def tracked_files() -> dict[str, Path]:
    raw = subprocess.check_output(
        ["/usr/bin/git", "-c", "safe.directory=/workspace", "ls-files", "--cached", "-z"],
        cwd=ROOT,
    )
    files = {}
    for name in raw.decode("utf-8", errors="surrogateescape").split("\0"):
        if not name:
            continue
        file = ROOT / name
        if {".git", ".gitnexus", "node_modules"}.intersection(file.relative_to(ROOT).parts):
            continue
        if file.resolve() == file and file.is_file() and file.stat().st_size <= MAX_TEXT:
            files[name] = file
    return files


def call_tool(name: str, arguments: dict, files: dict[str, Path]) -> str:
    fields = TOOLS[name][1]
    if not isinstance(arguments, dict) or set(arguments) != set(fields):
        raise ValueError("invalid tool arguments")
    for field, schema in fields.items():
        value = arguments[field]
        if schema["type"] == "string" and (not isinstance(value, str) or not value or len(value.encode()) > MAX_TEXT):
            raise ValueError(f"invalid {field}")
    if name == "submit_patch":
        patch = arguments["patch"]
        path = PROPOSAL.with_suffix(".tmp")
        path.write_text(patch, encoding="utf-8")
        path.replace(PROPOSAL)
        return "Patch submitted for grading."
    if name == "list_files":
        return "\n".join(path for path in files if arguments["text"] in path)[:12000]
    if name == "read_file":
        start = arguments["start"]
        if type(start) is not int or start < 1:
            raise ValueError("start must be a positive line number")
        lines = files[arguments["path"]].read_text(encoding="utf-8").splitlines()
        return "\n".join(lines[start - 1 : start - 1 + MAX_PAGE])[:32000]
    matches = []
    for path, file in files.items():
        try:
            lines = file.read_text(encoding="utf-8").splitlines()
        except UnicodeError:
            continue
        for line, value in enumerate(lines, 1):
            if arguments["text"] in value:
                matches.append(f"{path}:{line}: {value[:300]}")
                if len(matches) == 40:
                    return "\n".join(matches)
    return "\n".join(matches)


def main() -> None:
    files = tracked_files()
    for line in sys.stdin:
        req = json.loads(line)
        if "id" not in req:
            continue
        reply = {"jsonrpc": "2.0", "id": req["id"]}
        method = req.get("method")
        if method == "initialize":
            reply["result"] = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "workspace", "version": "1"},
            }
        elif method == "tools/list":
            reply["result"] = {
                "tools": [
                    {
                        "name": name,
                        "description": description,
                        "inputSchema": {
                            "type": "object",
                            "properties": fields,
                            "required": list(fields),
                            "additionalProperties": False,
                        },
                    }
                    for name, (description, fields) in TOOLS.items()
                ]
            }
        elif method == "tools/call":
            params = req.get("params", {})
            try:
                output = call_tool(params["name"], params["arguments"], files)
                is_error = False
            except (KeyError, OSError, ValueError) as exc:
                output, is_error = str(exc), True
            reply["result"] = {"content": [{"type": "text", "text": output}], "isError": is_error}
        elif method == "ping":
            reply["result"] = {}
        else:
            reply["error"] = {"code": -32601, "message": "Unknown method"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
