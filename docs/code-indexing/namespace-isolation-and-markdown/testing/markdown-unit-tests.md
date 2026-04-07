# Code Level: Markdown Pseudocode Unit Tests

**Level:** L4 (Code)
**File:** `gitnexus/test/unit/markdown-pseudocode.test.ts`
**Target Component:** [Markdown AST Parser](../ingestion/markdown/parser.md)

This L4 document extensively analyzes the test case system shielding the Markdown Parser engine, which dictates whether Code blocks and Headings can successfully morph into Knowledge Graph Nodes.

## 1. Environment Setup (Helpers)

### `setupAndProcess(filePath: string, content: string)`
- **File:** `markdown-pseudocode.test.ts:L10`
- **Purpose:** Encapsulates the process of creating an empty Graph -> Creating a File Node -> Forcing the execution of `processMarkdown()` into a singular function to minimize code duplication (DRY).

## 2. Unit Tests for Code Block Extraction

Examines the capability to distill functions and variables from a jumble of Pseudocode parsed into the AST Node `CodeElement`.

### `[UT-MD-01] extract definedSymbols from function definitions`
- **Line:** L23
- **Purpose:** Throws in a markdown text carrying `async function buildNamespaceMap() { ... }`. Expects the Graph Node of CodeElement to dissect the word `buildNamespaceMap` and tuck it into the Array `definedSymbols`. Tags `isPseudocode = true`.

### `[UT-MD-02] extract calledSymbols from function calls`
- **Line:** L40
- **Purpose:** Similarly, a markdown text harboring a function call `resolveNamespace()`. The Parser must recognize and attach it to the `calledSymbols` array.

### `[UT-MD-03] filter out common built-in calls`
- **Line:** L115
- **Purpose:** Within the code lies `console.log()` and `parseInt()`. The Parser is strictly obligated to eradicate these built-ins from `calledSymbols` so the Graph avoids clutter (Noise reduction).

### `[UT-MD-04] not include definedSymbols in calledSymbols (self-reference filter)`
- **Line:** L135
- **Purpose:** Tests the Recursive algorithm. The function `walkTree()` calls itself. The intelligent Parser must comprehend this as a Define, and strip this function name from the Calls list to circumvent generating an infinite loop Graph Edge `CALLS` piercing into itself.

## 3. Unit Tests for Graph Structural Links (Section & Edges)

Vouches for the Tree structure architecture of the Document being properly constructed via Edges.

### `[UT-MD-05] should create Section nodes for headings`
- **Line:** L176
- **Purpose:** Inserts 4 tags `#`, `##`, `###`. Demands the parser perfectly spawns 4 `Section` Nodes, tagging meta `nodeCategory: documentation`.

### `[UT-MD-06] create CONTAINS edges from parent section to child section`
- **Line:** L203
- **Purpose:** A Level 1 Heading tag harbors a Level 2 Heading. The Graph is obligated to generate a `CONTAINS` link cascading downwards from parent to child.

### `[UT-MD-07] create CONTAINS edges from section to enclosed code block`
- **Line:** L214
- **Purpose:** A Code Block is nestled snugly within a Level 2 Heading tag. The Graph must spawn a `CONTAINS` edge from the Heading (Section Node) piercing straight down to the Code Node.

### `[UT-MD-08] create CALLS edges between pseudocode blocks`
- **Line:** L242
- **Purpose:** Installs 2 code block chunks into one file. Chunk 2 calls the function hidden inside Chunk 1. The Parser must string a `CALLS` Line connecting the 2 static code chunks (Static Context). Showcasing the immensely potent simulated linking capability of the Markdown AST.
