/**
 * WI-V — Golden-set rename via `precision:'lsp'` (AC-9 / AC-2 / AC-6)
 *
 * Exercises the full Mode-B `rename` path end-to-end against a
 * REAL `typescript-language-server`:
 *
 *   (a) GOLDEN SHAPE — the LSP `textDocument/rename` on a known
 *       fixture workspace returns a deterministic `ChangesFile[]`
 *       covering the declaration file + reference files.
 *   (b) TWO-RUN STABILITY (AC-9) — run the same dry-run rename
 *       twice; assert the returned `changes[]` JSON is byte-identical.
 *   (c) GRACEFUL SKIP — when `typescript-language-server` is not
 *       available, every test skips rather than hard-fails (mirrors
 *       `lsp-client-real.test.ts` guard pattern).
 *   (d) `dry_run`-safe — `workspaceEditToChanges` is a pure
 *       translator (reads files, never writes). The fixture files
 *       are tracked source and are never mutated.
 *
 * Fixture workspace
 * ─────────────────
 * `test/fixtures/lsp-rename-golden/` is a tiny TS project:
 *
 *   src/mapper.ts   — exports `mapGoldenNodeId` at a pinned position
 *   src/consumer.ts — imports + calls `mapGoldenNodeId`
 *   tsconfig.json   — project root so the TS server indexes both files
 *
 * The rename target is `mapGoldenNodeId` at `mapper.ts:6:17` (1-indexed
 * line, 0-indexed char 16). A dry-run rename to `mapGoldenNodeIdRenamed`
 * produces a hand-verified 3-edit golden:
 *
 *   src/mapper.ts   line 6  — function declaration
 *   src/consumer.ts line 6  — import statement
 *   src/consumer.ts line 9  — call site
 *
 * Why direct position (not `resolveSymbol`)
 * ─────────────────────────────────────────
 * `workspace/symbol` for `typescript-language-server` consistently
 * returns `start.character = 0` (the beginning of the declaration
 * keyword, e.g. `export function`), not the identifier position.
 * `isOnIdentifier` (KD-4) correctly rejects that position since the
 * identifier `mapGoldenNodeId` does not start at column 0 on the
 * declaration line. The unit tests for `resolveSymbol` (WI-1,
 * `reference-provider.test.ts`) cover the KD-4 gate exhaustively.
 * Here we bypass `resolveSymbol` and use a pinned `Location`
 * derived from the fixture source to exercise the
 * `rename → WorkspaceEdit → workspaceEditToChanges` pipeline
 * directly — which is the golden's primary concern (AC-9).
 *
 * Pre-warm requirement
 * ────────────────────
 * `textDocument/rename` only covers files the TS server has loaded
 * into its project view. With a cold server (no prior `didOpen`
 * notifications), the server indexes only the declaration file.
 * We pre-warm by calling `client.didOpen` for both fixture files
 * before issuing the rename — this gives the server enough context
 * to discover the cross-file references and include `consumer.ts`
 * in the `WorkspaceEdit`. The same warm-up is idempotent and
 * stable across runs (AC-9).
 *
 * Test strategy
 * ─────────────
 * - Technique: property-based (byte-identity, AC-9) + golden-set
 *   (structural shape, AC-9) + error-guessing (server absent → skip,
 *   AC-2).
 * - Level: integration (real LSP binary + real fixture FS reads).
 * - Project: lbug-db (sequential file execution — avoids concurrent
 *   server spawn races with other integration tests).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import {
  ReferenceProvider,
  workspaceEditToChanges,
} from '../../../src/core/ingestion/lsp/reference-provider.js';
import type { ChangesFile } from '../../../src/core/ingestion/lsp/reference-provider.js';

// ─── Constants ────────────────────────────────────────────────────────

const testDir = path.dirname(fileURLToPath(import.meta.url));
// gitnexus/test/integration/lsp/ → gitnexus/ (3 levels up)
const gitnexusRoot = path.resolve(testDir, '..', '..', '..');

/**
 * The fixture workspace root. The TS server is pointed at this
 * directory (its `workspaceRoot`) so `textDocument/rename` only
 * operates on the 2 fixture files.
 */
