# Code Level: Git Namespace Detector Unit Tests

**Level:** L4 (Code)
**File:** `gitnexus/test/unit/git-namespace-detector.test.ts`
**Target Component:** [Git Boundary Detector](../ingestion/git-detector/detector.md)

This L4 document intrinsically describes the architecture of the Unit Tests safeguarding the Git Namespace boundary detection algorithm.

## 1. Mock Environment Initialization

### `createMockMap(): GitNamespaceMap`
- **File:** `git-namespace-detector.test.ts:L16`
- **Purpose:** Constructs a simulated data structure of a tangled Monorepo harboring Sub-repositories.
- **Data flow:**
  - Defines 3 boundaries: `DOCS/RESEARCH/poc/reference/GitNexus`, `DOCS/RESEARCH/poc/reference/browser-use`, and the root directory `''`.
  - Simulates the completion of Node file system crawling to inject into the detector.

## 2. Unit Tests for `resolveGitNamespace`

Secures the seamless execution of the Deepest-Wins algorithm, averting erroneous Boundary recognition.

### `[UT-NS-01] should resolve file in nested repo to deepest boundary`
- **Line:** L32
- **Purpose:** Injects a profoundly long file path, verifying the function returns exactly the "deepest" boundary (`GitNexus`) instead of defaulting to the root.

### `[UT-NS-02] should handle Windows backslash paths`
- **Line:** L48
- **Purpose:** Windows utilizes `\` rather than `/`. The algorithm is strictly obligated to normalize the string prior to equating Deepest-Wins.

### `[UT-NS-03] should not cross-match sibling boundaries`
- **Line:** L42
- **Purpose:** A file belonging to the `browser-use` repository is absolutely forbidden to throw out the word `GitNexus`, but must steadfastly retain `browser-use`. Guarantees absolute independence among sibling-repositories.

### `[UT-NS-04] should pick the deepest boundary in 3-level nesting`
- **Line:** L92
- **Purpose:** Challenges the algorithm with a web of 3 nested roots: Root -> `repos/outer` -> `repos/outer/inner`. Compels the function to land exactly in `inner` rather than getting stuck in `outer`.

## 3. Unit Tests for `buildNamespaceHint`

This function is utilized to render notifications for users when query results span across multiple disparate repos.

### `[UT-NS-05] should return hint when results span multiple namespaces`
- **Line:** L129
- **Purpose:** When the LLM initiates Fetching and entangles 2 separate namespaces, the Hint Builder must aggregate the count of each namespace and output the text Warning "2 git-namespaces".

### `[UT-NS-06] should return null when all results from same namespace`
- **Line:** L120
- **Purpose:** If the acquired LLM knowledge is entirely secure (belonging to 1 single repo), the Hint Builder must remain silent (`return null`) to prevent wasting superfluous Tokens.
