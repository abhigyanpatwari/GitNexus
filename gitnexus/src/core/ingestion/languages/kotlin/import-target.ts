/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` to Kotlin declared-package
 * resolution. Package facts and module bindings are already present on the
 * parsed workspace, so this performs no source I/O and no path inference.
 */

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { getKotlinPackageFact } from './package-facts.js';
import {
  buildKotlinPackageIndex,
  resolveKotlinModule,
  type KotlinPackageIndex,
} from './module-resolution.js';

export interface KotlinResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  /** Stable parsed-workspace identity supplied by the resolution pass. */
  readonly parsedFiles?: readonly ParsedFile[];
}

const getKotlinPackageIndex = perFileSet(
  (parsedFiles: readonly ParsedFile[]): KotlinPackageIndex =>
    buildKotlinPackageIndex(parsedFiles, getKotlinPackageFact),
);

export function resolveKotlinImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = narrowContext(workspaceIndex);
  if (ctx === null || parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const parsedFiles = ctx.parsedFiles;
  if (parsedFiles === undefined || parsedFiles.length === 0) return null;

  return resolveKotlinModule(parsedImport.targetRaw, getKotlinPackageIndex(parsedFiles));
}

function narrowContext(workspaceIndex: WorkspaceIndex): KotlinResolveContext | null {
  const ctx = workspaceIndex as KotlinResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  return ctx;
}
