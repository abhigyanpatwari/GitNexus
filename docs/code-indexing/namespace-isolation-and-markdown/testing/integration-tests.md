# Code Level: Namespace Isolation Integration Tests

**Level:** L4 (Code)
**File:** `gitnexus/test/integration/namespace-isolation.test.ts`
**Target Container:** [Search & Query Engine](../search/search-engine.md) / [Ingestion Pipeline](../ingestion/ingestion-pipeline.md)

This is the most dense L4 document, representing the ultimate Quality Assurance gateway guarding the entire GitNexus system from severe recurring anomalies. The test file invokes directly up to the End-to-End MCP Server (`LocalBackend`) and connects to the genuine Local KuzuDB.

## Test File Overview
- **Mocking:** Employs `withTestLbugDB()` to erect a local database pre-pumped with `NS_ISOLATION_SEED_DATA` (incorporating impeccable Section, CodeElement nodes) and indexes it.

## 1. Functional Tests (TC-1 to TC-17)

### Structural & Topology Verification
- **TC-1 & TC-2 (`CTX-MD-01`, `02`):** Calls Context Tool (CTX) into a "Section" Node. Demands the returning result distinctly clarifies the Incoming `CONTAINS` flow (Who encompasses me) and Outgoing `CONTAINS` (Who I encompass).
- **TC-4 (`CTX-CODE-01`):** Calls Context into a Function Node. Affirms: A Function is forbidden from having a `CONTAINS` Edge. It must be null or ignored (anti-mud trap).
- **TC-5 (`IMP-REL-01`):** Calls Impact Tool, passing `relationTypes: ['CONTAINS']`. Demands the Impact Tool does not hurl an "Invalid Relation" Exception.
- **TC-7, 8, 9 (`CTX-MD-03`, `04`, `CTX-CODE-02`):** Measures cross-links (`IMPORTS` for links, `DEFINES` for files spawning Sections, CodeElements locating their biological parent Section).

### Namespace Integrity Verification
This test group guarantees every LLM Output carries an "Identity Card" (git_namespace).
- **TC-3 (`CTX-NS-01`):** Disambiguation candidates must mandatorily attach the namespace to untangle LLM ambiguity.
- **TC-6 (`ROUTE-NS-01`):** The mapped out API Endpoint must declare which namespace it resides in.
- **TC-12 (`NS-BM25-01`):** The routine `/query` command must also brand the namespace upon the symbol.
- **TC-13 (`NS-IMPACT-01`):** The Output of the BFS Blast-Radius grid also forces the level 1 namespace addition (WILL BREAK).
- **TC-14 & TC-15 (`NS-CLUSTER-01`, `NS-PROCESS-01`):** Cypher query results traversing execution processes and community Clusters are fully branded.
- **TC-16 & TC-17:** Tool Map and Detect Changes Output bypass censorship without throwing errors when missing a namespace.

## 2. Edge Case Tests (TC-EC1 to TC-EC7)

Defends against unconscious vitality. Scenarios where an Agent or user executes abnormal scripts.

- **EC-1 (Collision):** Calls 2 h1 tags with identical names, disparate files. Returns exactly 2 results for the Agent to select.
- **EC-2 (Orphan):** Calls a CodeElement Node unanchored within any Heading. Embraces an empty incoming rather than Crashing the backend.
- **EC-3 (Regex Chars):** Section name slashed with `[Draft] (v2)`. Executes Rename altering Markdown Node via Dry Run. The system flawlessly regex escapes the string.
- **EC-4 (External URL):** Link outwards to Google website, the Parser avoids spawning an `IMPORTS` Edge (Combating external knowledge hallucination).
- **EC-5 (Two-Tier Fallback):** `Community` Node (cluster) lacks a `git_namespace` schema. The Two-Tier Guard smoothly catches Null and bypasses instead of screaming a Query Exception error.
- **EC-6 (Region Explosion Limit):** Overly massive outgoing nodes are clamped with a hard `LIMIT 30` ceiling for structural relations. Circumventing Context inflation.
- **EC-7 (Rename Crash):** Runs rename upon a Section tethered with an `IMPORTS` link. Soft fallback sidestepping Read Definition.
