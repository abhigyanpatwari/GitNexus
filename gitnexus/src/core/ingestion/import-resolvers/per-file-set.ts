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
 * `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`.
 *
 * A `WeakMap` rather than a `Map`: the entry is reclaimed with the file set it
 * was derived from, so a pass can never read a previous pass's index and memory
 * does not grow across runs. There is no invalidation rule to get wrong because
 * there is nothing to invalidate — a new file set is a new key.
 *
 * `K extends object` because the key is whatever object the pass keeps stable:
 * usually the `ReadonlySet<string>` of paths, sometimes a `readonly string[]`
 * materialized from it once per run (`import-resolvers/csharp.ts`). Stability
 * for the pass is the only property either needs.
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
