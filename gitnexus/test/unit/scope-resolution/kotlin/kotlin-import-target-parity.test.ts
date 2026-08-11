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
 *
 * ONE rule is deliberately no longer parity: #2881 removed the scan's
 * first-occurrence restriction on `dirChildren`, so a file whose package
 * directory name repeats higher in its path is now a child of that package.
 * The cases carrying it say so and name the issue.
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

  it('a package name repeated as the LEADING segment still fans out (#2881)', () => {
    // The scan tested `startsWith` before `indexOf`, so a path whose leading
    // segment repeats the parent directory name was dropped from the `data`
    // bucket entirely and `import data.something` resolved to null. The file is
    // a direct child of a `data` directory, so it belongs in the bucket.
    expect(resolve(['data/src/main/kotlin/com/example/data/Repo.kt'], 'data.something')).toEqual([
      'data/src/main/kotlin/com/example/data/Repo.kt',
    ]);
    // The single-file tiers were never affected — `suffixByStem` carries no
    // such guard — so this one resolved before the fix and still does.
    expect(resolve(['data/src/main/kotlin/com/example/data/Repo.kt'], 'data.Repo')).toBe(
      'data/src/main/kotlin/com/example/data/Repo.kt',
    );
  });

  it('a package name repeated MID-PATH also fans out (#2881)', () => {
    // Neither `data` is leading, so `startsWith` never fired here and the null
    // came from the `indexOf` position check alone — a second, independent
    // guard. Both are gone; without this case a fix that only drops
    // `startsWith` passes the file above and still leaves this shape broken.
    expect(resolve(['top/data/mid/data/Repo.kt'], 'data.something')).toEqual([
      'top/data/mid/data/Repo.kt',
    ]);
    // `['a/c/b/c/File.kt'], 'c.X'` used to sit here too. It is the same shape
    // with the segments renamed — four components, second and fourth equal,
    // query the repeated name — so it could not fail while the case above
    // passed. The bench corpus still carries it, where a second spelling of a
    // shape costs nothing; a unit case that cannot distinguish two
    // implementations is just a slower way to assert the first one.
    //
    // Unrepeated control: the parent is the only occurrence.
    expect(resolve(['top/data/Repo.kt'], 'data.something')).toEqual(['top/data/Repo.kt']);
  });

  it('a repeated name that is NOT the parent directory stays out of the bucket', () => {
    // The rule is "the parent directory is named `s`", not "`s` appears
    // anywhere in the path" — dropping the two guards must not widen it that
    // far. `data` is a component of the path but the parent is `mid`.
    expect(resolve(['top/data/mid/Repo.kt'], 'data.something')).toBeNull();
  });

  it('the package directory is derived from the normalized path, not the raw one', () => {
    // A backslash path whose `dirChildren` key must come from the normalized
    // form: reading the raw path's last separator instead would make the whole
    // `win\pkg\A.kt` string its own directory and the fan-out would miss.
    expect(resolve(['win\\pkg\\A.kt', 'win\\pkg\\B.kt'], 'win.pkg.someFunction')).toEqual([
      'win\\pkg\\A.kt',
      'win\\pkg\\B.kt',
    ]);
    expect(resolve(['win\\pkg\\A.kt'], 'pkg.someFunction')).toEqual(['win\\pkg\\A.kt']);
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
