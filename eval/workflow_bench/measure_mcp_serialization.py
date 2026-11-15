"""Measure lossless MCP response serialization with two pinned token encodings.

From eval/: uv run --locked python -m workflow_bench.measure_mcp_serialization
Requires the CLI's installed node dependencies. No model calls or index needed.
"""

import json
import subprocess
from pathlib import Path

import tiktoken


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    result = json.loads(
        subprocess.check_output(
            ["node", "--import", "tsx", "scripts/bench/mcp-serialization.ts", "--include-text"],
            cwd=root / "gitnexus",
            text=True,
        )
    )
    result["bytes"] = sum(row["currentBytes"] for row in result["measurements"])
    for encoding, key in [("o200k_base", "o200k_tokens"), ("cl100k_base", "cl100k_tokens")]:
        tokenizer = tiktoken.get_encoding(encoding)
        for row in result["measurements"]:
            row[key] = len(tokenizer.encode(row["currentText"], disallowed_special=()))
            row["baseline_" + key] = len(tokenizer.encode(row["prettyText"], disallowed_special=()))
        result[key] = sum(row[key] for row in result["measurements"])
    for row in result["measurements"]:
        del row["currentText"], row["prettyText"]
    result["tokenizer"] = f"tiktoken {tiktoken.__version__}"
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
