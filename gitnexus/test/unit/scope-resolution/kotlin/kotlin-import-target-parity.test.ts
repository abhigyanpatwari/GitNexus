/**
 * Parity guard for the memoized file index in `resolveKotlinImportTarget`
 * (`languages/kotlin/import-target.ts`).
 *
 * The index replaces four per-import O(files) scans — the cascade of
 * exact/suffix, directory-child, package fan-out and progressive prefix strip —
 * with O(1) lookups. It MUST reproduce the exact resolution result, including
 * the tie-breaks the scans implemented implicitly through iteration order.
 * These cases pin those semantics, so an index regression fails CI instead of
 * silently moving resolved edges in every Kotlin repository.
 */
import { describe, it, expect } from 'vitest';
import { resolveKotlinImportTarget } from '../../../../src/core/ingestion/languages/kotlin/import-target.js';
import type { ParsedImport } from 'gitnexus-shared';

function resolve(
  files: string[],
  targetRaw: string,
  fromFile = 'App.kt',
): string | readonly string[] | null {
  const parsed = { kind: 'named', localName: 'X', importedName: 'X', targetRaw } as ParsedImport;
  return resolveKotlinImportTarget(parsed, { fromFile, allFilePaths: new Set(files) } as never);
}

describe('resolveKotlinImportTarget — index parity', () => {
  it('tier 1: exact path match wins', () => {
    expect(resolve(['util/User.kt', 'util/Repo.kt'], 'util.User')).toBe('util/User.kt');
  });

  it('tier 1: suffix match when the import is not workspace-rooted', () => {
    expect(resolve(['src/main/kotlin/util/User.kt'], 'util.User')).toBe(
      'src/main/kotlin/util/User.kt',
    );
  });

  it('an exact match anywhere beats a suffix match found earlier', () => {
    // The scan returned on the first EXACT hit but only remembered the first
    // suffix hit, so an exact match later in iteration order still won.
    expect(resolve(['deep/util/User.kt', 'util/User.kt'], 'util.User')).toBe('util/User.kt');
  });

  it('first suffix match wins in iteration order when no exact match exists', () => {
    expect(resolve(['a/util/User.kt', 'b/util/User.kt'], 'util.User')).toBe('a/util/User.kt');
    expect(resolve(['b/util/User.kt', 'a/util/User.kt'], 'util.User')).toBe('b/util/User.kt');
  });

  it('tier 2: the stripped path resolves a member to its declaring file', () => {
    // `util.OneArg.writeAudit` — the last segment is a member, not a file, so
    // the stripped path `util/OneArg` is what has to match. This tier is
    // reached only after the full path misses all of tier 1.
    expect(resolve(['util/OneArg.kt'], 'util.OneArg.writeAudit')).toBe('util/OneArg.kt');
    expect(resolve(['util/OneArg.kt', 'util/Other.kt'], 'util.OneArg.writeAudit')).toBe(
      'util/OneArg.kt',
    );
  });

  it('tier 2 reaches a file by suffix, not just exactly', () => {
    expect(resolve(['src/main/kotlin/util/OneArg.kt'], 'util.OneArg.writeAudit')).toBe(
      'src/main/kotlin/util/OneArg.kt',
    );
  });

  it('a multi-segment suffix matches on the whole segment run', () => {
    // The suffix map is keyed per component-suffix, not per basename, so
    // `com/example/User` must hit as one key rather than filtering a `User`
    // bucket. An exact match still wins over it.
    expect(resolve(['src/main/com/example/User.kt'], 'com.example.User')).toBe(
      'src/main/com/example/User.kt',
    );
    expect(resolve(['a/b/com/example/User.kt', 'com/example/User.kt'], 'com.example.User')).toBe(
      'com/example/User.kt',
    );
  });

  it('a .kts-only workspace resolves on both the file and package tiers', () => {
    expect(resolve(['scripts/Build.kts', 'scripts/Deploy.kts'], 'scripts.Build')).toBe(
      'scripts/Build.kts',
    );
    expect(resolve(['scripts/Build.kts', 'scripts/Deploy.kts'], 'scripts.run')).toEqual([
      'scripts/Build.kts',
      'scripts/Deploy.kts',
    ]);
  });

  it('.kt and .kts sharing a stem resolve to whichever comes first', () => {
    expect(resolve(['dup/Thing.kt', 'dup/Thing.kts'], 'dup.Thing')).toBe('dup/Thing.kt');
    expect(resolve(['dup/Thing.kts', 'dup/Thing.kt'], 'dup.Thing')).toBe('dup/Thing.kts');
  });

  it('tier 3: a package import fans out to every direct child, in order', () => {
    expect(resolve(['models/User.kt', 'models/Repo.kt', 'models/sub/Deep.kt'], 'models.getRepo'))
      // `models/sub/Deep.kt` is package `models.sub` — a different package.
      .toEqual(['models/User.kt', 'models/Repo.kt']);
  });

  it('tier 4: progressive prefix strip reaches a deeper namespace alias', () => {
    expect(resolve(['x/y/z/Deep.kt'], 'com.example.z.Deep')).toBe('x/y/z/Deep.kt');
    // Several skip levels, not just one.
    expect(resolve(['pkg/A.kt'], 'a.b.c.d.pkg.A')).toBe('pkg/A.kt');
  });

  it('backslash paths are normalized', () => {
    expect(resolve(['win\\pkg\\A.kt'], 'win.pkg.A')).toBe('win\\pkg\\A.kt');
  });

  it('non-Kotlin files never resolve', () => {
    expect(resolve(['pkg/A.java', 'pkg/A.md'], 'pkg.A')).toBeNull();
  });

  it('only the FIRST occurrence of a repeated directory name counts', () => {
    // Deliberate parity with the scan: it tested `startsWith` first and then
    // used `indexOf` — the first `/data/` here is not the parent directory, and
    // it never looked for a second one. The file is therefore NOT a child of
    // `data`, even though it sits directly inside one.
    expect(resolve(['data/src/main/kotlin/com/example/data/Repo.kt'], 'data.something')).toBeNull();
  });

  it('a path starting with the directory name is not a child of it unless direct', () => {
    expect(resolve(['data/sub/Repo.kt'], 'data.something')).toBeNull();
    expect(resolve(['data/Repo.kt'], 'data.something')).toEqual(['data/Repo.kt']);
  });

  it('a repo-root file has no package directory', () => {
    expect(resolve(['Root.kt'], 'Root')).toBe('Root.kt');
  });

  it('wildcard strips the trailing .* and lands on the single-file tier', () => {
    // `models.*` becomes pathLike `models`, and tier 1's directory-child
    // fallback answers before the package fan-out is ever reached — so a
    // wildcard resolves to ONE file, not the whole package. Preserved as-is:
    // the scan behaved identically.
    expect(resolve(['models/User.kt', 'models/Repo.kt'], 'models.*')).toBe('models/User.kt');
  });

  it('an unknown target resolves to null', () => {
    expect(resolve(['pkg/A.kt'], 'nowhere.Thing')).toBeNull();
  });
});
