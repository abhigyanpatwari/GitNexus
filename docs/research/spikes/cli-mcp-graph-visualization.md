# Spike: Graph Visualization via CLI-MCP (no WebAssembly)

**Status:** Concluded
**Date:** 2026-02-22
**Type:** Spike — "Can this work technically?"
**Feature:** CLI-driven graph visualization without the `gitnexus-web` WebAssembly bundle

---

## Question

Can we render the GitNexus knowledge graph in the browser without the `gitnexus-web`
WebAssembly ingestion pipeline, driven purely from the CLI-indexed data?

---

## Context

Today there are two ways to visualize the graph:

| Path | Where | WebAssembly? | Requires |
|------|-------|-------------|----------|
| `gitnexus-web` browser app | `gitnexus-web/` | Yes (tree-sitter for in-browser parsing) | Full React bundle + WebGPU |
| `gitnexus serve` HTTP API | `gitnexus/src/server/api.ts` | No | Running server at `:4747` |

The WebAssembly dependency is **only for in-browser ingestion** (parsing source code without
the CLI). If the graph is already indexed via `gitnexus analyze`, the WebAssembly path is
never needed — the data is already in KuzuDB.

The `gitnexus-web` app can connect to `localhost:4747/api/graph` to fetch the pre-indexed
graph, but the WebAssembly ingestion bundle is still shipped as part of the app.

---

## Findings

### 1. `buildGraph()` already exists and returns the full graph

**File:** `gitnexus/src/server/api.ts:20`

```ts
const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }>
```

Iterates all `NODE_TABLES` in KuzuDB and fetches all `CodeRelation` edges. Returns a
plain `{ nodes, relationships }` object — ready to embed in HTML or serve over HTTP.

### 2. `GET /api/graph` is already exposed

**File:** `gitnexus/src/server/api.ts:103`

```
GET /api/graph → { nodes: GraphNode[], relationships: GraphRelationship[] }
```

The `gitnexus serve` command (port 4747) starts this HTTP server. Any HTML page with
JavaScript can `fetch('/api/graph')` and render the graph with a CDN-hosted renderer.

### 3. The self-contained HTML pattern already exists

**File:** `gitnexus/src/core/wiki/html-viewer.ts:21`

`generateHTMLViewer()` shows the exact pattern:
- Load data from disk
- Embed as JSON variables inside a `<script>` block
- Serve CDN JS (marked + mermaid) from `cdn.jsdelivr.net`
- No build step, no bundler, no WebAssembly

A graph viewer can use the same approach with **Sigma.js** or **D3.js** from CDN.

### 4. `gitnexus serve` command already exists

**File:** `gitnexus/src/cli/serve.ts` → `gitnexus/src/cli/index.ts:34`

```
gitnexus serve [--port 4747]
```

Starts the HTTP API. A lightweight HTML viewer could be served from this same process
(static file) and open automatically in the browser.

### 5. No MCP resource for raw graph data exists yet

The MCP server (`gitnexus/src/mcp/server.ts`) exposes tools and text/YAML resources.
There is no `gitnexus://repo/{name}/graph` resource or `export_graph` tool.
Adding one would let any MCP client consume nodes + edges directly.

---

## Three viable paths

### Path A — `gitnexus view` command (self-contained HTML, no server)

**Effort:** Low
**Dependencies:** None beyond what exists

1. New CLI command `gitnexus view`
2. Calls `buildGraph()` directly (same as `GET /api/graph` does)
3. Embeds `{ nodes, relationships }` as JSON in a self-contained HTML file (follow `html-viewer.ts` pattern)
4. Uses Sigma.js or D3.js force graph from CDN — no WebAssembly, no bundler
5. Writes to `.gitnexus/graph.html` and opens it with `open`/`xdg-open`

**Verdict:** ✅ Fully feasible. The machinery is all in place.

### Path B — `gitnexus serve` + lightweight static viewer

**Effort:** Low
**Dependencies:** Server must be running

1. `gitnexus serve` starts HTTP API on `:4747`
2. Serve a lightweight `graph.html` from the same Express process (one `app.use(express.static(...))` line)
3. HTML does `fetch('/api/graph')` and renders with Sigma.js/D3 from CDN
4. Add `--open` flag to `gitnexus serve` to launch browser automatically

**Verdict:** ✅ Feasible. Better for live updates (can poll `/api/graph`).

### Path C — MCP `graph` resource

**Effort:** Very low
**Dependencies:** None

Add `gitnexus://repo/{name}/graph` resource to `gitnexus/src/mcp/resources.ts` returning
`buildGraph()` output as JSON. Useful for AI agent clients but not for human-facing visualization.

**Verdict:** ✅ Feasible and complementary to A/B. Not a standalone visualization.

---

## Recommendation

**Build Path A first** (`gitnexus view`):
- Zero runtime dependencies (no server, no port conflict)
- Single command: `gitnexus view` → opens browser
- Directly analogous to `gitnexus wiki` which generates a self-contained HTML viewer
- Can be extended to Path B later by serving the file from `gitnexus serve`

**Add Path C** alongside A as a low-cost MCP resource for agent consumers.

---

## Key files

| File | Role |
|------|------|
| `gitnexus/src/server/api.ts:20` | `buildGraph()` — full graph from KuzuDB |
| `gitnexus/src/server/api.ts:103` | `GET /api/graph` endpoint |
| `gitnexus/src/core/wiki/html-viewer.ts:21` | Pattern for self-contained HTML |
| `gitnexus/src/cli/serve.ts` | `gitnexus serve` command |
| `gitnexus/src/cli/wiki.ts` | `gitnexus wiki` — analogous CLI command |
| `gitnexus/src/mcp/resources.ts` | Where to add Path C resource |
| `gitnexus/src/cli/index.ts` | Where to register new `view` command |

---

## Conclusion

**Yes, it works.** The full graph data is already accessible from KuzuDB via `buildGraph()`.
The only missing piece is an HTML renderer that consumes it without WebAssembly.
Effort is low because the pattern, the data layer, and the HTTP server all exist.
