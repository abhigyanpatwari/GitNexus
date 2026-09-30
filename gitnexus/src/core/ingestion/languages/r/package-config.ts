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
   * True when discovery did NOT visit every directory of the repo: the
   * directory cap stopped the walk with directories still queued, the depth
   * limit skipped directories, or a directory could not be read. A package
   * missing from {@link packages} is then not proven to be absent from the
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

export async function loadRPackageConfig(repoRoot: string): Promise<RPackageConfig | null> {
  const packages = new Map<string, string>();
  const namespaceInfoByPackageDir = new Map<string, RNamespaceInfo>();
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 3;
  const maxDirs = 200;
  let dirsScanned = 0;
  let truncated = false;

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === '.Rproj.user'
          )
            continue;
          // Below the depth limit: never visited, so a package could hide there.
          if (depth >= maxDepth) truncated = true;
        }
        if (entry.isDirectory() && depth < maxDepth) {
          scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
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

  // The directory cap stopped the walk with directories still queued.
  if (scanQueue.length > 0) truncated = true;
  if (packages.size === 0) return null;
  return { packages, namespaceInfoByPackageDir, truncated };
}
