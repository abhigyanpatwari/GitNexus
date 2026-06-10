/**
 * Shared forbidden-token list for the LSP no-write invariant.
 *
 * Single source of truth for the regex set that
 * `no-write-invariant.test.ts` (the canonical static guard)
 * and `mode-a-golden.test.ts` (the (e) static-guard block)
 * both apply to the `lsp/` module surface. Kept here (not
 * in the production tree) because these are TEST-SIDE
 * concerns — the production `lsp/` module never consumes
 * them.
 *
 * The list pins the LSP-module write-verb contract:
 *   - `addRelationship`, `addNode`, `executeQuery`,
 *     `initLbug`, `initLbugWithDb` (function calls)
 *   - Cypher write verbs (`CREATE`, `MERGE`, `SET`,
 *     `DELETE`, `DETACH DELETE`, `REMOVE`, `DROP`,
 *     `ALTER`, `COPY`) when followed by an upper-case
 *     identifier (Cypher syntax shape; avoids matching
 *     camelCase identifiers like `createInstance`).
 *
 * The shape is `{ name, regex, kind }` where `kind` is
 * `'import'` (a `import … from …` line that names the
 * symbol) or `'call'` (a call site / cypher verb). The
 * `kind` lets consumers filter by surface.
 *
 * Adding a new forbidden write API: append it to the
 * appropriate group and update the consumer tests. Each
 * consumer may filter the list, but the canonical
 * definitions live here.
 */
export interface ForbiddenLspToken {
  /** Human-readable name shown in diagnostics and test titles. */
  name: string;
  /** The regex pattern applied to the (comment-stripped) source text. */
  regex: RegExp;
  /** Whether the token is a `import` statement or a call/cypher-verb site. */
  kind: 'import' | 'call';
}

export const FORBIDDEN_LSP_TOKENS: ReadonlyArray<ForbiddenLspToken> = [
  // Write-API call sites
  { name: 'addRelationship (call)', regex: /\baddRelationship\s*\(/, kind: 'call' },
  { name: 'addNode (call)', regex: /\baddNode\s*\(/, kind: 'call' },
  { name: 'executeQuery (call)', regex: /\bexecuteQuery\s*\(/, kind: 'call' },
  { name: 'initLbug (call)', regex: /\binitLbug\s*\(/, kind: 'call' },
  { name: 'initLbugWithDb (call)', regex: /\binitLbugWithDb\s*\(/, kind: 'call' },
  // Cypher write verbs — UPPERCASE ONLY, since lowercase
  // `create` / `merge` / etc. collide with ordinary code words
  // (`createInstance`, `setFoo`, …). Cypher is case-insensitive
  // by spec, but the lsp/ modules never write cypher, so any
  // UPPERCASE occurrence is a structural red flag. A regular
  // variable named `setFoo` is not matched.
  //
  // Each pattern is anchored on the cypher syntax that follows
  // the verb:
  //   CREATE   →  followed by `(` (node/rel pattern)
  //   MERGE    →  followed by `(` (MERGE (n:Node …))
  //   SET      →  followed by uppercase identifier
  //   DELETE   →  followed by uppercase identifier
  //   REMOVE   →  followed by `(` or identifier
  //   DROP     →  followed by `(` or UPPERCASE keyword
  //   ALTER    →  followed by `(` or UPPERCASE keyword
  //   COPY     →  followed by UPPERCASE
  { name: 'CREATE (cypher verb)', regex: /\bCREATE\s*\(/, kind: 'call' },
  { name: 'MERGE (cypher verb)', regex: /\bMERGE\s*\(/, kind: 'call' },
  { name: 'SET (cypher verb)', regex: /\bSET\s+[A-Z_]/, kind: 'call' },
  { name: 'DELETE (cypher verb)', regex: /\bDELETE\s+[A-Z_]/, kind: 'call' },
  { name: 'DETACH DELETE', regex: /\bDETACH\s+DELETE\b/, kind: 'call' },
  { name: 'REMOVE (cypher verb)', regex: /\bREMOVE\s+[A-Z_(]/, kind: 'call' },
  { name: 'DROP (cypher verb)', regex: /\bDROP\s+[A-Z_(]/, kind: 'call' },
  { name: 'ALTER (cypher verb)', regex: /\bALTER\s+[A-Z_(]/, kind: 'call' },
  { name: 'COPY (cypher verb)', regex: /\bCOPY\s+[A-Z_]/, kind: 'call' },
];

/**
 * Convenience: the call-only subset. The (e) static-guard
 * block in `mode-a-golden.test.ts` only checks call sites —
 * import-side surface is a separate, simpler check there.
 */
export const FORBIDDEN_LSP_CALL_TOKENS: ReadonlyArray<ForbiddenLspToken> =
  FORBIDDEN_LSP_TOKENS.filter((t) => t.kind === 'call');
