/**
 * R import resolution.
 * Handles library(), require(), source(), and pkg::func() resolution.
 */

import path from 'path';
import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { RPackageConfig } from '../language-config.js';
import type { ImportResult, ResolveCtx } from './types.js';
import type { ImportResolutionContext } from '../scope-resolution/contract/scope-resolver.js';
import { getWorkspaceFileIndex } from './workspace-file-index.js';

/**
 * Low-level R import resolver (internal helper).
 * Resolves library/require/source paths to matching .R files.
 */
export function resolveRImportInternal(
  filePath: string,
  rawImportPath: string,
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
  rConfig: RPackageConfig | null,
  index?: SuffixIndex,
): string | string[] | null {
  const cleaned = rawImportPath.replace(/^["']|["']$/g, '');

  // source() with file path
  if (cleaned.endsWith('.R') || cleaned.endsWith('.r')) {
    if (path.isAbsolute(cleaned)) {
      const normalized = cleaned.replace(/\\/g, '/');
      const idx = normalizedFileList.indexOf(normalized);
      return idx >= 0 ? allFileList[idx] : null;
    }
    const dir = path.dirname(filePath);
    const resolved = path.join(dir, cleaned).replace(/\\/g, '/');
    const idx = normalizedFileList.indexOf(resolved);
    if (idx >= 0) return allFileList[idx];

    const pathParts = cleaned.split('/').filter(Boolean);
    return suffixResolve(pathParts, normalizedFileList, allFileList, index);
  }

  // library("pkg") / require("pkg") — resolve to ALL files in the local package
  if (rConfig) {
    const pkgDir = rConfig.packages.get(cleaned);
    if (pkgDir) {
      const rDirPrefix = (pkgDir ? pkgDir + '/' : '') + 'R/';
      const files: string[] = [];
      for (let i = 0; i < normalizedFileList.length; i++) {
        if (
          normalizedFileList[i].startsWith(rDirPrefix) &&
          (normalizedFileList[i].endsWith('.R') || normalizedFileList[i].endsWith('.r'))
        ) {
          files.push(allFileList[i]);
        }
      }
      if (files.length > 0) return files;
    }
  }

  // Fallback: suffix-based resolution
  const pathParts = cleaned.split('/').filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}

/** R: library/require/source resolution via R package config. */
export function resolveRImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolveRImportInternal(
    filePath,
    rawImportPath,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.configs.rPackageConfig ?? null,
    ctx.index,
  );
  if (!resolved) return null;
  const files = Array.isArray(resolved) ? resolved : [resolved];
  return { kind: 'files', files };
}

/**
 * `ScopeResolver.resolveImportTarget`-shaped adapter over
 * `resolveRImportInternal`. Two responsibilities live only here, not in the
 * internal resolver:
 *
 *  - Memoization: `getWorkspaceFileIndex` derives `{ normalized, all, index }`
 *    once per `allFilePaths` Set identity (see its own doc comment) and this
 *    adapter calls it on every invocation instead of materializing fresh
 *    arrays per import — the O(imports × files) regression PR #1918/#2911
 *    exist to catch (`import-target-index-reuse.contract.test.ts`).
 *  - Cross-language false-positive guard: a `library()`/`require()` package
 *    name not found in `rConfig.packages` would otherwise fall through to
 *    `resolveRImportInternal`'s generic suffix fallback — and `EXTENSIONS`
 *    (`./utils.js`) has no `.R`/`.r` entry, so a bare R package reference can
 *    suffix-match an unrelated same-named file in another language.
 *    `context.parsedImport.kind === 'wildcard'` is exactly the
 *    `library()`/`require()` shape (see `interpretRImport`), so the guard is
 *    scoped to that kind only — `source()`'s own suffix-based file-path
 *    fallback is unaffected.
 */
export function resolveRImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
  context?: ImportResolutionContext,
): string | readonly string[] | null {
  const rConfig = (resolutionConfig as RPackageConfig | null | undefined) ?? null;

  if (context?.parsedImport?.kind === 'wildcard') {
    const cleaned = targetRaw.replace(/^["']|["']$/g, '');
    if (rConfig === null || !rConfig.packages.has(cleaned)) return null;
  }

  const { normalized, all, index } = getWorkspaceFileIndex(allFilePaths);
  return resolveRImportInternal(fromFile, targetRaw, normalized, all, rConfig, index);
}
