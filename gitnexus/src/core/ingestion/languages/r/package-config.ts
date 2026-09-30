import fs from 'fs/promises';
import path from 'path';
import {
  parseRNamespaceExports,
  parseRNamespaceImportFrom,
  type RNamespaceImportFromEntry,
} from './namespace-imports.js';
import { compileRExportPattern } from './export-pattern.js';
import { isDev } from '../../utils/env.js';
import { logger } from '../../../logger.js';

/** R package config parsed from DESCRIPTION files in a multi-package repo */
export interface RPackageConfig {
  /** Map of package name to directory path relative to repo root */
  packages: Map<string, string>;
  /** Package-scoped NAMESPACE config keyed by package dir relative to repo root. */
  namespaceInfoByPackageDir: Map<string, RNamespaceInfo>;
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
  /** Precompiled regex patterns from exportPattern("..."), compiled once here so
   *  `refineRExportStatus` doesn't recompile a RegExp per node it checks. POSIX bracket
   *  classes such as `[[:alpha:]]` are translated to JS equivalents first
   *  (see `compileRExportPattern`). Patterns that fail to compile are dropped at this
   *  stage (invalid `exportPattern()` args never match). */
  exportPatterns: RegExp[];
  /** `importFrom(pkg, name)` pairs in NAMESPACE file order (all entries, incl. self-imports and duplicates). */
  importFrom: readonly RNamespaceImportFromEntry[];
}

/** Directories never descended into, by the main walk and the hidden-package scan alike. */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', '.Rproj.user']);

/** Global directory budget for {@link hidesUndiscoveredPackage} across all its roots. */
const HIDDEN_SCAN_BUDGET = 5000;

/**
 * Scan the subtrees the main walk skipped for a package it never discovered.
 *
 * Iterative DFS over `roots` under one global `budget` of directories (skipping
 * `node_modules`, `.git` and `.Rproj.user`, as the main walk does). Returns
 * `true` (cannot rule a hidden package out) when the budget is exceeded, when a
 * directory or `DESCRIPTION` cannot be read, or when a `DESCRIPTION` declares a
 * `Package:` name that is not in `knownPackageNames`. Returns `false` when every
 * subtree was scanned and holds no such package. Deterministic and read-only.
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
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name)) stack.push(path.join(dir, entry.name));
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

export async function loadRPackageConfig(repoRoot: string): Promise<RPackageConfig | null> {
  const packages = new Map<string, string>();
  const namespaceInfoByPackageDir = new Map<string, RNamespaceInfo>();
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
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
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
              packages.set(pkgName, pkgDir);
              if (isDev) {
                logger.info(`📦 Found R package: ${pkgName} at ${pkgDir}`);
              }

              const nsPath = path.join(dir, 'NAMESPACE');
              try {
                const nsContent = await fs.readFile(nsPath, 'utf-8');
                const parsedExports = parseRNamespaceExports(nsContent);
                const namedExports = new Set<string>(parsedExports.namedExports);
                // POSIX classes are translated; an uncompilable pattern is skipped (never matches).
                const exportPatterns = parsedExports.exportPatterns
                  .map(compileRExportPattern)
                  .filter((re): re is RegExp => re !== null);

                namespaceInfoByPackageDir.set(pkgDir, {
                  hasNamespaceFile: true,
                  namedExports,
                  exportPatterns,
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
  if (packages.size === 0) return null;
  return { packages, namespaceInfoByPackageDir, truncated };
}
