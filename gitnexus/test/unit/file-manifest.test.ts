import { describe, expect, it } from 'vitest';
import {
  createFileManifest,
  diffFileManifests,
  formatFileManifestDiffSummary,
  hasFileManifestChanges,
} from '../../src/core/incremental/file-manifest.js';

describe('file manifest incremental helpers', () => {
  it('creates a stable manifest from scanned files', () => {
    const manifest = createFileManifest(
      [
        { path: 'src/b.ts', size: 20, mtimeMs: 2000.9 },
        { path: 'src/a.ts', size: 10, mtimeMs: 1000.2 },
      ],
      '2026-04-30T12:00:00.000Z',
    );

    expect(manifest).toEqual({
      version: 1,
      generatedAt: '2026-04-30T12:00:00.000Z',
      files: {
        'src/a.ts': { size: 10, mtimeMs: 1000 },
        'src/b.ts': { size: 20, mtimeMs: 2000 },
      },
    });
  });

  it('diffs added, modified, deleted, and unchanged files', () => {
    const previous = createFileManifest(
      [
        { path: 'src/a.ts', size: 10, mtimeMs: 1000 },
        { path: 'src/b.ts', size: 20, mtimeMs: 2000 },
        { path: 'src/deleted.ts', size: 30, mtimeMs: 3000 },
      ],
      '2026-04-30T12:00:00.000Z',
    );
    const next = createFileManifest(
      [
        { path: 'src/a.ts', size: 10, mtimeMs: 1000 },
        { path: 'src/b.ts', size: 21, mtimeMs: 2000 },
        { path: 'src/new.ts', size: 5, mtimeMs: 4000 },
      ],
      '2026-04-30T12:01:00.000Z',
    );

    const diff = diffFileManifests(previous, next);

    expect(diff).toEqual({
      added: ['src/new.ts'],
      modified: ['src/b.ts'],
      deleted: ['src/deleted.ts'],
      unchanged: 1,
    });
    expect(hasFileManifestChanges(diff)).toBe(true);
    expect(formatFileManifestDiffSummary(diff)).toBe('1 added, 1 modified, 1 deleted');
  });

  it('reports no changes for equivalent manifests', () => {
    const previous = createFileManifest([{ path: 'src/a.ts', size: 10, mtimeMs: 1000 }]);
    const next = createFileManifest([{ path: 'src/a.ts', size: 10, mtimeMs: 1000.4 }]);

    const diff = diffFileManifests(previous, next);

    expect(diff).toEqual({ added: [], modified: [], deleted: [], unchanged: 1 });
    expect(hasFileManifestChanges(diff)).toBe(false);
  });
});
