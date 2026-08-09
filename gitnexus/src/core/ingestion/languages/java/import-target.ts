/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Converts Java package paths (dots → slashes) and tries:
 *   1. Exact file match: `com/example/User.java`
 *   2. Suffix match for nested layouts
 *   3. Directory match (wildcard imports)
 *   4. Progressive prefix stripping for non-standard layouts
 *
 * Returns `null` for unresolvable / JDK imports.
 *
 * ## Why the scans are gone (#2908)
 *
 * Every leg above used to be answered by `for (const raw of ctx.allFilePaths)`,
 * and the stripping loop ran that scan again per stripped segment — so one
 * unresolvable `import a.b.c.D;` (the COMMON case: JDK and third-party imports
 * run the whole cascade to completion) cost four full workspace passes. This is
 * byte-for-byte the shape C# carried until #2878; both now read the same two
 * per-file-set indexes, memoized on the Set's identity:
 *
 *   - `getWorkspaceFileIndex` — `normToRaw` (whole-path lookup) and `index`
 *     (segment-suffix lookup);
 *   - `getJavaDirIndex` — `firstFileDirectlyInPkgDir`'s package-directory index.
 *
 * ## The tie-breaks the scans encoded, and where they now live
 *
 *  1. The first pass `break`s on an exact whole-path hit but keeps scanning
 *     otherwise, then returns `exactFile ?? suffixFile ?? directoryChild`. So an
 *     exact match wins over a suffix or directory-child match found EARLIER in
 *     iteration order — hence `normToRaw` before `index`, which conflates the
 *     two (see `resolveDirectMatch`).
 *  2. The stripping loop instead `return`s mid-scan on `f === tailFile ||
 *     f.endsWith(tailSuffix)`, i.e. at the first hit of EITHER, and only returns
 *     its directory child after the scan completes. So file/suffix beats
 *     directory child within one `skip` level regardless of order, and the
 *     conflated `index.get` is the CORRECT lookup there (see
 *     `resolveByProgressiveStripping`).
 *  3. Wildcard imports drop their trailing `.*` before resolution, so
 *     `com.example.*` resolves as the package directory.
 *  4. `.java` filter and backslash normalization, with the RAW path returned:
 *     the indexes normalize for their keys and hand back the raw Set member, and
 *     only a `.java` file can carry a `…/<name>.java` suffix key, so the
 *     extension filter is implied on the file/suffix legs and explicit in the
 *     directory index's `accept`.
 *  5. The directory-child leg matched on the FIRST `'/' + pathLike + '/'`
 *     occurrence, so `com/example/com/example/Deep.java` does NOT answer
 *     `com.example`. `firstFileDirectlyInPkgDir` encodes exactly that rule (see
 *     the header of `import-resolvers/package-dir-index.ts`).
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import {
  getWorkspaceFileIndex,
  type WorkspaceFileIndex,
} from '../../import-resolvers/workspace-file-index.js';
import {
  buildPackageDirIndex,
  firstFileDirectlyInPkgDir,
  type PackageDirIndex,
} from '../../import-resolvers/package-dir-index.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';

export interface JavaResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

/**
 * Package-directory index over the `.java` files, memoized on the Set's
 * identity. Feeds `firstFileDirectlyInPkgDir`, which is called once for the
 * direct match and then up to once per stripped package prefix.
 */
const getJavaDirIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): PackageDirIndex =>
    buildPackageDirIndex(allFilePaths, (normalized) => normalized.endsWith('.java')),
);

export function resolveJavaImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = narrowContext(workspaceIndex);
  if (ctx === null) return null;
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  // Strip trailing `.*` for wildcard imports: `com.example.*` → `com.example`
  let target = parsedImport.targetRaw;
  if (target.endsWith('.*')) {
    target = target.slice(0, -2);
  }

  // Package path: `com.example.User` → `com/example/User`
  const pathLike = target.replace(/\./g, '/');

  const ws = getWorkspaceFileIndex(ctx.allFilePaths);
  const dirs = getJavaDirIndex(ctx.allFilePaths);

  const direct = resolveDirectMatch(ws, dirs, pathLike);
  if (direct !== null) return direct;

  // Progressive prefix stripping — handles `import com.example.User;`
  // in a repo laid out `User.java` (no `com/example/` prefix).
  return resolveByProgressiveStripping(ws, dirs, pathLike);
}

/**
 * `WorkspaceIndex` is an opaque `unknown` placeholder in the shared contract;
 * the orchestrator hands us a `JavaResolveContext`-shaped object. Narrow
 * structurally rather than via a cast chain so unexpected shapes fail cleanly.
 */
function narrowContext(workspaceIndex: WorkspaceIndex): JavaResolveContext | null {
  const ctx = workspaceIndex as JavaResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  return ctx;
}

/**
 * First-pass resolution against the full package path:
 * exact whole-path file > nested suffix file > first `.java` directly inside
 * the package directory.
 */
function resolveDirectMatch(
  ws: WorkspaceFileIndex,
  dirs: PackageDirIndex,
  pathLike: string,
): string | null {
  const exactName = `${pathLike}.java`;
  // The scan `break`s here, so an exact whole-path match wins even when a
  // `…/<exactName>` suffix match appeared EARLIER in iteration order. The two
  // lookups therefore stay separate: `index.get` conflates them and would
  // return the earlier suffix hit.
  const exact = ws.normToRaw.get(exactName);
  if (exact !== undefined) return exact;
  // No whole-path file exists, so every segment-suffix hit is a `/<exactName>`
  // match and `index.get` yields the first one in iteration order — exactly the
  // `suffixFile` the scan kept. Only a `.java` file can carry a `.java` suffix
  // key, so the old `endsWith('.java')` filter is implied.
  const suffixFile = ws.index.get(exactName);
  if (suffixFile !== undefined) return suffixFile;
  // First `.java` file living directly inside the package directory `pathLike`
  // (at repo root or nested under a source-root prefix), not deeper — the leg
  // wildcard imports land on.
  return firstFileDirectlyInPkgDir(dirs, pathLike);
}

/**
 * Try each suffix of the package path against `.java` files and directories,
 * stripping leading segments one at a time. Models `import com.example.User;`
 * resolving to `User.java` in a repo laid out without the `com/example/` prefix.
 */
function resolveByProgressiveStripping(
  ws: WorkspaceFileIndex,
  dirs: PackageDirIndex,
  pathLike: string,
): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    // `f === tailFile || f.endsWith('/' + tailFile)`, first in iteration order —
    // the scan returned at the first hit of EITHER, with no exact-wins rule,
    // so here the conflated suffix lookup is the right one.
    const tailFileMatch = ws.index.get(`${tail}.java`);
    if (tailFileMatch !== undefined) return tailFileMatch;
    // Collected mid-scan but returned only after it, so the file/suffix hit
    // above beats it even when this one came first in iteration order.
    const child = firstFileDirectlyInPkgDir(dirs, tail);
    if (child !== null) return child;
  }
  return null;
}
