/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Unit 2 shape: suffix-match against the repo's `.cs` files. Each
 * `using System.Collections.Generic;` could legally expand to multiple
 * files (every `.cs` that declares `namespace System.Collections.Generic`
 * — partial classes, assembly-wide namespaces). The scope-resolver
 * contract returns a single primary target, so we pick the first
 * match. Cross-file partial-class aggregation runs at graph-bridge
 * time (Unit 6) via `populateOwners`.
 *
 * The legacy csproj-based `resolveCSharpImportInternal` needs config
 * objects the scope-resolver doesn't carry; the Unit 7 parity gate
 * will surface cases where the suffix-match diverges from the
 * namespace-based resolver and we'll adjust the contract if needed.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

export interface CsharpResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolveCsharpImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  // WorkspaceIndex is `unknown` in the shared contract (Ring 1
  // placeholder). The scope-resolution orchestrator hands us a
  // CsharpResolveContext-shaped object; narrow structurally rather
  // than via a cast chain so unexpected shapes return null cleanly.
  const ctx = workspaceIndex as CsharpResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  // Namespace path: `System.Collections.Generic` → `System/Collections/Generic`.
  const pathLike = parsedImport.targetRaw.replace(/\./g, '/');
  const suffix = `/${pathLike}`;

  // Exact file match: `System/Collections/Generic.cs` (rare but legal).
  // Suffix match for nested layouts: `src/lib/System/Collections/Generic.cs`.
  // Directory match: first `.cs` file directly inside the namespace dir
  // (e.g. `System/Collections/Generic/List.cs` matches namespace Generic).
  let exactFile: string | null = null;
  let suffixFile: string | null = null;
  let directoryChild: string | null = null;
  const dirPrefix = `${pathLike}/`;
  const suffixDirPrefix = `/${dirPrefix}`;

  for (const raw of ctx.allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.cs')) continue;
    if (f === `${pathLike}.cs`) {
      exactFile = raw;
      break;
    }
    if (suffixFile === null && f.endsWith(`${suffix}.cs`)) {
      suffixFile = raw;
    }
    if (directoryChild === null) {
      // Namespace-to-directory match: pick the first `.cs` directly in
      // the namespace dir (not nested deeper). Legacy resolver emits
      // all of them; we take one so the scope-resolver contract stays
      // single-target.
      const atRoot = f.startsWith(dirPrefix);
      const atNested = f.includes(suffixDirPrefix);
      if (atRoot || atNested) {
        const idx = atRoot ? 0 : f.indexOf(suffixDirPrefix) + 1;
        const after = f.slice(idx + dirPrefix.length);
        if (after.length > 0 && !after.includes('/')) {
          directoryChild = raw;
        }
      }
    }
  }

  if (exactFile !== null) return exactFile;
  if (suffixFile !== null) return suffixFile;
  if (directoryChild !== null) return directoryChild;

  // Progressive prefix stripping — mirrors csproj's root-namespace
  // mapping without the csproj. `using CrossFile.Models;` in a repo
  // laid out `Models/User.cs` (no `CrossFile/` prefix) works because
  // the legacy resolver consults csproj; the scope-resolver layer
  // doesn't have csproj, so we try each suffix of the namespace path
  // against `.cs` files and directories.
  //
  // Also handles `using static CrossFile.Models.UserFactory;` —
  // strip the leading segment, try `Models/UserFactory.cs`; strip
  // two, try `UserFactory.cs`.
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    const tailFile = `${tail}.cs`;
    const tailSuffix = `/${tailFile}`;
    const tailDir = `${tail}/`;
    const tailSuffixDir = `/${tailDir}`;
    let tailDirectChild: string | null = null;
    for (const raw of ctx.allFilePaths) {
      const f = raw.replace(/\\/g, '/');
      if (!f.endsWith('.cs')) continue;
      if (f === tailFile) return raw;
      if (f.endsWith(tailSuffix)) return raw;
      if (tailDirectChild === null) {
        const atRoot = f.startsWith(tailDir);
        const atNested = f.includes(tailSuffixDir);
        if (atRoot || atNested) {
          const idx = atRoot ? 0 : f.indexOf(tailSuffixDir) + 1;
          const after = f.slice(idx + tailDir.length);
          if (after.length > 0 && !after.includes('/')) tailDirectChild = raw;
        }
      }
    }
    if (tailDirectChild !== null) return tailDirectChild;
  }

  return null;
}
