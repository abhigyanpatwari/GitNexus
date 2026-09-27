/**
 * Swift workspace module discovery (#3355).
 *
 * `loadSwiftPackageConfig` reads only the root package. A monorepo laid out as
 * `Core/<pkg>/Package.swift` has no root manifest and no root `Sources/`, and
 * an Xcode app keeps its targets in `<App>.xcodeproj`. Without both, every
 * Swift file lands in one `__default__` module that merges unrelated modules.
 *
 * This loader finds every SwiftPM package and Xcode project in the repo and
 * returns one {@link SwiftModuleSpec} per compiler module. SwiftPM targets are
 * keyed by their repo-relative directory, so two packages declaring the same
 * target name stay two modules. `origin` and `declaredTargets` stay the root's
 * for legacy callers; `modules` is the authority for grouping and `import`
 * resolution.
 *
 * Called from `ScopeResolver.loadResolutionConfig`, so only repos with Swift
 * pay for the walk — the same split as `loadZigWorkspaceIndex`.
 */

import fs from 'fs/promises';
import path from 'path';
import { isHardcodedIgnoredDirectoryAtPath } from '../../../../config/ignore-service.js';
import { logger } from '../../../logger.js';
import {
  isAbsoluteZigDepPath,
  loadSwiftPackageConfig,
  normalizeZigDepPath,
  type SwiftModuleSpec,
  type SwiftPackageConfig,
} from '../../language-config.js';
import { swiftC99ModuleName } from './target-grouping.js';
import { parseXcodeProject } from './xcode-project.js';

/** Bounds for the workspace walk, same as the Zig one. */
const SWIFT_SCAN_MAX_DIRS = 20_000;
const SWIFT_SCAN_MAX_DEPTH = 24;

/** Bundle directories that never hold a manifest or project, often numerous. */
const SWIFT_SKIPPED_DIR_SUFFIXES = ['.xcassets', '.xcworkspace', '.lproj', '.bundle'];

interface SwiftWorkspaceScan {
  /** Repo-relative directories below the root holding a `Package.swift`. */
  readonly packageDirs: string[];
  /** Repo-relative `.xcodeproj` bundle paths. */
  readonly xcodeProjects: string[];
  readonly truncated: boolean;
}

export async function loadSwiftWorkspaceConfig(
  repoRoot: string,
): Promise<SwiftPackageConfig | null> {
  const root = await loadSwiftPackageConfig(repoRoot);
  const scan = await scanSwiftWorkspace(repoRoot);
  const modules: SwiftModuleSpec[] = [];
  let complete = !scan.truncated;

  const addPackage = (config: SwiftPackageConfig, packageDir: string): void => {
    if (config.origin !== 'package.swift') complete = false;
    const declared = config.declaredTargets ?? config.targets;
    for (const [name, targetDir] of config.targets) {
      // An empty result under a nested package is the repo root, whose prefix
      // matches every file.
      const dir = rebase(packageDir, targetDir);
      if (dir === null || (dir === '' && packageDir !== '')) continue;
      // Inferred folders are grouping-only unless the package declared nothing
      // (`origin: 'directories'`), where the folder name is the best guess.
      const importable = config.origin === 'directories' || declared.has(name);
      const filter = config.targetFilters?.get(name);
      const sources = filter?.sources?.map((rel) => rebase(dir, rel));
      const excluded = filter?.exclude?.map((rel) => rebase(dir, rel));
      modules.push({
        key: dir === '' ? '.' : dir,
        name: swiftC99ModuleName(name),
        dir,
        importable,
        ...(sources !== undefined ? { sources: sources.filter(isPath) } : {}),
        ...(excluded !== undefined ? { excluded: excluded.filter(isPath) } : {}),
      });
    }
  };

  if (root !== null) addPackage(root, '');
  for (const dir of scan.packageDirs) {
    const config = await loadSwiftPackageConfig(repoRoot, dir);
    if (config !== null) addPackage(config, dir);
  }
  for (const project of scan.xcodeProjects) {
    let source: string;
    try {
      source = await fs.readFile(path.join(repoRoot, project, 'project.pbxproj'), 'utf-8');
    } catch {
      complete = false;
      continue;
    }
    const projectDir = path.posix.dirname(project);
    const parsed = parseXcodeProject(source, projectDir === '.' ? '' : projectDir);
    if (!parsed.complete) complete = false;
    for (const target of parsed.targets) {
      modules.push({
        key: `xcode:${project}:${target.name}`,
        name: target.moduleName,
        files: target.files,
        folders: target.folders,
        excluded: target.excluded,
        importable: true,
      });
    }
  }

  if (modules.length === 0) return root;
  const targets = new Map<string, string>();
  for (const m of modules) if (m.dir !== undefined) targets.set(m.key, m.dir);
  return {
    targets,
    origin: root?.origin ?? 'directories',
    ...(root?.declaredTargets !== undefined ? { declaredTargets: root.declaredTargets } : {}),
    modules,
    moduleNamesComplete: complete,
  };
}

/**
 * `rel` joined onto the repo-relative `base`, or null when it is absolute or
 * escapes the repo — the same rule as Zig path deps.
 */
function rebase(base: string, rel: string): string | null {
  if (isAbsoluteZigDepPath(rel)) return null;
  return normalizeZigDepPath(base === '' ? rel : `${base}/${rel}`);
}

function isPath(value: string | null): value is string {
  return value !== null;
}

async function scanSwiftWorkspace(repoRoot: string): Promise<SwiftWorkspaceScan> {
  const packageDirs: string[] = [];
  const xcodeProjects: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  // Head index, not `queue.shift()` — see `findZigPackageDirs`.
  let queueHead = 0;
  let truncated = false;
  const rel = (dir: string): string => path.relative(repoRoot, dir).split(path.sep).join('/');

  while (queueHead < queue.length) {
    if (queueHead >= SWIFT_SCAN_MAX_DIRS) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue[queueHead++]!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sorted so the directories a capped walk reaches do not depend on the
    // filesystem's listing order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name.startsWith('.')) continue;
        const childDir = path.join(dir, name);
        if (name.endsWith('.xcodeproj')) {
          xcodeProjects.push(rel(childDir));
          continue;
        }
        if (SWIFT_SKIPPED_DIR_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
        if (isHardcodedIgnoredDirectoryAtPath(repoRoot, childDir)) continue;
        // Bound what is queued, not only what is read: a root with a huge
        // fan-out would otherwise allocate far past the cap before it trips.
        if (depth >= SWIFT_SCAN_MAX_DEPTH || queue.length >= SWIFT_SCAN_MAX_DIRS) {
          truncated = true;
          continue;
        }
        queue.push({ dir: childDir, depth: depth + 1 });
      } else if (entry.isFile() && name === 'Package.swift' && dir !== repoRoot) {
        packageDirs.push(rel(dir));
      }
    }
  }

  if (truncated) {
    logger.warn(
      `[swift] workspace scan of ${repoRoot} truncated (dir cap ${SWIFT_SCAN_MAX_DIRS}, depth cap ${SWIFT_SCAN_MAX_DEPTH}); packages and projects past the cap are not modules`,
    );
  }
  return { packageDirs, xcodeProjects, truncated };
}
