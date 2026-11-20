/**
 * R import resolution.
 * Handles library(), require(), source(), and pkg::func() resolution.
 */

import path from 'path';
import type { SuffixIndex } from '../../utils/suffix-index.js';
import { suffixResolve } from '../../utils/suffix-index.js';
import { EXTENSIONS } from '../import-candidates.js';
import type { ParsedFile } from 'gitnexus-shared';
import { rExportPatternMatches, type RPackageConfig } from './package-config.js';
import { rBareName } from './bare-name.js';
import { rStringValue } from './export-pattern.js';
import {
  rFileTopLevel,
  rPackageDirForFile,
  rRDirPrefix,
  type RFileTopLevel,
} from './namespace-imports.js';
import type { ImportResolutionContext } from '../../scope-resolution/contract/scope-resolver.js';
import { perFileSet } from '../../utils/per-file-set.js';
import { getWorkspaceFileIndex } from '../../utils/workspace-file-index.js';

/** Matching R/ source prefixes, from the outermost directory to the nearest one. */
function* rSourceDirectoryPrefixes(filePath: string): Generator<string> {
  const normalized = filePath.replace(/\\/g, '/');
  for (const match of normalized.matchAll(/(?:^|\/)R(?=\/)/g)) {
    yield normalized.slice(0, match.index + match[0].length + 1);
  }
}

// A wildcard import needs the raw paths beneath the package's R/ directory in workspace order.
// A nested R/ directory contributes to each enclosing R/ prefix, as the prefix scan did.
const rFilesBySourceDirectory = perFileSet((paths: ReadonlySet<string>) => {
  const directories = new Map<string, string[]>();
  for (const raw of paths) {
    if (!/\.[Rr]$/.test(raw)) continue;
    for (const prefix of rSourceDirectoryPrefixes(raw)) {
      const files = directories.get(prefix);
      if (files) files.push(raw);
      else directories.set(prefix, [raw]);
    }
  }
  return directories;
});

/**
 * Low-level R import resolver (internal helper).
 * Resolves library/require/source paths to matching .R files.
 *
 * `normToRaw` (normalized path → first raw path with that spelling, built once per pass by
 * `getWorkspaceFileIndex`) answers the exact-path lookups of `source()` in O(1). Without it
 * they fall back to `indexOf` over `normalizedFileList`, which picks the same file (the first
 * in list order) but costs O(files) per `source()` import.
 */
