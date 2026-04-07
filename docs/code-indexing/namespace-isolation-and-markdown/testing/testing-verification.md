# Container Level / QA: Verification Pipeline

**System:** Namespace Isolation & Markdown Integration
**Type:** Verification Boundary

This L2 document encompasses the VERIFICATION phase of the Pipeline `(Constraints -> Design -> Implementation -> Verification)`. This defensive layer is responsible for locking down the entire architectural design, ensuring Components (Parser, Detector, Hybrid Engine) do not suffer from degradation or "hallucinations" in the future.

## Verification Matrix

The system is divided into 2 defensive perimeters: Unit Test (Module-level) and End-to-End Integration Test (System-level).

1. **[L4: Git Namespace Detector Unit Tests](./detector-unit-tests.md)**
   - Protects functions: `resolveGitNamespace`, `buildNamespaceHint`.
   - Focus: The `Deepest-Wins` rule, resolving Edge-cases of String Paths (Backslash, Sibling repos).

2. **[L4: Markdown Pseudocode Unit Tests](./markdown-unit-tests.md)**
   - Protects functions: AST Parser, Edge generation.
   - Focus: Noise filtering funnel (`console.log`), Resilience against self-referencing (`self-reference filter`), Accurate extraction of the Abstract Tree.

3. **[L4: Namespace & Markdown Integration Tests](./integration-tests.md)**
   - Protects: End-to-end Node Traversal (KuzuDB in-memory).
   - Focus: 24 Test cases simulating LLM Agent actions (Trial MCP Tool calls, Context limit 30 tests, Regex char parser breaks, Over-fetching).

## Relationship with Implementation (The Pipeline Hook)

According to the `@/doc-edit` rule: The existence of Verification MUST reside **AT THE VERY END** of the reasoning loop sequence:
- **Constraint:** Overfetching Token limit, Regex Null pointer, Graph Loop (Documented in System Context / Design ADR).
- **Design:** Inserting `git_namespace` node modifier, Limit 30 boundary, Self-reference filter, Two-Tier Fallback (Documented in L2 Ingestion/Search).
- **Verification:** Affirms 100% that the above Constraints and Design execute flawlessly via the Integration/Unit test suite in this directory.

---

> [!NOTE] Anti-Hallucination Security Gate
> Any modification to the Ingestion Pipeline (adding language support, modifying Regex) MUST conclusively pass these 24 Integration Tests. If it fails even 1 EC (Edge Case), the commit is instantaneously rejected from merging.
