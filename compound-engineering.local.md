---
review_agents: [kieran-typescript-reviewer, pattern-recognition-specialist, architecture-strategist, data-integrity-guardian, security-sentinel, performance-oracle, code-simplicity-reviewer]
plan_review_agents: [kieran-typescript-reviewer, architecture-strategist, code-simplicity-reviewer]
voltagent_agents: [voltagent-lang:typescript-pro, voltagent-qa-sec:security-auditor, voltagent-data-ai:database-optimizer]
---

# Review Context

## Project Overview
GitNexus is a code intelligence tool that builds a knowledge graph from source code using tree-sitter AST parsing across 12 languages and KuzuDB for graph storage. Two packages: `gitnexus/` (CLI/MCP, TypeScript) and `gitnexus-web/` (browser).

## Cross-Language Pattern Consistency (pattern-recognition-specialist)
- 12 language-specific type extractors in `gitnexus/src/core/ingestion/type-extractors/` must follow identical patterns for: async unwrapping, constructor binding, namespace handling, nullable type stripping, for-loop element typing.
- Past bugs: C#/Rust missing `await_expression` unwrapping that TypeScript handled correctly; PHP backslash namespace splitting inconsistent with other languages' `::` / `.` splitting.
- When reviewing type extractor changes, verify the same pattern exists in ALL applicable language files — asymmetry is the #1 source of bugs.

## Data Integrity (data-integrity-guardian)
- KuzuDB graph operations: schema in `gitnexus/src/core/kuzu/schema.ts`, adapter in `kuzu-adapter.ts`.
- The ingestion pipeline writes symbols and relationships to the graph — changes to node/relation schemas or the ingestion pipeline can corrupt the index.
- Known issue: KuzuDB `close()` hangs on Linux due to C++ destructor — use `detachKuzu()` pattern.
- `lbug-adapter.ts` fallback path needs quote/newline escaping for Cypher injection prevention.

## Security (security-sentinel)
- Cypher query construction in `lbug-adapter.ts` and `kuzu-adapter.ts` — watch for injection via unescaped user-provided symbol names.
- CLI accepts `--repo` parameter and file paths — validate against path traversal.
- MCP server exposes tools to external AI agents — all tool inputs are untrusted.

## Performance (performance-oracle)
- Tree-sitter buffer size is adaptive (512KB–32MB) via `getTreeSitterBufferSize()` in `constants.ts`.
- The ingestion pipeline processes entire repositories — O(n) per file with potential O(n²) in cross-file resolution.
- KuzuDB batch inserts vs individual inserts matter for large repos.

## Architecture (architecture-strategist)
- Ingestion pipeline phases: structure → parsing → imports → calls → heritage → processes → type resolution.
- Shared modules: `export-detection.ts`, `constants.ts`, `utils.ts` — changes here have wide blast radius.
- `gitnexus-web` package drifts behind CLI — flag if a change should be mirrored.

## Voltagent Supplementary Agents

Invoke these via the Agent tool alongside `/ce:review` for deeper specialist analysis. These cover gaps that compound-engineering agents don't:

### voltagent-lang:typescript-pro
**When:** Changes touch type-resolution logic, generics, conditional types, or complex type-level programming in `type-env.ts`, `type-extractors/*.ts`, or `types.ts`.
**Why:** The type resolution system uses advanced TypeScript patterns (discriminated unions, mapped types, recursive generics) that benefit from deep TS type-system review beyond what kieran-typescript-reviewer covers.

### voltagent-qa-sec:security-auditor
**When:** Changes touch MCP tool handlers, Cypher query construction, CLI argument parsing, or any code that processes external input.
**Why:** GitNexus is an MCP server — all tool inputs come from untrusted AI agents. Systematic OWASP-level audit catches injection vectors that spot-checking misses. Past finding: `lbug-adapter.ts` fallback path had unescaped newlines in Cypher queries.

### voltagent-data-ai:database-optimizer
**When:** Changes touch `kuzu-adapter.ts`, `schema.ts`, `lbug-adapter.ts`, or any Cypher query construction/execution.
**Why:** No CE agent specializes in graph database optimization. KuzuDB batch insert patterns, index usage, and query planning directly affect analysis speed on large repos.

## Review Tooling
- Use `gitnexus_impact()` before approving changes to any symbol — check d=1 (WILL BREAK) callers.
- Use `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` to map PR diffs to affected execution flows.
- Use claude-mem to surface past architectural decisions relevant to the code under review.
