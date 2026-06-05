---
name: tsx-queries-grammar-isolation
description: tree-sitter-tsx-specific queries (jsx_self_closing_element, jsx_element) must live in a separate TSX_QUERIES string; can't be in TYPESCRIPT_QUERIES because the .ts grammar rejects them at query-compile time
metadata:
  type: feedback
---

In `gitnexus/src/core/ingestion/tree-sitter-queries.ts`, TSX-only captures like `jsx_self_closing_element`, `jsx_element`, and `jsx_opening_element` cannot live in the shared `TYPESCRIPT_QUERIES` constant — the tree-sitter-typescript grammar (used for .ts files) does not define those node types and **fails the entire query at compile time** (`TSQueryErrorNodeType`), not just at match time.

**Why:** A single `TYPESCRIPT_QUERIES` string is used for both .ts and .tsx files in `parsing-processor.ts` and `parse-worker.ts`. The .ts grammar doesn't know JSX, so any `(jsx_*)` pattern in the shared string breaks every .ts parse.

**How to apply:** When adding TSX-only patterns:
1. Keep `TYPESCRIPT_QUERIES` for patterns valid in both grammars.
2. Put JSX-specific patterns in a separate `TSX_QUERIES = TYPESCRIPT_QUERIES + '...'` (string concatenation).
3. Register `TSX_QUERIES` under key `${SupportedLanguages.TypeScript}:tsx` in `LANGUAGE_QUERIES` (now a `Record<string, string>`, not `Record<SupportedLanguages, string>`).
4. In `parsing-processor.ts` and `parse-worker.ts`, look up the query string per file: `language === TypeScript && file.endsWith('.tsx') ? LANGUAGE_QUERIES['TypeScript:tsx'] : LANGUAGE_QUERIES[language]`.

Related: [[cross-batch-parse-worker-state]]
