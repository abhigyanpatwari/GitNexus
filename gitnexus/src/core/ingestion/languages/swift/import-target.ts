/**
 * `resolveImportTarget` adapter for the Swift `ScopeResolver`.
 *
 * Swift's `import ModuleName` brings in a whole SPM target / framework
 * module. The scope-resolution contract passes only `allFilePaths` (no
 * `SwiftPackageConfig`), so we resolve a module name to the `.swift`
 * files under a directory segment named after the module — the SPM
 * convention `Sources/<Module>/*.swift` (and the common
 * `<Module>/*.swift` layout). This needs no manifest parsing.
 *
 * Same-module (intra-target) visibility — the bulk of Swift cross-file
 * resolution, which needs NO `import` statement — is handled separately
 * by `populateSwiftTargetSiblings` (see `target-siblings.ts`). This
 * adapter only resolves EXPLICIT `import` statements (cross-module).
 *
 * Returns all matching files (one ImportEdge per file, like Go's
 * package resolver) so every exported symbol in the module materializes
 * a binding. Returns `null` for external frameworks (Foundation, UIKit,
 * …) that have no in-repo directory.
 *
 * Performance: the directory→files grouping is memoized on the stable
 * `allFilePaths` Set identity (the same Set is threaded to every import
 * in a run), so it is built once per run — NOT once per import. Mirrors
 * Python's `getPythonFileIndex` WeakMap pattern (PR #1918).
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

export interface SwiftResolveContext {
  readonly fromFile: string;
  /** `ReadonlySet` so the orchestrator's stable run-level set flows
   *  straight through to the memoized index key. */
  readonly allFilePaths: ReadonlySet<string>;
}

interface SwiftModuleIndex {
  /** Module (directory-segment) name → original-case `.swift` files
   *  whose path contains a `/<module>/` directory segment. */
  readonly byModule: Map<string, string[]>;
}

const SWIFT_MODULE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, SwiftModuleIndex>();

function getSwiftModuleIndex(allFilePaths: ReadonlySet<string>): SwiftModuleIndex {
  const cached = SWIFT_MODULE_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;

  const byModule = new Map<string, string[]>();
  for (const raw of allFilePaths) {
    const norm = raw.replace(/\\/g, '/');
    if (!norm.endsWith('.swift')) continue;
    // Each interior directory segment is a candidate module name. A file
    // `Sources/Models/User.swift` is attributed to module `Sources` and
    // module `Models`; an `import Models` then resolves to it.
    const segments = norm.split('/');
    // Drop the filename (last segment); the rest are directory segments.
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (seg === '') continue;
      let bucket = byModule.get(seg);
      if (bucket === undefined) {
        bucket = [];
        byModule.set(seg, bucket);
      }
      bucket.push(raw);
    }
  }

  const index: SwiftModuleIndex = { byModule };
  SWIFT_MODULE_INDEX_CACHE.set(allFilePaths, index);
  return index;
}

export function resolveSwiftImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = workspaceIndex as SwiftResolveContext | undefined;
  // Duck-type the set (PR #1918 P2: don't `instanceof Set`).
  const allFilePaths = (ctx as { allFilePaths?: unknown } | undefined)?.allFilePaths;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    typeof (allFilePaths as { has?: unknown } | undefined)?.has !== 'function' ||
    typeof (allFilePaths as Iterable<string> | undefined)?.[Symbol.iterator] !== 'function'
  ) {
    return null;
  }

  // Swift import target is the SPM module name (first dotted segment).
  const targetRaw = parsedImport.targetRaw;
  if (targetRaw === null || targetRaw === '') return null;
  const moduleName = targetRaw.split('.')[0];
  if (moduleName === '') return null;

  const index = getSwiftModuleIndex(ctx.allFilePaths);
  const files = index.byModule.get(moduleName);
  if (files === undefined || files.length === 0) return null; // external framework

  // Exclude the importer itself (a file under `Foo/` importing `Foo`).
  const out = files.filter((f) => f !== ctx.fromFile);
  return out.length > 0 ? out : null;
}
