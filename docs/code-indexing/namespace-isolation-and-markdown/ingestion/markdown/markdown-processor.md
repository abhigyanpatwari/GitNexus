# Code Level: Markdown Knowledge Graph Processor

**File Target:** `gitnexus/src/core/ingestion/markdown-processor.ts`

This document models how the Markdown Parser processor reads text documents, breaks them down, and synchronously establishes them into the Knowledge Graph using the V3 Architect communication standard.

## 1. Analysis of `processMarkdown`

### Signature
```typescript
export const processMarkdown = (
  graph: KnowledgeGraph, 
  files: MdFile[], 
  allPathSet: Set<string>, 
  namespaceMap?: GitNamespaceMap
): { sections: number; links: number; pendingResolutions: PendingResolution[] }
```

### Purpose
Converts markdown documents (`.md`, `.mdx`) across the entire project into `Section` nodes and `CodeElement` nodes (for code blocks) to load into the graph database. This is the foundation allowing the LLM to read document files and understand their correlation with the actual source code.

### Data Flow (Processing Logic)

**Step 1: AST (Abstract Syntax Tree) Initialization**
Uses the `unified` and `remarkParse` packages to compile primitive Text into mdast (Markdown AST). 

**Step 2: Heading Processing (Structural Segmentation)**
- Retrieves all `heading` type Nodes.
- Calculates coordinates (StartLine). EndLine is determined by measuring the distance until colliding with the next Heading of equal or higher level (e.g., h2 ends when encountering an h1 or the next h2).
- Creates a `Section` type node on the graph. The loop uses `sectionStack` to attach the `CONTAINS` relationship from parent down to child.

**Step 3: Code Blocks Processing (Pseudocode Tracking)**
- Node `code` on the markdown tag is turned into a `CodeElement` with the flag `isPseudocode = true`.
- Regex `defPattern` and `callPattern` are applied to the text portion of the sample source code (pseudocode) to extract EVERY FUNCTION NAME outlined manually by the user.
- The Graph connects this `CodeElement` (code blocks) block as a child of the `Section` (the closest heading enveloping that code block).

**Step 4: Edge Establishment (Relationships)**
- `IMPORTS`: Processes markdown Link tags (`[link](url)`). Maps relative URLs to file IDs and points `IMPORTS` from that `Section` to the other `File`.
- `CALLS`: From the functions array extracted in Step 3, establishes `CALLS` edges linking logics internally together, maintaining the `stepCounter` value (execution order tracking).
- CALLS commands pointing outside the document (not present in `docSymbolTable`) will be extracted and pushed into the `pendingResolutions` array waiting for the resolver to process in the final phase.

### Dependencies
- **Imports:** `unified`, `remarkParse`, `visit` from `unist-util-visit`. Integrates with `resolveGitNamespace` from `git-namespace-detector.ts`.
- **Calls:** `generateId()`, `graph.addNode()`, `graph.addRelationship()`.

---

## 2. Anti-Hallucination Technique (Exclusions List)

Inside the function lies a localized `EXCLUDE_CALLS` set strictly filtering out pure JS keywords (e.g. `console`, `Object`, `Date`, `if`, `when`) preventing them from forming `CALLS` Edges. Reason: Prevents the graph from suffering "Noise Contamination" when thousands of code lines all point to a Node named `if`.
