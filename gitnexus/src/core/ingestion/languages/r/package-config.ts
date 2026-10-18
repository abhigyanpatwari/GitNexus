import { constants, type Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  parseRNamespaceExports,
  parseRNamespaceImportFrom,
  type RNamespaceImportFromEntry,
} from './namespace-imports.js';
import { compileRExportPatternDetailed, type RExportMatcher } from './export-pattern.js';
import { SharedWorkBudget } from './linear-regex.js';
import { isDev } from '../../utils/env.js';
import { isHardcodedIgnoredDirectory } from '../../../../config/ignore-service.js';
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
   * libraries and check output (`renv`, `packrat`, `revdep`, `<name>.Rcheck`), dot-directories
   * and the directories the indexer ignores are not searched, and a `DESCRIPTION` with a
   * `Built:` field (an installed package) is not read, so none of their packages are entries here.
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
  /**
   * How many further non-empty `exportPattern()` arguments were dropped but not listed in
   * {@link droppedExportPatterns}, which holds at most {@link MAX_LISTED_DROPPED_PATTERNS}
   * per package so that a NAMESPACE of hundreds of thousands of refused patterns cannot
   * produce hundreds of thousands of warnings. Reported as one line.
   */
  omittedDroppedExportPatterns?: number;
  /**
   * The work budget this package's matchers draw on: a sub-budget of the load's. Absent on
   * hand-built configs. {@link rExportPatternMatches} stops consulting the matchers once it
   * is spent.
   */
  exportPatternBudget?: SharedWorkBudget;
  /**
   * True when the NAMESPACE reader skipped, dropped or could not read something that may hide an
   * export (see {@link RNamespaceExports.unreadable}): a conditional export, a raw-string or
   * multi-line argument, a malformed directive. A name absent from the export lists is then not
   * proven private. Optional so that hand-built configs read as "nothing hidden".
   */
  exportsUnreadable?: boolean;
  /** `importFrom(pkg, name)` pairs in NAMESPACE file order (all entries, incl. self-imports and duplicates). */
  importFrom: readonly RNamespaceImportFromEntry[];
}

/**
 * Most patterns named in warnings per package, for dropped patterns (the rest are counted,
 * see `omittedDroppedExportPatterns`) and for patterns cut short by the budget alike, so
 * that a NAMESPACE of tens of thousands of patterns cannot produce as many warnings.
 */
export const MAX_LISTED_DROPPED_PATTERNS = 50;

/** Most names remembered as matched per package, so a hostile name list cannot grow the set without bound. */
const MAX_REMEMBERED_MATCHES = 100_000;

/** Names a pattern list matched while its budget lasted (only for lists that draw on a budget). */
const matchedWhileBudgetLasted = new WeakMap<object, Set<string>>();

/**
 * True when one of the package's `exportPattern()` matchers matches `name`. Once the
 * package's work budget (or the load's) is spent it stops asking the matchers, so the cost no
 * longer grows as patterns x names. A name it matched while the budget lasted keeps that
 * answer (one set lookup, so a duplicate-named definition does not flip from exported to
 * private); a name it had not decided answers false, and the patterns it did not get to run are
 * then reported by {@link reportRExportPatternProblems}.
 */
export function rExportPatternMatches(
  info: Pick<RNamespaceInfo, 'exportPatterns' | 'exportPatternBudget'>,
  name: string,
): boolean {
  const budget = info.exportPatternBudget;
  let remembered = matchedWhileBudgetLasted.get(info.exportPatterns);
  for (const pattern of info.exportPatterns) {
    if (budget?.isSpent === true) {
      budget.cutShort = true;
      return remembered?.has(name) === true;
    }
    if (pattern.test(name)) {
      if (budget !== undefined) {
        if (remembered === undefined) {
          remembered = new Set();
          matchedWhileBudgetLasted.set(info.exportPatterns, remembered);
        }
        if (remembered.size < MAX_REMEMBERED_MATCHES) remembered.add(name);
      }
      return true;
    }
  }
  return false;
}

/**
 * True when the package's NAMESPACE exports `symbol`: an explicit `export()`, `exportClasses()`,
 * `exportMethods()` or `S3method()` entry, or an `exportPattern()` match. The one test the
 * indexer's export refinement and the rename guard both use.
 */
export function rNamespaceExports(
  info: Pick<RNamespaceInfo, 'namedExports' | 'exportPatterns' | 'exportPatternBudget'>,
  symbol: string,
): boolean {
  return info.namedExports.has(symbol) || rExportPatternMatches(info, symbol);
}

/**
 * True when part of the package's `exportPattern()` entries is not in effect: a pattern that
 * was dropped at load, or one that ran out of work budget. {@link rNamespaceExports} answers
 * false for a name such a pattern was meant to cover, so a false answer is not proof that the
 * name is private.
 */