export function resolveRImportInternal(
  filePath: string,
  rawImportPath: string,
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
  rConfig: RPackageConfig | null,
  index?: SuffixIndex,
  normToRaw?: ReadonlyMap<string, string>,
): string | string[] | null {
  const exactFile = (normalizedPath: string): string | undefined => {
    if (normToRaw !== undefined) return normToRaw.get(normalizedPath);
    const idx = normalizedFileList.indexOf(normalizedPath);
    return idx >= 0 ? allFileList[idx] : undefined;
  };
  const cleaned = rawImportPath.replace(/^["']|["']$/g, '');

  // source() with file path
  if (cleaned.endsWith('.R') || cleaned.endsWith('.r')) {
    if (path.isAbsolute(cleaned)) {
      const normalized = cleaned.replace(/\\/g, '/');
      return exactFile(normalized) ?? null;
    }
    const dir = path.dirname(filePath);
    const resolved = path.join(dir, cleaned).replace(/\\/g, '/');
    const direct = exactFile(resolved);
    if (direct !== undefined) return direct;

    const pathParts = cleaned.split('/').filter(Boolean);
    return suffixResolve(pathParts, normalizedFileList, allFileList, [''], index);
  }

  // library("pkg") / require("pkg") — resolve to ALL files in the local package
  if (rConfig) {
    const pkgDir = rConfig.packages.get(cleaned);
    // A root-level package has the directory '' (falsy), so test for absence, not truthiness.
    if (pkgDir !== undefined) {
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
  return suffixResolve(pathParts, normalizedFileList, allFileList, EXTENSIONS, index);
}

/** Per-package index of top-level definitions, built once per `parsedFiles` array. */
interface RPackageDefIndex {
  /** Files of the package's `R/` directory, with what each defines at top level. */
  readonly files: ReadonlyMap<string, RFileTopLevel>;
  /** Top-level symbol (backticks removed) → files (in `parsedFiles` order) that define it. */
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
    const built = new Map<
      string,
      {
        files: Map<string, RFileTopLevel>;
        definingFiles: Map<string, string[]>;
      }
    >();
    for (const parsed of parsedFiles) {
      const owner = rPackageDirForFile(parsed.filePath, rConfig)?.name;
      if (owner === undefined) continue;
      const topLevel = rFileTopLevel(parsed);
      let index = built.get(owner);
      if (index === undefined) {
        index = { files: new Map(), definingFiles: new Map() };
        built.set(owner, index);
      }
      index.files.set(parsed.filePath, topLevel);
      for (const name of topLevel.names) {
        const list = index.definingFiles.get(name);
        if (list === undefined) index.definingFiles.set(name, [parsed.filePath]);
        else list.push(parsed.filePath);
      }
    }
    byConfig.set(rConfig, (byPackage = built));
  }
  return byPackage.get(pkg);
}

/**
 * True when more than one `R/` file of the package that owns `filePath` defines `symbol` as a
 * function at top level. Such a name is ambiguous for `library()` and `importFrom()`: neither can tell the files
 * apart. False when `filePath` belongs to no package of `rConfig`.
 */
export function rNameDefinedInSeveralFiles(
  parsedFiles: readonly ParsedFile[],
  rConfig: RPackageConfig,
  filePath: string,
  symbol: string,
): boolean {
  const location = rPackageDirForFile(filePath, rConfig);
  if (location === undefined) return false;
  const index = packageDefIndex(parsedFiles, rConfig, location.name);
  const defining = index?.definingFiles.get(symbol);
  return (
    index !== undefined &&
    defining !== undefined &&
    definedAsFunctionInSeveralFiles(index, defining, symbol)
  );
}

/**
 * True when more than one of `files` binds `symbol` to a function. A class of that name next to a
 * function (a Bioconductor `setClass("Circle")` beside `Circle <- function(r)`) is not a second
 * callee: the call reaches the function.
 */
function definedAsFunctionInSeveralFiles(
  index: RPackageDefIndex,
  files: readonly string[],
  symbol: string,
): boolean {
  let functions = 0;
  for (const file of files) {
    if (index.files.get(file)?.functions.has(symbol) === true && ++functions > 1) return true;
  }
  return false;
}

/**
 * `s` without its leading and trailing backticks. Two scans, not `/^`+|`+$/g`: the pattern is
 * quadratic on `x` + n backticks + `y`, and a NAMESPACE entry is repository-controlled text.
 */
const stripBackticks = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 96) start++;
  while (end > start && s.charCodeAt(end - 1) === 96) end--;
  return s.slice(start, end);
};

/** The backticked entries of one export set, stripped, and the set size they were read at. */
const backtickedExportSymbols = new WeakMap<
  ReadonlySet<string>,
  { readonly size: number; readonly symbols: ReadonlySet<string> }
>();

/**
 * The symbols of the entries of `exports` that start or end with a backtick (a quoted
 * `` "`%+%`" `` entry keeps its backticks), stripped. Built in one pass per export set, so a
 * lookup is a set membership test instead of a walk over every export; a set that has grown or
 * shrunk since is read again.
 */
function backtickedExports(exports: ReadonlySet<string>): ReadonlySet<string> {
  const cached = backtickedExportSymbols.get(exports);
  if (cached !== undefined && cached.size === exports.size) return cached.symbols;
  const symbols = new Set<string>();
  for (const entry of exports) {
    if (entry.charCodeAt(0) === 96 || entry.charCodeAt(entry.length - 1) === 96) {
      symbols.add(stripBackticks(entry));
    }
  }
  backtickedExportSymbols.set(exports, { size: exports.size, symbols });
  return symbols;
}

/**
 * Resolve a NAMESPACE `importFrom(pkg, importedName)` to the `R/` file(s) of the
 * local package `pkg` that define `importedName` at top level, or `null`.
 * Look up the symbol without backticks. The module export map preserves its definition spelling.
 * A named import requires one package, a proven export, and one unambiguous file binding.
 * Dotted import names are outside the supported named-import rules.
 */
export function resolveRNamedImport(
  rConfig: RPackageConfig | null,
  targetRaw: string,
  importedName: string,
  parsedFiles: readonly ParsedFile[],
): readonly string[] | null {
  const pkg = targetRaw.replace(/^["']|["']$/g, '');
  const pkgDir = rConfig?.packages.get(pkg);
  if (
    rConfig === null ||
    pkgDir === undefined ||
    rConfig.packageUniquenessUnknown ||
    rConfig.duplicatePackageDirs?.has(pkgDir)
  )
    return null;

  if (importedName.includes('.')) return null;

  const symbol = rBareName(importedName);
  const info = rConfig.namespaceInfoByPackageDir.get(pkgDir);
  if (info !== undefined && info.hasNamespaceFile) {
    // An `S3method()` registration alone is not an export (`RNamespaceInfo.s3RegisteredOnly`).
    const exported =
      (info.s3RegisteredOnly?.has(symbol) !== true &&
        (info.namedExports.has(symbol) || backtickedExports(info.namedExports).has(symbol))) ||
      rExportPatternMatches(info, symbol);
    if (!exported) return null;
  }

  const index = packageDefIndex(parsedFiles, rConfig, pkg);
  const defining = index?.definingFiles.get(symbol);
  if (index === undefined || defining === undefined || defining.length === 0) return null;
  // Two files of the package define the name: which one R uses depends on load order, so the
  // name binds to neither.
  if (definedAsFunctionInSeveralFiles(index, defining, symbol)) return null;
  // A defining file in which another definition (a closure-local function, a second assignment)
  // carries the same name: finalize would bind the first one it meets.
  if (defining.some((file) => index.files.get(file)?.repeated.has(symbol) === true)) return null;
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
 *    (`languages/import-candidates.ts`) has no `.R`/`.r` entry, so a bare R package reference can
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
    const dir = rConfig?.packages.get(cleaned);
    if (
      dir === undefined ||
      rConfig.packageUniquenessUnknown ||
      rConfig.duplicatePackageDirs?.has(dir)
    )
      return null;
    return rFilesBySourceDirectory(allFilePaths).get(rRDirPrefix(dir)) ?? null;
  }

  if (context?.parsedImport?.kind === 'side-effect') {
    const source = rStringValue(targetRaw);
    if (source === null || !/\.[Rr]$/.test(source) || /^(?:~|[a-z][a-z0-9+.-]*:\/\/)/i.test(source))
      return null;
    // Keep this path separate from package discovery and cross-language suffix guesses.
    const { normalized, all, index, normToRaw } = getWorkspaceFileIndex(allFilePaths);
    return resolveRImportInternal(fromFile, source, normalized, all, null, index, normToRaw);
  }

  if (context?.parsedImport?.kind === 'named') {
    return resolveRNamedImport(
      rConfig,
      targetRaw,
      context.parsedImport.importedName,
      context.parsedFiles,
    );
  }

  const { normalized, all, index, normToRaw } = getWorkspaceFileIndex(allFilePaths);
  return resolveRImportInternal(fromFile, targetRaw, normalized, all, rConfig, index, normToRaw);
}
