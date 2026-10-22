/**
 * R `source("file.R")` exact-path lookup. The live resolver answers it from the per-pass
 * `normToRaw` map instead of `indexOf` over the whole file list for every `source()` call.
 * The map must pick exactly the file `indexOf` picked (first in list order), so these cases
 * compare both paths on the same corpus, including the duplicate-spelling and missing-file
 * cases where an index could plausibly diverge, and pin that the hot path no longer scans.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveRImportInternal,
  resolveRImportTarget,
} from '../../../../src/core/ingestion/languages/r/import-target.js';
import { getWorkspaceFileIndex } from '../../../../src/core/ingestion/import-resolvers/workspace-file-index.js';

// Raw spellings: the Windows-style duplicate of 'pkg/R/dup.R' comes FIRST, so first-wins must
// return the backslash spelling for both lookups.
const FILES = [
  'scripts\\win.R',
  'pkg\\R\\dup.R',
  'pkg/R/dup.R',
  'pkg/R/a.R',
  'pkg/R/b.R',
  'scripts/run.R',
  'scripts/helpers/util.R',
  'util.R',
  'vendor/other/util.R',
  '/abs/root.R',
];

interface Case {
  readonly title: string;
  readonly from: string;
  readonly raw: string;
}

const CASES: readonly Case[] = [
  { title: 'relative, found beside the caller', from: 'pkg/R/a.R', raw: '"b.R"' },
  { title: 'relative into a subdirectory', from: 'scripts/run.R', raw: '"helpers/util.R"' },
  { title: 'relative with ../', from: 'scripts/helpers/x.R', raw: '"../run.R"' },
  { title: 'duplicate spellings: first wins', from: 'pkg/R/a.R', raw: '"dup.R"' },
  { title: 'backslash spelling of the file', from: 'scripts/x.R', raw: '"win.R"' },
  { title: 'absolute, present', from: 'pkg/R/a.R', raw: '"/abs/root.R"' },
  { title: 'absolute, absent', from: 'pkg/R/a.R', raw: '"/abs/missing.R"' },
  { title: 'relative, absent: suffix fallback', from: 'pkg/R/a.R', raw: '"util.R"' },
  { title: 'relative, absent everywhere', from: 'pkg/R/a.R', raw: '"nowhere.R"' },
  { title: 'lowercase extension', from: 'pkg/R/a.R', raw: '"a.r"' },
];

const run = (c: Case, withMap: boolean): ReturnType<typeof resolveRImportInternal> => {
  const { normalized, all, index, normToRaw } = getWorkspaceFileIndex(new Set(FILES));
  return resolveRImportInternal(
    c.from,
    c.raw,
    normalized,
    all,
    null,
    index,
    withMap ? normToRaw : undefined,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRImportInternal: source() exact-path lookup', () => {
  it.each(CASES)('$title: the index agrees with indexOf', (c) => {
    expect(run(c, true)).toEqual(run(c, false));
  });

  it('positive controls: the corpus really exercises found, duplicate and missing files', () => {
    const byTitle = (title: string) => run(CASES.find((c) => c.title === title)!, true);
    expect(byTitle('relative, found beside the caller')).toBe('pkg/R/b.R');
    expect(byTitle('duplicate spellings: first wins')).toBe('pkg\\R\\dup.R');
    expect(byTitle('backslash spelling of the file')).toBe('scripts\\win.R');
    expect(byTitle('absolute, present')).toBe('/abs/root.R');
    expect(byTitle('absolute, absent')).toBeNull();
    expect(byTitle('relative, absent everywhere')).toBeNull();
  });

  it('does not scan the file list for an exact hit when the index is supplied', () => {
    const { normalized, all, index, normToRaw } = getWorkspaceFileIndex(new Set(FILES));
    const indexOf = vi.spyOn(normalized, 'indexOf');
    expect(
      resolveRImportInternal('pkg/R/a.R', '"b.R"', normalized, all, null, index, normToRaw),
    ).toBe('pkg/R/b.R');
    expect(
      resolveRImportInternal('pkg/R/a.R', '"/abs/root.R"', normalized, all, null, index, normToRaw),
    ).toBe('/abs/root.R');
    expect(indexOf).not.toHaveBeenCalled();
  });

  it('still scans (and agrees) when called without the index', () => {
    const { normalized, all, index } = getWorkspaceFileIndex(new Set(FILES));
    const indexOf = vi.spyOn(normalized, 'indexOf');
    expect(resolveRImportInternal('pkg/R/a.R', '"b.R"', normalized, all, null, index)).toBe(
      'pkg/R/b.R',
    );
    expect(indexOf).toHaveBeenCalled();
  });
});

describe('resolveRImportTarget: source() through the live adapter', () => {
  // `source()` carries no wildcard/named context, so the adapter takes the file-path branch.
  it.each(CASES)('$title: matches the indexOf result', (c) => {
    const viaAdapter = resolveRImportTarget(c.raw, c.from, new Set(FILES));
    expect(viaAdapter).toEqual(run(c, false));
  });

  it('does not scan the file list on a repeat call for the same file set', () => {
    const files = new Set(FILES);
    resolveRImportTarget('"b.R"', 'pkg/R/a.R', files); // builds the per-set index
    const indexOf = vi.spyOn(Array.prototype, 'indexOf');
    expect(resolveRImportTarget('"b.R"', 'pkg/R/a.R', files)).toBe('pkg/R/b.R');
    expect(indexOf.mock.calls.filter(([needle]) => needle === 'pkg/R/b.R')).toEqual([]);
  });
});
