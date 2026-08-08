/**
 * A `Set<string>` that counts how many times it is TRAVERSED in full — the
 * measuring instrument behind the import-target index-reuse guards
 * (`test/unit/scope-resolution/import-target-index-parity.test.ts` and the
 * per-language `test/integration/<lang>-import-index-reuse.test.ts` files).
 *
 * ## Why a counting Set rather than a production build counter
 *
 * Kotlin and Python count index BUILDS from production (`languages/<lang>/
 * index-stats.ts`). That catches the per-import rebuild, but it is blind to a
 * scan added BESIDE a reused index: the cache still hits, the build count still
 * reads 1. Counting traversals of the file set instead needs no production
 * surface at all and catches both failures with one number:
 *
 *   - an adapter that copies the set (`new Set(allFilePaths)`) hands a fresh
 *     `WeakMap` key per import, so the count rises to the import count;
 *   - a scan reintroduced next to the index raises the count by one per scan.
 *
 * The second is the case the benchmark provably cannot see: a full workspace
 * scan on 1-in-32 imports passes every timing arm in `bench/import-target/`
 * (measured, see `baselines.json` `_blind_spot`) while this counter reads 14
 * instead of 1.
 *
 * ## Why every traversal entry point is overridden
 *
 * `for…of`, spread and `new Set(x)` go through `[Symbol.iterator]`, but
 * `forEach`, `values`, `keys` and `entries` walk the same elements without
 * touching it. Overriding only `[Symbol.iterator]` would let a reintroduced
 * scan spelled `allFilePaths.forEach(…)` or `[...allFilePaths.values()]` sit
 * under the guard uncounted. `Set.prototype[Symbol.iterator]` and
 * `Set.prototype.values` are the same function object in the spec, but the
 * `super.*` lookups below resolve on `Set.prototype`, not on this subclass, so
 * a single traversal is still counted exactly once.
 *
 * ## What it does NOT see
 *
 * Only traversals of the SET. Once an index has materialized the file list into
 * an array (`WorkspaceFileIndex.normalized` / `.all`, Dart's basename buckets,
 * `PackageDirIndex.filesByDir`), a scan over that array is invisible here.
 * Guarding that would mean either instrumenting production or proxying an index
 * internal; see the header of the parity test for why neither is in place.
 *
 * `instanceof Set` still holds, which matters: C#'s `narrowContext` rejects a
 * workspace context whose `allFilePaths` is not a `Set`, so a plain object with
 * a counter would silently resolve nothing and every assertion would pass on
 * `null === null`.
 */
export class CountingSet extends Set<string> {
  /** Full traversals of this set, by any entry point. */
  scans = 0;

  override [Symbol.iterator](): SetIterator<string> {
    this.scans++;
    return super[Symbol.iterator]();
  }

  override values(): SetIterator<string> {
    this.scans++;
    return super.values();
  }

  override keys(): SetIterator<string> {
    this.scans++;
    return super.keys();
  }

  override entries(): SetIterator<[string, string]> {
    this.scans++;
    return super.entries();
  }

  override forEach(
    callbackfn: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown,
  ): void {
    this.scans++;
    super.forEach(callbackfn, thisArg);
  }
}