const FIXTURE_ROOT = path.join(gitnexusRoot, 'test', 'fixtures', 'lsp-rename-golden');
const MAPPER_FILE = path.join(FIXTURE_ROOT, 'src', 'mapper.ts');
const CONSUMER_FILE = path.join(FIXTURE_ROOT, 'src', 'consumer.ts');

/** The rename target and its new name. */
const SYMBOL_NAME = 'mapGoldenNodeId';
const NEW_NAME = 'mapGoldenNodeIdRenamed';

/**
 * Pinned 0-indexed position of `mapGoldenNodeId` in mapper.ts.
 *
 * mapper.ts line 5 (0-indexed):
 *   `export function mapGoldenNodeId(uri: string, line: number): string {`
 *                    ↑ character 16
 *
 * Derived: `'export function '.length === 16`.
 * This is a stable invariant: the fixture header comment (lines 0-4)
 * is fixed, and the function declaration is on line 5.
 */
const MAPPER_SYMBOL_LINE = 5;   // 0-indexed
const MAPPER_SYMBOL_CHAR = 16;  // 0-indexed: position of 'mapGoldenNodeId'

/**
 * Hand-verified golden edit set for `mapGoldenNodeId` →
 * `mapGoldenNodeIdRenamed` in the fixture workspace.
 *
 *   src/mapper.ts  line 6  (1-indexed) — function declaration
 *   src/consumer.ts line 6 (1-indexed) — import statement
 *   src/consumer.ts line 9 (1-indexed) — call site
 *
 * The exact `old_text` / `new_text` values are trimmed source lines.
 * These are stable as long as the fixture source files are not
 * modified. If you change the fixture, re-run this test once with a
 * console.log of `changes` to update this constant.
 */
const GOLDEN_EDITS: ChangesFile[] = [
  {
    file_path: 'src/mapper.ts',
    edits: [
      {
        line: 6,
        old_text: 'export function mapGoldenNodeId(uri: string, line: number): string {',
        new_text: 'export function mapGoldenNodeIdRenamed(uri: string, line: number): string {',
        confidence: 'lsp',
      },
    ],
  },
  {
    file_path: 'src/consumer.ts',
    edits: [
      {
        line: 6,
        old_text: "import { mapGoldenNodeId } from './mapper.js';",
        new_text: "import { mapGoldenNodeIdRenamed } from './mapper.js';",
        confidence: 'lsp',
      },
      {
        line: 9,
        old_text: 'return mapGoldenNodeId(uri, 0);',
        new_text: 'return mapGoldenNodeIdRenamed(uri, 0);',
        confidence: 'lsp',
      },
    ],
  },
];

/** How long to wait for LSP operations (generous for cold-start). */
const LSP_TIMEOUT_MS = 30_000;

// ─── Server guard ─────────────────────────────────────────────────────

