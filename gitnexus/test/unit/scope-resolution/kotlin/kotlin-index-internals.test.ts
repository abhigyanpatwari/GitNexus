/**
 * Structural guard for the two `getKotlinFileIndex` optimizations added in
 * #2881 — the per-directory key memo and the bucket compaction.
 *
 * Both are output-identical by construction, which is why they exist and also
 * why nothing else in the repo watches them. `bench/kotlin-import-target`'s
 * correctness fingerprint observes the index only through the four resolver
 * tiers, so it cannot see a Map key-ORDER move, and reverting either
 * optimization leaves every arm of both benches green (the heap ceiling is a
 * 1.5x bound, not an equality). Without this file the memo's safety argument —
 * "the key list is a pure function of `dir`, so interning it per directory
 * cannot change the key set, the key insertion order or any bucket's order" —
 * is asserted nowhere.
 *
 * The index is module-private, so these assertions run through the resolver's
 * observable surface and reconstruct what they need:
 *
 *   - bucket CONTENTS and ORDER come from the fan-out tier, which hands out the
 *     bucket array itself;
 *   - bucket IDENTITY across calls proves the memoization, and `Object.isFrozen`
 *     proves the compaction pass ran over the array actually handed out;
 *   - the memo HIT path is reached only by a second file in the same directory,
 *     which is the case a single-file corpus never exercises.
 *
 * A key-order assertion is deliberately absent: `dirChildren` is only ever read
 * by `.get(key)`, so Map key order has no consumer and pinning it would assert
 * an implementation detail nothing depends on.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import { resolveKotlinImportTarget } from '../../../../src/core/ingestion/languages/kotlin/import-target.js';

function bucket(files: readonly string[], targetRaw: string, set = new Set(files)) {
  const parsed = { kind: 'named', localName: 'X', importedName: 'X', targetRaw } as ParsedImport;
  return resolveKotlinImportTarget(parsed, { fromFile: 'App.kt', allFilePaths: set } as never);
}

describe('getKotlinFileIndex internals (#2881)', () => {
  it('the memo hit path produces the same bucket as the miss path', () => {
    // Every file after the first in `pkg/` takes the memo, so a divergence
    // between the two paths shows up as a missing or reordered member. The
    // per-file form and the memoized form must agree element for element.
    const files = ['a/b/pkg/One.kt', 'a/b/pkg/Two.kt', 'a/b/pkg/Three.kt', 'a/b/pkg/Four.kts'];
    expect(bucket(files, 'pkg.someTopLevelFun')).toEqual(files);
    expect(bucket(files, 'b.pkg.someTopLevelFun')).toEqual(files);
    expect(bucket(files, 'a.b.pkg.someTopLevelFun')).toEqual(files);
  });

  it('two directories sharing a component-suffix keep separate buckets', () => {
    // The memo is keyed on the full `dir`. Keying it on the last segment — the
    // one way this optimization can move an answer — would hand `x/pkg`'s key
    // list to `y/pkg` and merge them.
    const files = ['x/pkg/One.kt', 'y/pkg/Two.kt'];
    expect(bucket(files, 'x.pkg.fn')).toEqual(['x/pkg/One.kt']);
    expect(bucket(files, 'y.pkg.fn')).toEqual(['y/pkg/Two.kt']);
    // `pkg` alone is a component-suffix of both, so it legitimately holds both,
    // in file-set iteration order.
    expect(bucket(files, 'pkg.fn')).toEqual(files);
  });

  it('the bucket handed out is frozen, compacted and the same object every call', () => {
    // `slice()` in the freeze loop must not break the caching contract: the
    // fan-out tier hands out the cached array, and the first-child tier reads
    // `[0]` from the same one, so a downstream `sort()` would reorder the index
    // itself. Freezing makes that a loud TypeError.
    const set = new Set(['pkg/One.kt', 'pkg/Two.kt']);
    const first = bucket([], 'pkg.fn', set) as readonly string[];
    const second = bucket([], 'pkg.fn', set) as readonly string[];
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (first as string[]).push('pkg/Three.kt')).toThrow(TypeError);
  });

  it('a single-child bucket is frozen too, on the length === 1 skip path', () => {
    // Compaction skips `slice()` for a bucket that never grew. That branch must
    // still freeze, or exactly the packages with one file stay mutable.
    const set = new Set(['solo/One.kt']);
    const only = bucket([], 'solo.fn', set) as readonly string[];
    expect(only).toEqual(['solo/One.kt']);
    expect(Object.isFrozen(only)).toBe(true);
  });

  it('a package larger than V8 s first growth step keeps every member in order', () => {
    // 40 files takes the backing store through 1 -> 17 -> 41, so this is the
    // shape compaction actually reclaims. Nothing may be lost or reordered.
    const files = Array.from({ length: 40 }, (_, i) => `big/Item${i}.kt`);
    expect(bucket(files, 'big.fn')).toEqual(files);
  });

  it('the memo keys on the NORMALIZED directory while storing raw paths', () => {
    // `dir` is now sliced from `stem` rather than from `norm`. Both are the
    // backslash-normalized form and an extension holds no '/', so the last
    // separator is the same character at the same index — but only the KEY is
    // normalized; the memo must not leak that into the stored value, which
    // stays the raw path the file set holds.
    expect(bucket(['win\\pkg\\A.kt', 'win\\pkg\\B.kt'], 'win.pkg.fn')).toEqual([
      'win\\pkg\\A.kt',
      'win\\pkg\\B.kt',
    ]);
    // Same directory reached by its component-suffix, i.e. through the memo's
    // second and later keys rather than the full-dir key.
    expect(bucket(['win\\pkg\\A.kt', 'win\\pkg\\B.kt'], 'pkg.fn')).toEqual([
      'win\\pkg\\A.kt',
      'win\\pkg\\B.kt',
    ]);
  });
});
