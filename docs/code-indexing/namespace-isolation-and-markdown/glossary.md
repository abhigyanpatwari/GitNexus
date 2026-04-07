# Glossary: Unified Terminology (Namespace Isolation & Markdown)

| Term | Meaning | Scope / Context | View Details |
|------|---------|-----------------|--------------|
| **GitBoundary** | A directory containing hidden files or a `.git` directory, considered as an independent Repository isolation unit. | Ingestion Pipeline | `git-namespace-detector.md` |
| **Deepest-Wins** | The algorithm for matching string based on path depth. A file with path `/A/B/C` will match the boundary `/A/B` first, before falling back to boundary `/A` or root. | Ingestion Pipeline | `detector.md` |
| **AST** | Abstract Syntax Tree - A data structure framework simulating Text format into a logical structure tree of code/markdown. | Parser | `parser.md` |
| **Section Node** | Term indicating the Node used to encapsulate Heading content groups (h1, h2, h3) within the Graph. | Knowledge Graph | `markdown-processor.md` |
| **Pseudocode Tracking** | The act of an Agent reading a fake code block (used only for documentation), parsing it, and using the Graph to trace (like a `CALLS` Edge) to the actual code function being described. | Knowledge Graph | `markdown-processor.md` |
| **Reciprocal Rank Fusion (RRF)** | An algorithm for fusing indices from multiple Search Engines (BM25 and Semantic) without worrying about the score scaling ratio of each engine, only caring about the rank. | Search Engine | `hybrid.md` |
| **BM25 / FTS** | The fundamental exact-match text search algorithm, finding exact character sequences. Distinct from RAG. | Search Engine | `hybrid-search.md` |
| **Namespace Over-fetching** | The RAG Agent error of accessing a component's documentation and pulling in identically named documentation residing in another component belonging to a second git repository. | System Context | `system-context.md` |
