/**
 * Regression test for issue #2605: `rename` must report every edit it applies.
 *
 * The apply step does a whole-file `\boldName\b` global replace on each touched
 * file, but the reported `changes`/`total_edits` were built from a partial
 * enumeration that (a) recorded only the definition line, (b) recorded one edit
 * per graph-ref file then broke, and (c) skipped text-search on any file already
 * covered by the graph. When a private symbol's definition and all its call
 * sites live in one file, only the definition line was reported (total_edits: 1)
 * while apply rewrote every occurrence. These tests drive the single-file repro,
 * a mixed graph/text_search multi-file rename, and a partial write failure, and
 * assert the report matches what apply actually writes in each case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import fsPromises from 'fs/promises';
import os from 'node:os';
import path from 'node:path';

// Prevent onnxruntime / native search adapters from loading at import time
// (mirrors test/unit/calltool-dispatch.test.ts). We drive the private rename()
// directly, so the graph/DB/embedding layers are never exercised.
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// rename() shells out to `rg -l` to discover text-search files. Stub it so the
// ripgrep-discovery branch is deterministic and driveable (rg is not reliably
// on PATH inside the vitest worker). Default: no hits.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn(() => '') }));
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

type Incoming = {
  calls: { filePath: string }[];
  imports: { filePath: string }[];
  extends: { filePath: string }[];
  implements: { filePath: string }[];
};
const EMPTY_INCOMING: Incoming = { calls: [], imports: [], extends: [], implements: [] };

type RenameResult = {
  status: string;
  applied: boolean;
  files_affected: number;
  total_edits: number;
  graph_edits: number;
  text_search_edits: number;
  changes: { file_path: string; edits: { line: number; confidence: string }[] }[];
  failed_files?: string[];
};

// The #2605 repro: a private free fn with exactly 4 textual occurrences of
// `rename_target` — the definition, one production call, two test calls — all
// in the same file.
const RUST_SRC = `fn rename_target(x: u32) -> u32 {
    x + 1
}

pub fn prod_call() -> u32 {
    rename_target(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_one() {
        assert_eq!(rename_target(1), 2);
    }

    #[test]
    fn unit_two() {
        assert_eq!(rename_target(2), 3);
    }
}
`;

/** 1-based occurrence lines of `rename_target` in `src` — the ground truth the
 *  report must match. Computed (not hardcoded) so editing a fixture cannot
 *  silently desync the expectation. */
