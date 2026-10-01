import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  parseRNamespaceExports,
  parseRNamespaceImportFrom,
  type RNamespaceImportFromEntry,
} from './namespace-imports.js';
import { compileRExportPatternDetailed, type RExportMatcher } from './export-pattern.js';
import { isDev } from '../../utils/env.js';
import { logger } from '../../../logger.js';

/** An `exportPattern()` argument that was not compiled, and why. */
export interface RDroppedExportPattern {
  /** The pattern text as R would see it (the string value, after unescaping). */
  readonly pattern: string;
  readonly reason: string;
}

/** R package config parsed from DESCRIPTION files in a multi-package repo */
export interface RPackageConfig {
  /**
   * Map of package name to directory path relative to repo root. When several
   * directories declare the same `Package:` name the shallowest directory wins
   * and, among equal depths, the one whose whole path string sorts first by
   * code unit (so `a-b/x` beats `a/x`: `-` sorts before `/`); the others are
   * not entries here (their NAMESPACE is still recorded in
   * {@link namespaceInfoByPackageDir}, which is keyed by directory). Installed
   * libraries and check output (`renv`, `packrat`, `revdep`, `<name>.Rcheck`) are
   * not searched, so their packages are not entries here.
   */
  packages: Map<string, string>;
  /** Package-scoped NAMESPACE config keyed by package dir relative to repo root. */
  namespaceInfoByPackageDir: Map<string, RNamespaceInfo>;
  /**
   * Every directory (relative to the repo root, `''` for the root) in which discovery read a
   * `DESCRIPTION` with a `Package:` line: the directories of {@link packages} plus the
   * directories of same-name copies that lost to them, with or without a NAMESPACE. The
   * qualifier-locality decision reads it, so that a file under such a directory's `R/` is not
   * taken as evidence for a package named after its directory. Optional so that hand-built
   * configs read as "the directories of {@link packages} and {@link namespaceInfoByPackageDir}".
   */
  packageDirs?: ReadonlySet<string>;
  /**
   * True when discovery cannot rule out an undiscovered package: a directory
   * of the main walk could not be read, or a subtree the walk skipped (below
   * the depth limit, or still queued when the directory cap stopped it) may
   * hide a package. Skipped subtrees are scanned once more for `DESCRIPTION`
   * files (see {@link hidesUndiscoveredPackage}); the flag is set only when
   * that scan finds a `Package:` name absent from {@link packages}, exceeds
   * its directory budget, or hits an unreadable path. A skipped subtree with
   * no package inside (`tests/testthat/fixtures/...`, `inst/extdata/...`) or
   * only a same-name copy of an already-discovered package does NOT truncate.
   * A package missing from {@link packages} is then not proven absent from the
   * repo, so `rQualifierLocality` answers `unknown` rather than `external`.
   * This holds for an empty {@link packages} map too: a complete scan that found
   * no package at all proves every qualifier external.
   * Optional so that hand-built configs (tests, callers that never scan) read
   * as "complete".
   */
  truncated?: boolean;
}

export interface RNamespaceInfo {
  /** True when the package has a readable NAMESPACE file. */
  hasNamespaceFile: boolean;
  /** Explicit named exports from export()/exportClasses()/exportMethods()/S3method(). */
  namedExports: Set<string>;
  /** Precompiled matchers from exportPattern("..."), compiled once here so
   *  `refineRExportStatus` doesn't recompile per node it checks. POSIX bracket
   *  classes such as `[[:alpha:]]` are translated to JS equivalents first
   *  (see `compileRExportPattern`). The matchers run in linear time, so a hostile
   *  pattern cannot stall analysis. Patterns that fail to compile, or that the
   *  linear-time matcher cannot handle, are dropped at this stage (they never match)
   *  and listed in {@link droppedExportPatterns}. */
  exportPatterns: RExportMatcher[];
  /**
   * Non-empty `exportPattern()` arguments that could not be compiled, with the reason.
   * A dropped pattern exports nothing, so every name the pattern was meant to cover
   * reads as unexported; `reportDroppedRExportPatterns` turns these into warnings.
   * Optional so that hand-built configs read as "nothing dropped".
   */
  droppedExportPatterns?: readonly RDroppedExportPattern[];
  /** `importFrom(pkg, name)` pairs in NAMESPACE file order (all entries, incl. self-imports and duplicates). */
  importFrom: readonly RNamespaceImportFromEntry[];
}

