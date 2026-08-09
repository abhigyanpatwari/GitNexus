/**
 * Import-target resolver for Vue SFCs (RFC #909 Ring 3, issue #940).
 *
 * Vue `<script>` / `<script setup>` blocks are TypeScript (or plain
 * JavaScript), so the resolver delegates to `resolveTsTarget` with
 * `language: SupportedLanguages.TypeScript` to get:
 *
 *   - tsconfig path-alias rewriting (Vue projects universally use TS)
 *   - `.ts` / `.tsx` / `.js` / `.jsx` extension-suffix fallback
 *
 * `.vue` imports are written with explicit extensions (`'./Button.vue'`),
 * so no Vue-specific suffix guessing is required: the standard
 * resolver finds them via the exact-path branch before any extension
 * logic fires.
 *
 * Memoization mirrors the TypeScript adapter: workspace file-list
 * arrays, the suffix index and the per-pass resolve cache are built
 * once per `allFilePaths` Set and memoized on that Set's identity.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { resolveTsTarget, type TsResolveContext } from '../typescript/import-target.js';
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import type { TsconfigPaths } from '../../language-config.js';

interface VueResolutionConfig {
  readonly tsconfigPaths: TsconfigPaths | null;
}

interface PassCache {
  readonly allFilePaths: Set<string>;
  readonly allFileList: readonly string[];
  readonly normalizedFileList: readonly string[];
  readonly index: SuffixIndex;
  readonly resolveCache: Map<string, string | null>;
}

/**
 * Memoized on the `allFilePaths` Set identity, like every other language's
 * import index (`import-resolvers/workspace-file-index.ts` and friends).
 *
 * This used to be a single-slot `let cached` invalidated by
 * `cached.key !== allFilePaths` — correct for one file set and degenerate for
 * two: alternating calls across two sets rebuilt everything every time.
 * Measured on the identical TypeScript adapter at 4000 files × 400 imports:
 * 12.0 ms for one set, 1438.2 ms alternating between two (120x). A `WeakMap`
 * has no such state to thrash, and it is what lets this adapter carry the
 * standard
 * `expectDistinctFileSetsGetOwnIndex` guard the other languages carry
 * (`test/integration/vue-import-index-reuse.test.ts`).
 *
 * The Set must be passed THROUGH by the caller, never copied: a defensive
 * `new Set(allFilePaths)` at the adapter boundary hands a fresh key per import
 * and restores the per-import rebuild (PR #1918 review P1).
 */
const PASS_CACHE = new WeakMap<ReadonlySet<string>, PassCache>();

function passCacheFor(allFilePaths: ReadonlySet<string>): PassCache {
  const cached = PASS_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;

  const allFileList = Array.from(allFilePaths);
  const normalizedFileList = allFileList.map((f) => f.toLowerCase());
  const built: PassCache = {
    // Copied ONCE per file set, not once per import: `TsResolveContext` wants a
    // mutable `Set` and the orchestrator hands us a `ReadonlySet`. The copy is
    // not the #1918 hazard because the cache KEY is the caller's original Set.
    allFilePaths: new Set(allFilePaths),
    allFileList,
    normalizedFileList,
    index: buildSuffixIndex(normalizedFileList, allFileList),
    resolveCache: new Map(),
  };
  PASS_CACHE.set(allFilePaths, built);
  return built;
}

/**
 * Build a memoized `resolveImportTarget` adapter for Vue SFCs.
 *
 * Uses `SupportedLanguages.TypeScript` so tsconfig path-alias resolution
 * and `.ts`/`.tsx` extension guessing fire for relative and bare-specifier
 * imports inside `<script>` blocks.
 */
export function makeVueResolveImportTarget(): (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
) => string | readonly string[] | null {
  return (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    const cached = passCacheFor(allFilePaths);

    const cfg = resolutionConfig as VueResolutionConfig | undefined;
    const ws: TsResolveContext = {
      fromFile,
      language: SupportedLanguages.TypeScript,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      index: cached.index,
      resolveCache: cached.resolveCache,
      tsconfigPaths: cfg?.tsconfigPaths ?? null,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}