export function rExportPatternsIncomplete(
  info: Pick<
    RNamespaceInfo,
    | 'exportPatterns'
    | 'exportPatternBudget'
    | 'droppedExportPatterns'
    | 'omittedDroppedExportPatterns'
  >,
): boolean {
  return (
    (info.droppedExportPatterns?.length ?? 0) > 0 ||
    (info.omittedDroppedExportPatterns ?? 0) > 0 ||
    info.exportPatternBudget?.isSpent === true ||
    info.exportPatternBudget?.cutShort === true ||
    info.exportPatterns.some((matcher) => matcher.exhausted === true)
  );
}

/**
 * The package config each parsed file was resolved with. The resolution pass records it
 * (`recordRPackageConfig`, from the scope resolver's workspace hook) so that the rename guard,
 * which receives the parsed files but not the config, can read the NAMESPACE the planner loaded
 * from disk for this very plan rather than the export verdict persisted at index time.
 */
const packageConfigOfParsedFile = new WeakMap<object, RPackageConfig>();

/** Record `resolutionConfig` (an {@link RPackageConfig}, if it is one) against each parsed file. */
export function recordRPackageConfig(
  parsedFiles: readonly object[],
  resolutionConfig: unknown,
): void {
  if (typeof resolutionConfig !== 'object' || resolutionConfig === null) return;
  const config = resolutionConfig as RPackageConfig;
  if (!(config.namespaceInfoByPackageDir instanceof Map)) return;
  for (const parsed of parsedFiles) packageConfigOfParsedFile.set(parsed, config);
}

