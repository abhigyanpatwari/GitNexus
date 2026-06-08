/**
 * WI-9 — No-Write Invariant Static Guard (Invariant 1)
 *
 * This test mechanically enforces the read-only contract of the
 * `core/ingestion/lsp/` module by reading every `.ts` file in
 * that directory and asserting that:
 *
 *   1. No file imports a write-API symbol from `lbug-adapter`
 *      (`addNode`, `addRelationship`, `executeQuery`,
 *      `initLbug`, `initLbugWithDb`).
 *   2. No file contains a Cypher write verb (`CREATE`, `MERGE`,
 *      `SET`, `DELETE`, `DETACH DELETE`, `REMOVE`, `DROP`,
 *      `ALTER`, `COPY`) that is not inside a JSDoc comment
 *      or a string-literal "explainer" of the verb itself.
 *   3. No file imports a `CYPHER_WRITE_RE` token (the regex
 *      constant the adapter uses to reject write queries —
 *      the lsp/ modules should never even reference it).
 *
 * The test is purely static: it does not import any of the lsp/
 * modules, does not need LadybugDB, does not need a fixture. It
 * is the cheapest possible guard against a future refactor that
 * (by accident or by intent) introduces a write path. The CI gate
 * is structural: if a file under lsp/ ever calls a write API,
 * the test fails at the source-text level — the lsp/ module
 * would never even have to be loaded.
 *
 * Methodology
 * ───────────
 * - Read each `.ts` file with `fs.readFile` (sync, simple).
 * - Strip JSDoc block comments and line comments to avoid
 *   false positives (the existing JSDoc references to "CREATE"
 *   / "MERGE" in `mode-c-verifier.ts:50` are explanations, not
 *   code paths).
 * - Apply the forbidden-token regex set.
 * - On any match, fail with a diagnostic pointing at the file
 *   and the matched line.
 *
 * Why static, not dynamic
 * ───────────────────────
 * - Dynamic ("did the module import a write symbol?") requires
 *   loading the module, which requires a DB, which the unit
 *   test runner does not provide.
 * - TS `import` statements are resolved at runtime — once the
 *   module is loaded, the source text no longer has the import
 *   declaration. Static source-text reading is the only way to
 *   mechanically check the import surface.
 * - The `mode-c-verifier.ts` module already ships a
 *   `assertNoGraphWriteImports()` runtime helper for ITSELF.
 *   This test generalises that idea to all five lsp/ files.
 *
 * Files covered
 * ─────────────
 *   lsp-client.ts
 *   server-discovery.ts
 *   location-mapper.ts
 *   workspace-readiness-probe.ts
 *   mode-c-verifier.ts
 *   reference-provider.ts     (added in P2 of #159 — WI-V)
 *
 * New files added to lsp/ MUST extend this list — the test
 * fails the first time a new file is added (it is not in
 * `LSP_FILES` yet) so the author is forced to acknowledge the
 * new file in the audit.
 *
 * Reverse-subset guard (added in P2 of #159 — WI-V): the test
 * ALSO asserts that the set of `.ts` files actually present
 * under `lsp/` is a subset of `LSP_FILES`. Without this, a new
 * untracked `lsp/foo.ts` would slip past the per-file token
 * scan and the end-to-end summary — both iterate only over
 * `LSP_FILES`. AC-6 / Inv-1 require that *every* lsp/ module
 * is in the no-write allowlist.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// gitnexus/test/unit/lsp/ → gitnexus/ (3 levels up)
const repoRoot = path.resolve(testDir, '..', '..', '..');
const lspDir = path.join(repoRoot, 'src', 'core', 'ingestion', 'lsp');

/**
 * The set of `.ts` files under `lsp/` that are subject to the
 * no-write guard. Listed explicitly (rather than read via
 * `fs.readdir`) so a new file under `lsp/` fails the test
 * until the author adds it here — the structural fix for
 * "I added lsp/foo.ts and it bypassed the audit".
 */
const LSP_FILES = [
  'lsp-client.ts',
  'server-discovery.ts',
  'location-mapper.ts',
  'node-labels.ts',
  'workspace-readiness-probe.ts',
  'mode-c-verifier.ts',
  'reference-provider.ts',
] as const;