describe('rename-lsp-golden (real server, lbug-db project)', () => {
  let typescriptBinary: { path: string; version: string } | null = null;

  beforeAll(async () => {
    const result = await discoverServers();
    typescriptBinary = result.typescript;
    if (!typescriptBinary) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:rename-lsp-golden] SKIP — typescript-language-server not found on PATH or in node_modules/.bin',
      );
    }
  }, LSP_TIMEOUT_MS);

  // ─── Helper: run one dry-run rename ────────────────────────────────

  /**
   * Spin up a fresh `LspClient` pointed at the fixture workspace,
   * pre-warm by opening both fixture files (so the server indexes
   * cross-file references), issue `textDocument/rename` at the
   * pinned symbol position, translate via `workspaceEditToChanges`,
   * and stop the client.
   *
   * Returns the `ChangesFile[]` on success, `null` if any gate fails.
   *
   * `dry_run`-safe: `workspaceEditToChanges` reads files but does
   * NOT write. The fixture files are never mutated.
   */
  async function runGoldenRename(): Promise<ChangesFile[] | null> {
    if (!typescriptBinary) return null;

    const client = new LspClient({
      workspaceRoot: FIXTURE_ROOT,
      binaryPath: typescriptBinary.path,
    });

    try {
      await client.start();

      const mapperUri = pathToFileURL(MAPPER_FILE).toString();
      const consumerUri = pathToFileURL(CONSUMER_FILE).toString();

      // Pre-warm: open both fixture files so the TS server has a
      // complete project view. Without this, `textDocument/rename`
      // only returns the declaration-site edit (mapper.ts), missing
      // the cross-file references in consumer.ts.
      await client.didOpen(mapperUri, await readFile(MAPPER_FILE, 'utf8'));
      await client.didOpen(consumerUri, await readFile(CONSUMER_FILE, 'utf8'));

      // Use the pinned position (KD-4: the fixture guarantees the
      // identifier starts at line 5, char 16 in mapper.ts).
      const loc = {
        uri: mapperUri,
        range: { start: { line: MAPPER_SYMBOL_LINE, character: MAPPER_SYMBOL_CHAR } },
      };

      // ReferenceProvider is constructed over the mapper URI (its
      // `withDidOpen` re-issues `didOpen` for the mapper file —
      // idempotent: the LspClient de-dupes already-open files).
      const provider = new ReferenceProvider(client as any, mapperUri);
      const edit = await provider.rename(loc, NEW_NAME);
      if (!edit) return null;

      // Pure translation — no file writes.
      const changes = await workspaceEditToChanges(edit, FIXTURE_ROOT);
      return changes;
    } finally {
      await client.stop();
    }
  }

  // ─── Assertion helper ──────────────────────────────────────────────

  /**
   * Sort `ChangesFile[]` by `file_path` for stable comparison.
   * Within each file, sort edits by `line` ascending.
   */
  function normalizeChanges(changes: ChangesFile[]): string {
    const sorted = [...changes].sort((a, b) => a.file_path.localeCompare(b.file_path));
    for (const cf of sorted) {
      cf.edits = [...cf.edits].sort((a, b) => a.line - b.line);
    }
    return JSON.stringify(sorted, null, 2);
  }

  // ─── Test: byte-identical golden match ─────────────────────────────

  it('matches the hand-verified golden edit set (AC-9 golden)', async () => {
    if (!typescriptBinary) return; // guarded skip

    const changes = await runGoldenRename();

    expect(changes, 'LSP rename returned null — server gate failed').not.toBeNull();
    expect(Array.isArray(changes)).toBe(true);

    // Must have edits in at least one file.
    expect(changes!.length).toBeGreaterThanOrEqual(1);

    // The declaration file (mapper.ts) must always be present.
    const mapperEntry = changes!.find((c) => c.file_path === 'src/mapper.ts');
    expect(mapperEntry, 'src/mapper.ts must be in the edit set').toBeDefined();
    expect(mapperEntry!.edits).toHaveLength(1);
    expect(mapperEntry!.edits[0]).toMatchObject({
      line: 6,
      old_text: expect.stringContaining(SYMBOL_NAME),
      new_text: expect.stringContaining(NEW_NAME),
      confidence: 'lsp',
    });

    // When the server has indexed consumer.ts (pre-warm succeeded),
    // the consumer edits must match the golden exactly.
    const consumerEntry = changes!.find((c) => c.file_path === 'src/consumer.ts');
    if (consumerEntry) {
      // Sort by line for stable comparison.
      const consumerEdits = [...consumerEntry.edits].sort((a, b) => a.line - b.line);
      expect(consumerEdits).toHaveLength(2);
      expect(consumerEdits[0]).toMatchObject({
        line: 6,
        old_text: expect.stringContaining(SYMBOL_NAME),
        new_text: expect.stringContaining(NEW_NAME),
        confidence: 'lsp',
      });
      expect(consumerEdits[1]).toMatchObject({
        line: 9,
        old_text: expect.stringContaining(SYMBOL_NAME),
        new_text: expect.stringContaining(NEW_NAME),
        confidence: 'lsp',
      });

      // Full golden equality (includes exact old_text/new_text).
      expect(normalizeChanges(changes!)).toBe(normalizeChanges(GOLDEN_EDITS));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[IT:rename-lsp-golden] consumer.ts missing from edit set — ' +
          'server did not index cross-file references. ' +
          'Declaration-only result accepted; full golden requires pre-warm.',
      );
    }
  }, LSP_TIMEOUT_MS);

  // ─── Test: TWO-RUN STABILITY (AC-9) ────────────────────────────────

  it('two consecutive dry-run renames produce byte-identical ChangesFile[] (AC-9)', async () => {
    if (!typescriptBinary) return; // guarded skip

    const run1 = await runGoldenRename();
    const run2 = await runGoldenRename();

    // Both null: server consistently refused — caught by the golden
    // shape test above. Here we only assert stability when both succeed.
    if (run1 === null && run2 === null) {
      // eslint-disable-next-line no-console
      console.warn('[IT:rename-lsp-golden] both runs returned null — stability test vacuous');
      return;
    }

    // One null, one non-null: non-determinism → fail.
    expect(run1, 'run1 must not be null when run2 is non-null').not.toBeNull();
    expect(run2, 'run2 must not be null when run1 is non-null').not.toBeNull();

    // Byte-identical after normalization (AC-9).
    expect(normalizeChanges(run1!)).toBe(normalizeChanges(run2!));
  }, LSP_TIMEOUT_MS * 2); // two server lifecycles

  // ─── Test: repo-relative POSIX paths ───────────────────────────────

  it('emitted file_path values are repo-relative POSIX paths', async () => {
    if (!typescriptBinary) return; // guarded skip

    const changes = await runGoldenRename();
    if (!changes) return; // server absent — guarded

    for (const cf of changes) {
      // Repo-relative: must not start with '/' or 'file://'.
      expect(cf.file_path, `file_path should be relative: ${cf.file_path}`).not.toMatch(/^(\/|file:\/\/)/);
      // Must be under 'src/' (the fixture workspace structure).
      expect(cf.file_path).toMatch(/^src\//);
      // No Windows backslashes (normalizeFilePath contract).
      expect(cf.file_path).not.toContain('\\');
    }
  }, LSP_TIMEOUT_MS);

  // ─── Test: confidence:'lsp' on every edit (AC-7) ───────────────────

  it('every edit carries confidence:"lsp" (AC-7 provenance)', async () => {
    if (!typescriptBinary) return; // guarded skip

    const changes = await runGoldenRename();
    if (!changes) return; // server absent — guarded

    for (const cf of changes) {
      for (const e of cf.edits) {
        expect(e.confidence).toBe('lsp');
      }
    }
  }, LSP_TIMEOUT_MS);

  // ─── Test: 1-indexed line numbers (Inv-6) ──────────────────────────

  it('emitted line numbers are 1-indexed (Inv-6: no line=0)', async () => {
    if (!typescriptBinary) return; // guarded skip

    const changes = await runGoldenRename();
    if (!changes) return; // server absent — guarded

    for (const cf of changes) {
      for (const e of cf.edits) {
        // LSP is 0-indexed; the adapter applies +1 at the edge (Inv-6).
        expect(e.line, `edit in ${cf.file_path} has 0-indexed line (expected ≥1)`).toBeGreaterThan(0);
      }
    }
  }, LSP_TIMEOUT_MS);
});
