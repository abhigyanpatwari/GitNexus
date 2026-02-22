# 05 — Open Questions & RFCs

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)

---

## Open questions

### Q1: Large graph performance threshold
The `--filter <cluster>` flag is proposed for repos >1500 symbols. What is the actual
threshold where Sigma.js ForceAtlas2 becomes unusable? Needs measurement on a large repo.

**Resolution needed before:** implementation of R6

### Q2: `buildGraph()` export — breaking change?
`buildGraph()` is currently a module-internal `const`. Exporting it is a one-line change,
but we should confirm no other module relies on it being private.

**Resolution:** Run `gitnexus impact --target buildGraph` before the change.
(Easy — already has the tool for this.)

### Q3: Node filtering — which node types to show by default?
`buildGraph()` returns all node types including `Folder`, `Community`, and `Process` nodes.
For the graph viewer, showing `Community` and `Process` nodes alongside `Function`/`Class`
may clutter the view.

**Proposed default:** Show `Function`, `Class`, `Interface`, `Method`, `File`.
`Community` and `Process` nodes available via `--show-meta` flag.

**Resolution needed before:** implementation of R3/R4

---

## Deferred to v2

- **Path B:** `--open` flag for `gitnexus serve` to serve the viewer live with polling
- **Path C:** `gitnexus://repo/{name}/graph` MCP resource for agent consumers
- **Search/filter within viewer:** filter nodes by cluster or name in the browser
- **Offline CDN bundle:** option to embed Sigma.js inline for air-gapped environments