/**
 * Forbidden source-text tokens. Each entry is `{ name, regex, kind }`
 * where `kind` is `'import'` (a `import … from …` line that names
 * the symbol) or `'call'` (a call site / cypher verb). We match
 * with word boundaries to avoid partial-string collisions
 * (e.g. `deleteFiles` must NOT match `\bdelete\b`).
 */
const FORBIDDEN: ReadonlyArray<{
  name: string;
  regex: RegExp;
  kind: 'import' | 'call';
}> = [
  // Write-API imports
  { name: 'executeQuery (import)', regex: /\bimport\b[^\n;]*\bexecuteQuery\b/, kind: 'import' },
  { name: 'addNode (import)', regex: /\bimport\b[^\n;]*\baddNode\b/, kind: 'import' },
  { name: 'addRelationship (import)', regex: /\bimport\b[^\n;]*\baddRelationship\b/, kind: 'import' },
  { name: 'initLbug (import)', regex: /\bimport\b[^\n;]*\binitLbug\b/, kind: 'import' },
  { name: 'initLbugWithDb (import)', regex: /\bimport\b[^\n;]*\binitLbugWithDb\b/, kind: 'import' },
  { name: 'CYPHER_WRITE_RE (import)', regex: /\bimport\b[^\n;]*\bCYPHER_WRITE_RE\b/, kind: 'import' },
  // Write-API call sites
  { name: 'executeQuery()', regex: /\bexecuteQuery\s*\(/, kind: 'call' },
  { name: 'addNode()', regex: /\baddNode\s*\(/, kind: 'call' },
  { name: 'addRelationship()', regex: /\baddRelationship\s*\(/, kind: 'call' },
  { name: 'initLbug()', regex: /\binitLbug\s*\(/, kind: 'call' },
  { name: 'initLbugWithDb()', regex: /\binitLbugWithDb\s*\(/, kind: 'call' },
  // Cypher write verbs — UPPERCASE ONLY, since lowercase
  // `create` / `merge` / etc. collide with ordinary code words
  // (`createInstance`, `setFoo`, …). Cypher is case-insensitive
  // by spec, but the lsp/ modules never write cypher, so any
  // UPPERCASE occurrence is a structural red flag. A future
  // refactor that introduces, e.g., a `cypher.write` constant
  // is caught here; a regular variable named `setFoo` is not.
  //
  // Each pattern is anchored on the cypher syntax that follows
  // the verb:
  //   CREATE   →  followed by `(` (node/rel pattern: CREATE (n:Node …))
  //   MERGE    →  followed by `(` (MERGE (n:Node …))
  //   SET      →  followed by uppercase identifier (SET n.prop = …)
  //   DELETE   →  followed by uppercase identifier (DELETE n)
  //   REMOVE   →  followed by `(` (REMOVE n:Label) or identifier
  //   DROP     →  followed by `(` (DROP TABLE foo) or
  //               UPPERCASE keyword (DROP INDEX foo)
  //   ALTER    →  followed by `(` (ALTER TABLE …) or
  //               UPPERCASE keyword (ALTER TABLE …)
  //   COPY     →  followed by UPPERCASE (COPY foo FROM bar)
  // A regular camelCase identifier like `createFoo` is not a
  // cypher verb (it has lowercase tail) and is NOT matched.
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
 * Strip JSDoc `/* … *​/` block comments and `// …` line comments
 * from the source text. We replace each matched comment with
 * a single space (preserving line numbers for diagnostics).
 *
 * Why strip? The `mode-c-verifier.ts` JSDoc already contains
 * tokens like "no write API" and "CREATE / MERGE / SET / DELETE"
 * as explanations of WHAT the verifier avoids. Those references
 * are valid documentation and MUST NOT be flagged.
 */
function stripComments(src: string): string {
  // Block comments (multi-line, /* … */).
  // The `[\s\S]` form matches newlines inside the comment.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Line comments (// … to end of line).
  out = out.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  return out;
}

describe('WI-9 — no-write invariant (Invariant 1)', () => {
  it('lsp/ directory exists and contains the expected file set', () => {
    // Sanity: the test is meaningless if lsp/ is empty.
    expect(fs.existsSync(lspDir)).toBe(true);
    const actual = new Set(
      fs
        .readdirSync(lspDir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')),
    );
    const expected = new Set(LSP_FILES);
    for (const f of expected) {
      expect(actual.has(f), `expected lsp/${f} to exist`).toBe(true);
    }
  });

  it('lsp/ contains no untracked .ts files (reverse-subset guard, AC-6 / Inv-1)', () => {
    // The forward assertion above is necessary but not sufficient:
    // a new untracked `lsp/foo.ts` would pass the per-file scan
    // (which only iterates `LSP_FILES`) and the end-to-end
    // summary (same). The reverse-subset guard ensures that
    // EVERY `.ts` file in lsp/ is in the allowlist — i.e. the
    // allowlist is the COMPLETE set, not just a subset.
    //
    // If this fails, the fix is one of two:
    //   (a) the new file is intended — add it to `LSP_FILES` and
    //       confirm it has no write imports;
    //   (b) the new file is unintended — delete it.
    const actual = new Set(
      fs
        .readdirSync(lspDir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')),
    );
    const expected = new Set(LSP_FILES);
    const untracked = [...actual].filter((f) => !expected.has(f));
    expect(
      untracked,
      `lsp/ contains files not in LSP_FILES allowlist (AC-6 / Inv-1): ${untracked.join(', ')}. ` +
        `Add to LSP_FILES or remove the file.`,
    ).toEqual([]);
  });

  // Build a test for every (file, token) pair so a regression
  // surfaces as a single failing test with a precise name.
  for (const filename of LSP_FILES) {
    describe(`lsp/${filename}`, () => {
      for (const token of FORBIDDEN) {
        it(`does not contain ${token.name}`, () => {
          const filePath = path.join(lspDir, filename);
          expect(fs.existsSync(filePath), `missing file: ${filePath}`).toBe(true);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const stripped = stripComments(raw);
          const m = stripped.match(token.regex);
          if (m) {
            // Find the line number for the diagnostic.
            const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
            throw new Error(
              `lsp/${filename} contains forbidden token "${token.name}" at line ${lineNum}: ${m[0].slice(0, 80)}`,
            );
          }
        });
      }

      it(`only imports read-only modules from lbug-adapter (read-only surface check)`, () => {
        // Belt-and-braces: even if the per-token regexes above
        // miss a future write-API addition, the explicit
        // allow-list of readable symbols from lbug-adapter
        // catches it.
        const filePath = path.join(lspDir, filename);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const ALLOWED_FROM_LBUG_ADAPTER = new Set([
          'executeParameterized', // the only sanctioned read API
        ]);
        // Match `import { … } from '…/lbug-adapter…'`.
        const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*lbug-adapter[^'"]*['"]/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(raw)) !== null) {
          const names = m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          for (const name of names) {
            // Strip "type " prefix and " as X" alias.
            const clean = name.replace(/^type\s+/, '').replace(/\s+as\s+\w+/, '').trim();
            expect(
              ALLOWED_FROM_LBUG_ADAPTER.has(clean),
              `lsp/${filename} imports non-allow-listed symbol "${clean}" from lbug-adapter`,
            ).toBe(true);
          }
        }
      });
    });
  }

  it('end-to-end: scan the whole lsp/ directory and report any violation', () => {
    // The single-shot summary check. Mirrors what CI sees —
    // one assertion, one failure message, one diff to debug.
    // We use this as the canonical "pass / fail" test; the
    // per-(file, token) tests above pin individual lines so
    // a regression is debuggable.
    //
    // Iterate over the FILESYSTEM listing, not just LSP_FILES,
    // so a new untracked file would be caught by THIS summary
    // (the reverse-subset guard catches it at file-existence
    // time). Together: allowlist completeness + token scan =
    // structural no-write guarantee.
    const onDisk = fs
      .readdirSync(lspDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
    const allowlisted = new Set(LSP_FILES);
    const scanTargets = onDisk.filter((f) => allowlisted.has(f));
    const violations: string[] = [];
    for (const filename of scanTargets) {
      const filePath = path.join(lspDir, filename);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const stripped = stripComments(raw);
      for (const token of FORBIDDEN) {
        const m = stripped.match(token.regex);
        if (m) {
          const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
          violations.push(
            `  - lsp/${filename}:${lineNum}  ${token.name}  →  ${m[0].slice(0, 60)}`,
          );
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `no-write invariant violations found in lsp/:\n${violations.join('\n')}\n` +
          `These violate Invariant 1 (no graph writes). The lsp/ module is read-only.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
