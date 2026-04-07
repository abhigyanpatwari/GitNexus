# Component Level: Hybrid Search Mechanism

**Container:** Search Engine
**Module Code:** `hybrid-search.ts`

This L3 document outlines the internal structure of the Hybrid Search block - the paramount Component responsible for dictating which result (from the Graph or FTS) will be injected into the Agent's brain.

## Responsibility

1. **RRF Fusion:** Fuses ranking from BM25 search (specializing in Keyword/Syntax) with Semantic Embedding (specializing in Concept/Intent). RRF (Reciprocal Rank Fusion) abstains from normalizing scores to avoid scale distortion, computing sums iteratively by rank.
2. **Namespace Segregation:** Intake of the `git_namespace` parameter (supplied by Git Boundary Detector) establishes an absolute boundary permitting RAG, safeguarding the Agent from confusing distinct modules spanning different repos.

## Public API & Interfaces

- `mergeWithRRF(bm25Results, semanticResults, limit)`: Returns `HybridSearchResult[]`.
- `hybridSearch(..., gitNamespace)`: Async API wrapper.

## Internal Logics

**Industry-Standard RRF Algorithm:**
`score = 1 / (60 + rank)`

With K = 60. The assignment of 60 is deliberate; it is a meticulously researched constant across labs (like Elasticsearch) proven optimal to avoid overly penalizing mediocre-ranking results that concurrently appear in both scoreboards.

The `mergeWithRRF` iteration leverages `Map<string, HybridSearchResult>` keyed by `filePath`. Complexity plunges from O(N*M) down to O(N) because BM25 is thrown into the Map first, letting Semantic simply execute an O(1) `.get(filePath)` to accumulate the RRF.

## Dependencies

- **Depended by:**
  - **`mcp/tools.ts`** (Utilized for the `gitnexus_query` tool).
- **Depends on:**
  - The `bm25-index.ts` block (KuzuDB FTS connection)
  - Embedding Engine block (Provisioning Vectors).
