"""Content-free workload signals. Associations are not causal cost attribution."""

from __future__ import annotations

import json
import shlex
from collections import Counter
from pathlib import PurePosixPath
from typing import Any

# Also the publication allowlist. No arguments, paths, source, or hashes leave
# this module. Unknown/missing observations must not become measured zeros.
COUNT_FIELDS = (
    "source_reads", "repeated_source_reads", "reads_after_graph_reference",
    "reads_after_graph_content_reference", "query_context_read_chains",
    "graph_calls", "graph_calls_before_first_edit", "edits", "edits_after_verification",
    "verification_calls", "verification_repeated_without_observed_change",
    "verification_repeated_after_possible_change", "verification_errors",
    "bash_test", "bash_typecheck", "bash_lint", "bash_build", "bash_source",
    "bash_mutation", "bash_mixed", "bash_other", "compactions",
    "usage_snapshots", "complete_input_snapshots", "usage_after_graph_snapshots",
    "reference_scan_limited",
)
TOKEN_FIELDS = (
    "first_input_tokens", "last_input_tokens", "max_input_tokens", "sum_input_tokens",
    "sum_cache_read_tokens", "sum_cache_write_tokens", "sum_output_tokens",
    "input_tokens_after_graph",
)
FIELDS = (*COUNT_FIELDS, *TOKEN_FIELDS)
VERIFY = frozenset({"test", "typecheck", "lint", "build"})


def classify_bash(command: Any) -> str:
    """Conservative lexical classification, never shell evaluation.

    Compound commands are explicitly mixed; their time cannot be assigned to
    one test/build. A common `cd dir && command` prefix is the sole exception.
    """
    if not isinstance(command, str):
        return "other"
    try:
        words = shlex.split(command)
    except ValueError:
        return "other"
    if len(words) >= 4 and words[0] == "cd" and words[2] == "&&":
        words = words[3:]
        # Inspect the remainder too: shell substitutions and pipes stay mixed.
        command = shlex.join(words)
    if any(op in command for op in (";", "|", "&", "\n", "`", "$(", ">", "<")):
        return "mixed"
    if not words:
        return "other"
    executable = PurePosixPath(words[0]).name
    args = words[1:]
    if executable == "uv" and args[:1] == ["run"]:
        return classify_bash(shlex.join(args[1:]))
    if executable in ("python", "python3") and args[:2] == ["-m", "pytest"]:
        return "test"
    if executable in ("npm", "pnpm", "yarn", "bun", "npx") and args:
        if args[0] in ("run", "exec", "x"):
            args = args[1:]
        executable = args[0] if args else ""
    if executable in ("test", "pytest", "vitest", "jest") or executable.startswith("test:"):
        return "test"
    if executable in ("tsc", "mypy", "pyright", "typecheck"):
        return "typecheck"
    if executable in ("eslint", "ruff", "prettier", "lint"):
        mutates = any(arg in ("--fix", "--write", "-w") for arg in args)
        if executable == "ruff" and "format" in args and not any(arg in ("--check", "--diff") for arg in args):
            mutates = True
        return "mutation" if mutates else "lint"
    if executable in ("build", "vite", "tsup"):
        return "build"
    if executable in ("rg", "grep", "cat", "head", "tail", "sed"):
        return "mutation" if executable == "sed" and any(
            arg.startswith(("-i", "--in-place")) for arg in args
        ) else "source"
    if executable in ("apply_patch", "patch", "touch", "rm", "mv", "cp", "tee"):
        return "mutation"
    return "other"


def _references(content: Any) -> tuple[dict[str, bool], bool]:
    """Structured result references only; cap traversal of large tool results."""
    if isinstance(content, list):
        text = "\n".join(b["text"] for b in content
                         if isinstance(b, dict) and isinstance(b.get("text"), str))
    else:
        text = content if isinstance(content, str) else ""
    if len(text) > 2_000_000:
        return {}, True
    try:
        body = json.loads(text.split("\n\n---", 1)[0])
    except (ValueError, RecursionError):
        return {}, False
    stack, paths, visited = [body], {}, 0
    while stack and visited < 10_000 and len(paths) < 1000:
        item = stack.pop()
        visited += 1
        if isinstance(item, dict):
            path = item.get("filePath", item.get("file_path"))
            if isinstance(path, str) and path and len(path) <= 4096:
                # Same-object source only. Descriptions and arbitrary text are
                # not evidence that the response supplied the file's contents.
                supplied = any(isinstance(item.get(key), str) and bool(item[key].strip())
                               for key in ("content", "source", "code"))
                paths[path] = paths.get(path, False) or supplied
            stack.extend(value for value in item.values() if isinstance(value, (dict, list)))
        elif isinstance(item, list):
            stack.extend(item)
    return paths, bool(stack)


def _same_path(read: str, reference: str) -> bool:
    read_parts, ref_parts = PurePosixPath(read).parts, PurePosixPath(reference).parts
    if ".." in read_parts or ".." in ref_parts:
        return False
    if read_parts == ref_parts:
        return True
    # Absolute sandbox paths can match repo-relative graph paths. Never match
    # unrelated absolute roots or a basename-only relative reference.
    return (len(ref_parts) > 1 and not reference.startswith("/")
            and len(read_parts) >= len(ref_parts) and read_parts[-len(ref_parts):] == ref_parts)


