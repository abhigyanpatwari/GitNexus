# 01 — Product Statement

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)
**Status:** Draft
**Date:** 2026-02-22

---

## One-liner

Add a `gitnexus view` command that opens a self-contained, browser-based graph visualization
driven entirely from the CLI-indexed data — no WebAssembly, no running server required.

## Goals

- A developer runs `gitnexus view` and sees their codebase knowledge graph in the browser
  within seconds, from any terminal, with no prerequisites beyond a prior `gitnexus analyze`
- The visualization reads from the existing KuzuDB index — zero re-ingestion
- No WebAssembly ingestion pipeline in the render path

## Non-goals

- Replacing `gitnexus-web` (the full interactive app with in-browser ingestion)
- Real-time graph updates (static snapshot is sufficient for v1)
- Editing or querying the graph from the viewer

## Proposal status

Spike concluded: `docs/research/spikes/cli-mcp-graph-visualization.md`
→ Technically feasible. Recommended path: self-contained HTML file (Path A).
