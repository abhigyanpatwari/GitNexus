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
const STORAGE_PATH_ENV = 'GITNEXUS_STORAGE_PATH';
const STORAGE_ROOT_ENV = 'GITNEXUS_STORAGE_ROOT';
const STORAGE_SLOT_HASH_LENGTH = 12;
const LOCAL_OWNED_PARENT_HOPS = 5;

function stripWindowsLongPathPrefix(p) {
  if (process.platform !== 'win32') return p;
  if (/^\\\\\?\\UNC\\(?=[^\\])/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4);
  return p;
}

function canonicalize(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value))
    return null;
  const resolved = path.resolve(value);
  try {
    return stripWindowsLongPathPrefix(fs.realpathSync.native(resolved));
  } catch {
    return stripWindowsLongPathPrefix(resolved);
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

function isInsideOrEqual(child, ancestor) {
  if (child == null || ancestor == null) return false;
  if (samePath(child, ancestor)) return true;
  const relative = path.relative(ancestor, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ancestorPathsThrough(cwd, stopAt) {
  const paths = [];
  let current = canonicalize(cwd);
  const stop = canonicalize(stopAt);
  while (current) {
    if (stop && !isInsideOrEqual(current, stop)) break;
    paths.push(current);
    if (stop && samePath(current, stop)) break;
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
    if (!worktreeRoot || !path.isAbsolute(worktreeRoot)) {
      return { repoPaths: fallbackPaths, branch: null };
    }

    // Keep ancestor paths of cwd that stay inside this worktree (cwd up to
    // and including show-toplevel) so a --skip-git subdirectory index can
    // win via longest-match. Do not walk ancestors outside the worktree —
    // that would re-attribute a parent index to a nested git checkout.
    const repoPaths = ancestorPathsThrough(cwd, worktreeRoot);
    const worktreeCanon = canonicalize(worktreeRoot);
    if (worktreeCanon && !repoPaths.some((repoPath) => samePath(repoPath, worktreeCanon))) {
      repoPaths.push(worktreeCanon);
    }

    // Linked worktrees share the canonical repo's git dir. Include that
    // parent so the registered main checkout is still discoverable, but do
    // not walk any further outside this worktree.
    if (commonDir) {
      const commonParent = canonicalize(path.dirname(commonDir));
      if (
        commonParent &&
        worktreeCanon &&
        !samePath(commonParent, worktreeCanon) &&
        !repoPaths.some((repoPath) => samePath(repoPath, commonParent))
      ) {
        repoPaths.push(commonParent);
      }
    }
    return {
      repoPaths,
      branch: currentGitBranch(cwd),
    };
  } catch {
    return { repoPaths: fallbackPaths, branch: null };
  }
}

function branchSlug(rawRef) {
  const sanitized = rawRef.replace(/^-+/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  const safe =
    !sanitized || sanitized === '.' || sanitized === '..' || reserved.test(sanitized)
      ? 'unknown'
      : sanitized;
  const hash = createHash('sha256').update(rawRef).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

// Mirror gitnexus/src/storage/storage-resolver.ts storageSlotName exactly
// (sanitize + sha256 of the canonical repo path, 12-hex suffix).
function sanitizeSlotBasename(value) {
  // Cap first, then walk the tail once — same order as
  // gitnexus/src/storage/storage-resolver.ts (avoids /[. ]+$/ ReDoS).
  const sanitized = value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 80);
  let end = sanitized.length;
  while (end > 0) {
    const code = sanitized.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x2e) break;
    end--;
  }
  const candidate = sanitized.slice(0, end) || 'repository';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate)
    ? `repository-${candidate}`
    : candidate;
}

function storageSlotName(repoPath) {
  const canonical = canonicalize(repoPath);
  if (!canonical) return null;
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const basename = sanitizeSlotBasename(path.basename(canonical));
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, STORAGE_SLOT_HASH_LENGTH);
  return `${basename}-${digest}`;
}

function envOverridesStorage() {
  const envPath = process.env[STORAGE_PATH_ENV];
  const envRoot = process.env[STORAGE_ROOT_ENV];
  return (
    (typeof envPath === 'string' && envPath.length > 0) ||
    (typeof envRoot === 'string' && envRoot.length > 0)
  );
}

function resolveEntryStoragePath(entry) {
  const envPath = process.env[STORAGE_PATH_ENV];
  if (
    typeof envPath === 'string' &&
    envPath.length > 0 &&
    !envPath.includes('\0') &&
    path.isAbsolute(envPath)
  ) {
    const resolved = path.resolve(envPath);
    if (path.isAbsolute(resolved)) return resolved;
  }

  const envRoot = process.env[STORAGE_ROOT_ENV];
  if (
    typeof envRoot === 'string' &&
    envRoot.length > 0 &&
    !envRoot.includes('\0') &&
    path.isAbsolute(envRoot)
  ) {
    const root = path.resolve(envRoot);
    const slot = storageSlotName(entry.path);
    if (slot) {
      const storagePath = path.join(root, slot);
      if (samePath(path.dirname(storagePath), root)) return storagePath;
    }
  }

  if (entry.storagePath !== undefined) {
    if (
      typeof entry.storagePath !== 'string' ||
      !entry.storagePath ||
      entry.storagePath.includes('\0') ||
      !path.isAbsolute(entry.storagePath)
    ) {
      return null;
    }
    return path.resolve(entry.storagePath);
  }
  return path.resolve(path.join(entry.path, GITNEXUS_DIR));
}

function hasLocalIndexSignal(storagePath) {
  try {
    return (
      fs.existsSync(path.join(storagePath, INDEX_METADATA_FILE)) ||
      fs.existsSync(path.join(storagePath, LBUG_DIRECTORY))
    );
  } catch {
    return false;
  }
}

function findLocalOwnedRepo(cwd) {
  // Environment storage overrides win; a leftover repo-local .gitnexus must
  // not skip the registry scan that applies STORAGE_PATH / STORAGE_ROOT.
  if (envOverridesStorage()) return null;
  const { repoPaths, branch } = registryPathsForCwd(cwd);
  let current = canonicalize(cwd);
  for (let hops = 0; hops <= LOCAL_OWNED_PARENT_HOPS && current; hops++) {
    const storagePath = path.join(current, GITNEXUS_DIR);
    if (hasLocalIndexSignal(storagePath)) {
      const metadata = readIndexMetadata(storagePath);
      if (isOwnedStorage(current, storagePath, true, metadata)) {
        const branchDir =
          branch != null ? path.join(storagePath, BRANCHES_DIRECTORY, branchSlug(branch)) : null;
        const indexDir = branchDir && hasLocalIndexSignal(branchDir) ? branchDir : storagePath;
        return {
          path: current,
          storagePath,
          lbugPath: path.join(indexDir, LBUG_DIRECTORY),
          metadata: indexDir === storagePath ? metadata : readIndexMetadata(indexDir),
        };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    // Stay inside this checkout. Registered lookup already stops at
    // `--show-toplevel`; walking raw parents would adopt `/outer/.gitnexus`
    // from `/outer/nested-repo`.
    if (repoPaths.length > 0 && !repoPaths.some((repoPath) => samePath(repoPath, parent))) {
      break;
    }
    current = parent;
  }
  return null;
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

  let best = null;
  let bestLen = -1;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.path !== 'string') continue;
    if (entry.path.includes('\0') || !path.isAbsolute(entry.path)) continue;
    const registeredPath = canonicalize(entry.path);
    if (!registeredPath || !repoPaths.some((repoPath) => samePath(repoPath, registeredPath))) {
      continue;
    }
    const storagePath = resolveEntryStoragePath(entry);
    if (!storagePath) continue;
    const repositoryLocal = samePath(
      canonicalize(path.join(entry.path, GITNEXUS_DIR)),
      canonicalize(storagePath),
    );
    const ownershipMetadata = readIndexMetadata(storagePath);
    if (!isOwnedStorage(entry.path, storagePath, repositoryLocal, ownershipMetadata)) continue;
    const branchIsIndexed =
      branch &&
      Array.isArray(entry.branches) &&
      entry.branches.some((summary) => summary && summary.branch === branch);
    const indexDir = branchIsIndexed
      ? path.join(storagePath, BRANCHES_DIRECTORY, branchSlug(branch))
      : storagePath;
    if (registeredPath.length > bestLen) {
      bestLen = registeredPath.length;
      best = {
        path: entry.path,
        storagePath,
        lbugPath: path.join(indexDir, LBUG_DIRECTORY),
        metadata: branchIsIndexed ? readIndexMetadata(indexDir) : ownershipMetadata,
      };
    }
  }
  return best;
}

/** Registry row wins (including persisted external storagePath); local owned is fallback. */
function resolveHookRepo(cwd) {
  return findRegisteredRepo(cwd) || findLocalOwnedRepo(cwd);
}

module.exports = {
  findRegisteredRepo,
  findLocalOwnedRepo,
  resolveHookRepo,
  INDEX_METADATA_FILE,
  LEGACY_METADATA_FILE,
  LBUG_DIRECTORY,
};
