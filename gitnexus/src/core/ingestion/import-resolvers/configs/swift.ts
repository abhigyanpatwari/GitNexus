/**
 * Swift import resolution config.
 * Package.swift target map strategy — no standard fallback (unresolved = external framework).
 *
 * ## Performance (anti-O(imports × files))
 *
 * The previous implementation rescanned the whole `normalizedFileList`
 * on every import to collect the `.swift` files under the requested
 * target's directory — O(imports × files) per run, the exact hot path
 * fixed for Python in PR #1918. We now build a `target → files` index
 * ONCE per run, memoized on the stable `allFileList` array reference
 * (the same `ResolveCtx` — and therefore the same array — is passed to
 * every strategy invocation, per `import-processor`'s build-once
 * context). Lookup per import is then O(1).
 *
 * A file is attributed to a target iff its **forward-slash
 * (backslash-normalized), case-sensitive** path matches at a
 * **segment boundary**: it starts with `<targetDir>/` or contains
 * `/<targetDir>/`. `normalizedFileList` is
 * only backslash→forward-slash normalized — NOT lowercased — so the
 * match is case-sensitive. The returned paths are the original-case
 * `allFileList` entries, and the per-target file ORDER follows
 * `allFileList`.
 *
 * Import-config fans a file to every matching declared target. Grouping
 * (`groupSwiftFilesBySpmTarget`) is first-target-wins. That divergence
 * is intentional.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { coerceDeclaredSwiftTargets, swiftDeclaredTargetPrefix } from '../../language-config.js';
import type { ImportResolutionConfig, ImportResolverStrategy, ResolveCtx } from '../types.js';

interface SwiftTargetIndex {
  /** Target name → original-case `.swift` file paths under that target dir. */
  readonly byTarget: ReadonlyMap<string, string[]>;
}

/**
 * Memoized on the `allFileList` array identity. `import-processor` builds
 * the `ResolveCtx` once per run and threads the same object (and the same
 * `allFileList`) through every strategy call, so the WeakMap is keyed on a
 * stable reference and the index is built once — not once per import. A
 * fresh run produces a fresh array → a fresh index, so cross-run staleness
 * is impossible.
 *
 * DELIBERATELY NOT ON `import-resolvers/per-file-set.ts` (#2909 sweep): this is
 * a TWO-input memo keyed on ONE of them. The index is a function of both
 * `ctx` (`allFileList` + the index-aligned `normalizedFileList`) and `targets`,
 * but the key is only `ctx.allFileList`, and `perFileSet`'s `build: (key) => T`
 * hands the builder nothing but the key. It is sound here only because of an
 * invariant OUTSIDE the memo — `targets` is `ctx.configs.swiftPackageConfig
 * .targets`, so it shares `ctx`'s lifetime and cannot vary while
 * `ctx.allFileList` is fixed — and `perFileSet` has no way to express "and this
 * other input is pinned by the same lifetime". Re-keying on `ctx` to make
 * `targets` derivable from the key would change what the cache is keyed on and
 * force an unreachable null-config arm into the builder, so it is a behaviour
 * change rather than a consolidation. Leave it hand-rolled.
 */
const SWIFT_TARGET_INDEX_CACHE = new WeakMap<object, SwiftTargetIndex>();

function getSwiftTargetIndex(
  ctx: ResolveCtx,
  targets: ReadonlyMap<string, string>,
): SwiftTargetIndex {
  const key = ctx.allFileList as object;
  const cached = SWIFT_TARGET_INDEX_CACHE.get(key);
  if (cached !== undefined) return cached;

  // Pre-compute each target's directory prefix once (original case, to
  // match the legacy comparison against the forward-slash-normalized,
  // case-sensitive file list — see module docstring).
  const targetDirs: { name: string; prefix: string }[] = [];
  const byTarget = new Map<string, string[]>();
  for (const [name, dir] of targets) {
    targetDirs.push({ name, prefix: swiftDeclaredTargetPrefix(dir) });
    byTarget.set(name, []);
  }

  // Single pass over the file list. `normalizedFileList` is forward-slash
  // (backslash-normalized), case-sensitive, and index-aligned with
  // `allFileList`; attribute the original-case path to every target whose
  // prefix the normalized path starts with (a file under a nested target
  // dir can legitimately belong to multiple configured targets — the
  // legacy per-import scan would have returned it for each).
  for (let i = 0; i < ctx.allFileList.length; i++) {
    const norm = ctx.normalizedFileList[i];
    if (!norm.endsWith('.swift')) continue;
    for (const { name, prefix } of targetDirs) {
      if (!norm.startsWith(prefix) && !norm.includes(`/${prefix}`)) continue;
      const bucket = byTarget.get(name);
      if (bucket !== undefined) bucket.push(ctx.allFileList[i]);
    }
  }

  const index: SwiftTargetIndex = { byTarget };
  SWIFT_TARGET_INDEX_CACHE.set(key, index);
  return index;
}

/** Swift Package.swift target map resolution strategy. */
export const swiftPackageStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const swiftPackageConfig = ctx.configs.swiftPackageConfig;
  if (swiftPackageConfig == null) return null;
  const declared = coerceDeclaredSwiftTargets(swiftPackageConfig);
  if (declared == null) return null;
  const moduleName = rawImportPath.split('.')[0];
  if (moduleName === '' || !declared.has(moduleName)) {
    return null;
  }
  const index = getSwiftTargetIndex(ctx, declared);
  const files = index.byTarget.get(moduleName);
  if (files !== undefined && files.length > 0) {
    return { kind: 'files', files: [...files] };
  }
  return null;
};

export const swiftImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Swift,
  strategies: [swiftPackageStrategy],
};
