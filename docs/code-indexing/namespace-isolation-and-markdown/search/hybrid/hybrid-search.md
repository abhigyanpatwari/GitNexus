# Code Level: Hybrid Search Mechanism

**File Target:** `gitnexus/src/core/search/hybrid-search.ts`

This Code-Level L4 document dissects the source code undertaking the heavy burden of processing multi-paradigm search (BM25 Keyword + Semantic Embeddings) paired with the namespace filtering unique to the RAG engine.

## 1. Rank RRF Algorithm Analysis (`mergeWithRRF`)

### Signature
```typescript
export const mergeWithRRF = (
  bm25Results: BM25SearchResult[], 
  semanticResults: SemanticSearchResult[], 
  limit: number = 10
): HybridSearchResult[]
```

### Purpose
Coalesces 2 isolated graph rank lists (One from FTS KuzuDB, One from Vector Embeddings) melding them into 1 ultimate overarching list without necessitating score range normalization.

### Data Flow (Processing Logic)
**RRF Strategy (Reciprocal Rank Fusion):**
Adopts the constant `RRF_K = 60` (Globally standardized in Data Retrieval including Elasticsearch):
`rrfScore = 1 / (RRF_K + rank);` Where `rank` equates the placement 1, 2, 3...

1. Instantiates mapping `merged = new Map()`.
2. O(N) iteration sweeping BM25 outcomes. Upon emerging at the `i`-th position, translates into the `RRF` formula. Ingests into the Map.
3. O(N) iteration sweeping Semantic outcomes. Should the filepath already inhabit the Map courtesy of BM25 -> CUMULATIVELY ADDS the `rrfScore` value (Empowering immense gravity weights for Nodes duplicated across both search engines). If absent, inserts anew.
4. Resorts (`sort`) the Final List derived from the Map leaning on the accumulated RRF score garnered. Plucks the top `limit`. Transmits back the Array indexed by `rank` per the newly established hierarchy.

### Over-fetching Mitigation via Map:
When Semantic supplants the existing File, the script actively appends metadata flags `nodeId`, `label`, `startLine` acquired from Semantic to compensate for the innate deficiencies of the BM25 library (which habitually supplies exclusively Keywords).

---

## 2. Orchestration Analysis: `hybridSearch`

### Signature
```typescript
export const hybridSearch = async (
  query: string,
  limit: number,
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (execute: (...), query: string, k: number) => Promise<SemanticSearchResult[]>,
  gitNamespace?: string
): Promise<HybridSearchResult[]>
```

### Purpose
Component running dual computations synchronously, embedding the `gitNamespace` param to thoroughly eradicate cross-repo results.

### Namespace Blocking (RAG Isolation)
The `gitNamespace` param (if existent, procured by caller from `resolveGitNamespace`), routes straight into the params argument of `searchFTSFromLbug()`. 
Simultaneously, the interpolation function `semanticSearch` is structurally programmed with a Cypher query absorbing the `git_namespace` field amid the Node Properties WHERE Clause to quarantine Vectors. 

Blocking right at the genesis (Query Execution) decisively outperforms blocking (Filtering) post-JS Fetching, assisting in retaining the pristine magnitude of `limit` unaffected by deficit.
