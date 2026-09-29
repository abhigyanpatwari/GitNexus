/**
 * R import resolution.
 * Handles library(), require(), source(), and pkg::func() resolution.
 */

import path from 'path';
import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { ParsedFile } from 'gitnexus-shared';
import type { RPackageConfig } from '../language-config.js';
import {
  rFileTopLevel,
  rPackageDirForFile,
  type RFileTopLevel,
} from '../languages/r/namespace-imports.js';
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

/** Per-package index of top-level definitions, built once per `parsedFiles` array. */
interface RPackageDefIndex {
  /** Files of the package's `R/` directory, with what each defines at top level. */
  readonly files: ReadonlyMap<string, RFileTopLevel>;
  /** Top-level name → files (in `parsedFiles` order) that define it. */
  readonly definingFiles: ReadonlyMap<string, readonly string[]>;
}

const packageDefIndexes = new WeakMap<
  readonly ParsedFile[],
  WeakMap<RPackageConfig, ReadonlyMap<string, RPackageDefIndex>>
>();

function packageDefIndex(
  parsedFiles: readonly ParsedFile[],
  rConfig: RPackageConfig,
  pkg: string,
): RPackageDefIndex | undefined {
  let byConfig = packageDefIndexes.get(parsedFiles);
  if (byConfig === undefined) packageDefIndexes.set(parsedFiles, (byConfig = new WeakMap()));
  let byPackage = byConfig.get(rConfig);
  if (byPackage === undefined) {
    const files = new Map<string, Map<string, RFileTopLevel>>();
    const defining = new Map<string, Map<string, string[]>>();
    for (const parsed of parsedFiles) {
      const location = rPackageDirForFile(parsed.filePath, rConfig);
      if (location === undefined) continue;
      const topLevel = rFileTopLevel(parsed);
      let pkgFiles = files.get(location.name);
      let pkgDefining = defining.get(location.name);
      if (pkgFiles === undefined || pkgDefining === undefined) {
        files.set(location.name, (pkgFiles = new Map()));
        defining.set(location.name, (pkgDefining = new Map()));
      }
      pkgFiles.set(parsed.filePath, topLevel);
      for (const name of topLevel.names) {
        const list = pkgDefining.get(name);
        if (list === undefined) pkgDefining.set(name, [parsed.filePath]);
        else list.push(parsed.filePath);
      }
    }
    const built = new Map<string, RPackageDefIndex>();
    for (const [name, pkgFiles] of files) {
      built.set(name, { files: pkgFiles, definingFiles: defining.get(name) ?? new Map() });
    }
    byConfig.set(rConfig, (byPackage = built));
  }
  return byPackage.get(pkg);
}

const stripBackticks = (s: string): string => s.replace(/^`+|`+$/g, '');

/**
 * Resolve a NAMESPACE `importFrom(pkg, importedName)` to the `R/` file(s) of the
 * local package `pkg` that define `importedName` at top level, or `null`.
 *
 * `null` (no binding, no IMPORTS edge) when: `pkg` is not a local package
 * (external packages never suffix-match anything); `importedName` is dotted
 * (finalize keys defs by the text after the last `.`, so it can never bind);
 * the provider has a NAMESPACE that does not export the name; no file defines
 * it at top level; or a defining file also holds a dotted top-level def whose
 * tail equals `importedName` (finalize would index `print.tidy` under `tidy`
 * and bind the WRONG def — the guard is order-blind, so it also refuses the
 * layout where the bare def comes first). `null` degrades the call site to the
 * baseline `global-name-fallback` guess. Never builds a workspace file index.
 */
function resolveRNamedImport(
  rConfig: RPackageConfig | null,
  targetRaw: string,
  importedName: string,
  parsedFiles: readonly ParsedFile[],
): readonly string[] | null {
  const pkg = targetRaw.replace(/^["']|["']$/g, '');
  const pkgDir = rConfig?.packages.get(pkg);
  if (rConfig === null || pkgDir === undefined) return null;

  if (importedName.includes('.')) return null;

  const info = rConfig.namespaceInfoByPackageDir.get(pkgDir);
  if (info !== undefined && info.hasNamespaceFile) {
    const exported =
      info.namedExports.has(importedName) ||
      [...info.namedExports].some((entry) => stripBackticks(entry) === importedName) ||
      info.exportPatterns.some((pattern) => pattern.test(importedName));
    if (!exported) return null;
  }

  const index = packageDefIndex(parsedFiles, rConfig, pkg);
  const defining = index?.definingFiles.get(importedName);
  if (index === undefined || defining === undefined || defining.length === 0) return null;
  if (defining.some((file) => index.files.get(file)?.dottedTails.has(importedName) === true)) {
    return null;
  }
  return defining;
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
 *  - NAMESPACE `importFrom()` names (`kind: 'named'`, synthesised by
 *    `populateRNamespaceImports`): resolved by {@link resolveRNamedImport}
 *    before `getWorkspaceFileIndex`, so they build no file index.
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

  if (context?.parsedImport?.kind === 'named') {
    return resolveRNamedImport(
      rConfig,
      targetRaw,
      context.parsedImport.importedName,
      context.parsedFiles,
    );
  }

  const { normalized, all, index } = getWorkspaceFileIndex(allFilePaths);
  return resolveRImportInternal(fromFile, targetRaw, normalized, all, rConfig, index);
}
