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
 * arrays, the suffix index, and the per-pass resolve cache are rebuilt
 * lazily when `allFilePaths` reference changes (once per workspace pass).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { resolveTsTarget, type TsResolveContext } from '../typescript/import-target.js';
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import type { TsconfigPaths } from '../../language-config.js';

interface VueResolutionConfig {
  readonly tsconfigPaths: TsconfigPaths | null;
}

interface PassCache {
  readonly key: ReadonlySet<string>;
  readonly allFilePaths: Set<string>;
  readonly allFileList: readonly string[];
  readonly normalizedFileList: readonly string[];
  readonly index: SuffixIndex;
  readonly resolveCache: Map<string, string | null>;
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
  let cached: PassCache | null = null;

  return (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    if (cached === null || cached.key !== allFilePaths) {
      const allFileList = Array.from(allFilePaths);
      const normalizedFileList = allFileList.map((f) => f.toLowerCase());
      cached = {
        key: allFilePaths,
        allFilePaths: new Set(allFilePaths),
        allFileList,
        normalizedFileList,
        index: buildSuffixIndex(normalizedFileList, allFileList),
        resolveCache: new Map(),
      };
    }

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
