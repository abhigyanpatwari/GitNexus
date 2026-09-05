const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

// Hooks are copied into editor-specific directories and run without the
// package's TypeScript modules. Keep their on-disk names centralized here.
const GITNEXUS_DIR = '.gitnexus';
const INDEX_METADATA_FILE = 'gitnexus.json';
const LEGACY_METADATA_FILE = 'meta.json';
const LBUG_DIRECTORY = 'lbug';
const BRANCHES_DIRECTORY = 'branches';

function canonicalize(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left, right) {
  if (left == null || right == null) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissingFile(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function readMetadataFile(storagePath, filename) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(storagePath, filename), 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { state: 'valid', value }
      : { state: 'invalid' };
  } catch (error) {
    return isMissingFile(error) ? { state: 'absent' } : { state: 'invalid' };
  }
}

function readIndexMetadata(storagePath) {
  const primary = readMetadataFile(storagePath, INDEX_METADATA_FILE);
  if (primary.state === 'valid') return primary.value;
  if (primary.state !== 'absent') return null;

  const legacy = readMetadataFile(storagePath, LEGACY_METADATA_FILE);
  return legacy.state === 'valid' ? legacy.value : null;
}

function isOwnedStorage(repoPath, storagePath, repositoryLocal, metadata) {
  // Repository-local storage remains usable for metadata written before
  // repoPath was recorded, but an explicit repoPath must never name another
  // checkout. External storage always requires the complete ownership binding.
  if (repositoryLocal && (!metadata || typeof metadata.repoPath !== 'string')) {
    return true;
  }
  if (!metadata || typeof metadata.repoPath !== 'string') return false;

  const metadataRepoPath = canonicalize(metadata.repoPath);
  const expectedRepoPath = canonicalize(repoPath);
  if (
    metadataRepoPath == null ||
    expectedRepoPath == null ||
    !samePath(metadataRepoPath, expectedRepoPath)
  ) {
    return false;
  }
  if (repositoryLocal) return true;
  if (typeof metadata.storagePath !== 'string') return false;

  const metadataStoragePath = canonicalize(metadata.storagePath);
  const expectedStoragePath = canonicalize(storagePath);
  return (
    metadataStoragePath != null &&
    expectedStoragePath != null &&
    samePath(metadataStoragePath, expectedStoragePath)
  );
}

function ancestorPaths(cwd) {
  const paths = [];
  let current = canonicalize(cwd);
  while (current) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

function currentGitBranch(cwd) {
  try {
    const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 2000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const branch = String(result.stdout || '').trim();
    return branch || null;
  } catch {
    return null;
  }
}

function registryPathsForCwd(cwd) {
  const fallbackPaths = ancestorPaths(cwd);
  if (fallbackPaths.length === 0) return { repoPaths: [], branch: null };
  try {
    const result = spawnSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      {
        encoding: 'utf-8',
        timeout: 2000,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) return { repoPaths: fallbackPaths, branch: null };

    const [worktreeRoot, commonDir] = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const roots = [worktreeRoot];
    if (commonDir) roots.push(path.dirname(commonDir));
    return {
      repoPaths: roots.map(canonicalize).filter(Boolean),
      branch: currentGitBranch(cwd),
    };
  } catch {
    return { repoPaths: fallbackPaths, branch: null };
  }
}

function branchSlug(rawRef) {
  const safe = rawRef.replace(/^-+/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = createHash('sha256').update(rawRef).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

function findRegisteredRepo(cwd) {
  const { repoPaths, branch } = registryPathsForCwd(cwd);
  if (repoPaths.length === 0) return null;

  const home = process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus');
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.path !== 'string') continue;
    if (!path.isAbsolute(entry.path)) continue;
    if (
      entry.storagePath !== undefined &&
      (typeof entry.storagePath !== 'string' ||
        !entry.storagePath ||
        !path.isAbsolute(entry.storagePath))
    ) {
      continue;
    }
    const registeredPath = canonicalize(entry.path);
    if (registeredPath && repoPaths.some((repoPath) => samePath(repoPath, registeredPath))) {
      // Registry rows written before configurable storage have no storagePath.
      // Match the CLI's read-boundary compatibility rule for those rows only.
      const storagePath = path.resolve(entry.storagePath ?? path.join(entry.path, GITNEXUS_DIR));
      const repositoryLocal = samePath(
        canonicalize(path.join(entry.path, GITNEXUS_DIR)),
        canonicalize(storagePath),
      );
      const metadata = readIndexMetadata(storagePath);
      if (!isOwnedStorage(entry.path, storagePath, repositoryLocal, metadata)) continue;
      const branchIsIndexed =
        branch &&
        Array.isArray(entry.branches) &&
        entry.branches.some((summary) => summary && summary.branch === branch);
      return {
        path: entry.path,
        storagePath,
        lbugPath: branchIsIndexed
          ? path.join(storagePath, BRANCHES_DIRECTORY, branchSlug(branch), LBUG_DIRECTORY)
          : path.join(storagePath, LBUG_DIRECTORY),
        metadata,
      };
    }
  }
  return null;
}

module.exports = {
  findRegisteredRepo,
  INDEX_METADATA_FILE,
  LEGACY_METADATA_FILE,
  LBUG_DIRECTORY,
};
