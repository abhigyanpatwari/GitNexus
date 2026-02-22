# 02 — Product Brief

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)

---

## Context

`gitnexus-web` is a React app that ships a full WebAssembly (tree-sitter) ingestion pipeline
so it can analyze codebases directly in the browser — without the CLI. This is its primary
value proposition for the cloud/hosted use case.

For developers who already use the CLI (`gitnexus analyze`), the WebAssembly bundle is
unnecessary: the graph is already fully indexed in KuzuDB on disk. Yet today there is no
lightweight way to *see* the graph from the CLI — you must either run the `gitnexus-web`
React app or inspect graph data through raw MCP tool calls.

## Problem

- No visual entry point from the CLI for developers who have already indexed a repo
- `gitnexus-web` ships WebAssembly for in-browser ingestion; this is overhead for the
  CLI use case where data is pre-indexed
- The HTTP API (`gitnexus serve`) exposes full graph data but has no viewer to consume it

## Scope

**In scope (v1):**
- `gitnexus view` CLI command
- Generates a self-contained `graph.html` from the KuzuDB index
- Opens it in the default browser
- Nodes colored by cluster (community), edges typed by relation
- Basic interactions: pan, zoom, click-to-highlight neighbors

**Out of scope (v1):**
- Search/filter within the viewer
- Real-time updates (re-run `gitnexus view` to refresh)
- MCP `graph` resource (Path C from spike — low-effort add-on, separate task)
- `--open` flag for `gitnexus serve` to serve the viewer live (Path B from spike)

## Affected components

| Component | Change |
|-----------|--------|
| `gitnexus/src/cli/index.ts` | Register new `view` command |
| `gitnexus/src/cli/view.ts` | New file: command entry point |
| `gitnexus/src/core/graph/html-graph-viewer.ts` | New file: HTML generator (follows `html-viewer.ts` pattern) |
| `gitnexus/src/server/api.ts` | Reuse `buildGraph()` — no changes needed |

## Trade-offs

| Option | Pro | Con |
|--------|-----|-----|
| Self-contained HTML (Path A, chosen) | No server, no port conflict, shareable file | Static snapshot; must re-run to update |
| Serve from `gitnexus serve` (Path B) | Live updates via poll | Requires server running |
| Terminal rendering | No browser needed | Unusable for large graphs |
