# Code Level: Git Namespace Detector

**File Target:** `gitnexus/src/core/ingestion/git-namespace-detector.ts`

This document details the technical aspect (source code level) of the processing functions that detect and delineate git namespace boundaries within the GitNexus system.

## 1. Analysis of `buildGitNamespaceMap`

### Signature
```typescript
export async function buildGitNamespaceMap(repoPath: string): Promise<GitNamespaceMap>
```

### Purpose
Scans the entire repository root directory to find `**/.git`. This involves tracking `.git` directories of submodules and establishing a Map for subsequent resolution.

### Data Flow (Processing Logic)
1. Determines `repoName` using `path.basename(repoPath)`.
2. Uses the `glob` library with the query `**/.git` (setting `dot: true` to scan hidden files).
3. Iterates through the result array:
   - Root `.git` (equivalent to `parentDir === '.'`) is bypassed in the loop but is always manually added with the default namespace as the `repoName`.
   - Other `.git` instances (e.g., `lib/auth/.git`) will form a boundary record (`lib/auth` mapping to `repoName/lib/auth`).
4. **Depth Sorting:** The `boundaries` array is sorted by decreasing path length (deepest first), while the root repo's empty string `''` stands last. This is the core to executing the `Deepest-Wins` algorithm.

### Dependencies
- **Imports:** `glob`, `path`.
- **Calls:** `glob()`, `path.basename()`, `path.dirname()`.

---

## 2. Analysis of `resolveGitNamespace`

### Signature
```typescript
export function resolveGitNamespace(filePath: string, namespaceMap: GitNamespaceMap): string
```

### Purpose
Converts a relative internal filepath into a complete `git_namespace` name space, serving the purpose of tagging AST Nodes to prevent RAG Context Leakage.

### Data Flow (Processing Logic)
1. Normalizes `filePath` to the standard `/` instead of `\` (Windows support).
2. Iterates over the `namespaceMap.boundaries` array (the array already sorted by `buildGitNamespaceMap` according to Deepest-Wins criteria).
3. If the file path starts with `boundary + '/'` (meaning it resides inside that boundary directory), immediately return the corresponding `namespace` in the Map.
4. The final fallback is the root repository (`''`).

---

## 3. Analysis of `buildNamespaceHint`

### Signature
```typescript
export function buildNamespaceHint(
  results: Array<{ git_namespace: string }>,
  namespaceMap: GitNamespaceMap
): NamespaceHint | null
```

### Purpose
Protects the End-User Experience when they execute a RAG Query without specifying a `git_namespace`. 

### Data Flow (Processing Logic)
1. Iterates all returned results (`results`), counting the occurrences of different namespaces.
2. If `resultsByNamespace.size <= 1` (results are confined to 1 repo), returns null (no hint needed).
3. If greater than 1 (risk of RAG Hallucination/Leakage when over-fetching), the function returns a `NamespaceHint` object containing:
   - `warning`: A warning regarding the number of cross-context namespaces.
   - `available_namespaces`: The list of available namespaces for the user (or LLM agent) to select again (recreating the query with narrowed parameters).
   - `results_by_namespace`: Chart/metrics counting the result distribution.
