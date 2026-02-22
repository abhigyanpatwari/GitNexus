# 04 — Architecture Decision Records

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)

---

## ADR-001: Self-contained HTML over live server

**Status:** Accepted
**Date:** 2026-02-22

**Context:** Three rendering paths were evaluated in the spike (see `docs/research/spikes/cli-mcp-graph-visualization.md`).

**Decision:** Use a self-contained HTML file (Path A) rather than serving from `gitnexus serve` (Path B).

**Consequences:**
- (+) Zero runtime dependency — no port, no server process, no `gitnexus serve` running
- (+) The file is shareable / committable as a snapshot artifact
- (+) Directly analogous to `gitnexus wiki` — same UX pattern, easier to maintain
- (-) Static snapshot; must re-run `gitnexus view` to reflect new analysis
- (-) Cannot poll for live updates in v1

---

## ADR-002: CDN-hosted renderer (Sigma.js) over bundled renderer

**Status:** Accepted
**Date:** 2026-02-22

**Context:** The graph renderer (Sigma.js or D3.js) must be loaded in the HTML viewer.
Options: bundle it inline (large HTML, no CDN dependency) or load from CDN.

**Decision:** Load from `cdn.jsdelivr.net` — same approach as the wiki viewer (marked + mermaid).

**Consequences:**
- (+) Keeps generated HTML small
- (+) Consistent with existing `html-viewer.ts` pattern — no new infrastructure
- (-) First open requires internet; subsequent opens use browser cache
- (-) CDN version pinning required to avoid breaking changes (pin to semver minor)

**Renderer choice:** Sigma.js v3 — already referenced in `gitnexus-web/src/lib/graph-adapter.ts`
(`SigmaNodeAttributes`, `SigmaEdgeAttributes`). Reuses familiarity with the existing web app.

---

## ADR-003: Reuse `buildGraph()` without modification

**Status:** Accepted
**Date:** 2026-02-22

**Context:** `buildGraph()` in `gitnexus/src/server/api.ts:20` queries all node tables and
all `CodeRelation` edges from KuzuDB. It was written for the HTTP API but contains no
HTTP-specific logic.

**Decision:** Import `buildGraph()` directly in the new `view` command. Do not duplicate
the query logic.

**Consequences:**
- (+) Single source of truth for graph data shape
- (+) No code duplication
- (-) `buildGraph()` is currently not exported — needs `export` keyword added (one-line change)
