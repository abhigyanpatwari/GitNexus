#!/usr/bin/env python3
"""CPython runtime + AST call-resolution reporter for compiler conformance.

Executes a fixture's configured Python entrypoint under `sys.setprofile`,
maps each observed in-repo call via PEP 657 bytecode positions (`co_positions`)
and AST spans to UTF-16 source coordinates, and emits a conformance JSON report
compatible with `tools/compiler-conformance/compare.mjs`.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True


def utf8_col_to_utf16(line_text: str, utf8_byte_col: int) -> int:
    """Convert a 0-based UTF-8 byte offset on a line into a UTF-16 code-unit offset."""
    prefix = line_text.encode("utf-8")[:utf8_byte_col].decode("utf-8", errors="replace")
    return len(prefix.encode("utf-16-le")) // 2


class FixtureIndex:
    """AST-derived declarations and call spans for all .py files in a fixture."""

    def __init__(self, fixture_dir: Path) -> None:
        self.fixture_dir = fixture_dir.resolve()
        self.decls: dict[tuple[str, int], str] = {}
        self.calls: dict[str, list[tuple[int, int, int, int, str, str]]] = {}
        self._index_all()

    def _rel(self, abs_path: Path) -> str:
        return abs_path.relative_to(self.fixture_dir).as_posix()

    def _index_all(self) -> None:
        for py_file in sorted(self.fixture_dir.rglob("*.py")):
            abs_resolved = py_file.resolve()
            rel = self._rel(abs_resolved)
            source = abs_resolved.read_text(encoding="utf-8")
            lines = source.splitlines(keepends=True)
            tree = ast.parse(source, filename=str(abs_resolved))

            file_calls: list[tuple[int, int, int, int, str, str]] = []
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    line_idx = node.lineno - 1
                    line_str = lines[line_idx] if 0 <= line_idx < len(lines) else ""
                    col_u16 = utf8_col_to_utf16(line_str, node.col_offset)
                    decl = f"{rel}#{node.lineno}:{col_u16}"
                    self.decls[(str(abs_resolved), node.lineno)] = decl
                    if node.decorator_list:
                        self.decls[(str(abs_resolved), node.decorator_list[0].lineno)] = decl
                elif isinstance(node, ast.Call):
                    if node.end_lineno is None or node.end_col_offset is None:
                        continue
                    s_line = lines[node.lineno - 1] if 0 <= node.lineno - 1 < len(lines) else ""
                    e_line = (
                        lines[node.end_lineno - 1]
                        if 0 <= node.end_lineno - 1 < len(lines)
                        else ""
                    )
                    s_u16 = utf8_col_to_utf16(s_line, node.col_offset)
                    e_u16 = utf8_col_to_utf16(e_line, node.end_col_offset)
                    file_calls.append(
                        (
                            node.lineno,
                            node.col_offset,
                            node.end_lineno,
                            node.end_col_offset,
                            f"{node.lineno}:{s_u16}",
                            f"{node.end_lineno}:{e_u16}",
                        )
                    )
            self.calls[str(abs_resolved)] = file_calls

    def in_fixture(self, filename: str) -> str | None:
        try:
            resolved = str(Path(filename).resolve())
        except OSError:
            return None
        root_str = str(self.fixture_dir)
        if resolved == root_str or resolved.startswith(root_str + os.sep):
            return resolved
        return None

    def find_call_span(
        self, abs_file: str, pos: tuple[int | None, int | None, int | None, int | None]
    ) -> tuple[str, str] | None:
        lineno, end_lineno, col_offset, end_col_offset = pos
        if lineno is None or end_lineno is None or col_offset is None or end_col_offset is None:
            return None
        candidates = self.calls.get(abs_file, [])
        exact: list[tuple[int, str, str]] = []
        enclosing: list[tuple[int, str, str]] = []
        for s_l, s_c, e_l, e_c, start_u16, end_u16 in candidates:
            if (s_l, s_c, e_l, e_c) == (lineno, col_offset, end_lineno, end_col_offset):
                exact.append((0, start_u16, end_u16))
            elif (s_l, s_c) <= (lineno, col_offset) and (end_lineno, end_col_offset) <= (e_l, e_c):
                span_size = (e_l - s_l) * 10000 + (e_c - s_c)
                enclosing.append((span_size, start_u16, end_u16))
        if exact:
            return exact[0][1], exact[0][2]
        if enclosing:
            enclosing.sort(key=lambda item: item[0])
            return enclosing[0][1], enclosing[0][2]
        return None


def run_report(fixture_dir: Path, entry_code: str, names: set[str]) -> dict[str, Any]:
    index = FixtureIndex(fixture_dir)
    sites_seen: set[tuple[str, str, str, str]] = set()
    edges_seen: set[tuple[str, str]] = set()
    sites: list[dict[str, str]] = []
    edges: list[dict[str, str]] = []

    def profiler(frame: Any, event: str, arg: Any) -> None:
        if event != "call":
            return
        callee_code = frame.f_code
        callee_file = index.in_fixture(callee_code.co_filename)
        if callee_file is None:
            return
        callee_name = callee_code.co_name
        if names and callee_name not in names:
            return
        callee_decl = index.decls.get((callee_file, callee_code.co_firstlineno))
        if callee_decl is None:
            return

        caller_frame = frame.f_back
        if caller_frame is None:
            return
        caller_code = caller_frame.f_code
        caller_file = index.in_fixture(caller_code.co_filename)
        if caller_file is None:
            return
        caller_decl = index.decls.get((caller_file, caller_code.co_firstlineno))
        if caller_decl is None:
            return

        edge_key = (caller_decl, callee_decl)
        if edge_key not in edges_seen:
            edges_seen.add(edge_key)
            edges.append({"from": caller_decl, "to": callee_decl})

        positions = list(caller_code.co_positions())
        inst_idx = caller_frame.f_lasti // 2
        if 0 <= inst_idx < len(positions):
            span = index.find_call_span(caller_file, positions[inst_idx])
            if span is not None:
                rel_caller = index._rel(Path(caller_file))
                site_key = (rel_caller, span[0], span[1], callee_decl)
                if site_key not in sites_seen:
                    sites_seen.add(site_key)
                    sites.append(
                        {
                            "file": rel_caller,
                            "start": span[0],
                            "end": span[1],
                            "status": "resolved",
                            "target": callee_decl,
                        }
                    )

    sys.path.insert(0, str(index.fixture_dir))
    ns: dict[str, Any] = {}
    compiled = compile(entry_code, "<conformance-entry>", "exec")
    old_profiler = sys.getprofile()
    sys.setprofile(profiler)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compiled, ns)
    finally:
        sys.setprofile(old_profiler)
        if sys.path and sys.path[0] == str(index.fixture_dir):
            sys.path.pop(0)

    return {"producer": "CPython", "sites": sites, "edges": edges}


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage: python-report.py <fixture_dir> <entry_code> [names...]",
            file=sys.stderr,
        )
        sys.exit(2)
    fixture_dir = Path(sys.argv[1])
    entry_code = sys.argv[2]
    names = set(sys.argv[3:])
    report = run_report(fixture_dir, entry_code, names)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
