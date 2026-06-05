---
name: react-tsx-indexing-fixes
description: WI-#107 closed React/TSX indexing gaps in 2026-06; added JSX element captures (CodeElement), type_alias_declaration, and React hook binding captures (const handleClick = useCallback(...))
metadata:
  type: project
---

WI-#107 (closed 2026-06) closed three React/TSX indexing gaps in the parser pipeline:

1. **JSX element references** (`<Button />`, `<div>`): now captured as `CodeElement` nodes via two new tree-sitter queries in `TSX_QUERIES` (one for `jsx_self_closing_element`, one for `jsx_element` capturing the opening tag's identifier). The `definition.jsx_element` capture is mapped to `CodeElement` label in `parse-worker.ts:getLabelFromCaptures`.

2. **Type alias declarations** (`type X = ...`): now captured via `(type_alias_declaration name: (type_identifier) @name) @definition.type` → `TypeAlias` label. This is in `TYPESCRIPT_QUERIES` (works in both .ts and .tsx grammars).

3. **React hook bindings** (`const handleClick = useCallback(() => {...}, [])`): the variable name now appears as a Function node via a new tree-sitter query that matches `lexical_declaration` with `value: (call_expression function: (identifier|member_expression))`. This is in `TYPESCRIPT_QUERIES`. The inner arrow function is anonymous (no name → no node) but the binding is queryable.

**Why:** Issue #107 reported React components and hooks were missing from the graph. After the fix, a `MyComponent` that uses `useCallback` produces these nodes: `MyComponent` (Function), `handleClick` (Function, from the hook binding), `<Button>` (CodeElement JSX reference), `CardProps` (TypeAlias). The CALLS edge from `handleClick` to `useCallback` is NOT resolved because `useCallback` is an external import; the call is captured but dropped by `processCallsFromExtracted`.

**How to apply:** When adding more TS/TSX-specific patterns, use [[tsx-queries-grammar-isolation]] — JSX-specific patterns go in `TSX_QUERIES`, everything else in `TYPESCRIPT_QUERIES`.

**Tests:** `test/integration/resolvers/react.test.ts` (8 tests, 1 fixture in `test/fixtures/lang-resolution/react-basic/`). 192 existing `test/integration/resolvers/typescript.test.ts` tests must keep passing — they validate no regression.
