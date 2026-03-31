# Draft: Gitnexus Brainstorming - Clustering & Process Maps

## Initial Context

- Project: **GitnexusV2**
- Structure:
  - `gitnexus/` (Likely the core application)
  - `gitnexus-mcp/` (Likely a Model Context Protocol server)
- Goal: Make it accurate and usable for smaller/dumber models.
- Current Focus: Implementing **Clustering** and **Process Maps**.

## Findings

- **Clustering**: Found `gitnexus/src/core/ingestion/cluster-enricher.ts`.
- **Process Maps**: No files matched `*process*map*` yet. Searching content next.

## Open Questions

- How is "process map" defined in this context? (Graph, mermaid diagram, flowchart?)
- What is the input for clustering? (Code chunks, files, commits?)
- What is the intended output for "smaller models"? (Simplified context, summaries?)
