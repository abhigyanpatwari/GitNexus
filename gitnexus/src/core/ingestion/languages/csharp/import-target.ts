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
 * When `.csproj` configs are available, consults the legacy
 * namespace-directory resolver first. Both that resolver's suffix
 * fallback and the progressive prefix stripping below are gated on
 * declared in-repo namespaces so BCL usings like `System.Threading.Tasks`
 * cannot spuriously match a local `Tasks.cs` (#1881).
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import type { CSharpProjectConfig, CSharpNamespaceEvidence } from '../../language-config.js';
import { resolveCSharpImportInternal } from '../../import-resolvers/csharp.js';
import {
  getWorkspaceFileIndex,
  type WorkspaceFileIndex,
} from '../../import-resolvers/workspace-file-index.js';
import {
  buildPackageDirIndex,
  firstFileDirectlyInPkgDir,
  type PackageDirIndex,
} from '../../import-resolvers/package-dir-index.js';
import { csharpSuffixFallbackAllowed } from '../../csharp-namespace-gate.js';

export interface CsharpResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  readonly csharpConfigs?: readonly CSharpProjectConfig[];
  readonly namespaces?: CSharpNamespaceEvidence;
}

/**
 * Namespace-directory index over the `.cs` files, memoized on the Set's
 * identity. Feeds `firstFileDirectlyInPkgDir` (in
 * `import-resolvers/package-dir-index.ts`), which the no-csproj path calls once
 * for the direct match and then up to once per stripped namespace prefix.
 */
const csharpDirIndexCache = new WeakMap<ReadonlySet<string>, PackageDirIndex>();

function getCsharpDirIndex(allFilePaths: ReadonlySet<string>): PackageDirIndex {
  const cached = csharpDirIndexCache.get(allFilePaths);
  if (cached) return cached;
  const built = buildPackageDirIndex(allFilePaths, (normalized) => normalized.endsWith('.cs'));
  csharpDirIndexCache.set(allFilePaths, built);
  return built;
}

export function resolveCsharpImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = narrowContext(workspaceIndex);
  if (ctx === null) return null;
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;
  const targetRaw = parsedImport.targetRaw;
  const evidence = ctx.namespaces;

  const csharpConfigs = ctx.csharpConfigs ?? [];
  if (csharpConfigs.length > 0) {
    const { normalized, all, index } = getWorkspaceFileIndex(ctx.allFilePaths);
    const fromCsproj = resolveCSharpImportInternal(
      targetRaw,
      [...csharpConfigs],
      normalized,
      all,
      index,
      evidence,
    );
    if (fromCsproj.length > 0) return fromCsproj[0]!;
    // csproj configs are authoritative: mirror legacy `configs/csharp.ts`,
    // which returns an empty result to STOP the chain. Falling through to the
    // ungated `resolveDirectMatch` would re-introduce the BCL→local match the
    // internal resolver's gate just suppressed (#1881 parity, #2).
    return null;
  }

  // Namespace path: `System.Collections.Generic` → `System/Collections/Generic`.
  const pathLike = targetRaw.replace(/\./g, '/');

  // Gate the WHOLE no-csproj path on declared in-repo namespaces — the direct
  // path/suffix match INCLUDED — so a BCL using can't resolve to a
  // coincidentally path-aligned local file (e.g. `Legacy/System/Threading/
  // Tasks.cs` satisfying `using System.Threading.Tasks;`). Running the gate
  // before `resolveDirectMatch` mirrors the legacy leg's gate-first ordering
  // (`import-resolvers/configs/csharp.ts`), so the two legs are equivalent
  // (#1881 parity, Codex F2). The gate keeps its fail-open for
  // undefined/truncated evidence, so legitimate edges in unscanned repos are
  // unaffected.
  if (!csharpSuffixFallbackAllowed(targetRaw, evidence)) {
    return null;
  }

  // Exact file / nested-suffix / namespace-dir direct-child match.
  //
  // The no-csproj path used to take the raw Set and re-scan it — up to eight
  // full workspace passes for a four-segment `using` — past the memoized index
  // sitting right there for the csproj branch (#2878). Both legs now read the
  // same per-run indexes.
  const ws = getWorkspaceFileIndex(ctx.allFilePaths);
  const dirs = getCsharpDirIndex(ctx.allFilePaths);
  const direct = resolveDirectMatch(ws, dirs, pathLike);
  if (direct !== null) return direct;

  // Progressive prefix stripping — mirrors csproj's root-namespace mapping
  // without the csproj.
  return resolveByProgressiveStripping(ws, dirs, pathLike);
}

/**
 * `WorkspaceIndex` is an opaque `unknown` placeholder in the shared contract;
 * the orchestrator hands us a `CsharpResolveContext`-shaped object. Narrow
 * structurally rather than via a cast chain so unexpected shapes fail cleanly.
 */
function narrowContext(workspaceIndex: WorkspaceIndex): CsharpResolveContext | null {
  const ctx = workspaceIndex as CsharpResolveContext | undefined;
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
 * First-pass resolution against the full namespace path:
 * exact whole-path file > nested suffix file > first `.cs` directly inside
 * the namespace directory.
 */
function resolveDirectMatch(
  ws: WorkspaceFileIndex,
  dirs: PackageDirIndex,
  pathLike: string,
): string | null {
  const exactName = `${pathLike}.cs`;
  // An exact whole-path match wins even when a `…/<exactName>` suffix match
  // appeared EARLIER in iteration order, so the two lookups stay separate:
  // `index.get` conflates them and would return the earlier suffix hit.
  const exact = ws.normToRaw.get(exactName);
  if (exact !== undefined) return exact;
  // No whole-path file exists, so every segment-suffix hit is a `/<exactName>`
  // match and `index.get` yields the first one in iteration order — exactly the
  // `suffixFile` the scan kept. Only a `.cs` file can carry a `.cs` suffix key,
  // so the old `endsWith('.cs')` filter is implied.
  const suffixFile = ws.index.get(exactName);
  if (suffixFile !== undefined) return suffixFile;
  // First `.cs` file living directly inside the namespace directory `pathLike`
  // (at repo root or nested under a project prefix), not deeper. The legacy
  // resolver emits all of them; the scope-resolver contract is single-target so
  // we take one.
  return firstFileDirectlyInPkgDir(dirs, pathLike);
}

/**
 * Try each suffix of the namespace path against `.cs` files and directories,
 * stripping leading segments one at a time. Models `using CrossFile.Models;`
 * resolving to `Models/User.cs` in a repo laid out without the `CrossFile/`
 * prefix (the scope-resolver layer has no csproj to consult).
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
    // no exact-wins rule here, unlike `resolveDirectMatch`, so the conflated
    // suffix lookup is the right one.
    const tailFileMatch = ws.index.get(`${tail}.cs`);
    if (tailFileMatch !== undefined) return tailFileMatch;
    const child = firstFileDirectlyInPkgDir(dirs, tail);
    if (child !== null) return child;
  }
  return null;
}
