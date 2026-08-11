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
 *
 * ## The suffix index changes bare-specifier answers (PR #2911)
 *
 * Supplying `index` is not only a speed-up: `suffixResolve` answers a different
 * question with one than without. Without an index it tests
 * `filePath.endsWith('/' + suffix)`, so only a PROPER suffix can match; with
 * one it reads `buildSuffixIndex`, which indexes `j = 0` and therefore matches
 * WHOLE paths too. Two classes of answer move, both only on the bare/absolute
 * specifier leg (relative imports resolve by exact `Set.has` and never reach
 * it), and both toward what TypeScript and Vue have always answered:
 *
 *   1. a repo-root file becomes reachable at all — `require('config')` now
 *      finds `config.js`, where before no proper suffix existed and the answer
 *      was null;
 *   2. a whole-path candidate outranks a proper-suffix candidate found at a
 *      SHORTER path suffix or a later extension — `import 'app/main'` resolved
 *      to `node_modules/dep/lib/main.js` (the first `/main.js` in file order)
 *      and now resolves to `app/main.js`.
 *
 * Measured over 211 200 old-vs-new pairs there is no third class: the index
 * never loses a match the scan found, and its answer is never matched at a less
 * specific (path-part, extension) position. `test/unit/scope-resolution/
 * javascript-import-target-parity.test.ts` is that differential, and pins both
 * classes by witness.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { resolveTsTarget, type TsResolveContext } from '../typescript/import-target.js';
import { buildImportPassCache } from '../../import-resolvers/pass-cache.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';

export type JsResolveContext = TsResolveContext;

/**
 * Everything `resolveTsTarget` derives from one workspace file set, built once
 * per set rather than once per import.
 *
 * `index` is not optional, and its absence was the defect (PR #2911). The
 * TypeScript adapter has carried a `SuffixIndex` since #1918; this one did not,
 * so every JavaScript import reached `suffixResolve` with `index === undefined`
 * and took its linear-`findIndex` fallback — one pass over `normalizedFileList`
 * per path part per extension, and `EXTENSIONS` has ~39 entries. Measured on
 * mostly-missing bare specifiers (imports scaling with files, as in
 * `bench/import-target/`): 6448.9 µs per import at 2000 files and 25972.6 µs at
 * 8000 — 4.12x the per-import cost for 4x the files, which is O(imports ×
 * files) — against 25.0 / 27.0 µs for TypeScript over the identical corpus.
 * With the index it is 28.5 / 27.4 µs and the scaling factor is 1.09x.
 *
 * No instrument on the #2901-#2909 branch could see it: `CountingSet` counts
 * traversals of the SET, and this scan walks the materialized array behind it.
 * See `test/integration/javascript-import-index-reuse.test.ts` for the guard
 * that can.
 *
 * Memoized on the `allFilePaths` Set identity, like every other language's
 * import index (`import-resolvers/workspace-file-index.ts` and friends).
 *
 * A single-slot `let cached` keyed on `cached.key !== allFilePaths` — what this
 * adapter used before — is correct for one file set and degenerate for two:
 * alternating calls across two sets rebuild everything every time. Measured on
 * the TypeScript adapter at 4000 files × 400 imports: 12.0 ms for one set,
 * 1438.2 ms alternating between two (120x). A `WeakMap` has no such state to
 * thrash, which is also what lets this adapter carry the standard
 * `expectDistinctFileSetsGetOwnIndex` guard every other indexed adapter
 * carries.
 *
 * The Set must be passed THROUGH by the caller, never copied: a defensive
 * `new Set(allFilePaths)` at the adapter boundary hands a fresh key per import
 * and restores the per-import rebuild (PR #1918 review P1).
 */
const passCacheFor = perFileSet(buildImportPassCache);

/**
 * Build a memoized `resolveImportTarget` adapter for JavaScript.
 * Caches the derived arrays, the suffix index and the per-pass resolve cache
 * across `resolveImportTarget` calls over one workspace file set.
 */
export function makeJsResolveImportTarget(): (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
) => string | readonly string[] | null {
  return (targetRaw, fromFile, allFilePaths) => {
    const cached = passCacheFor(allFilePaths);

    const ws: JsResolveContext = {
      fromFile,
      language: SupportedLanguages.JavaScript,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      index: cached.index,
      resolveCache: cached.resolveCache,
      tsconfigPaths: null,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}
