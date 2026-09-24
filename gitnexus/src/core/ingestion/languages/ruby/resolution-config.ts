import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface RubyResolutionScope {
  /** Require prefixes provided by gems whose source is outside this repository. */
  readonly externalRequirePrefixes: ReadonlySet<string>;
  /** Require prefix -> repository-relative Ruby load roots for local gems. */
  readonly localLoadRootsByPrefix: ReadonlyMap<string, readonly string[]>;
}

export interface RubyResolutionConfig {
  /** Manifest directory (repository-relative POSIX path) -> dependency scope. */
  readonly scopesByDirectory: ReadonlyMap<string, RubyResolutionScope>;
}

interface MutableRubyResolutionScope {
  readonly externalRequirePrefixes: Set<string>;
  readonly localLoadRootsByPrefix: Map<string, Set<string>>;
}

interface GemspecMetadata {
  readonly name: string | null;
  readonly requirePaths: readonly string[];
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

const GEMFILE_DEPENDENCY = /^\s*gem\s*(?:\(\s*)?(['"])([A-Za-z0-9_.-]+)\1(?<options>.*)$/;
const GEMSPEC_DEPENDENCY =
  /^\s*(?:[A-Za-z_]\w*\.)?(?:add_dependency|add_runtime_dependency|add_development_dependency)\s*(?:\(\s*)?(['"])([A-Za-z0-9_.-]+)\1/;
const GEMSPEC_NAME = /^\s*(?:[A-Za-z_]\w*\.)?name\s*=\s*(['"])([A-Za-z0-9_.-]+)\1/;
const GEMSPEC_REQUIRE_PATHS = /^\s*(?:[A-Za-z_]\w*\.)?require_paths\s*=\s*\[([^\]]*)\]/;
const QUOTED_LITERAL = /(['"])([^'"]+)\1/g;
const LOCKFILE_SECTION = /^([A-Z][A-Z ]*)\s*$/;
const LOCKFILE_REMOTE = /^ {2}remote:\s*(.+?)\s*$/;
const LOCKFILE_SPECS_HEADER = /^ {2}specs:\s*$/;
const LOCKFILE_SPEC = /^ {4}([A-Za-z0-9_.-]+) \(/;

function createMutableScope(): MutableRubyResolutionScope {
  return {
    externalRequirePrefixes: new Set<string>(),
    localLoadRootsByPrefix: new Map<string, Set<string>>(),
  };
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function repoRelativePath(repoPath: string, candidate: string): string | null {
  const rel = relative(resolve(repoPath), resolve(candidate));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    return null;
  }
  return normalizeRepoPath(rel);
}

function requirePrefixes(gemName: string, requireAs?: string): readonly string[] {
  const prefixes = new Set<string>([gemName]);
  if (gemName.includes('-')) prefixes.add(gemName.replaceAll('-', '/'));
  if (requireAs !== undefined && requireAs.length > 0) prefixes.add(requireAs);
  return [...prefixes];
}

function literalOption(options: string, name: string): string | undefined {
  const modern = new RegExp(`(?:^|[,\\s])${name}\\s*:\\s*(['"])([^'"]+)\\1`).exec(options);
  if (modern !== null) return modern[2];
  const hashRocket = new RegExp(`(?:^|[,\\s]):${name}\\s*=>\\s*(['"])([^'"]+)\\1`).exec(options);
  return hashRocket?.[2];
}

function hasOption(options: string, name: string): boolean {
  return (
    new RegExp(`(?:^|[,\\s])${name}\\s*:`).test(options) ||
    new RegExp(`(?:^|[,\\s]):${name}\\s*=>`).test(options)
  );
}

function addExternalGem(
  scope: MutableRubyResolutionScope,
  gemName: string,
  requireAs?: string,
): void {
  for (const prefix of requirePrefixes(gemName, requireAs)) {
    if (!scope.localLoadRootsByPrefix.has(prefix)) scope.externalRequirePrefixes.add(prefix);
  }
}

function addLocalGem(
  scope: MutableRubyResolutionScope,
  gemName: string,
  loadRoots: readonly string[],
  requireAs?: string,
): void {
  for (const prefix of requirePrefixes(gemName, requireAs)) {
    scope.externalRequirePrefixes.delete(prefix);
    let roots = scope.localLoadRootsByPrefix.get(prefix);
    if (roots === undefined) {
      roots = new Set<string>();
      scope.localLoadRootsByPrefix.set(prefix, roots);
    }
    for (const loadRoot of loadRoots) roots.add(loadRoot);
  }
}

function parseGemspecMetadata(contents: string): GemspecMetadata {
  let name: string | null = null;
  let requirePaths: string[] | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const nameMatch = GEMSPEC_NAME.exec(line);
    if (nameMatch !== null) name = nameMatch[2];

    const requirePathsMatch = GEMSPEC_REQUIRE_PATHS.exec(line);
    if (requirePathsMatch === null) continue;
    const paths: string[] = [];
    for (const match of requirePathsMatch[1].matchAll(QUOTED_LITERAL)) paths.push(match[2]);
    if (paths.length > 0) requirePaths = paths;
  }

  return { name, requirePaths: requirePaths ?? ['lib'] };
}

function loadLocalGemRoots(
  repoPath: string,
  gemRoot: string,
  expectedGemName: string,
): readonly string[] | null {
  const gemRootRelative = repoRelativePath(repoPath, gemRoot);
  if (gemRootRelative === null) return null;

  let requirePaths: readonly string[] = ['lib'];
  try {
    const gemspecs = readdirSync(gemRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.gemspec'))
      .map((entry) => join(gemRoot, entry.name))
      .sort();
    for (const gemspec of gemspecs) {
      const metadata = parseGemspecMetadata(readFileSync(gemspec, 'utf8'));
      if (metadata.name === expectedGemName) {
        requirePaths = metadata.requirePaths;
        break;
      }
    }
  } catch {
    // An unreadable local gem stays local; the conventional lib root is a
    // bounded best effort, and resolution falls through if no file matches.
  }

  return requirePaths
    .map((requirePath) => repoRelativePath(repoPath, resolve(gemRoot, requirePath)))
    .filter((loadRoot): loadRoot is string => loadRoot !== null);
}

function addGemfileDependencies(
  contents: string,
  manifestDirectory: string,
  repoPath: string,
  scope: MutableRubyResolutionScope,
): void {
  for (const line of contents.split(/\r?\n/)) {
    const match = GEMFILE_DEPENDENCY.exec(line);
    if (match === null) continue;

    const gemName = match[2];
    const options = match.groups?.options ?? '';
    const requireAs = literalOption(options, 'require');
    const localPath = literalOption(options, 'path');

    if (localPath !== undefined) {
      const loadRoots = loadLocalGemRoots(repoPath, resolve(manifestDirectory, localPath), gemName);
      if (loadRoots === null) addExternalGem(scope, gemName, requireAs);
      else addLocalGem(scope, gemName, loadRoots, requireAs);
      continue;
    }

    // A dynamic path expression cannot be classified without evaluating Ruby.
    // Fail open instead of deleting a potentially real in-repo import edge.
    if (hasOption(options, 'path')) continue;

    addExternalGem(scope, gemName, requireAs);
  }
}

function addGemspecDependencies(
  contents: string,
  gemspecDirectory: string,
  repoPath: string,
  scope: MutableRubyResolutionScope,
): void {
  const metadata = parseGemspecMetadata(contents);
  if (metadata.name !== null) {
    if (repoRelativePath(repoPath, gemspecDirectory) !== null) {
      const loadRoots = metadata.requirePaths
        .map((requirePath) => repoRelativePath(repoPath, resolve(gemspecDirectory, requirePath)))
        .filter((loadRoot): loadRoot is string => loadRoot !== null);
      addLocalGem(scope, metadata.name, loadRoots);
    }
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = GEMSPEC_DEPENDENCY.exec(line);
    if (match !== null) addExternalGem(scope, match[2]);
  }
}

function addLockedDependencies(
  contents: string,
  lockfileDirectory: string,
  repoPath: string,
  scope: MutableRubyResolutionScope,
): void {
  let section = '';
  let remote: string | null = null;
  let inSpecs = false;

  for (const line of contents.split(/\r?\n/)) {
    const sectionMatch = LOCKFILE_SECTION.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      remote = null;
      inSpecs = false;
      continue;
    }

    const remoteMatch = LOCKFILE_REMOTE.exec(line);
    if (remoteMatch !== null) {
      remote = remoteMatch[1];
      continue;
    }

    if (LOCKFILE_SPECS_HEADER.test(line)) {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;

    const specMatch = LOCKFILE_SPEC.exec(line);
    if (specMatch === null) continue;
    const gemName = specMatch[1];

    if (section === 'GEM' || section === 'GIT') {
      addExternalGem(scope, gemName);
      continue;
    }

    if (section !== 'PATH' && section !== 'GEMSPEC') continue;
    if (remote === null) continue;

    const loadRoots = loadLocalGemRoots(repoPath, resolve(lockfileDirectory, remote), gemName);
    if (loadRoots === null) addExternalGem(scope, gemName);
    else addLocalGem(scope, gemName, loadRoots);
  }
}

function freezeScope(scope: MutableRubyResolutionScope): RubyResolutionScope {
  const localLoadRootsByPrefix = new Map<string, readonly string[]>();
  for (const [prefix, roots] of scope.localLoadRootsByPrefix) {
    localLoadRootsByPrefix.set(prefix, [...roots].sort());
  }
  return {
    externalRequirePrefixes: new Set(scope.externalRequirePrefixes),
    localLoadRootsByPrefix,
  };
}

/**
 * Select the nearest manifest directory that owns `fromFile`.
 *
 * Walking ancestors makes lookup O(path depth), independent of how many
 * sibling Gemfiles a monorepo contains.
 */
export function findRubyResolutionScope(
  config: RubyResolutionConfig,
  fromFile: string,
): RubyResolutionScope | undefined {
  const normalized = normalizeRepoPath(fromFile);
  let directory = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';

  for (;;) {
    const scope = config.scopesByDirectory.get(directory);
    if (scope !== undefined) return scope;
    if (directory === '') return undefined;
    const slash = directory.lastIndexOf('/');
    directory = slash === -1 ? '' : directory.slice(0, slash);
  }
}

/**
 * Statically collect Ruby dependency sources without evaluating Gemfile or
 * gemspec code. Scopes stay separate by manifest directory so sibling projects
 * in a monorepo cannot suppress one another's local imports. Lockfiles
 * contribute remote GEM/GIT specs and local PATH/GEMSPEC load roots only when
 * an adjacent Gemfile or gemspec establishes a Bundler/RubyGems project.
 *
 * No declarative manifest means no safe gate, so return null and preserve the
 * resolver's existing fail-open behavior for loose script directories.
 */
export function loadRubyResolutionConfig(repoPath: string): RubyResolutionConfig | null {
  const pending = [repoPath];
  const manifestsByDirectory = new Map<string, string[]>();
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
        const manifests = manifestsByDirectory.get(directory) ?? [];
        manifests.push(join(directory, entry.name));
        manifestsByDirectory.set(directory, manifests);
      } else if (entry.isFile() && entry.name === 'Gemfile.lock') {
        lockfilesByDirectory.set(directory, join(directory, entry.name));
      }
    }
  }

  if (manifestsByDirectory.size === 0) return null;

  const mutableScopes = new Map<string, MutableRubyResolutionScope>();
  for (const [directory, manifests] of [...manifestsByDirectory].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const directoryRelative = repoRelativePath(repoPath, directory);
    if (directoryRelative === null) continue;
    const scope = createMutableScope();
    mutableScopes.set(directoryRelative, scope);

    for (const manifest of manifests.sort()) {
      try {
        const contents = readFileSync(manifest, 'utf8');
        if (manifest.endsWith('.gemspec')) {
          addGemspecDependencies(contents, directory, repoPath, scope);
        } else {
          addGemfileDependencies(contents, directory, repoPath, scope);
        }
      } catch {
        // A partially readable scope remains fail-open for unknown gems.
      }
    }

    const lockfile = lockfilesByDirectory.get(directory);
    if (lockfile === undefined) continue;
    try {
      addLockedDependencies(readFileSync(lockfile, 'utf8'), directory, repoPath, scope);
    } catch {
      // Direct declarations still provide bounded evidence when the lock is unreadable.
    }
  }

  const scopesByDirectory = new Map<string, RubyResolutionScope>();
  for (const [directory, scope] of mutableScopes) {
    scopesByDirectory.set(directory, freezeScope(scope));
  }
  return { scopesByDirectory };
}
