/**
 * Unit Tests: `workspaceEditToChanges` + `applyPreciseEdits` (WI-3, issue #159 P2).
 *
 * The two functions form the LSP→`rename`-wire bridge:
 *
 *   - `workspaceEditToChanges(edit, repoPath)` is a pure adapter that
 *     converts an LSP `WorkspaceEdit` (either `.changes` or
 *     `.documentChanges` form) to the `changes` shape the existing
 *     `rename` tool emits: `{file_path, edits:[{line, old_text,
 *     new_text, confidence:'lsp'}]}`. It refuses (returns `null`)
 *     wholesale on: any edit in `node_modules`/`.d.ts`, any resolved
 *     path OUTSIDE `repoPath`, any multi-line range, any non-text
 *     `documentChanges` op (kind: create/rename/delete), or an
 *     empty/malformed edit. Otherwise it emits one entry per
 *     affected file.
 *   - `applyPreciseEdits(changes, {repoPath, dryRun})` is the
 *     **precise per-edit applier** (KD-2). Per file, it sorts the
 *     edits DESCENDING by (line, character) and splices `newText`
 *     into exact ranges, then writes the file once. With
 *     `dryRun=true` it returns the count of edits that WOULD be
 *     written but never calls `fs.writeFile`. With `dryRun=false`
 *     it writes each file once regardless of edit count.
 *
 * Methodology (per WI-3 spec):
 *   - BVA: line 0 → emitted `line: 1`; line N-1 → emitted `line: N`;
 *     OOB line → adapter cannot resolve the line text → it refuses.
 *   - EP: form partitions (.changes / .documentChanges / both) +
 *     refuse partitions (node_modules / .d.ts / out-of-repo /
 *     multi-line / non-text-op / malformed).
 *   - error-guessing: same-line multiple edits in REVERSE input
 *     order (descending sort MUST still splice correctly), dryRun
 *     suppresses writeFile, every emitted edit has `confidence:'lsp'`.
 *
 * The test mocks `fs/promises` via `vi.mock` and uses a hoisted
 * `fileContents` map so test bodies can stage file content per case.
 * The dispatch on the readFile path matches by absolute path
 * (mock uses `path.resolve` then `endsWith` on keys, mirroring
 * `rename-accuracy.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ─── Hoisted mock state ────────────────────────────────────────────────
//
// vi.hoisted() lets the mock factory (which runs at module-load
// time, before vi.mock) share state with the test bodies (which run
// after all imports). The factory only knows the SHAPE; bodies fill
// in per-case content. The dispatch key is the absolute path; the
// mock resolves symlinks/styles and matches by `endsWith` on each
// key so tests can use either forward- or back-slash separators.

const { fileContents, writeCalls } = vi.hoisted(() => ({
  /**
   * In-memory filesystem. Keys are absolute paths (the mock resolves
   * keys with path.resolve and matches by `endsWith` on the test
   * path, mirroring the rename-accuracy.test.ts pattern).
   */
  fileContents: new Map<string, string>(),

  /**
   * Recorded `writeFile(absPath, content)` calls. Used by tests
   * to assert the applier writes the right content to the right
   * file, and to assert dryRun suppresses the call.
   */
  writeCalls: [] as Array<{ absPath: string; content: string }>,
}));

// ─── Mock fs/promises ──────────────────────────────────────────────────
//
// The adapter calls readFile; the applier calls readFile + writeFile.
// The mock mirrors both under `default` AND named exports so callers
// using either `import fs from 'fs/promises'` or
// `import { readFile, writeFile } from 'fs/promises'` see the mocks
// (esModuleInterop resolution — see vitest-fs-default-import-mock
// in MEMORY.md).

