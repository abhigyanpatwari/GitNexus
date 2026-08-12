/**
 * Structural guard for the two `getKotlinFileIndex` optimizations added in
 * #2881 — the per-directory key memo and the bucket compaction.
 *
 * ## What this file can and cannot see
 *
 * Read this before adding a case here, and before citing this file as coverage
 * for either optimization. Both claims below were checked by re-running every
 * arm in this file against a mutated COPY of the resolver:
 *
 *  - **the key memo (`dirKeys`) is not observable.** Deleting it outright —
 *    cutting the component-suffix key list once per FILE, the way the code did
 *    before — leaves every arm here green. That is not a hole to be plugged: it
 *    is the optimization's safety argument restated, since the key list is a
 *    pure function of `dir` and interning it cannot change the key set, the key
 *    insertion order or any bucket's order. In particular
 *    `expect(first).toBe(second)` proves nothing about it — bucket identity
 *    across calls comes from the OUTER `perFileSet` memo on the Set's identity,
 *    a different cache, guarded in
 *    `test/integration/kotlin-import-index-reuse.test.ts`. What the arms below
 *    pin is the OUTPUT INVARIANT the memo has to preserve, and the one
 *    plausible way to get the memo wrong — keying it on the last directory
 *    segment instead of the whole `dir`, which hands `x/pkg`'s key list to
 *    `y/pkg` and merges them — fails three of them. So: a MIS-KEYED memo is
 *    caught here, a DELETED one is not.
 *
 *  - **the compaction (`bucket.slice()`) is not observable either.** Deleting
 *    the slice and freezing the grown bucket in place leaves every arm green,
 *    `Object.isFrozen` included. A JS array's backing-store capacity has no
 *    reflective surface, so no assertion through any API can see the reclaimed
 *    slack. The only instrument that can is `heap_ceiling_bytes.kotlin` in
 *    `bench/import-target/baselines.json` — a CEILING, not a floor: compaction
 *    reclaims, so deleting it makes the retained reading GROW (measured
 *    +12.57%, 42 805 256 -> 48 184 784 B), which no floor could see.
 *    `Object.isFrozen` is still worth
 *    asserting for what it DOES catch: no freeze at all, and "compact, freeze
 *    the copy, forget to `set` it back" — which hands out the original,
 *    unfrozen bucket, and which fails the arm (verified).
 *
 * ## What the arms are for
 *
 * The index is module-private, so these assertions run through the resolver's
 * observable surface and reconstruct what they need:
 *
 *   - bucket CONTENTS and ORDER come from the fan-out tier, which hands out the
 *     bucket array itself;
 *   - the FIRST-CHILD tier reads `[0]` of that same array, so the two tiers
 *     agreeing is what makes the freeze load-bearing rather than decorative;
 *   - a second file in the same directory is what reaches the memo's hit path
 *     at all, which a single-file corpus never exercises.
 *
 * A key-order assertion is deliberately absent: `dirChildren` is only ever read
 * by `.get(key)`, so Map key order has no consumer and pinning it would assert
 * an implementation detail nothing depends on.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import { resolveKotlinImportTarget } from '../../../../src/core/ingestion/languages/kotlin/import-target.js';

/**
 * Takes the file Set directly. It used to take `(files, targetRaw, set = new
 * Set(files))`, which three call sites drove as `bucket([], 'pkg.fn', set)` —
 * an empty first argument that reads as "no files" in the one place the corpus
 * matters most. Callers now spell `new Set(...)`, which also makes it visible
 * where a Set is REUSED across calls (the `perFileSet` cache hit) and where a
 * fresh one is built.
 */
function bucket(files: ReadonlySet<string>, targetRaw: string) {
  const parsed = { kind: 'named', localName: 'X', importedName: 'X', targetRaw } as ParsedImport;
  return resolveKotlinImportTarget(parsed, { fromFile: 'App.kt', allFilePaths: files } as never);
}

