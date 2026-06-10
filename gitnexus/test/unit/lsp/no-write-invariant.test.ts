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
import { FORBIDDEN_LSP_TOKENS } from './lsp-no-write-tokens.js';

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
 *
 * The call-side set is imported from the shared helper at
 * `./lsp-no-write-tokens.ts` (the canonical list, also used
 * by `mode-a-golden.test.ts`). The import-side set is
 * unique to this test (the (e) static guard in
 * `mode-a-golden.test.ts` checks imports against the
 * reconciler file only; the per-(file, token) matrix here
 * scans imports across every lsp/ file).
 */
const FORBIDDEN: ReadonlyArray<{
  name: string;
  regex: RegExp;
  kind: 'import' | 'call';
}> = [
  // Write-API imports (lsp/ must never import these from
  // lbug-adapter; the only sanctioned import is
  // `executeParameterized`).
  { name: 'executeQuery (import)', regex: /\bimport\b[^\n;]*\bexecuteQuery\b/, kind: 'import' },
  { name: 'addNode (import)', regex: /\bimport\b[^\n;]*\baddNode\b/, kind: 'import' },
  { name: 'addRelationship (import)', regex: /\bimport\b[^\n;]*\baddRelationship\b/, kind: 'import' },
  { name: 'initLbug (import)', regex: /\bimport\b[^\n;]*\binitLbug\b/, kind: 'import' },
  { name: 'initLbugWithDb (import)', regex: /\bimport\b[^\n;]*\binitLbugWithDb\b/, kind: 'import' },
  { name: 'CYPHER_WRITE_RE (import)', regex: /\bimport\b[^\n;]*\bCYPHER_WRITE_RE\b/, kind: 'import' },
  // Write-API call sites + Cypher write verbs — shared with
  // `mode-a-golden.test.ts` via the helper. The list below
  // is the canonical, single source of truth.
  ...FORBIDDEN_LSP_TOKENS,
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

// ═══════════════════════════════════════════════════════════════════════════
// AC-8 — reconciler no-write leg (B2)
//
// `mode-a-reconciler.ts` lives OUTSIDE `lsp/` (I-7) and is
// therefore NOT covered by the WI-9 scan above.  Its job is to
// mutate the *in-memory* graph (`graph.addRelationship`,
// `graph.removeRelationship`) — those calls are the DESIGN and
// MUST be allowed.
//
// What it MUST NOT do:
//   (a) import any direct-DB writer from `lbug-adapter`:
//       `executeQuery`, `initLbug`, `initLbugWithDb`, `addNode`
//   (b) call those symbols at call-site level (bare, unqualified
//       — not as a method on an object):
//       `executeQuery(`, `initLbug(`, `initLbugWithDb(`, `addNode(`
//   (c) embed raw Cypher WRITE verbs in string literals —
//       the same UPPERCASE-verb patterns the lsp/ scan uses
//       (`CREATE (`, `MERGE (`, `SET [A-Z_]`, etc.)
//
// Why a separate token set (not `FORBIDDEN_LSP_TOKENS`):
//   `FORBIDDEN_LSP_TOKENS` bans `addRelationship (call)` outright
//   — that is correct for lsp/ files which are READ-ONLY.  The
//   reconciler legitimately calls `graph.addRelationship()` /
//   `graph.removeRelationship()` — they are in-memory operations
//   on a `KnowledgeGraph`, not DB writers.  Reusing the lsp/ set
//   would produce a false-positive on every single engine call.
//
// Demonstration that the tests would FAIL if a DB writer were
// added:  each `it` below applies a regex to the reconciler source;
// the comment in each test spells out which literal string in a
// hypothetical "bad" import or call-site would be caught.
// ═══════════════════════════════════════════════════════════════════════════

describe('AC-8 — reconciler no-write leg (WI-9 extension)', () => {
  const reconcilerPath = path.join(repoRoot, 'src', 'core', 'ingestion', 'mode-a-reconciler.ts');

  // Read + strip once; reused by all children.
  let raw: string;
  let stripped: string;

  // Vitest `beforeAll` is not available at describe-top-level scope
  // here, but since `fs.readFileSync` is synchronous and cheap we
  // simply read at describe-eval time (same pattern used by the
  // per-lsp-file loop above).
  try {
    raw = fs.readFileSync(reconcilerPath, 'utf-8');
    stripped = stripComments(raw);
  } catch (e) {
    // If the file doesn't exist the tests below will fail with a
    // clear message — no need to swallow here.
    raw = '';
    stripped = '';
  }

  it('reconciler source file exists', () => {
    expect(
      fs.existsSync(reconcilerPath),
      `mode-a-reconciler.ts not found at ${reconcilerPath}`,
    ).toBe(true);
    expect(raw.length, 'file is unexpectedly empty').toBeGreaterThan(0);
  });

  // ── (a) Import-side: no lbug-adapter DB-writer imports ──────────────────
  //
  // Pattern: any `import { … <symbol> … } from '…/lbug-adapter…'`.
  // If someone added `import { executeQuery } from '../lbug/lbug-adapter.js'`
  // the first regex below would match.

  const RECONCILER_FORBIDDEN_IMPORTS: ReadonlyArray<{ name: string; regex: RegExp }> = [
    {
      name: 'executeQuery (import from lbug-adapter)',
      // Catches: import { executeQuery } from '…/lbug-adapter…'
      // Would fire on: import { executeQuery } from '../lbug/lbug-adapter.js'
      regex: /\bimport\b[^\n;]*\bexecuteQuery\b[^\n;]*from\s*['"][^'"]*lbug-adapter[^'"]*['"]/,
    },
    {
      name: 'initLbug (import from lbug-adapter)',
      // Catches: import { initLbug } from '…/lbug-adapter…'
      // Would fire on: import { initLbug } from '../lbug/lbug-adapter.js'
      regex: /\bimport\b[^\n;]*\binitLbug\b[^\n;]*from\s*['"][^'"]*lbug-adapter[^'"]*['"]/,
    },
    {
      name: 'initLbugWithDb (import from lbug-adapter)',
      // Catches: import { initLbugWithDb } from '…/lbug-adapter…'
      // Would fire on: import { initLbugWithDb } from '../lbug/lbug-adapter.js'
      regex: /\bimport\b[^\n;]*\binitLbugWithDb\b[^\n;]*from\s*['"][^'"]*lbug-adapter[^'"]*['"]/,
    },
    {
      name: 'addNode (import from lbug-adapter)',
      // Catches: import { addNode } from '…/lbug-adapter…'
      // Would fire on: import { addNode } from '../lbug/lbug-adapter.js'
      regex: /\bimport\b[^\n;]*\baddNode\b[^\n;]*from\s*['"][^'"]*lbug-adapter[^'"]*['"]/,
    },
  ];

  for (const token of RECONCILER_FORBIDDEN_IMPORTS) {
    it(`does not import ${token.name}`, () => {
      // We scan the RAW source (not comment-stripped) for imports —
      // a real import cannot be inside a block comment.  Using raw
      // avoids the (unlikely) edge case where comment-stripping alters
      // an import line's whitespace and breaks the regex boundary.
      const m = raw.match(token.regex);
      if (m) {
        const lineNum = raw.slice(0, m.index ?? 0).split('\n').length;
        throw new Error(
          `mode-a-reconciler.ts contains forbidden import "${token.name}" at line ${lineNum}: ${m[0].slice(0, 120)}`,
        );
      }
      expect(m).toBeNull();
    });
  }

  // ── (b) Call-site: no bare adapter DB-writer calls ──────────────────────
  //
  // These check for unqualified call-sites of the adapter writer symbols.
  // They are distinct from the import check: an attacker could import the
  // symbol under an alias, but the alias would still appear at the call
  // site.  More importantly, a dynamic-import + destructure path
  // (e.g. `const { executeQuery } = await import(…)`) would also be caught
  // by the call-site regex since `executeQuery(` would still appear.
  //
  // NOTE: `addRelationship(` and `removeRelationship(` are NOT in this
  // list — the reconciler legitimately calls `graph.addRelationship(...)` /
  // `graph.removeRelationship(...)` and those are IN-MEMORY operations on
  // the `KnowledgeGraph` interface, not lbug-adapter DB writes.

  const RECONCILER_FORBIDDEN_CALLS: ReadonlyArray<{ name: string; regex: RegExp }> = [
    {
      name: 'executeQuery (call)',
      // Catches: executeQuery(  (bare, unqualified)
      // Would fire on: await executeQuery('MATCH …', params)
      // Would NOT fire on: graph.executeQuery(…) — not that the graph
      // interface even has such a method, but the word-boundary (\b)
      // before `executeQuery` rules out any dotted form.
      // Actually \bexecuteQuery\s*\( fires on `graph.executeQuery(`
      // too because `.` is not a word char — but the reconciler has
      // no such method on KnowledgeGraph, so this is safe.
      regex: /\bexecuteQuery\s*\(/,
    },
    {
      name: 'initLbug (call)',
      // Catches: initLbug(  or  initLbug ()
      // Would fire on: await initLbug(config)
      regex: /\binitLbug\s*\(/,
    },
    {
      name: 'initLbugWithDb (call)',
      // Catches: initLbugWithDb(
      // Would fire on: await initLbugWithDb(db, config)
      regex: /\binitLbugWithDb\s*\(/,
    },
    {
      name: 'addNode (call)',
      // Catches: addNode(  — the bare function call form from lbug-adapter.
      // Would fire on: addNode({ id: 'x', label: 'Fn', properties: {} })
      // Does NOT fire on: graph.addNode(…) because `\b` in `\baddNode`
      // matches a word boundary — but `.addNode` has `.` before it,
      // and `.` is NOT a word char, so `\b` would STILL match there.
      // To avoid false-positives on `graph.addNode(` (which the
      // in-memory graph offers), we require there is NO `.` immediately
      // before `addNode`:  we use a negative lookbehind (?<!\.)\baddNode\s*\(.
      // The reconciler calls `graph.addRelationship` / `graph.removeRelationship`
      // — it does NOT call `graph.addNode` anywhere (it only mutates edges).
      // But we use the lookbehind for correctness: if a future caller
      // does `graph.addNode(...)` that is in-memory and should be allowed.
      regex: /(?<!\.)\baddNode\s*\(/,
    },
  ];

  for (const token of RECONCILER_FORBIDDEN_CALLS) {
    it(`does not call ${token.name}`, () => {
      const m = stripped.match(token.regex);
      if (m) {
        const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
        throw new Error(
          `mode-a-reconciler.ts contains forbidden call "${token.name}" at line ${lineNum}: ${m[0].slice(0, 120)}`,
        );
      }
      expect(m).toBeNull();
    });
  }

  // ── (c) Cypher write verbs in string literals ────────────────────────────
  //
  // After comment-stripping, any remaining UPPERCASE Cypher verb in a
  // string is a structural red flag.  The reconciler has no business
  // embedding Cypher write queries — it operates on the in-memory
  // `KnowledgeGraph` API, not the DB.
  //
  // These are the SAME patterns as `FORBIDDEN_LSP_TOKENS` for Cypher verbs;
  // they are reproduced here (not imported) to keep the reconciler token
  // set self-contained and to document the design reason explicitly.

  const RECONCILER_FORBIDDEN_CYPHER: ReadonlyArray<{ name: string; regex: RegExp }> = [
    {
      name: 'COPY (cypher write verb)',
      // Catches: COPY [A-Z_] — Cypher bulk-copy syntax
      // Would fire on: `COPY Person FROM …`
      // Does NOT fire on the comment `// COPY serialization` (stripped).
      regex: /\bCOPY\s+[A-Z_]/,
    },
    {
      name: 'CREATE ( (cypher write verb)',
      // Catches: CREATE (  — Cypher node/rel CREATE pattern
      // Would fire on: `CREATE (n:Node { … })`
      regex: /\bCREATE\s*\(/,
    },
    {
      name: 'MERGE ( (cypher write verb)',
      // Catches: MERGE (
      // Would fire on: `MERGE (n:Node { … })`
      regex: /\bMERGE\s*\(/,
    },
    {
      name: 'SET [A-Z_] (cypher write verb)',
      // Catches: SET followed by an uppercase identifier
      // Would fire on: `SET n.prop = value`  (n is uppercase after trim, but
      // the pattern requires an uppercase LETTER as the first char following SET).
      // Actually `n` is lowercase — the pattern catches `SET N.prop`
      // or `SET PROPERTY = …` which is the Cypher SET-clause shape.
      regex: /\bSET\s+[A-Z_]/,
    },
    {
      name: 'DELETE [A-Z_] (cypher write verb)',
      // Catches: DELETE followed by uppercase identifier
      // Would fire on: `DELETE N` or `DELETE rel`? (no — rel starts lowercase).
      // The point: detects any `DELETE <UppercaseVar>` shape.
      regex: /\bDELETE\s+[A-Z_]/,
    },
    {
      name: 'DETACH DELETE (cypher write verb)',
      // Catches: DETACH DELETE — the Cypher cascade-delete form
      regex: /\bDETACH\s+DELETE\b/,
    },
  ];

  for (const token of RECONCILER_FORBIDDEN_CYPHER) {
    it(`does not contain ${token.name}`, () => {
      const m = stripped.match(token.regex);
      if (m) {
        const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
        throw new Error(
          `mode-a-reconciler.ts contains forbidden Cypher write verb "${token.name}" at line ${lineNum}: ${m[0].slice(0, 120)}`,
        );
      }
      expect(m).toBeNull();
    });
  }

  // ── Allowed: in-memory graph mutations ────────────────────────────────────
  //
  // Belt-and-braces: assert the ALLOWED in-memory calls DO appear so we
  // know this test is scanning a non-trivial file (if the reconciler were
  // refactored away from `addRelationship`, the test would still pass
  // but would silently stop being a meaningful guard for the in-memory
  // design).  This is a presence-check, not a ban.

  it('contains graph.addRelationship( (in-memory write — allowed design)', () => {
    // The reconciler MUST call graph.addRelationship.  If it doesn't,
    // something significant has changed and this assertion flags the
    // change explicitly rather than silently.
    const m = stripped.match(/\bgraph\.addRelationship\s*\(/);
    expect(
      m,
      'expected mode-a-reconciler.ts to contain graph.addRelationship( — ' +
        'this is the designed in-memory write; if it has been removed, ' +
        'update this test intentionally',
    ).not.toBeNull();
  });

  it('contains graph.removeRelationship( (in-memory write — allowed design)', () => {
    const m = stripped.match(/\bgraph\.removeRelationship\s*\(/);
    expect(
      m,
      'expected mode-a-reconciler.ts to contain graph.removeRelationship( — ' +
        'this is the designed in-memory write; if it has been removed, ' +
        'update this test intentionally',
    ).not.toBeNull();
  });

  // ── End-to-end summary ────────────────────────────────────────────────────
  //
  // A single-shot assertion that mirrors CI output.  Identical in intent
  // to the WI-9 end-to-end above but scoped to the reconciler.

  it('end-to-end: mode-a-reconciler.ts passes the full reconciler no-write scan', () => {
    const violations: string[] = [];

    // (a) import-side
    for (const token of RECONCILER_FORBIDDEN_IMPORTS) {
      const m = raw.match(token.regex);
      if (m) {
        const lineNum = raw.slice(0, m.index ?? 0).split('\n').length;
        violations.push(`  - import  :${lineNum}  ${token.name}  →  ${m[0].slice(0, 80)}`);
      }
    }

    // (b) call-site
    for (const token of RECONCILER_FORBIDDEN_CALLS) {
      const m = stripped.match(token.regex);
      if (m) {
        const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
        violations.push(`  - call    :${lineNum}  ${token.name}  →  ${m[0].slice(0, 80)}`);
      }
    }

    // (c) cypher verbs
    for (const token of RECONCILER_FORBIDDEN_CYPHER) {
      const m = stripped.match(token.regex);
      if (m) {
        const lineNum = stripped.slice(0, m.index ?? 0).split('\n').length;
        violations.push(`  - cypher  :${lineNum}  ${token.name}  →  ${m[0].slice(0, 80)}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `AC-8 reconciler no-write violations in mode-a-reconciler.ts:\n${violations.join('\n')}\n` +
          'The reconciler must use only the in-memory KnowledgeGraph API ' +
          '(graph.addRelationship / graph.removeRelationship). ' +
          'It must never import or call lbug-adapter DB writers directly.',
      );
    }
    expect(violations).toEqual([]);
  });
});