def workload_metrics(
    observations: list[tuple[dict[str, Any], Any, Any]],
    usage: list[dict[str, Any]], events: list[dict[str, Any]],
) -> dict[str, int | None]:
    """Compute bounded numeric signals from accepted, deduplicated calls.

    `observations` holds (call metadata, input, result content) only in memory.
    No assumption that an unknown Bash action left the checkout unchanged.
    """
    counts = Counter(dict.fromkeys(COUNT_FIELDS, 0))
    counts["compactions"] = sum(e.get("type") == "system" and e.get("subtype") == "compact_boundary" for e in events)
    reads: set[str] = set()
    checks: dict[str, int] = {}
    mutation_epoch = 0
    verified = False
    graph_results: list[tuple[int, str, dict[str, bool]]] = []
    reference_budget = 5000
    for call, args, content in observations:
        args = args if isinstance(args, dict) else {}
        tool = call["tool"]
        if "__gitnexus__" in tool:
            counts["graph_calls"] += 1
            counts["graph_calls_before_first_edit"] += counts["edits"] == 0
            if call.get("result_event") is not None:
                paths, limited = _references(content)
                if len(paths) > reference_budget:
                    paths = dict(list(paths.items())[:reference_budget])
                    limited = True
                reference_budget -= len(paths)
                counts["reference_scan_limited"] += limited
                graph_results.append((call["result_event"], tool.rsplit("__", 1)[-1], paths))
        elif tool == "Read":
            counts["source_reads"] += 1
            signature = json.dumps(args, sort_keys=True, ensure_ascii=True)
            counts["repeated_source_reads"] += signature in reads
            reads.add(signature)
            path = args.get("file_path")
            prior = sorted((g for g in graph_results if g[0] < call["request_event"]), key=lambda g: g[0])
            if isinstance(path, str):
                matching = [supplied for _, _, paths in prior for ref, supplied in paths.items() if _same_path(path, ref)]
                counts["reads_after_graph_reference"] += bool(matching)
                counts["reads_after_graph_content_reference"] += any(matching)
                counts["query_context_read_chains"] += (
                    len(prior) >= 2 and [g[1] for g in prior[-2:]] == ["query", "context"]
                    and any(_same_path(path, ref) for ref in prior[-1][2])
                )
        elif tool in ("Edit", "Write"):
            counts["edits"] += 1
            counts["edits_after_verification"] += verified
            mutation_epoch += 1
        elif tool == "Bash":
            category = classify_bash(args.get("command"))
            counts[f"bash_{category}"] += 1
            if category in VERIFY:
                counts["verification_calls"] += 1
                counts["verification_errors"] += call["outcome"] == "error"
                signature = json.dumps(args, sort_keys=True, ensure_ascii=True)
                if signature in checks:
                    field = "verification_repeated_without_observed_change" if checks[signature] == mutation_epoch else "verification_repeated_after_possible_change"
                    counts[field] += 1
                checks[signature] = mutation_epoch
                verified = True
            elif category in ("mutation", "mixed", "other"):
                mutation_epoch += 1
                if category == "mutation":
                    counts["edits"] += 1
                    counts["edits_after_verification"] += verified
    counts["usage_snapshots"] = len(usage)
    input_fields = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    complete = [u for u in usage if all(type(u.get(f)) is int and u[f] >= 0 for f in input_fields)]
    totals = [sum(u[f] for f in input_fields) for u in complete]
    counts["complete_input_snapshots"] = len(complete)
    after_graph = []
    for u in complete:
        preceding = [call for call, _, _ in observations
                     if call.get("result_event") is not None and call["result_event"] < u["event_index"]]
        latest = max((call["result_event"] for call in preceding), default=-1)
        if any("__gitnexus__" in c["tool"] and c["result_event"] == latest for c in preceding):
            after_graph.append(sum(u[f] for f in input_fields))
    counts["usage_after_graph_snapshots"] = len(after_graph)
    tokens = {
        "first_input_tokens": totals[0] if totals else None,
        "last_input_tokens": totals[-1] if totals else None,
        "max_input_tokens": max(totals) if totals else None,
        "sum_input_tokens": sum(totals) if totals else None,
        "input_tokens_after_graph": sum(after_graph) if after_graph else None,
    }
    for dest, source in (("sum_cache_read_tokens", "cache_read_input_tokens"),
                         ("sum_cache_write_tokens", "cache_creation_input_tokens"), ("sum_output_tokens", "output_tokens")):
        # A partial sum labelled as total would understate spend. These fields
        # stay unknown unless every observed usage snapshot supplies the field.
        tokens[dest] = sum(u[source] for u in usage) if usage and all(source in u for u in usage) else None
    return {**counts, **tokens}


def public_workload(value: Any) -> dict[str, int | None]:
    if not isinstance(value, dict):
        return {}
    return {field: n if type(n := value.get(field)) is int and 0 <= n <= 10**15 else None for field in FIELDS}
