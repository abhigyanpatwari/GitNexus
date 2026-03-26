from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class ToolScriptSpec:
    key: str
    bin_name: str
    endpoint: str | None
    payload_builder: str
    fallback: str
    header: str | None = None


TOOL_METRIC_KEYS: Tuple[str, ...] = ("query", "context", "impact", "cypher", "overview")

TOOL_SPECS: Dict[str, ToolScriptSpec] = {
    "query": ToolScriptSpec(
        key="query",
        bin_name="gitnexus-query",
        endpoint="/tool/query",
        payload_builder=r'''query="$1"; task_ctx="${2:-}"; goal="${3:-}"
[ -z "$query" ] && echo "Usage: gitnexus-query <query> [task_context] [goal]" && exit 1
payload="{\"query\": \"$query\""
[ -n "$task_ctx" ] && payload="$payload, \"task_context\": \"$task_ctx\""
[ -n "$goal" ] && payload="$payload, \"goal\": \"$goal\""
payload="$payload}"''',
        fallback='cd /testbed && npx gitnexus query "$query" 2>&1',
    ),
    "context": ToolScriptSpec(
        key="context",
        bin_name="gitnexus-context",
        endpoint="/tool/context",
        payload_builder=r'''name="$1"; file_path="${2:-}"
[ -z "$name" ] && echo "Usage: gitnexus-context <symbol_name> [file_path]" && exit 1
payload="{\"name\": \"$name\""
[ -n "$file_path" ] && payload="$payload, \"file_path\": \"$file_path\""
payload="$payload}"''',
        fallback='cd /testbed && npx gitnexus context "$name" 2>&1',
    ),
    "impact": ToolScriptSpec(
        key="impact",
        bin_name="gitnexus-impact",
        endpoint="/tool/impact",
        payload_builder=r'''target="$1"; direction="${2:-upstream}"
[ -z "$target" ] && echo "Usage: gitnexus-impact <symbol_name> [upstream|downstream]" && exit 1
payload="{\"target\": \"$target\", \"direction\": \"$direction\"}"''',
        fallback='cd /testbed && npx gitnexus impact "$target" --direction "$direction" 2>&1',
    ),
    "cypher": ToolScriptSpec(
        key="cypher",
        bin_name="gitnexus-cypher",
        endpoint="/tool/cypher",
        payload_builder=r'''query="$1"
[ -z "$query" ] && echo "Usage: gitnexus-cypher <cypher_query>" && exit 1
payload="{\"query\": \"$query\"}"''',
        fallback='cd /testbed && npx gitnexus cypher "$query" 2>&1',
    ),
    "overview": ToolScriptSpec(
        key="overview",
        bin_name="gitnexus-overview",
        endpoint="/tool/list_repos",
        header='echo "=== Code Knowledge Graph Overview ==="',
        payload_builder='payload="{}"',
        fallback='cd /testbed && npx gitnexus list 2>&1',
    ),
    "augment": ToolScriptSpec(
        key="augment",
        bin_name="gitnexus-augment",
        endpoint=None,
        payload_builder="",
        fallback='cd /testbed && npx gitnexus augment "$1" 2>&1 || true',
    ),
}

BINARIES_BY_KEY: Dict[str, str] = {spec.key: spec.bin_name for spec in TOOL_SPECS.values()}
ENDPOINTS_BY_KEY: Dict[str, str | None] = {spec.key: spec.endpoint for spec in TOOL_SPECS.values()}
