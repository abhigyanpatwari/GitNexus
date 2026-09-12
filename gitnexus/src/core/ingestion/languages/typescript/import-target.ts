/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Delegates to `module-resolution.ts`, which runs the algorithm `tsc` and Node
 * actually run. It used to delegate to the shared `resolveImportPath`, whose
 * final step was `suffixResolve` — a repo-wide search for any file path ending
 * in the specifier. That is what #2953 removed: this path now resolves only
 * against declared inputs (real paths, tsconfig `paths`/`baseUrl`, package
 * manifests) and answers `null` for everything else.
 *
 * The `WorkspaceIndex` is opaque at the shared contract layer; we narrow it to
 * a TypeScript-shaped context carrying `fromFile`, the workspace file set, and
 * the two config indexes the algorithm reads.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'` — which for an external package is the correct
 * and complete answer.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import type { NodeWorkspacePackages } from '../../import-resolvers/node-workspace-packages.js';
import { resolveTsModule } from './module-resolution.js';
import type { TsconfigIndex } from './tsconfig.js';

export interface TsResolveContext {
  readonly fromFile: string;
  /** The workspace file set. */
  readonly allFilePaths: ReadonlySet<string>;
  /** Every tsconfig in the repo; `null` when the repo declares none. */
  readonly tsconfigs?: TsconfigIndex | null;
  /** Every in-repo `package.json`; `null` when the repo declares none. */
  readonly nodeWorkspacePackages?: NodeWorkspacePackages | null;
}

export function resolveTsImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = narrowTsContext(workspaceIndex);
  if (ctx === null) return null;

  // Dynamic imports carry `targetRaw` only for diagnostics; when the
  // expression isn't a string literal we can't resolve a file.
  // A string-literal dynamic import (`import('./m')`) resolves like a
  // static import — fall through to the shared path resolver.
  if (parsedImport.kind === 'dynamic-unresolved' && parsedImport.targetRaw === null) return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  return resolveTsTarget(parsedImport.targetRaw, ctx);
}

/**
 * Resolve a raw module-path string to a workspace file path. Operates directly
 * on the source string without requiring a `ParsedImport`, so the
 * `ScopeResolver.resolveImportTarget` adapter doesn't need to construct a fake
 * one to reach the resolver.
 *
 * Returns `null` when `targetRaw` is empty, names an external package, or names
 * something no declared config maps into the repo.
 */
export function resolveTsTarget(targetRaw: string, ctx: TsResolveContext): string | null {
  return resolveTsModule(targetRaw, {
    fromFile: ctx.fromFile,
    allFilePaths: ctx.allFilePaths,
    tsconfigs: ctx.tsconfigs ?? null,
    workspacePackages: ctx.nodeWorkspacePackages ?? null,
  });
}

function narrowTsContext(workspaceIndex: WorkspaceIndex): TsResolveContext | null {
  const ctx = workspaceIndex as TsResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  return ctx;
}
