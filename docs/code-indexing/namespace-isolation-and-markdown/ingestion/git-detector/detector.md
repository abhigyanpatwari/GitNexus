# Component Level: Git Boundary Detector

**Container:** Ingestion Pipeline
**Module Code:** `git-namespace-detector.ts`

The Component Level document describes the overall logic flow of the Git Boundary Detector block in partitioning the Codebase architecture into multiple parallel virtual spaces while preventing knowledge spillage (RAG Isolation).

## Responsibility

This component is responsible for:
1. **Boundary Mapping Initialization:** Pre-calculates the source code regions belonging to nested git repositories (Submodules/Monorepos).
2. **Dynamic Resolution:** Processes thousands of filepath queries per second during the source code parsing phase to identify every AST object (Functions, Classes, Sections).
3. **Hallucination Defense:** Returns Metadata/Hints that block accidental RAG queries from crossing repository borders.

## Public API & Interfaces

- `buildGitNamespaceMap(repoPath)`: The initial setup function, returning `GitNamespaceMap`.
- `resolveGitNamespace(filePath, map)`: The Gateway, receiving a path -> returning the `git_namespace` string.
- `buildNamespaceHint(results, map)`: The Bridging connection helping the Hybrid Search engine provide hints to narrow the scope.

## Internal Logics

The focal algorithm of this Component is **Deepest-Wins Routing**:
- A Repository Root might contain `libs/parser` (Git Submodule 1) and `libs/parser/tests` (Git Submodule 2).
- If greedy top-down matching is used, a file `libs/parser/tests/main.test.ts` would be mistakenly identified as belonging to `libs/parser`.
- Deepest-Wins forces the component to sort the boundaries array by depth (`/` counts length). `libs/parser/tests` will be checked before `libs/parser`.

## Dependencies

- **Depended by:**
  - **`markdown-processor.ts`** (Uses `resolveGitNamespace` to tag Heading tags).
  - **`call-processor.ts`, `class-processor.ts`** (Tags Code elements).
  - **`hybrid-search.ts`** (Uses `buildNamespaceHint`).
- **Depends on:**
  - OS File System (`glob` library) to read `.git` structure.

## Data Contracts (Transmission Structure)

```typescript
interface GitNamespaceMap {
  boundaries: string[]; // ['A/B/C', 'A/B', 'A', '']
  namespaces: Map<string, string>; // 'A/B' -> 'root-repo/A/B'
}
```
