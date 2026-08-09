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
 * Build that state. Shared by the adapters whose resolution runs through
 * `resolveTsTarget` (TypeScript, JavaScript, Vue) — three byte-identical copies
 * before this existed.
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
  const normalizedFileList = allFileList.map((f) => f.toLowerCase());
  return {
    // Copied ONCE per file set, not once per import: `TsResolveContext` wants a
    // mutable `Set` and the orchestrator hands us a `ReadonlySet`. The copy is
    // not the #1918 hazard because the cache KEY is the caller's original Set.
    allFilePaths: new Set(allFilePaths),
    allFileList,
    normalizedFileList,
    index: buildSuffixIndex(normalizedFileList, allFileList),
    resolveCache: new Map(),
  };
}
