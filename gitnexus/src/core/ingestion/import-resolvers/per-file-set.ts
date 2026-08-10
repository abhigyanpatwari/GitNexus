/**
 * The one memo every per-file-set index in this pipeline is built on.
 *
 * The scope-resolution orchestrator builds ONE file-set object per provider
 * pass and threads that same object through every `resolveImportTarget` call in
 * the pass, so anything derived from it — a suffix index, a package-directory
 * map, a basename bucket — can be built once and read by every import instead
 * of rebuilt per import. Keying on the object's IDENTITY is what makes that
 * work, and it is equally the contract callers must keep: the set is passed
 * THROUGH, never copied. A defensive `new Set(allFilePaths)` at an adapter
 * boundary hands a fresh key per import and silently restores
 * O(imports × files) — the bug PR #1918 shipped and had to fix in review (P1).
 * The guards are `test/integration/<lang>-import-index-reuse.test.ts` and, for
 * every registered language at once,
 * `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`,
 * whose inventory arm fails when an entry of `SCOPE_RESOLVERS` has no fixture.
 * That arm is why no language is named here: the registry is the census, and a
 * hand-copied list of languages goes stale the release after it is written.
 *
 * A `WeakMap` rather than a `Map`: the entry is reclaimed with the file set it
 * was derived from, so a pass can never read a previous pass's index and memory
 * does not grow across runs. There is no invalidation rule to get wrong because
 * there is nothing to invalidate — a new file set is a new key.
 *
 * `K extends object` because the key is whatever object the pass keeps stable.
 * Stability for the pass is the only property any of them needs — but WHICH
 * object is the key decides whether the guards above can see the memo fail, and
 * only one shape is instrumentable by them:
 *
 *  - `ReadonlySet<string>`, the pass's file set — every index derived from the
 *    file set, including the derived header-closure sets that
 *    `languages/{c,cpp}/scope-resolver.ts` memoize inside an outer per-file-set
 *    memo. Defeating one of these means copying the SET, which re-traverses it,
 *    which the `CountingSet` instrument (`test/helpers/counting-file-set.ts`)
 *    reads as a scan count rising with the import count.
 *  - `readonly ParsedFile[]`, the pass's parsed-file array — `languages/c/
 *    static-linkage.ts`, `languages/cpp/file-local-linkage.ts` and
 *    `languages/php/import-target.ts`. Not derived from the file set at all, so
 *    the file-set guards do not reach them; these key on the array the
 *    orchestrator already threads through the pass, and their contract is that
 *    same pass-through discipline.
 *
 * No index derived from the file set is keyed on an ARRAY materialized from it.
 * `import-resolvers/csharp.ts` was, until #2911, and the reason it is worth
 * stating as a rule: copying an array mints a fresh `WeakMap` key while
 * traversing the Set zero extra times, so every scan-counting guard stays green
 * at its correct value while the index rebuilds once per import. That failure
 * is invisible to the whole instrument family above and was caught only by a
 * timing ratio in `bench/import-target/`. Derive the array inside the builder
 * from `getWorkspaceFileIndex(allFilePaths)` instead, and the Set stays the
 * single key shape and the single thing that has to be passed through.
 *
 * `T extends object` is deliberate, chosen over probing `has` before `get`.
 * `WeakMap.get` returning `undefined` cannot distinguish "not built yet" from
 * "built, and the value is `undefined`"; constraining the value to an object
 * makes the second case unrepresentable rather than paying a second lookup on
 * every import, and it needs no cast to type-check. Every index memoized here
 * is a record, `Map` or `Set`, so the constraint costs nothing today — and a
 * later caller wanting to memoize a `string | null` gets a compile error
 * pointing at this line instead of a memo that silently rebuilds on every miss.
 *
 * A `build` that THROWS stores nothing, so the next call for that key runs it
 * again: failures are not memoized, and a half-filled index is never published.
 * Inert for the builders here — each is a pure, total pass over the file set —
 * and the safer of the two behaviours if that ever stops being true.
 */
export function perFileSet<K extends object, T extends object>(
  build: (key: K) => T,
): (key: K) => T {
  const cache = new WeakMap<K, T>();
  return (key) => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = build(key);
    cache.set(key, built);
    return built;
  };
}
