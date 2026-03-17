# Code Complexity Metrics

GitNexus computes code complexity metrics during ingestion to identify hotspots and coupling issues.

## Metrics Computed

| Metric | Description | Calculation |
|--------|-------------|-------------|
| **Cyclomatic Complexity (CC)** | Number of independent paths through code | Count of decision points (`if`, `for`, `while`, `switch`, `&&`, `\|\|`, `?:`) + 1 |
| **Fan-In** | How many functions call this one | Count of incoming `CALLS` edges |
| **Fan-Out** | How many functions this one calls | Count of outgoing `CALLS` edges |
| **Instability** | Tendency to change | `fanOut / (fanIn + fanOut)` — 0 = stable, 1 = unstable |
| **LOC** | Lines of code | `endLine - startLine + 1` |

## Complexity Ranks

| Rank | CC Range | Color | Interpretation |
|------|----------|-------|----------------|
| 🟢 Low | 1–5 | Green | Simple, easy to test |
| 🟡 Medium | 6–10 | Yellow | Moderate complexity |
| 🟠 High | 11–20 | Orange | Consider refactoring |
| 🔴 Critical | 21+ | Red | High risk, hard to maintain |

## How It Works

1. **AST Traversal** — During ingestion, each function/method's AST is traversed to count decision nodes
2. **Language-Aware** — Uses Tree-sitter node types specific to each language (JS/TS, Python, Go, Rust, Java, C/C++)
3. **Graph Analysis** — After CALLS edges are built, fan-in/fan-out are computed from the knowledge graph
4. **Stored on Nodes** — Metrics are stored as properties on Function/Method nodes

## UI Features

- **Metrics Tab** — Right panel tab showing hotspots sorted by complexity
- **Heatmap Toggle** — 🔥 button in graph canvas colors nodes by complexity rank
- **Filters** — Filter by rank (critical/high/medium/low), sort by CC/fan-in/fan-out/instability

## AI Tool

Ask the AI agent:
- "Show me the most complex functions"
- "Which functions have high coupling?"
- "Find critical hotspots"

The `metrics` tool returns a summary table with emoji-coded ranks.

## Pipeline Phase

Metrics are computed in **Phase 9** of the ingestion pipeline, after:
- Parsing (Phase 3)
- Call graph resolution (Phase 5)
- Community detection (Phase 7)
- Process detection (Phase 8)

---

## References

- [Cyclomatic Complexity (Wikipedia)](https://en.wikipedia.org/wiki/Cyclomatic_complexity)
- [Software Package Metrics](https://en.wikipedia.org/wiki/Software_package_metrics)
