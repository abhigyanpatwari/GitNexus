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
});
