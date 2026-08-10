import { buildSuffixIndex, type SuffixIndex } from './utils.js';

/**
 * Everything the standard `resolveTsTarget` path derives from one workspace
 * file set: the file list, the lower-cased file list, the suffix index and the
 * per-pass `resolveCache`.
 *
 * Without this memoization the resolver re-derived `allFileList` and
 * `normalizedFileList` (both O(N_files)), rebuilt the index and threw away the
 * `resolveCache` on every import — O(N_files × N_imports) total work for what
 * should be O(N_files + N_imports).
 */
export interface ImportPassCache {
  readonly allFilePaths: Set<string>;
  readonly allFileList: readonly string[];
  readonly normalizedFileList: readonly string[];
  readonly index: SuffixIndex;
  readonly resolveCache: Map<string, string | null>;
}

/**
 * Build that state. Shared by every adapter whose resolution runs through
 * `resolveTsTarget`.
 *
 * Not a dedup of identical copies, and the difference is the point. At
 * 49c5b7d81 each of those adapters carried this record inline and they did NOT
 * agree: `languages/typescript/scope-resolver.ts` and
 * `languages/vue/import-target.ts` held six byte-identical fields built around
 * `index: buildSuffixIndex(normalizedFileList, allFileList)`, while
 * `languages/javascript/import-target.ts` held five and never called
 * `buildSuffixIndex` at all. That one missing field IS the O(imports × files)
 * defect PR #2911 fixed — `resolveTsTarget` fell back to `suffixResolve`'s
 * linear scan for every JavaScript import — and the header of
 * `languages/javascript/import-target.ts` carries the measurements. Hoisting
 * the builder is what makes a fourth adapter unable to omit it again: `index`
 * is not optional on `ImportPassCache`.
 *
 * The BUILDER is shared; the MEMO deliberately is not. Each adapter wraps this
 * in its own `perFileSet(...)`, so each gets its own `WeakMap`, its own index
 * instance and — the one that would be a behaviour change — its own
 * `resolveCache`. The languages disagree about what a specifier resolves to
 * (`tsconfigPaths` is read from config for TypeScript and Vue, pinned to `null`
 * for JavaScript, and the tried extension list differs), so one shared resolve
 * cache across them would hand a language another language's answers.
 *
 * Sharing the builder is a code dedup and nothing more: it buys no runtime
 * reuse, because there is none to buy. Each provider pass builds its own
 * `allFilePaths` Set (`scope-resolution/pipeline/run.ts`, per provider), so
 * TypeScript's set and JavaScript's set are different objects and therefore
 * different `WeakMap` keys even where the two memos are the same code.
 */
export function buildImportPassCache(allFilePaths: ReadonlySet<string>): ImportPassCache {
  const allFileList = Array.from(allFilePaths);
  // LOWERCASED, not slash-normalized — unlike every other caller of
  // `buildSuffixIndex`. That is what `alreadyLowercased` below records.
  const normalizedFileList = allFileList.map((f) => f.toLowerCase());
  return {
    // Copied ONCE per file set, not once per import: `TsResolveContext` wants a
    // mutable `Set` and the orchestrator hands us a `ReadonlySet`. The copy is
    // not the #1918 hazard because the cache KEY is the caller's original Set.
    allFilePaths: new Set(allFilePaths),
    allFileList,
    normalizedFileList,
    // Every suffix of an all-lowercase path is itself lowercase, so the index's
    // case-folded map came out a byte-for-byte copy of its exact map — same
    // keys, same values, same insertion order — one per `ImportPassCache`, so
    // once per adapter per pass. Measured 14.00 MiB at 32 000 paths, 29.8% of
    // the retained `ImportPassCache`. The flag drops the copy; it does not change
    // what `getInsensitive` answers, because the copy was the identity (see
    // `SuffixIndexOptions`). Checked, not assumed: over 474 524 probes on four
    // mixed-case corpora — Vue PascalCase plus alias specifiers, case-colliding
    // twins, a 600-file deep monorepo, and Unicode paths carrying final sigma,
    // dotted-I and sharp-S — the two maps came out byte-identical, the exact
    // map was the sole answerer 0 times, and `get(s) || getInsensitive(s)`
    // returned the same file 474 524 times out of 474 524.
    index: buildSuffixIndex(normalizedFileList, allFileList, { alreadyLowercased: true }),
    resolveCache: new Map(),
  };
}