/** Longest pattern prefix quoted in a warning. */
const QUOTED_PATTERN_LENGTH = 60;

const quotePattern = (pattern: string): string =>
  JSON.stringify(
    pattern.length > QUOTED_PATTERN_LENGTH
      ? `${pattern.slice(0, QUOTED_PATTERN_LENGTH)}...`
      : pattern,
  );

/**
 * Warn, once per pattern per package, about every `exportPattern()` that is not in
 * effect: one dropped at load ({@link RNamespaceInfo.droppedExportPatterns}) or one
 * whose matcher ran out of work budget since (names it had not yet decided were read as
 * unexported). Call after the matchers have been used. A dropped pattern exports
 * nothing, which would otherwise look exactly like a package that exports few names.
 */
export function reportRExportPatternProblems(config: RPackageConfig): void {
  for (const [pkgDir, info] of config.namespaceInfoByPackageDir) {
    const where = pkgDir === '' ? '.' : pkgDir;
    for (const { pattern, reason } of info.droppedExportPatterns ?? []) {
      logger.warn(
        `R package ${where}: exportPattern(${quotePattern(pattern)}) was ignored (${reason}); ` +
          `names it would export are treated as not exported`,
      );
    }
    for (const matcher of info.exportPatterns) {
      if (matcher.exhausted !== true) continue;
      logger.warn(
        `R package ${where}: exportPattern(${quotePattern(matcher.source)}) exceeded its work ` +
          `budget; names it had not yet been tested against are treated as not exported`,
      );
    }
  }
}

/** Directories never descended into, by the main walk and the hidden-package scan alike. */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', '.Rproj.user']);

/**
 * Directories R tooling fills with installed packages or check output: the renv project
 * library, the packrat private library and the revdepcheck workspace. Each holds one
 * `DESCRIPTION` per third-party package, none of which is part of the repository.
 */
const VENDORED_LIBRARY_DIR_NAMES: ReadonlySet<string> = new Set(['renv', 'packrat', 'revdep']);

/** Suffix of the `<pkg>.Rcheck` directories `R CMD check` writes. */
const RCHECK_SUFFIX = '.Rcheck';

/**
 * True for a directory that discovery must not enter. The match is on the directory's own
 * name, exact and case-sensitive: `renv`, `packrat` or `revdep`, or `<something>.Rcheck`
 * (a name that is only the suffix is not one). Look-alikes such as `renv-tools`, `Renv`,
 * `revdeps` or `pkg.rcheck` are ordinary directories and may hold a real package.
 */
function isSkippedDirName(name: string): boolean {
  return (
    SKIPPED_DIR_NAMES.has(name) ||
    VENDORED_LIBRARY_DIR_NAMES.has(name) ||
    (name.length > RCHECK_SUFFIX.length && name.endsWith(RCHECK_SUFFIX))
  );
}

/**
 * Directory entries in code-unit name order. `readdir` order is filesystem-dependent
 * (and `localeCompare` is locale-dependent), so every walk below reads through this to
 * make what it visits, and what it finds first, the same on every machine.
 */