vi.mock('fs/promises', () => {
  // F1: realpath is called by `defaultRealpath` for the symlink
  // TOCTOU re-check. The default behavior in the mock is to
  // echo the abs path (no symlink resolution happens), so
  // existing tests that don't model symlinks see no behavior
  // change. The F1 tests inject a custom `realpath` via
  // `ApplierDeps.realpath` to exercise the resolve-outside and
  // broken-symlink paths.
  const realpath = vi.fn(async (p: string) => String(p));
  return {
    default: {
      readFile: vi.fn(async (filePath: string) => {
        const p = String(filePath).replace(/\\/g, '/');
        for (const [key, val] of fileContents.entries()) {
          const k = key.replace(/\\/g, '/');
          if (p === k || p.endsWith('/' + k) || p.endsWith(k)) {
            return val;
          }
        }
        const e: any = new Error(`ENOENT (mock): ${filePath}`);
        e.code = 'ENOENT';
        throw e;
      }),
      writeFile: vi.fn(async (absPath: string, content: string) => {
        writeCalls.push({ absPath: String(absPath), content });
        // Mirror what the real writeFile would do: update the in-memory
        // fileContents so a subsequent readFile returns the new content.
        const norm = String(absPath).replace(/\\/g, '/');
        for (const key of Array.from(fileContents.keys())) {
          const k = key.replace(/\\/g, '/');
          if (norm === k || norm.endsWith('/' + k) || norm.endsWith(k)) {
            fileContents.set(key, content);
            return;
          }
        }
        fileContents.set(String(absPath), content);
      }),
      realpath,
    },
    readFile: vi.fn(async (filePath: string) => {
      const p = String(filePath).replace(/\\/g, '/');
      for (const [key, val] of fileContents.entries()) {
        const k = key.replace(/\\/g, '/');
        if (p === k || p.endsWith('/' + k) || p.endsWith(k)) {
          return val;
        }
      }
      const e: any = new Error(`ENOENT (mock): ${filePath}`);
      e.code = 'ENOENT';
      throw e;
    }),
    writeFile: vi.fn(async (absPath: string, content: string) => {
      writeCalls.push({ absPath: String(absPath), content });
      const norm = String(absPath).replace(/\\/g, '/');
      for (const key of Array.from(fileContents.keys())) {
        const k = key.replace(/\\/g, '/');
        if (norm === k || norm.endsWith('/' + k) || norm.endsWith(k)) {
          fileContents.set(key, content);
          return;
        }
      }
      fileContents.set(String(absPath), content);
    }),
    realpath,
  };
});

// ─── Imports under test ───────────────────────────────────────────────

import {
  workspaceEditToChanges,
  workspaceEditToApplierChanges,
  applyPreciseEdits,
  __test__,
  type WorkspaceEdit,
  type ChangesFile,
  type ApplierChangesFile,
} from '../../../src/core/ingestion/lsp/reference-provider.js';

// ─── Constants ────────────────────────────────────────────────────────

const REPO = process.platform === 'win32' ? 'C:\\repo' : '/repo';
// POSIX repo path (the adapter does `path.relative(repoPath, abs)`,
// which on POSIX produces clean relative paths).
const REPO_NORM = REPO.replace(/\\/g, '/');
const FILE_URI = (p: string) =>
  process.platform === 'win32' ? `file:///${p.replace(/\\/g, '/')}` : `file://${p}`;
const ABS = (rel: string) => path.resolve(REPO, rel);

/** Stage a file in the in-memory mock. The key is the absolute path. */
function stage(relPath: string, content: string): string {
  const abs = ABS(relPath);
  fileContents.set(abs, content);
  return abs;
}

/** Build a `.changes` WorkspaceEdit keyed by the URI of `relPath`. */
function changesForm(relPath: string, edits: any[]): WorkspaceEdit {
  return { changes: { [FILE_URI(ABS(relPath))]: edits } };
}

/** Build a `.documentChanges` WorkspaceEdit (text edits only). */
function docChangesForm(relPath: string, edits: any[]): WorkspaceEdit {
  return {
    documentChanges: [
      { textDocument: { uri: FILE_URI(ABS(relPath)) }, edits },
    ],
  };
}

// ─── Test suite ───────────────────────────────────────────────────────

