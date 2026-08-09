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
 *
 * `expectDistinctFileSetsGetOwnIndex` below is the one arm of those guards that
 * is identical in every language once the four values that differ are named, so
 * it lives here beside the instrument it reads rather than in each guard.
 */
import { expect } from 'vitest';
import type { ScopeResolver } from '../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

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

/**
 * Everything that differs between the per-language spellings of the
 * distinct-file-set arm. Nothing else about that arm varies, which is why it is
 * a parameter list rather than four copies.
 */
export interface DistinctFileSetArm {
  /**
   * The orchestrator adapter under test — `<lang>ScopeResolver
   * .resolveImportTarget`, NOT the language's `resolve<Lang>ImportTarget`. The
   * adapter is the surface the unit parity test cannot reach, and the surface a
   * defensive `new Set(allFilePaths)` copy would break.
   */
  readonly resolveImportTarget: ScopeResolver['resolveImportTarget'];
  /**
   * Builds one workspace. Called twice, and must return a FRESH `CountingSet`
   * each time: the two sets being distinct objects is the whole subject of the
   * arm, since the indexes are memoized on Set identity via a `WeakMap`.
   */
  readonly buildWorkspace: () => CountingSet;
  /** The import spelling to resolve, as it would appear in source. */
  readonly targetRaw: string;
  /** The importing file the target is resolved against. */
  readonly fromFile: string;
  /**
   * The resolver's `resolutionConfig` argument (Go's `{ modulePath }`). Not
   * optional: the languages that take none pass `undefined` in the open, so a
   * call site never hides which adapters read this channel behind an omission.
   */
  readonly resolutionConfig: unknown;
  /**
   * What `targetRaw` must resolve to — a path for the string-returning
   * resolvers, a path list for Go. Never `null`: the pairing rule below exists
   * precisely because an adapter that has stopped resolving anything returns
   * `null` and still posts a perfect scan count, so a `null` expectation would
   * reinstate the hole it closes.
   */
  readonly expected: string | readonly string[];
  /** Traversals of ONE file set that full reuse permits: one per index built. */
  readonly expectedScans: number;
}

/** Resolutions driven against each file set before the counts are read. */
const DISTINCT_FILE_SET_REPEATS = 20;

/**
 * Assert that two independently built file sets each get their own index, built
 * once — no stale reuse of one set's index for the other, and no rebuild per
 * import within either.
 *
 * The repeats are driven bare, following the equivalent arm in
 * `test/unit/scope-resolution/import-target-index-parity.test.ts`: asserting
 * inside the loop restates one bit of information forty times. The two asserted
 * resolutions afterwards are the pairing rule the guards' headers state — a
 * scan count must never be the count of an adapter that resolves nothing.
 */
export function expectDistinctFileSetsGetOwnIndex(arm: DistinctFileSetArm): void {
  const a = arm.buildWorkspace();
  const b = arm.buildWorkspace();

  for (let i = 0; i < DISTINCT_FILE_SET_REPEATS; i++) {
    arm.resolveImportTarget(arm.targetRaw, arm.fromFile, a, arm.resolutionConfig);
    arm.resolveImportTarget(arm.targetRaw, arm.fromFile, b, arm.resolutionConfig);
  }

  expect(arm.resolveImportTarget(arm.targetRaw, arm.fromFile, a, arm.resolutionConfig)).toEqual(
    arm.expected,
  );
  expect(arm.resolveImportTarget(arm.targetRaw, arm.fromFile, b, arm.resolutionConfig)).toEqual(
    arm.expected,
  );

  expect(a.scans).toBe(arm.expectedScans);
  expect(b.scans).toBe(arm.expectedScans);
}
