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
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import { csharpSuffixFallbackAllowed } from '../../csharp-namespace-gate.js';

export interface CsharpResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  readonly csharpConfigs?: readonly CSharpProjectConfig[];
  readonly namespaces?: CSharpNamespaceEvidence;
}

/** Normalized file list + suffix index, built once per workspace `allFilePaths`. */
interface WorkspaceFileIndex {
  readonly normalized: string[];
  readonly all: string[];
  readonly index: SuffixIndex;
}

// Memoize on Set identity: the orchestrator passes the SAME `allFilePaths`
// Set through every `resolveImportTarget` call in a pass, so this rebuilds
// the normalized list + suffix index once instead of once per import (#1881 #2).
const workspaceFileIndexCache = new WeakMap<ReadonlySet<string>, WorkspaceFileIndex>();

function getWorkspaceFileIndex(allFilePaths: ReadonlySet<string>): WorkspaceFileIndex {
  const cached = workspaceFileIndexCache.get(allFilePaths);
  if (cached) return cached;
  const all = [...allFilePaths];
  const normalized = all.map((f) => f.replace(/\\/g, '/'));
  const built: WorkspaceFileIndex = { normalized, all, index: buildSuffixIndex(normalized, all) };
  workspaceFileIndexCache.set(allFilePaths, built);
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
  const direct = resolveDirectMatch(ctx.allFilePaths, pathLike);
  if (direct !== null) return direct;

  // Progressive prefix stripping — mirrors csproj's root-namespace mapping
  // without the csproj.
  return resolveByProgressiveStripping(ctx.allFilePaths, pathLike);
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
function resolveDirectMatch(allFilePaths: ReadonlySet<string>, pathLike: string): string | null {
  const exactName = `${pathLike}.cs`;
  const nestedSuffix = `/${exactName}`;
  let suffixFile: string | null = null;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.cs')) continue;
    if (f === exactName) return raw; // exact whole-path match wins
    if (suffixFile === null && f.endsWith(nestedSuffix)) suffixFile = raw;
  }
  if (suffixFile !== null) return suffixFile;
  return findDirectChild(allFilePaths, pathLike);
}

/**
 * First `.cs` file that lives directly inside the namespace directory
 * `dirSegment` (at repo root or nested under a project prefix), not deeper.
 * The legacy resolver emits all of them; the scope-resolver contract is
 * single-target so we take one.
 */
function findDirectChild(allFilePaths: ReadonlySet<string>, dirSegment: string): string | null {
  const dirPrefix = `${dirSegment}/`;
  const nestedDirPrefix = `/${dirPrefix}`;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.cs')) continue;
    const atRoot = f.startsWith(dirPrefix);
    const atNested = f.includes(nestedDirPrefix);
    if (!atRoot && !atNested) continue;
    const idx = atRoot ? 0 : f.indexOf(nestedDirPrefix) + 1;
    const after = f.slice(idx + dirPrefix.length);
    if (after.length > 0 && !after.includes('/')) return raw;
  }
  return null;
}

/**
 * Try each suffix of the namespace path against `.cs` files and directories,
 * stripping leading segments one at a time. Models `using CrossFile.Models;`
 * resolving to `Models/User.cs` in a repo laid out without the `CrossFile/`
 * prefix (the scope-resolver layer has no csproj to consult).
 */
function resolveByProgressiveStripping(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    const tailFile = `${tail}.cs`;
    const tailSuffix = `/${tailFile}`;
    let tailFileMatch: string | null = null;
    for (const raw of allFilePaths) {
      const f = raw.replace(/\\/g, '/');
      if (!f.endsWith('.cs')) continue;
      if (f === tailFile || f.endsWith(tailSuffix)) {
        tailFileMatch = raw;
        break;
      }
    }
    if (tailFileMatch !== null) return tailFileMatch;
    const child = findDirectChild(allFilePaths, tail);
    if (child !== null) return child;
  }
  return null;
}