// (S-23 + S-28) Hoisted per-file fs-mock reset — every test
// in this file gets a fresh `fileContents` map and an empty
// `writeCalls` log. Eliminates the 5× per-describe
// `beforeEach(() => { fileContents.clear(); writeCalls.length = 0; })`
// boilerplate. The mock factory (the `vi.mock('fs/promises', …)`
// at the top of this file) reuses these hoisted refs, so a
// single reset point is correct — clearing in one place clears
// for every test that reads/writes the in-memory fs.
beforeEach(() => {
  fileContents.clear();
  writeCalls.length = 0;
});

describe('WI-3 — workspaceEditToChanges (adapter)', () => {
  // ─── Form partitions: .changes vs .documentChanges ────────────────

  it('A1: .changes form → emits {file_path, edits[]} with 1-indexed lines', async () => {
    stage('src/foo.ts', 'export const X = 1;\n');
    const edit = changesForm('src/foo.ts', [
      {
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } },
        newText: 'Y',
      },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].file_path).toBe('src/foo.ts');
    expect(result![0].edits).toHaveLength(1);
    // BVA: LSP line 0 → emitted 1
    expect(result![0].edits[0].line).toBe(1);
    // old_text = trimmed source line
    expect(result![0].edits[0].old_text).toBe('export const X = 1;');
    // new_text = line with the range replaced by newText, trimmed
    expect(result![0].edits[0].new_text).toBe('export const Y = 1;');
    // confidence must be 'lsp'
    expect(result![0].edits[0].confidence).toBe('lsp');
  });

  it('A2: .documentChanges form → emits {file_path, edits[]} with 1-indexed lines', async () => {
    stage('src/bar.ts', 'function f() { return 1; }\n');
    const edit = docChangesForm('src/bar.ts', [
      {
        range: { start: { line: 0, character: 9 }, end: { line: 0, character: 10 } },
        newText: 'g',
      },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    expect(result![0].file_path).toBe('src/bar.ts');
    expect(result![0].edits[0].line).toBe(1);
    expect(result![0].edits[0].old_text).toBe('function f() { return 1; }');
    expect(result![0].edits[0].new_text).toBe('function g() { return 1; }');
    expect(result![0].edits[0].confidence).toBe('lsp');
  });

  it('A3: same line, multiple edits in REVERSE order → both emitted on the same line', async () => {
    // Two edits on line 0 (0-indexed) → emitted line: 1 (1-indexed).
    // Input order is REVERSE: char 0..3 then char 5..6.
    // The adapter does NOT sort — it preserves input order. Sorting
    // is the applier's job (KD-2). The adapter only translates.
    stage('src/multi.ts', 'aaa bbb ccc\n');
    const edit = changesForm('src/multi.ts', [
      // Edit 0: char 4..7 ("bbb") → "Z". Line 0 → emitted line 1.
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: 'Z' },
      // Edit 1: char 0..3 ("aaa") → "X". Same line, both edits on line 1 (emitted).
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    expect(result![0].edits).toHaveLength(2);
    // Both edits share the same emitted line (1-indexed, BVA: 0 → 1)
    expect(result![0].edits[0].line).toBe(1);
    expect(result![0].edits[1].line).toBe(1);
    // The adapter must produce independent old_text/new_text for each.
    // Edit 0: char 4..7 ("bbb") → "Z", trimmed: "aaa Z ccc"
    expect(result![0].edits[0].old_text).toBe('aaa bbb ccc');
    expect(result![0].edits[0].new_text).toBe('aaa Z ccc');
    // Edit 1: char 0..3 ("aaa") → "X", trimmed: "X bbb ccc"
    expect(result![0].edits[1].old_text).toBe('aaa bbb ccc');
    expect(result![0].edits[1].new_text).toBe('X bbb ccc');
  });

  it('A4: BVA — line N-1 (last line) → emitted line N (1-indexed)', async () => {
    // 3 lines; edit on line index 2 (the last) → emitted line 3.
    stage('src/last.ts', 'line 0\nline 1\nline 2\n');
    const edit = changesForm('src/last.ts', [
      { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 6 } }, newText: 'X' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    expect(result![0].edits[0].line).toBe(3);
    expect(result![0].edits[0].old_text).toBe('line 2');
    expect(result![0].edits[0].new_text).toBe('line X');
  });

  // ─── Refuse partitions (KD-7) ────────────────────────────────────

  it('R1: refuse — edit resolves under node_modules (whole attempt → null)', async () => {
    stage('node_modules/lib/foo.ts', 'export const X = 1;\n');
    const edit = changesForm('node_modules/lib/foo.ts', [
      { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'Y' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R2: refuse — edit resolves to a .d.ts file (whole attempt → null)', async () => {
    stage('src/types.d.ts', 'export declare const X: number;\n');
    const edit = changesForm('src/types.d.ts', [
      { range: { start: { line: 0, character: 23 }, end: { line: 0, character: 24 } }, newText: 'Y' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R3: refuse — file path resolves OUTSIDE the repo root (whole attempt → null)', async () => {
    // File URI points to /etc/passwd — resolves outside /repo.
    const edit: WorkspaceEdit = {
      changes: {
        'file:///etc/passwd': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' },
        ],
      },
    };
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R4: refuse — multi-line range (start.line !== end.line) (whole attempt → null)', async () => {
    stage('src/multi.ts', 'line 0\nline 1\nline 2\n');
    const edit = changesForm('src/multi.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'X' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R5: refuse — non-text documentChanges op (kind: create) (whole attempt → null)', async () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'create', uri: FILE_URI(ABS('src/new.ts')) } as any,
      ],
    };
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R6: refuse — non-text documentChanges op (kind: rename) (whole attempt → null)', async () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'rename', oldUri: FILE_URI(ABS('src/a.ts')), newUri: FILE_URI(ABS('src/b.ts')) } as any,
      ],
    };
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R7: refuse — non-text documentChanges op (kind: delete) (whole attempt → null)', async () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'delete', uri: FILE_URI(ABS('src/gone.ts')) } as any,
      ],
    };
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R8: refuse — empty edit (neither .changes nor .documentChanges) (whole attempt → null)', async () => {
    const edit: WorkspaceEdit = {};
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  it('R9: refuse — line out of bounds (line index ≥ source line count)', async () => {
    // Source has 2 lines; the edit claims line index 5 (does not exist).
    // The adapter cannot read the line text → refuse.
    stage('src/short.ts', 'a\nb\n');
    const edit = changesForm('src/short.ts', [
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }, newText: 'X' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  // ─── Mixed: a valid edit + a refused edit → whole attempt null ───

  it('R10: ANY refuse condition taints the whole attempt → null (wholesale)', async () => {
    stage('src/ok.ts', 'export const X = 1;\n');
    stage('node_modules/lib/foo.ts', 'export const Y = 2;\n');
    // Two URIs: one valid, one under node_modules. Refuse wholesale.
    const edit: WorkspaceEdit = {
      changes: {
        [FILE_URI(ABS('src/ok.ts'))]: [
          { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'A' },
        ],
        [FILE_URI(ABS('node_modules/lib/foo.ts'))]: [
          { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'B' },
        ],
      },
    };
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).toBeNull();
  });

  // ─── Output shape contract ────────────────────────────────────────

  it('S1: every emitted edit has confidence:"lsp"', async () => {
    stage('src/a.ts', 'aaa\nbbb\n');
    const edit = changesForm('src/a.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'Y' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    for (const f of result!) {
      for (const e of f.edits) {
        expect(e.confidence).toBe('lsp');
      }
    }
  });
});

// ─── applyPreciseEdits ────────────────────────────────────────────────

describe('WI-3 — applyPreciseEdits (precise per-edit applier, KD-2)', () => {
  // ─── BVA: sort descending by (line, character), splice in place ──

  it('P1: same-line edits, input in REVERSE order → applied right-to-left (correct result)', async () => {
    // Source: "  aaa bbb ccc"
    // Edit A: char 0..3 ("  a") → "X"  → "X bbb ccc"
    // Edit B: char 6..9 ("bbb") → "YYY" → "  aaa YYY ccc"
    //
    // The applier sorts DESCENDING by (line, character) and applies
    // right-to-left, so edit B (char 6) is applied first, then edit A
    // (char 0). If the sort were ascending, edit A at char 0 would
    // shift every later offset, corrupting edit B.
    stage('src/multi.ts', '  aaa bbb ccc\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/multi.ts',
        edits: [
          {
            // A — leftward (char 0..3) — raw newText="X" replaces "  a"
            line: 1,
            old_text: '  aaa bbb ccc',
            new_text: 'X bbb ccc',
            newText: 'X',
            confidence: 'lsp',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          },
          {
            // B — rightward (char 6..9) — raw newText="YYY" replaces "bbb"
            // Should be applied FIRST (descending sort by character).
            line: 1,
            old_text: '  aaa bbb ccc',
            new_text: '  aaa YYY ccc',
            newText: 'YYY',
            confidence: 'lsp',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          },
        ],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    // 2 edits in the file → 2 written.
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    // writeFile called exactly once for the single file (write-once)
    expect(writeCalls).toHaveLength(1);
    // The new content must be the result of applying BOTH edits.
    // If the sort is wrong (ascending), edit A at char 0 would shift
    // B's character range, producing "X aaa YYY ccc" — assert we
    // did NOT get that.
    const written = writeCalls[0].content;
    // Source on disk: "  aaa bbb ccc\n" (2 leading spaces).
    // Edit A: char 0..3 ("  a") → "X" → "Xaa bbb ccc"
    // Edit B: char 6..9 ("bbb") → "YYY" → "  aaa YYY ccc"
    // After descending sort: B is applied first → "  aaa YYY ccc"
    // then A on the already-modified line → "Xaa YYY ccc".
    expect(written).toBe('Xaa YYY ccc\n');
  });

  it('P2: different lines, input in REVERSE order → applied bottom-to-top', async () => {
    // Source has 3 lines. Edits target line 1 and line 2 (1-indexed).
    // Input order is REVERSE: line 2 first, then line 1. The applier
    // sorts descending by (line, character), so line 2 is applied
    // first, then line 1 — no offset shift across lines.
    stage('src/three.ts', 'aaa\nbbb\nccc\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/three.ts',
        edits: [
          { line: 2, old_text: 'bbb', new_text: 'BBB', newText: 'BBB', confidence: 'lsp', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
          { line: 3, old_text: 'ccc', new_text: 'CCC', newText: 'CCC', confidence: 'lsp', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
        ],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    expect(result.written).toBe(2);
    const written = writeCalls[0].content;
    expect(written).toBe('aaa\nBBB\nCCC\n');
  });

  it('P3: dryRun=true → NO writeFile call, counts reflect would-be writes', async () => {
    stage('src/x.ts', 'aaa\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/x.ts',
        edits: [{
          line: 1,
          old_text: 'aaa',
          new_text: 'XXX',
          newText: 'XXX',
          confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: true });
    expect(writeCalls).toHaveLength(0);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    // The in-memory file content should NOT have changed.
    expect(fileContents.get(ABS('src/x.ts'))).toBe('aaa\n');
  });

  it('P4: dryRun=false → exactly ONE writeFile per file, regardless of edit count', async () => {
    stage('src/many.ts', 'a\nb\nc\nd\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/many.ts',
        edits: [
          { line: 1, old_text: 'a', new_text: 'A', newText: 'A', confidence: 'lsp', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
          { line: 2, old_text: 'b', new_text: 'B', newText: 'B', confidence: 'lsp', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
          { line: 3, old_text: 'c', new_text: 'C', newText: 'C', confidence: 'lsp', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
          { line: 4, old_text: 'd', new_text: 'D', newText: 'D', confidence: 'lsp', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } },
        ],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    expect(result.written).toBe(4);
    expect(result.skipped).toBe(0);
    // 4 edits but 1 file → exactly 1 writeFile call.
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].content).toBe('A\nB\nC\nD\n');
  });

  it('P5: multiple files → one writeFile per file, written count = total edits', async () => {
    stage('src/a.ts', 'aaa\n');
    stage('src/b.ts', 'bbb\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/a.ts',
        edits: [
          { line: 1, old_text: 'aaa', new_text: 'AAA', newText: 'AAA', confidence: 'lsp', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
          { line: 1, old_text: 'aaa', new_text: 'AAA', newText: 'AAA', confidence: 'lsp', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        ],
      },
      {
        file_path: 'src/b.ts',
        edits: [
          { line: 1, old_text: 'bbb', new_text: 'BBB', newText: 'BBB', confidence: 'lsp', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        ],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    expect(result.written).toBe(3);
    expect(writeCalls).toHaveLength(2);
  });

  it('P6: empty changes array → zero writes, counts both 0', async () => {
    const result = await applyPreciseEdits([], { repoPath: REPO, dryRun: false });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('P7: out-of-repo file_path is refused (skipped) — does NOT throw, does NOT write', async () => {
    // Stage a file outside the repo. The applier's repo-root
    // containment MUST refuse it (KD-7, Inv-8) and skip the write
    // without throwing — the caller (WI-4) handles the skip count.
    stage('src/in-repo.ts', 'aaa\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: '../escape.ts', // resolves outside /repo
        edits: [{
          line: 1,
          old_text: 'x',
          new_text: 'y',
          newText: 'y',
          confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        }],
      },
      {
        file_path: 'src/in-repo.ts',
        edits: [{
          line: 1,
          old_text: 'aaa',
          new_text: 'AAA',
          newText: 'AAA',
          confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    // The in-repo edit was written; the out-of-repo one was skipped.
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].absPath).toBe(ABS('src/in-repo.ts'));
  });

  // ─── E-1: content-injected fast path ────────────────────────────
  //
  // The adapter (`workspaceEditToApplierChanges`) carries the
  // pre-read `content` on each emitted `ApplierChangesFile`.
  // The applier MUST use it without re-reading the file via
  // the injected `readFile`. This test pins the fast path:
  //   - the `readFile` mock is set to a sentinel that, if
  //     called, would fail the test (we assert `not.toHaveBeenCalled`).
  //   - `change.content` is pre-populated with the splice input.
  //   - the write still happens once, with the expected spliced
  //     content (the fast path produces the same result as the
  //     readFile path).

  it('E1.1: change.content is set → readFile is NOT called for that file', async () => {
    const readFile = vi.fn(async () => {
      // If the applier calls readFile, this throws — the
      // test fails with a clear "ENOENT (mock)" message.
      throw Object.assign(new Error('readFile MUST NOT be called when change.content is pre-set'), { code: 'ENOTPERMITTED' });
    });
    const writeFile = vi.fn(async () => undefined);
    const realpath = vi.fn(async (p: string) => p);
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/injected.ts',
        content: 'aaa\nbbb\nccc\n',
        edits: [{
          line: 2, old_text: 'bbb', new_text: 'BBB', newText: 'BBB', confidence: 'lsp',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, {
      repoPath: REPO,
      dryRun: false,
      deps: { readFile, writeFile, realpath },
    });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(ABS('src/injected.ts'), 'aaa\nBBB\nccc\n');
  });
});

// ─── Cross-Contract: shape must match what `rename` emits ────────────

describe('WI-3 — output shape matches the existing `rename` changes shape', () => {
  it('C1: emitted ChangesFile carries only the public display fields (F5 split)', async () => {
    stage('src/contract.ts', 'export const A = 1;\n');
    const edit = changesForm('src/contract.ts', [
      { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'B' },
    ]);
    const result = await workspaceEditToChanges(edit, REPO);
    expect(result).not.toBeNull();
    // The PUBLIC shape (F5 split) must be: {file_path, edits:Array<{line, old_text, new_text, confidence}>}.
    // The raw LSP `newText` / `range` are NOT on the public type —
    // they live on the `@internal` `ApplierChangesFileEdit` extension
    // (use `workspaceEditToApplierChanges` for that).
    const f = result![0];
    expect(Object.keys(f).sort()).toEqual(['edits', 'file_path']);
    expect(Object.keys(f.edits[0]).sort()).toEqual([
      'confidence',
      'line',
      'new_text',
      'old_text',
    ]);
    expect(f.edits[0].confidence).toBe('lsp');
  });

  it('C1b: ApplierChangesFile shape carries the precise splice fields (F5 split)', async () => {
    stage('src/contract.ts', 'export const A = 1;\n');
    const edit = changesForm('src/contract.ts', [
      { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'B' },
    ]);
    const result = await workspaceEditToApplierChanges(edit, REPO);
    expect(result).not.toBeNull();
    // The applier shape (F5 split) adds `newText` + `range` to
    // every edit so `applyPreciseEdits` can do the character-
    // precise splice (KD-2) without re-deriving them. The
    // E-1 fast-path adds `content` (the file's pre-read content)
    // so the applier can skip its own `readFile`.
    const f = result![0];
    expect(Object.keys(f).sort()).toEqual(['content', 'edits', 'file_path']);
    expect(Object.keys(f.edits[0]).sort()).toEqual([
      'confidence',
      'line',
      'newText',
      'new_text',
      'old_text',
      'range',
    ]);
    expect(f.edits[0].newText).toBe('B');
    expect(f.content).toBe('export const A = 1;\n');
  });
});

// ─── __test__ exports ────────────────────────────────────────────────

describe('WI-3 — module exports', () => {
  it('exposes internal helpers via __test__', () => {
    expect(__test__).toBeDefined();
    // The internal helpers are exported for white-box tests.
    // The exact key set is intentionally not pinned here — it is
    // part of the public-ish test surface and can grow with future
    // helpers. We just verify the object exists and is non-null.
    expect(typeof __test__).toBe('object');
  });
});

// ─── F6: partial-deps footgun guard ──────────────────────────────────
//
// A partial `ApplierDeps` bag (e.g. only `readFile`) would silently
// fall back to the real `fs.writeFile` for the missing `writeFile`
// field, making test setups that mock only reads either leak to
// real disk (test pollution) or have unreadable mocks. The
// validator refuses this at the entry point so the failure is loud.

describe('applyPreciseEdits — partial-deps guard (F6)', () => {
  it('F6.1: deps:{readFile} only (no writeFile) → throws synchronously', async () => {
    // A readFile mock is provided but no writeFile. The validator
    // must reject this — otherwise a partial test setup would
    // silently fall through to the real fs.writeFile.
    const partialRead: any = vi.fn(async () => 'x');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/partial.ts',
        edits: [{
          line: 1, old_text: 'x', new_text: 'y', newText: 'y', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        }],
      },
    ];
    await expect(
      applyPreciseEdits(changes, {
        repoPath: REPO,
        dryRun: false,
        deps: { readFile: partialRead },
      }),
    ).rejects.toThrow(/readFile and writeFile must be provided together/);
    // No real writeFile must have been called either way.
    expect(writeCalls).toHaveLength(0);
  });

  it('F6.2: deps:{writeFile} only (no readFile) → throws synchronously', async () => {
    // Symmetric to F6.1: writeFile provided but no readFile.
    const partialWrite: any = vi.fn(async () => undefined);
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/partial.ts',
        edits: [{
          line: 1, old_text: 'x', new_text: 'y', newText: 'y', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        }],
      },
    ];
    await expect(
      applyPreciseEdits(changes, {
        repoPath: REPO,
        dryRun: false,
        deps: { writeFile: partialWrite },
      }),
    ).rejects.toThrow(/readFile and writeFile must be provided together/);
  });

  it('F6.3: deps:{} (empty) — all defaults, no throw', async () => {
    // An EMPTY deps bag is allowed: the validator treats "neither
    // present" as "use both defaults". This is the production path.
    stage('src/empty.ts', 'aaa\n');
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/empty.ts',
        edits: [{
          line: 1, old_text: 'aaa', new_text: 'AAA', newText: 'AAA', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        }],
      },
    ];
    // The defaults are the mocked fs/promises from this suite's
    // top-of-file vi.mock, so this should run to completion with
    // the same write-once contract as P4.
    const result = await applyPreciseEdits(changes, { repoPath: REPO, dryRun: false });
    expect(result.written).toBe(1);
  });
});

// ─── F1: symlink-redirect TOCTOU guard ────────────────────────────────
//
// A symlink under the repo that resolves outside (e.g. a
// malicious `<repo>/escape` → `/tmp/outside`) would pass the
// textual `isWithinRepo` gate but escape via the real `writeFile`
// call (which follows symlinks). The applier must re-check
// containment against the resolved realpath before any write
// can land outside the repo. The realpath check is exposed via
// `deps.realpath` for testability (production callers omit it
// and the applier uses `fs/promises.realpath`).

describe('applyPreciseEdits — symlink-redirect TOCTOU guard (F1)', () => {
  it('F1.1: realpath resolves OUTSIDE repo → skip the write (no real writeFile call)', async () => {
    // A "file" whose realpath resolves to /tmp/outside (escape).
    // The textual path is inside the repo (the symlink lives
    // there) but the realpath re-check must refuse.
    const evilReal = '/tmp/outside-target';
    const readFile = vi.fn(async (abs: string) => {
      if (abs.endsWith('evil-link')) return 'line1\nline2\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const writeFile = vi.fn(async () => undefined);
    const realpath = vi.fn(async (abs: string) => {
      if (abs.endsWith('evil-link')) return evilReal;
      return abs;
    });
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'evil-link',
        edits: [{
          line: 1, old_text: 'line1', new_text: 'LINE1', newText: 'LINE1', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, {
      repoPath: REPO,
      dryRun: false,
      deps: { readFile, writeFile, realpath },
    });
    // The applier counted the edit as skipped (not written).
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    // And the writeFile mock was NOT called for the escape target.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('F1.2: realpath throws (broken symlink) → skip, not throw', async () => {
    // A broken symlink (realpath throws ENOENT). The applier
    // must treat the edit as skipped, not throw, and must not
    // call writeFile.
    const readFile = vi.fn(async (abs: string) => {
      if (abs.endsWith('broken-link')) return 'line1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const writeFile = vi.fn(async () => undefined);
    const realpath = vi.fn(async (abs: string) => {
      if (abs.endsWith('broken-link')) {
        throw Object.assign(new Error('ENOENT (broken symlink)'), { code: 'ENOENT' });
      }
      return abs;
    });
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'broken-link',
        edits: [{
          line: 1, old_text: 'line1', new_text: 'LINE1', newText: 'LINE1', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, {
      repoPath: REPO,
      dryRun: false,
      deps: { readFile, writeFile, realpath },
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('F1.3: realpath resolves INSIDE repo → write proceeds', async () => {
    // Sanity check: when realpath is injected and resolves to
    // an in-repo path, the write proceeds normally. The
    // re-check is a no-op in the common case.
    const inRepoReal = `${REPO}/src/normal.ts`;
    const readFile = vi.fn(async () => 'aaa\n');
    const writeFile = vi.fn(async () => undefined);
    const realpath = vi.fn(async (abs: string) => {
      if (abs.endsWith('normal.ts')) return inRepoReal;
      return abs;
    });
    const changes: ApplierChangesFile[] = [
      {
        file_path: 'src/normal.ts',
        edits: [{
          line: 1, old_text: 'aaa', new_text: 'AAA', newText: 'AAA', confidence: 'lsp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        }],
      },
    ];
    const result = await applyPreciseEdits(changes, {
      repoPath: REPO,
      dryRun: false,
      deps: { readFile, writeFile, realpath },
    });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(inRepoReal, 'AAA\n');
  });
});
