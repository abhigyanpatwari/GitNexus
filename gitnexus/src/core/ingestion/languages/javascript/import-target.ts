/**
 * Import-target resolver for JavaScript.
 *
 * Delegates to the TypeScript `resolveTsTarget` standard-strategy resolver
 * with `language: SupportedLanguages.JavaScript` so the resolver tries
 * `.js` / `.jsx` extensions in addition to (or instead of) `.ts` / `.tsx`.
 *
 * The `TsResolveContext.language` flag already exists in `import-target.ts`
 * and the resolver (`resolveImportPath`) already branches on it — this
 * adapter just wires the right value in.
 *
 * CJS `require()` calls reference the same module-path strings as ESM
 * `import` statements, so the resolver handles them uniformly without any
 * CJS-specific logic here.
 *
 * No `tsconfig.json` path-alias support (JavaScript projects don't use
 * `tsconfig.json` compilerOptions.paths in general). Projects that DO use
 * tsconfig-based aliases alongside JavaScript can still resolve via the
 * standard extension-suffix fallback; the alias branch is a no-op when
 * `tsconfigPaths` is null.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { resolveTsTarget, type TsResolveContext } from '../typescript/import-target.js';

export type JsResolveContext = TsResolveContext;

type PassCache = {
  readonly key: ReadonlySet<string>;
  readonly allFilePaths: Set<string>;
  readonly allFileList: readonly string[];
  readonly normalizedFileList: readonly string[];
  readonly resolveCache: Map<string, string | null>;
};

/**
 * Build a memoized `resolveImportTarget` adapter for JavaScript.
 * Caches the derived arrays and per-pass resolve cache across
 * `resolveImportTarget` calls within a single workspace pass.
 */
export function makeJsResolveImportTarget(): (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
) => string | readonly string[] | null {
  let cached: PassCache | null = null;

  return (targetRaw, fromFile, allFilePaths) => {
    if (cached === null || cached.key !== allFilePaths) {
      const allFileList = Array.from(allFilePaths);
      cached = {
        key: allFilePaths,
        allFilePaths: new Set(allFilePaths),
        allFileList,
        normalizedFileList: allFileList.map((f) => f.toLowerCase()),
        resolveCache: new Map(),
      };
    }

    const ws: JsResolveContext = {
      fromFile,
      language: SupportedLanguages.JavaScript,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      resolveCache: cached.resolveCache,
      tsconfigPaths: null,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}
