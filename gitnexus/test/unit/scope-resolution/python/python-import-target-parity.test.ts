/**
 * Parity guard for the memoized file index in `resolvePythonImportTarget`
 * (import-target.ts).
 *
 * The index replaces two per-import O(files) scans (the suffix match in
 * `resolveAbsoluteFromFiles` and the package-existence gate in
 * `hasRepoCandidate`) with O(1)/O(bucket) lookups. It MUST reproduce the exact
 * resolution result — in particular the deterministic tie-break
 * (fewest-segments, then lexicographic) and the false-positive gating that the
 * import-target.ts comments call out. These cases pin those semantics so an
 * index regression fails CI rather than silently changing resolved edges.
 */
import { describe, it, expect } from 'vitest';
import { resolvePythonImportTarget } from '../../../../src/core/ingestion/languages/python/index.js';
import type { ParsedImport } from 'gitnexus-shared';

function mkImport(targetRaw: string): ParsedImport {
  return { kind: 'absolute', targetRaw, isRelative: false, names: [] } as unknown as ParsedImport;
}

function resolve(fromFile: string, files: string[], targetRaw: string): string | null {
  return resolvePythonImportTarget(mkImport(targetRaw), {
    fromFile,
    allFilePaths: new Set(files),
  });
}

describe('resolvePythonImportTarget — index parity', () => {
  it('direct workspace-root hit wins', () => {
    expect(
      resolve('app/main.py', ['services/sync.py', 'services/__init__.py'], 'services.sync'),
    ).toBe('services/sync.py');
  });

  it('ancestor walk resolves nested namespace packages', () => {
    expect(resolve('backend/routers/cron.py', ['backend/services/sync.py'], 'services.sync')).toBe(
      'backend/services/sync.py',
    );
  });

  it('suffix fallback resolves a nested vendored layout', () => {
    expect(resolve('app/main.py', ['pkg/__init__.py', 'vendor/pkg/thing.py'], 'pkg.thing')).toBe(
      'vendor/pkg/thing.py',
    );
  });

  it('suffix tie-break prefers fewest path segments', () => {
    expect(
      resolve(
        'app/main.py',
        ['pkg/__init__.py', 'a/pkg/models.py', 'b/c/pkg/models.py'],
        'pkg.models',
      ),
    ).toBe('a/pkg/models.py');
  });

  it('suffix tie-break at equal depth is lexicographic', () => {
    expect(
      resolve(
        'app/main.py',
        ['pkg/__init__.py', 'z/pkg/models.py', 'a/pkg/models.py'],
        'pkg.models',
      ),
    ).toBe('a/pkg/models.py');
  });

  it('external dotted import is gated out by hasRepoCandidate (django.apps guard)', () => {
    expect(resolve('app/main.py', ['accounts/apps.py'], 'django.apps')).toBeNull();
  });

  it('does not suffix-match a different package basename (accounts.models vs billing/models.py)', () => {
    expect(
      resolve('app/main.py', ['accounts/__init__.py', 'billing/models.py'], 'accounts.models'),
    ).toBeNull();
  });

  it('candidate exists but no concrete file resolves to null', () => {
    expect(resolve('app/main.py', ['pkg/__init__.py'], 'pkg.ghost')).toBeNull();
  });

  it('package __init__ suffix resolves', () => {
    expect(
      resolve('app/main.py', ['pkg/__init__.py', 'x/pkg/subpkg/__init__.py'], 'pkg.subpkg'),
    ).toBe('x/pkg/subpkg/__init__.py');
  });

  it('the index is reused across imports on the same file set (no stale results)', () => {
    const files = ['pkg/__init__.py', 'a/pkg/models.py', 'vendor/pkg/thing.py'];
    const ctx = { fromFile: 'app/main.py', allFilePaths: new Set(files) };
    expect(resolvePythonImportTarget(mkImport('pkg.models'), ctx)).toBe('a/pkg/models.py');
    expect(resolvePythonImportTarget(mkImport('pkg.thing'), ctx)).toBe('vendor/pkg/thing.py');
    expect(resolvePythonImportTarget(mkImport('pkg.ghost'), ctx)).toBeNull();
  });

  it('resolves a nested package via the parent-keyed __init__ bucket (PR #1918 P2b)', () => {
    // `mypkg` is a candidate (root package), but the real target is nested under
    // vendor/. `noise/sub/__init__.py` shares the parent-bucket key (`sub`) yet
    // is filtered out by the full-suffix confirm — proving the parent bucket is
    // a candidate set, not the answer, and that the result matches the old scan.
    const files = ['mypkg/__init__.py', 'vendor/mypkg/sub/__init__.py', 'noise/sub/__init__.py'];
    expect(resolve('app/main.py', files, 'mypkg.sub')).toBe('vendor/mypkg/sub/__init__.py');
  });

  it('resolves an explicit pkg.__init__ import via the module lookup', () => {
    // `from pkg.__init__ import x` targets the package init module directly;
    // it must still resolve (it goes through the `<lastSeg>.py` = `__init__.py`
    // bucket, not the parent-keyed package bucket).
    expect(resolve('app/main.py', ['pkg/__init__.py', 'pkg/widget.py'], 'pkg.__init__')).toBe(
      'pkg/__init__.py',
    );
  });

  it('reproduces old startsWith gating for absolute paths (PR #1918 P3a)', () => {
    // Absolute file set. hasRepoCandidate must NOT gate-pass `pkg` off
    // `/repo/pkg/__init__.py` the way the first #1918 index did (its prefix set
    // dropped the leading slash). The old full-scan gate did
    // `"/repo/pkg/__init__.py".startsWith("repo/pkg/")` === false → blocked, so
    // the suffix-only file `/repo/vendor/pkg/thing.py` stays unresolved.
    expect(
      resolve(
        '/repo/app/main.py',
        ['/repo/pkg/__init__.py', '/repo/vendor/pkg/thing.py'],
        'pkg.thing',
      ),
    ).toBeNull();

    // Control: the SAME shape with repo-relative paths (what production emits)
    // gates through and resolves — proving the fix only blocks the absolute-path
    // false positive, not the real relative case.
    expect(
      resolve(
        'repo/app/main.py',
        ['repo/pkg/__init__.py', 'repo/vendor/pkg/thing.py'],
        'pkg.thing',
      ),
    ).toBe('repo/vendor/pkg/thing.py');
  });

  it('ignores non-.py files in a polyglot file set (PR #1918 P3b)', () => {
    // The index is .py-only; sibling .ts/.go files of the same basename must not
    // affect resolution. `pkg.models` resolves to the .py, never the .ts/.go.
    const files = [
      'pkg/__init__.py',
      'a/pkg/models.py',
      'a/pkg/models.ts',
      'b/pkg/models.go',
      'a/pkg/helper.ts',
    ];
    expect(resolve('app/main.py', files, 'pkg.models')).toBe('a/pkg/models.py');
    // A package whose only file is non-.py is not a repo candidate → null.
    expect(resolve('app/main.py', [...files, 'tsonly/widget.ts'], 'tsonly.widget')).toBeNull();
  });
});
