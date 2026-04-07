# ADR-001: KuzuDB Schema Modifications to support Git Namespace and Section Edge

## Status: ACCEPTED (2026-04-06)

## Context
KuzuDB is presently utilized as the Knowledge Graph backend of GitNexus.
While conducting the merger of 2 features: Namespace Isolation and Markdown Integration (V3 Architecture), we stumbled upon 2 severe technical thresholds.
1. The KuzuDB `GraphNode` Table currently lacks a distinct property field for blocking queries according to source code perimeters. The LLM Agent suffers from over-fetching when Semantic RAG searches the sprawling BM25 spectrum across the Monorepo.
2. Exploiting the `OR` logic operator inside KuzuDB's `WHERE` function triggers profoundly high performance latency when scouring tens of thousands of `CONTAINS`, `DEFINES` Edges.

## Decision
We approve the following 2 alterations, notwithstanding the bulkiness of a Database Migration:

**1. Mutate GraphNode Schema:**
Amplify the `GraphNode` table by appending the string property field `git_namespace` (if null, defaults to the root repo name). `Section` and `CodeElement` nodes upon initialization at the `markdown-processor` must fetch the value from the `resolveGitNamespace` algorithm.

**2. UNION ALL Strategy on KuzuDB Query execution:**
Shatter the query from an OR structure (prone to coaxing Full Table Scans) into a multitude of independent sub-query statements, then bind them back together utilizing Union All.

*Poor (Old):*
```cypher
MATCH (a)-[r:CodeRelation]->(b) 
WHERE r.type = 'CONTAINS' OR r.type = 'DEFINES' 
RETURN a
```

*Approved (Decided):*
```cypher
MATCH (a)-[r:CodeRelation {type: 'CONTAINS'}]->(b) RETURN a
UNION ALL
MATCH (a)-[r:CodeRelation {type: 'DEFINES'}]->(b) RETURN a
```

## Consequences (Trade-offs / Aftermath)

* Upsides:
  * Hybrid search speed (combined with BM25) skyrockets incredibly fast due to the glued, parallelly running cypher UNION ALL pipelines.
  * The RAG is exhaustively contained, outright forbidding the Agent from perceiving erroneous context.

* Risks:
  * All legacy data is obliterated. Upon applying this update, the Client must be forced to run the terminal `npx gitnexus analyze --embeddings` to scrape and re-parse the entire AST and rebuild the Vectors from outright scratch.