/** The config recorded for `parsed`, or undefined when no resolution pass recorded one. */
export function recordedRPackageConfig(parsed: object | undefined): RPackageConfig | undefined {
  return parsed === undefined ? undefined : packageConfigOfParsedFile.get(parsed);
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
    if ((info.omittedDroppedExportPatterns ?? 0) > 0) {
      logger.warn(
        `R package ${where}: ${info.omittedDroppedExportPatterns} further exportPattern() ` +
          `arguments were ignored as well and are not listed; names they would export are ` +
          `treated as not exported`,
      );
    }
    const cutShort = info.exportPatternBudget?.cutShort === true;
    let listed = 0;
    let unlisted = 0;
    for (const matcher of info.exportPatterns) {
      if (matcher.exhausted !== true && !cutShort) continue;
      if (listed >= MAX_LISTED_DROPPED_PATTERNS) {
        unlisted++;
        continue;
      }
      listed++;
      logger.warn(
        `R package ${where}: exportPattern(${quotePattern(matcher.source)}) exceeded its work ` +
          `budget (its own, its package's or the repository's); ` +
          `names it had not yet been tested against are treated as not exported`,
      );
    }
    if (unlisted > 0) {
      logger.warn(
        `R package ${where}: ${unlisted} further exportPattern() arguments exceeded their work ` +
          `budget as well and are not listed; names they had not yet been tested against are ` +
          `treated as not exported`,
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
 * True for a directory that discovery must not enter: `renv`, `packrat` or `revdep`,
 * `<something>.Rcheck` (a name that is only the suffix is not one), any dot-directory
 * (`.Rlibs`, `.git`, `.Rproj.user`), and every directory the indexer itself never reads
 * ({@link isHardcodedIgnoredDirectory}: `vendor`, `build`, `dist`, `lib64`, `fixtures`, ...).
 * The indexer indexes no file under those, so a package in one is not part of the repository,
 * and a tree of them would otherwise spend the scan budgets. The match is on the directory's
 * own name, exact and case-sensitive: `renv-tools`, `Renv`, `revdeps` or `pkg.rcheck` are
 * ordinary directories and may hold a real package. The indexer's rules that need the
 * directory's location (a root-level `env` or `generated`, an `env` with `pyvenv.cfg`) are not
 * applied; neither holds an R package in practice.
 */
function isSkippedDirName(name: string): boolean {
  return (
    SKIPPED_DIR_NAMES.has(name) ||
    VENDORED_LIBRARY_DIR_NAMES.has(name) ||
    name.startsWith('.') ||
    isHardcodedIgnoredDirectory(name) ||
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
 * The `Package:` field of a `DESCRIPTION` file's text, or `undefined` when it has none. A leading
 * UTF-8 byte-order mark is not part of the first field name, and a field with an empty value
 * names nothing: `[ \t]*`, not `\s*`, so the value never begins on the next line.
 */
function descriptionPackageName(content: string): string | undefined {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return /^Package:[ \t]*(\S+)/m.exec(text)?.[1];
}

/**
 * True when a `DESCRIPTION` file's text has a `Built:` field. `R CMD INSTALL` adds it to the
 * copy it installs; a source package never has one, so a `DESCRIPTION` with it belongs to an
 * installed library package (`lib/`, `library/`, a site library checked in), not to the
 * repository's own packages.
 */
function isInstalledPackageDescription(content: string): boolean {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return /^Built:/m.test(text);
}

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
          const content = await readManifestFile(path.join(dir, entry.name));
          const pkgName = descriptionPackageName(content);
          if (
            pkgName !== undefined &&
            !knownPackageNames.has(pkgName) &&
            !isInstalledPackageDescription(content)
          ) {
            return true;
          }
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Largest DESCRIPTION or NAMESPACE read (4 MiB). Neither is a parsed source file, so the walker's
 * per-file cap does not apply; a real one is a few kilobytes. A larger file is treated like one
 * that cannot be read: a DESCRIPTION leaves its package undiscovered (discovery is then marked
 * truncated), a NAMESPACE leaves the package without NAMESPACE information (rename refuses).
 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Read a DESCRIPTION or NAMESPACE as UTF-8. Rejects when the file cannot be read, is not a regular
 * file, or is larger than {@link MAX_MANIFEST_BYTES}.
 *
 * The file is opened once and the type check, the size check and the read all use that one handle,
 * so the file cannot be swapped between the check and the read (a `stat` by path followed by a
 * `readFile` by path can). `O_NOFOLLOW` makes the open itself refuse a symlink where the platform
 * has it; where it does not (Windows) the callers' directory read has already admitted only a
 * regular file. `O_NONBLOCK` stops a FIFO blocking the open; it is then refused as not a file. At
 * most one byte past the checked size is read, so a file that grows after the check is refused
 * rather than read whole (or truncated).
 */
export async function readManifestFile(file: string): Promise<string> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path.basename(file)} is not a file`);
    const { size } = opened;
    if (size > MAX_MANIFEST_BYTES) throw new Error(`${path.basename(file)} is too large to read`);
    // One byte more than the size checked above: reading it means the file grew.
    const buffer = Buffer.allocUnsafe(size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > size) throw new Error(`${path.basename(file)} changed while it was read`);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
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
  // One allowance (matching work and NFA states) for every exportPattern of every package
  // found by this load, split into a sub-budget per package: the number of patterns a
  // repository carries must not multiply the per-matcher cost.
  const loadBudget = new SharedWorkBudget();
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
            const content = await readManifestFile(descPath);
            const pkgName = descriptionPackageName(content);
            if (pkgName !== undefined && !isInstalledPackageDescription(content)) {
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

              // The same test as DESCRIPTION: a regular file listed by the directory read, never
              // a symlink (which could point outside the repository).
              const nsEntry = entries.find((candidate) => candidate.name === 'NAMESPACE');
              try {
                if (nsEntry === undefined || !nsEntry.isFile())
                  throw new Error('no NAMESPACE file');
                const nsContent = await readManifestFile(path.join(dir, 'NAMESPACE'));
                const parsedExports = parseRNamespaceExports(nsContent);
                const namedExports = new Set<string>(parsedExports.namedExports);
                // POSIX classes are translated; an uncompilable pattern is skipped (never
                // matches) and recorded so the caller can say so.
                const exportPatterns: RExportMatcher[] = [];
                const droppedExportPatterns: RDroppedExportPattern[] = [];
                let omittedDropped = 0;
                // This package's share of the load's budget: one hostile package cannot
                // take all of it and leave the packages after it without their patterns.
                const packageBudget = loadBudget.child();
                for (const pattern of new Set(parsedExports.exportPatterns)) {
                  const compiled = compileRExportPatternDetailed(pattern, packageBudget);
                  if ('reason' in compiled) {
                    if (droppedExportPatterns.length < MAX_LISTED_DROPPED_PATTERNS) {
                      droppedExportPatterns.push({ pattern, reason: compiled.reason });
                    } else {
                      omittedDropped++;
                    }
                  } else {
                    exportPatterns.push(compiled.matcher);
                  }
                }

                namespaceInfoByPackageDir.set(pkgDir, {
                  hasNamespaceFile: true,
                  namedExports,
                  exportPatterns,
                  droppedExportPatterns,
                  omittedDroppedExportPatterns: omittedDropped,
                  exportPatternBudget: packageBudget,
                  exportsUnreadable: parsedExports.unreadable,
                  importFrom: parseRNamespaceImportFrom(nsContent),
                });
              } catch {
                // No NAMESPACE file or can't read it
              }
            }
          } catch {
            // Can't read DESCRIPTION: the package it declares was not discovered.
            truncated = true;
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
