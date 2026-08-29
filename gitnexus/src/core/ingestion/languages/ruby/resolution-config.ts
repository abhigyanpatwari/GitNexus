import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RubyResolutionConfig {
  readonly gemNames: ReadonlySet<string>;
}

const MAX_VISITED_DIRECTORIES = 20_000;
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.gitnexus',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
]);

const GEMFILE_DEPENDENCY = /^\s*gem\s*(?:\(\s*)?(['"])([A-Za-z0-9_.-]+)\1/;
const GEMSPEC_DEPENDENCY =
  /^\s*(?:[A-Za-z_]\w*\.)?(?:add_dependency|add_runtime_dependency|add_development_dependency)\s*(?:\(\s*)?(['"])([A-Za-z0-9_.-]+)\1/;
const LOCKFILE_SPECS_HEADER = /^ {2}specs:\s*$/;
const LOCKFILE_SPEC = /^ {4}([A-Za-z0-9_.-]+) \(/;

function addLiteralDependencies(
  contents: string,
  dependencyPattern: RegExp,
  gemNames: Set<string>,
): void {
  for (const line of contents.split(/\r?\n/)) {
    const match = dependencyPattern.exec(line);
    if (match !== null) gemNames.add(match[2]);
  }
}

function addLockedDependencies(contents: string, gemNames: Set<string>): void {
  let inSpecs = false;
  for (const line of contents.split(/\r?\n/)) {
    if (LOCKFILE_SPECS_HEADER.test(line)) {
      inSpecs = true;
      continue;
    }
    if (inSpecs && /^\S/.test(line)) {
      inSpecs = false;
      continue;
    }
    if (!inSpecs) continue;
    const match = LOCKFILE_SPEC.exec(line);
    if (match !== null) gemNames.add(match[1]);
  }
}

/**
 * Statically collect Ruby dependency names without evaluating Gemfile or
 * gemspec code. A lockfile contributes transitive dependencies only when an
 * adjacent Gemfile or gemspec establishes a Bundler/RubyGems project.
 *
 * No declarative manifest means no safe gate, so return null and preserve the
 * resolver's existing fail-open behavior for loose script directories.
 */
export function loadRubyResolutionConfig(repoPath: string): RubyResolutionConfig | null {
  const pending = [repoPath];
  const manifests: string[] = [];
  const lockfilesByDirectory = new Map<string, string>();
  let visitedDirectories = 0;

  while (pending.length > 0 && visitedDirectories < MAX_VISITED_DIRECTORIES) {
    const directory = pending.pop();
    if (directory === undefined) break;
    visitedDirectories++;

    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
        pending.push(join(directory, entry.name));
      } else if (entry.isFile() && (entry.name === 'Gemfile' || entry.name.endsWith('.gemspec'))) {
        manifests.push(join(directory, entry.name));
      } else if (entry.isFile() && entry.name === 'Gemfile.lock') {
        lockfilesByDirectory.set(directory, join(directory, entry.name));
      }
    }
  }

  if (manifests.length === 0) return null;

  const gemNames = new Set<string>();
  const manifestDirectories = new Set<string>();
  for (const manifest of manifests.sort()) {
    manifestDirectories.add(dirname(manifest));
    try {
      addLiteralDependencies(
        readFileSync(manifest, 'utf8'),
        manifest.endsWith('.gemspec') ? GEMSPEC_DEPENDENCY : GEMFILE_DEPENDENCY,
        gemNames,
      );
    } catch {
      // A partially readable workspace remains fail-open for unknown gems.
    }
  }

  for (const directory of [...manifestDirectories].sort()) {
    const lockfile = lockfilesByDirectory.get(directory);
    if (lockfile === undefined) continue;
    try {
      addLockedDependencies(readFileSync(lockfile, 'utf8'), gemNames);
    } catch {
      // Direct declarations still provide safe evidence when the lock is unreadable.
    }
  }

  return { gemNames };
}