describe('getKotlinFileIndex internals (#2881)', () => {
  it('the memo hit path produces the same bucket as the miss path', () => {
    // Every file after the first in `pkg/` takes the memo, so a divergence
    // between the two paths shows up as a missing or reordered member. The
    // per-file form and the memoized form must agree element for element.
    const files = ['a/b/pkg/One.kt', 'a/b/pkg/Two.kt', 'a/b/pkg/Three.kt', 'a/b/pkg/Four.kts'];
    const set = new Set(files);
    expect(bucket(set, 'pkg.someTopLevelFun')).toEqual(files);
    expect(bucket(set, 'b.pkg.someTopLevelFun')).toEqual(files);
    expect(bucket(set, 'a.b.pkg.someTopLevelFun')).toEqual(files);
  });

  it('two directories sharing a component-suffix keep separate buckets', () => {
    // The memo is keyed on the full `dir`. Keying it on the last segment — the
    // one way this optimization can move an answer — would hand `x/pkg`'s key
    // list to `y/pkg` and merge them.
    const files = ['x/pkg/One.kt', 'y/pkg/Two.kt'];
    const set = new Set(files);
    expect(bucket(set, 'x.pkg.fn')).toEqual(['x/pkg/One.kt']);
    expect(bucket(set, 'y.pkg.fn')).toEqual(['y/pkg/Two.kt']);
    // `pkg` alone is a component-suffix of both, so it legitimately holds both,
    // in file-set iteration order.
    expect(bucket(set, 'pkg.fn')).toEqual(files);
  });

  it('a shorter key list cached first does not truncate a longer one', () => {
    // The case above has two directories of EQUAL depth, so a mis-keyed memo
    // merges two lists of the same length and only the bucket contents move.
    // Here the first directory seen (`pkg`) contributes one key and the second
    // (`a/pkg`) contributes two, so reusing the first's list by last segment
    // loses the `a/pkg` key entirely — a lookup that resolves today returning
    // null. Different failure, same mis-keying.
    const set = new Set(['pkg/One.kt', 'a/pkg/Two.kt']);
    expect(bucket(set, 'pkg.fn')).toEqual(['pkg/One.kt', 'a/pkg/Two.kt']);
    expect(bucket(set, 'a.pkg.fn')).toEqual(['a/pkg/Two.kt']);
  });

  it('directories sharing a MULTI-segment suffix keep separate buckets', () => {
    // `q/pkg` is a shared suffix of both directories and `pkg` is a shared
    // suffix of that, so the two files collide on two keys and stay apart on a
    // third. A memo keyed on anything shorter than the whole `dir` merges the
    // third as well.
    const set = new Set(['p/q/pkg/One.kt', 'r/q/pkg/Two.kt']);
    expect(bucket(set, 'p.q.pkg.fn')).toEqual(['p/q/pkg/One.kt']);
    expect(bucket(set, 'r.q.pkg.fn')).toEqual(['r/q/pkg/Two.kt']);
    expect(bucket(set, 'q.pkg.fn')).toEqual(['p/q/pkg/One.kt', 'r/q/pkg/Two.kt']);
    expect(bucket(set, 'pkg.fn')).toEqual(['p/q/pkg/One.kt', 'r/q/pkg/Two.kt']);
  });

  it('the bucket handed out is frozen and the same object every call', () => {
    // What this pins is the FREEZE, not the compaction (see the header): the
    // array the fan-out tier hands out must be the one stored in the index and
    // must be immutable. The finalize pass normalizes with `Array.isArray(t) ?
    // t : [t]`, whose `arg is any[]` predicate widens the true branch, so
    // `tsc --strict` accepts a `.sort()` or `.push()` there — and a sort would
    // permanently reorder the cached bucket and flip the first-child tier's
    // answer for every later import in the run. Freezing makes that a loud
    // TypeError. It also fails if the compacted copy is frozen but never
    // written back, since the array handed out is then the original.
    const set = new Set(['pkg/One.kt', 'pkg/Two.kt']);
    const first = bucket(set, 'pkg.fn') as readonly string[];
    const second = bucket(set, 'pkg.fn') as readonly string[];
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (first as string[]).push('pkg/Three.kt')).toThrow(TypeError);
  });

  it('the first-child tier reads position 0 of the SAME bucket the fan-out returns', () => {
    // The reason the freeze above matters, made observable. `import pkg.*`
    // strips to `pkg`, which is the whole `pathLike`, so it answers from
    // `findKotlinDirectoryChild`'s `children[0]`; `import pkg.fn` strips to
    // `pkg` and fans the bucket out. One array, two tiers — so any reordering
    // of the fan-out array moves the wildcard's single answer with it.
    const set = new Set(['pkg/One.kt', 'pkg/Two.kt']);
    const fanOut = bucket(set, 'pkg.fn') as readonly string[];
    expect(fanOut).toEqual(['pkg/One.kt', 'pkg/Two.kt']);
    expect(bucket(set, 'pkg.*')).toBe(fanOut[0]);
  });

  it('every key of one directory hands out its own frozen array', () => {
    // The compaction loop walks EVERY key, and a file's directory contributes
    // one key per component-suffix. Checking a single key would leave a loop
    // that freezes only the first entry — or that interns one array across the
    // keys, which would make a future in-place edit of one bucket visible
    // through all of them — passing.
    const set = new Set(['a/b/pkg/One.kt', 'a/b/pkg/Two.kt']);
    const full = bucket(set, 'a.b.pkg.fn') as readonly string[];
    const mid = bucket(set, 'b.pkg.fn') as readonly string[];
    const leaf = bucket(set, 'pkg.fn') as readonly string[];
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.isFrozen(mid)).toBe(true);
    expect(Object.isFrozen(leaf)).toBe(true);
    expect(full).not.toBe(mid);
    expect(mid).not.toBe(leaf);
    expect(full).toEqual(leaf);
  });

  it('a single-child bucket is frozen too, on the length === 1 skip path', () => {
    // Compaction skips `slice()` for a bucket that never grew. That branch must
    // still freeze, or exactly the packages with one file stay mutable.
    const only = bucket(new Set(['solo/One.kt']), 'solo.fn') as readonly string[];
    expect(only).toEqual(['solo/One.kt']);
    expect(Object.isFrozen(only)).toBe(true);
  });

  it('a package larger than V8 s first growth steps keeps every member in order', () => {
    // Measured on this repo's Node (v22.18.0, x64, 8 bytes per element slot),
    // by allocating 40 000 push-grown arrays per length and reading retained
    // heap against the same arrays rebuilt at exact length: a bucket minted as
    // `[raw]` and pushed into takes its backing store through
    //
    //     capacity 1 -> 19 -> 46 -> 86 -> 146
    //     growing at lengths 2, 20, 47, 87
    //
    // so 40 files sits inside the 46-slot store with 6 slots — 48 bytes — of
    // retained slack, which is what compaction reclaims. (The older `1 -> 17 ->
    // 41` note in this comment described a capacity that never appears here and
    // under-counted that slack by 6x. The arm is unaffected either way: 40 is
    // past a growth step under both models. The exact steps are a V8 detail and
    // may move with the Node floor — the assertion deliberately depends only on
    // there BEING slack, not on how much.)
    const files = Array.from({ length: 40 }, (_, i) => `big/Item${i}.kt`);
    expect(bucket(new Set(files), 'big.fn')).toEqual(files);
  });

  it('the memo keys on the NORMALIZED directory while storing raw paths', () => {
    // `dir` is now sliced from `stem` rather than from `norm`. Both are the
    // backslash-normalized form and an extension holds no '/', so the last
    // separator is the same character at the same index — but only the KEY is
    // normalized; the memo must not leak that into the stored value, which
    // stays the raw path the file set holds.
    const set = new Set(['win\\pkg\\A.kt', 'win\\pkg\\B.kt']);
    expect(bucket(set, 'win.pkg.fn')).toEqual(['win\\pkg\\A.kt', 'win\\pkg\\B.kt']);
    // Same directory reached by its component-suffix, i.e. through the memo's
    // second and later keys rather than the full-dir key.
    expect(bucket(set, 'pkg.fn')).toEqual(['win\\pkg\\A.kt', 'win\\pkg\\B.kt']);
  });
});
