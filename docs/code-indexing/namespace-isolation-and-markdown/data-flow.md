# Data Flow Process: From File System to RAG Response

**Cross-Cutting Documentation**

This document details the data journey traversing through both Containers (Ingestion Engine and Search Engine).

## Phase 1: Ingestion Pipeline (Isolation Initialization)

### Step 1: Detector Scanning
- **Entry:** `buildGitNamespaceMap(repoPath)`
- **Source:** Local disk at the project root directory.
- **Process:** Scans and detects 2 `.git` directories (Root and `libs/utils`).
- **Data shape returned:** `{ boundaries: ["libs/utils", ""], namespaces: Map("libs/utils" -> "repo/libs/utils", "" -> "repo") }`

### Step 2: Markdown Parsing
- **Entry:** `processMarkdown(graph, files, namespaceMap)`
- **Source:** Text content (`# Heading 1 \n \n Code here`).
- **Process:** Translates into AST. Heading => Creates `Section` Node. Code block => Creates `CodeElement` Node.
- **Data shape transformation:** Nodes are tagged with metadata right before Insertion into the Graph.
  ```json
  {
    "id": "Section-123",
    "properties": {
      "name": "heading-1",
      "git_namespace": "repo/libs/utils" 
    }
  }
  ```

## Phase 2: Search Arbiter (RAG Selection)

### Step 3: Client Query Calling
- **Entry:** Agent dispatches the flag `gitnexus_query(query: "auth token", git_namespace: "repo")`

### Step 4: Query Splitting
- **Entry:** `hybridSearch()`
- **Process 1 FTS:** KuzuDB FTS query forcibly appends `WHERE git_namespace = 'repo'`.
- **Process 2 Vector:** Semantic Embeddings query executes the equivalent filter on KuzuDB or Pinecone.

### Step 5: Hybrid RRF Fusion
- **Entry:** `mergeWithRRF()`
- **Source:** Retrieves the 2 result arrays from Step 4.
- **Process:** `score = sum(1 / (60 + rank))`. Nodes containing mismatched namespace tags that were blocked in Step 4 no longer have a chance to enter here.
- **Data shape returned to LLM:** Summarized text of files matching the highest hybridSearch scores.
