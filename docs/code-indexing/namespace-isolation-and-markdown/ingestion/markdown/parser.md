# Component Level: Markdown AST Parser & Ingester

**Container:** Ingestion Pipeline
**Module Code:** `markdown-processor.ts`

This document summarizes the operational logic of the Markdown Processor component responsible for translating and loading human-written documents (Design Docs, Specs) into the unified Knowledge Graph reference system.

## Responsibility
This component holds the "Bridging Layer" role between natural language and source code structure:
1. **Chunking (Divide and Conquer):** Does not load the entire massive text file into the Graph. Tears them down into `Section` nodes based on the Hierarchy level of the Heading (h1, h2, h3).
2. **Pseudocode Extraction (Simulation Engineering):** Automatically retrieves Code Block blocks (`\````), delves to extract function calls inside that simulated block, and from there links to the actual function.
3. **Cross-Link Resolution:** Transforms Hyperlink tags (`[click here](./other-doc.md)`) into Semantic Vector configurations connecting two disconnected documents.

## Public API & Interfaces

- `processMarkdown(graph, files, allPathSet, namespaceMap)`
  - Input: Array of objects containing text content (`files`).
  - Output: Metrics (total sections, links) and the `pendingResolutions` Array (Symbols detected in the algorithm but whose source file location is yet unknown).

## Internal Logics

### AST Parsing Architecture
- Tools: `unified` + `remarkParse`
- Operation: Inputs String `"# Title \n content"` into Parser -> Tree Node -> Scans via Visitor Pattern -> Emits Graph Nodes.

### Structural Rules Logic (Per GitNexus Design)
1. **Rule §1.2.1:** From `File` -> `Section` -> `CodeElement`. The Relationship must inherently carry the `CONTAINS` nature.
2. **Rule §1.2.2:** From this `Section` Markdown Linking to another `File`, the Relationship must be `IMPORTS`.
3. **Rule §1.2.3:** A call command within the simulated Code block body will generate a `CALLS` relationship looping directly to other Pseudocode blocks, or load into the Queue for `call-processor.ts` resolving.

## Dependencies

- **Depended by:**
  - **`pipeline.ts`** (The root Ingestion Pipeline, calls this processor at Phase 1 Extractor).
- **Depends on:**
  - OS File System (via params).
  - External Libs: `unified`, `remarkParse`, `mdast`.
  - Internal components: `git-namespace-detector.ts` (to segment git boundary metadata).