async function readDirSorted(dir: string): Promise<Dirent[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Sort key that ranks the directories declaring one package name: fewer path segments
 * first, then the whole `/`-separated relative path compared by code unit. Comparing keys
 * with `<` therefore needs no help from the walk order. The depth is zero-padded so that
 * it compares as a number; `''` (the repo root) has depth 0.
 */
function preferredPackageDir(pkgDir: string): string {
  const depth = pkgDir === '' ? 0 : pkgDir.split('/').length;
  return `${String(depth).padStart(6, '0')}\0${pkgDir}`;
}

/** Global directory budget for {@link hidesUndiscoveredPackage} across all its roots. */
const HIDDEN_SCAN_BUDGET = 5000;

/**
 * Scan the subtrees the main walk skipped for a package it never discovered.
 *
 * Iterative DFS over `roots` under one global `budget` of directories (skipping
 * the directories {@link isSkippedDirName} names, as the main walk does). Returns
 * `true` (cannot rule a hidden package out) when the budget is exceeded, when a
 * directory or `DESCRIPTION` cannot be read, or when a `DESCRIPTION` declares a
 * `Package:` name that is not in `knownPackageNames`. Returns `false` when every
 * subtree was scanned and holds no such package. Deterministic and read-only.
 * The answer is a property of the set of directories, not of the order they are
 * visited in (every `true` condition is order-independent and a `false` means the
 * whole forest was read), but the walk still reads sorted so that it is reproducible.
 */
export async function hidesUndiscoveredPackage(
  roots: readonly string[],
  knownPackageNames: ReadonlySet<string>,
  budget: number = HIDDEN_SCAN_BUDGET,
): Promise<boolean> {
  const stack = [...roots];
  let remaining = budget;
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    if (--remaining < 0) return true;
    let entries;
    try {
      entries = await readDirSorted(dir);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isSkippedDirName(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'DESCRIPTION') {
        try {
          const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
          const pkgMatch = content.match(/^Package:\s*(\S+)/m);
          if (pkgMatch && !knownPackageNames.has(pkgMatch[1])) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Discover the R packages of a repo. Always returns a config: a scan that finds
 * no package yields an empty {@link RPackageConfig.packages} map, and its
 * {@link RPackageConfig.truncated} flag says whether that result is complete
 * (no `DESCRIPTION` anywhere, so no `pkg::fn()` qualifier names a local package)
 * or merely what the bounded scan managed to see.
 */
export async function loadRPackageConfig(repoRoot: string): Promise<RPackageConfig> {
  const packages = new Map<string, string>();
  const namespaceInfoByPackageDir = new Map<string, RNamespaceInfo>();
  const packageDirs = new Set<string>();
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 3;
  const maxDirs = 200;
  let dirsScanned = 0;
  let truncated = false;
  // Directories the walk never visits (depth limit, cap leftovers): scanned at the end.
  const unvisited: string[] = [];

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await readDirSorted(dir);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (isSkippedDirName(entry.name)) continue;
          const child = path.join(dir, entry.name);
          if (depth < maxDepth) {
            scanQueue.push({ dir: child, depth: depth + 1 });
          } else {
            // Below the depth limit: not visited by the walk; scanned below.
            unvisited.push(child);
          }
        }
        if (entry.isFile() && entry.name === 'DESCRIPTION') {
          try {
            const descPath = path.join(dir, entry.name);
            const content = await fs.readFile(descPath, 'utf-8');
            const pkgMatch = content.match(/^Package:\s*(\S+)/m);
            if (pkgMatch) {
              const pkgName = pkgMatch[1];
              const pkgDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
              packageDirs.add(pkgDir);
              // Same name in several directories: keep the preferred one, whatever the
              // order the walk met them in (see preferredPackageDir).
              const current = packages.get(pkgName);
              if (
                current === undefined ||
                preferredPackageDir(pkgDir) < preferredPackageDir(current)
              ) {
                packages.set(pkgName, pkgDir);
                if (isDev) {
                  logger.info(`📦 Found R package: ${pkgName} at ${pkgDir}`);
                }
              }

              const nsPath = path.join(dir, 'NAMESPACE');
              try {
                const nsContent = await fs.readFile(nsPath, 'utf-8');
                const parsedExports = parseRNamespaceExports(nsContent);
                const namedExports = new Set<string>(parsedExports.namedExports);
                // POSIX classes are translated; an uncompilable pattern is skipped (never
                // matches) and recorded so the caller can say so.
                const exportPatterns: RExportMatcher[] = [];
                const droppedExportPatterns: RDroppedExportPattern[] = [];
                for (const pattern of new Set(parsedExports.exportPatterns)) {
                  const compiled = compileRExportPatternDetailed(pattern);
                  if ('reason' in compiled) {
                    droppedExportPatterns.push({ pattern, reason: compiled.reason });
                  } else {
                    exportPatterns.push(compiled.matcher);
                  }
                }

                namespaceInfoByPackageDir.set(pkgDir, {
                  hasNamespaceFile: true,
                  namedExports,
                  exportPatterns,
                  droppedExportPatterns,
                  importFrom: parseRNamespaceImportFrom(nsContent),
                });
              } catch {
                // No NAMESPACE file or can't read it
              }
            }
          } catch {
            // Can't read DESCRIPTION
          }
        }
      }
    } catch {
      // Can't read directory: whatever it holds was not discovered.
      truncated = true;
    }
  }

  // Directories still queued when the cap stopped the walk were never visited either.
  for (const { dir } of scanQueue) unvisited.push(dir);
  if (
    !truncated &&
    unvisited.length > 0 &&
    (await hidesUndiscoveredPackage(unvisited, new Set(packages.keys())))
  ) {
    truncated = true;
  }
  return { packages, namespaceInfoByPackageDir, packageDirs, truncated };
}