function occurrenceLines(src: string): number[] {
  return src
    .split('\n')
    .map((line, i) => (/\brename_target\b/.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}
const OCCURRENCE_LINES = occurrenceLines(RUST_SRC);

/** Build a backend whose graph lookup returns the symbol (definition at
 *  src/lib.rs) with the given incoming refs. */
function stubbedBackend(incoming: Incoming = EMPTY_INCOMING): LocalBackend {
  const backend = new LocalBackend();
  vi.spyOn(
    backend as unknown as { ensureInitialized: () => Promise<void> },
    'ensureInitialized',
  ).mockResolvedValue(undefined);
  vi.spyOn(backend as unknown as { context: () => Promise<unknown> }, 'context').mockResolvedValue({
    status: 'success',
    symbol: { name: 'rename_target', filePath: 'src/lib.rs', startLine: OCCURRENCE_LINES[0] },
    incoming,
  });
  return backend;
}

function callRename(
  backend: LocalBackend,
  repoPath: string,
  params: Record<string, unknown>,
): Promise<RenameResult> {
  return (
    backend as unknown as { rename: (r: unknown, p: unknown) => Promise<RenameResult> }
  ).rename({ repoPath }, { symbol_name: 'rename_target', new_name: 'renamed_fn', ...params });
}

const editsFor = (r: RenameResult, file: string) =>
  r.changes.find((c) => c.file_path === file)?.edits ?? [];

describe('rename edit report is faithful to apply (#2605)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    execFileSyncMock.mockReturnValue(''); // default: no ripgrep hits
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-2605-'));
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'lib.rs'), RUST_SRC, 'utf-8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('previews every occurrence that apply will rewrite (dry_run)', async () => {
    const result = await callRename(stubbedBackend(), tmpDir, { dry_run: true });

    expect(result.applied).toBe(false);
    expect(result.files_affected).toBe(1);
    expect(result.total_edits).toBe(OCCURRENCE_LINES.length); // 4, not 1
    // Concrete split, not just the sum: all occurrences are in the definition
    // file, so they are graph-confidence and text_search is zero.
    expect(result.graph_edits).toBe(OCCURRENCE_LINES.length);
    expect(result.text_search_edits).toBe(0);

    const edits = editsFor(result, 'src/lib.rs');
    expect(edits.map((e) => e.line).sort((a, b) => a - b)).toEqual(OCCURRENCE_LINES);
    expect(edits.every((e) => e.confidence === 'graph')).toBe(true);

    // A dry run leaves the file untouched.
    const onDisk = await fs.readFile(path.join(tmpDir, 'src', 'lib.rs'), 'utf-8');
    expect(onDisk).toContain('rename_target');
  });

  it('reports exactly what it wrote (apply)', async () => {
    const result = await callRename(stubbedBackend(), tmpDir, { dry_run: false });

    expect(result.applied).toBe(true);
    expect(result.total_edits).toBe(OCCURRENCE_LINES.length);

    const onDisk = await fs.readFile(path.join(tmpDir, 'src', 'lib.rs'), 'utf-8');
    const renamedCount = (onDisk.match(/\brenamed_fn\b/g) || []).length;
    const stragglers = (onDisk.match(/\brename_target\b/g) || []).length;
    expect(renamedCount).toBe(OCCURRENCE_LINES.length); // all 4 rewritten
    expect(stragglers).toBe(0);

    // The reported edit count equals the number of replacements that landed.
    const reportedEdits = result.changes.reduce((n, c) => n + c.edits.length, 0);
    expect(reportedEdits).toBe(renamedCount);
  });

  it('enumerates all occurrences across graph-ref and text-search files, keeping confidence per file', async () => {
    // A graph-referencing file (not the definition) with MULTIPLE occurrences —
    // the exact "one edit per file then break" bug's other original trigger.
    const CALLER = 'use crate::rename_target;\nfn a() { rename_target(1); rename_target(2); }\n';
    // A file discovered only by ripgrep — the text_search branch.
    const NOTES = '// see rename_target for details\n';
    await fs.writeFile(path.join(tmpDir, 'src', 'caller.rs'), CALLER, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'src', 'notes.rs'), NOTES, 'utf-8');
    // rg reports the definition file (already graph — exercises never-downgrade)
    // and the text-only file.
    execFileSyncMock.mockReturnValue('src/lib.rs\nsrc/notes.rs\n');

    const backend = stubbedBackend({
      ...EMPTY_INCOMING,
      calls: [{ filePath: 'src/caller.rs' }],
    });
    const result = await callRename(backend, tmpDir, { dry_run: true });

    const callerOcc = occurrenceLines(CALLER).length; // 3
    const notesOcc = occurrenceLines(NOTES).length; // 1

    expect(result.files_affected).toBe(3);
    expect(result.total_edits).toBe(OCCURRENCE_LINES.length + callerOcc + notesOcc);
    // Split is concrete: definition + graph-ref file are graph; the rg-only file
    // is text_search. A file reached by both graph and rg keeps graph (never
    // downgraded).
    expect(result.graph_edits).toBe(OCCURRENCE_LINES.length + callerOcc);
    expect(result.text_search_edits).toBe(notesOcc);

    expect(editsFor(result, 'src/lib.rs').every((e) => e.confidence === 'graph')).toBe(true);
    expect(editsFor(result, 'src/caller.rs').map((e) => e.confidence)).toEqual(['graph', 'graph']);
    expect(editsFor(result, 'src/notes.rs').map((e) => e.confidence)).toEqual(['text_search']);
  });

  it('reports only files that landed when a write fails mid-apply (#2605 partial)', async () => {
    const CALLER = 'fn a() { rename_target(1); rename_target(2); }\n';
    await fs.writeFile(path.join(tmpDir, 'src', 'caller.rs'), CALLER, 'utf-8');
    const backend = stubbedBackend({ ...EMPTY_INCOMING, calls: [{ filePath: 'src/caller.rs' }] });

    // caller.rs write throws; lib.rs succeeds.
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(
      async (p: Parameters<typeof fsPromises.writeFile>[0]) => {
        if (String(p).endsWith(`${path.sep}caller.rs`)) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
      },
    );

    const result = await callRename(backend, tmpDir, { dry_run: false });

    expect(result.status).toBe('partial');
    expect(result.failed_files).toEqual(['src/caller.rs']);
    // The failed file's edits are NOT reported as applied: totals describe only
    // what reached disk (lib.rs), never the attempted caller.rs occurrences.
    expect(result.files_affected).toBe(1);
    expect(result.total_edits).toBe(OCCURRENCE_LINES.length);
    expect(result.graph_edits).toBe(OCCURRENCE_LINES.length);
    expect(result.changes.map((c) => c.file_path)).toEqual(['src/lib.rs']);
  });
});
