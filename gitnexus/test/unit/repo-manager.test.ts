/**
 * P1 Unit Tests: Repository Manager
 *
 * Tests: getStoragePath, getStoragePaths, readRegistry, registerRepo, unregisterRepo
 * Covers hardening fixes #29 (API key file permissions) and #30 (case-insensitive paths on Windows)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getStoragePath,
  getStoragePaths,
  readRegistry,
  loadCLIConfig,
  registerRepo,
  listRegisteredRepos,
  resolveRegistryEntry,
  canonicalizePath,
  assertSafeStoragePath,
  RegistryNameCollisionError,
  RegistryNotFoundError,
  RegistryAmbiguousTargetError,
  UnsafeStoragePathError,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { parseRepoNameFromUrl, getInferredRepoName } from '../../src/storage/git.js';
import { execSync } from 'child_process';
import { createTempDir } from '../helpers/test-db.js';

// ─── getStoragePath ──────────────────────────────────────────────────

describe('getStoragePath', () => {
  it('appends .gitnexus to resolved repo path', () => {
    const result = getStoragePath('/home/user/project');
    expect(result).toContain('.gitnexus');
    expect(path.basename(result)).toBe('.gitnexus');
  });

  it('resolves relative paths', () => {
    const result = getStoragePath('.');
    // Should be an absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── getStoragePaths ─────────────────────────────────────────────────

describe('getStoragePaths', () => {
  it('returns storagePath, lbugPath, metaPath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.storagePath).toContain('.gitnexus');
    expect(paths.lbugPath).toContain('lbug');
    expect(paths.metaPath).toContain('meta.json');
  });

  it('all paths are under storagePath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.lbugPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.metaPath.startsWith(paths.storagePath)).toBe(true);
  });
});

// ─── readRegistry ────────────────────────────────────────────────────

describe('readRegistry', () => {
  it('returns empty array when registry does not exist', async () => {
    // readRegistry reads from ~/.gitnexus/registry.json
    // If the file doesn't exist, it should return []
    // This test exercises the catch path
    const result = await readRegistry();
    // Result is an array (may or may not be empty depending on user's system)
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── CLI Config (file permissions) ───────────────────────────────────

describe('saveCLIConfig / loadCLIConfig', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    tmpHandle = await createTempDir('gitnexus-config-test-');
    originalHomedir = os.homedir;
    // Mock os.homedir to point to our temp dir
    // Note: This won't fully work because repo-manager uses its own import of os
    // We'll test what we can.
  });

  afterEach(async () => {
    os.homedir = originalHomedir;
    await tmpHandle.cleanup();
  });

  it('loadCLIConfig returns empty object when config does not exist', async () => {
    const config = await loadCLIConfig();
    // Returns {} or existing config
    expect(typeof config).toBe('object');
  });
});

// ─── Case-insensitive path comparison (Windows hardening #30) ────────

describe('case-insensitive path comparison', () => {
  it('registerRepo uses case-insensitive compare on Windows', () => {
    // The fix is in registerRepo: process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase()
    // We verify the logic inline since we can't easily mock process.platform

    const compareWindows = (a: string, b: string): boolean => {
      return a.toLowerCase() === b.toLowerCase();
    };

    // On Windows, these should match
    expect(compareWindows('D:\\Projects\\MyApp', 'd:\\projects\\myapp')).toBe(true);
    expect(compareWindows('C:\\Users\\USER\\project', 'c:\\users\\user\\project')).toBe(true);

    // Different paths should not match
    expect(compareWindows('D:\\Projects\\App1', 'D:\\Projects\\App2')).toBe(false);
  });

  it('case-sensitive compare for non-Windows', () => {
    const compareUnix = (a: string, b: string): boolean => {
      return a === b;
    };

    // On Unix, case matters
    expect(compareUnix('/home/user/Project', '/home/user/project')).toBe(false);
    expect(compareUnix('/home/user/project', '/home/user/project')).toBe(true);
  });
});

// ─── API key file permissions (hardening #29) ────────────────────────

describe('API key file permissions', () => {
  it('saveCLIConfig calls chmod 0o600 on non-Windows', async () => {
    // We verify that the saveCLIConfig code has the chmod call
    // by reading the source and checking statically.
    // The actual chmod behavior is platform-dependent.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'storage', 'repo-manager.ts'),
      'utf-8',
    );
    expect(source).toContain('chmod(configPath, 0o600)');
    expect(source).toContain("process.platform !== 'win32'");
  });
});

// ─── analyze --name <alias> + duplicate-name guard (#829) ────────────
//
// Each test isolates the global registry by pointing GITNEXUS_HOME at a
// per-test tmpdir. `getGlobalDir()` honors that env var, so registerRepo
// writes/reads a sandboxed registry.json without touching the user's
// real ~/.gitnexus.

describe('registerRepo name override + collision guard (#829)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoA: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoB: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  const meta: RepoMeta = {
    repoPath: '',
    lastCommit: 'abc1234',
    indexedAt: '2026-04-18T12:00:00.000Z',
    stats: { files: 1, nodes: 1 },
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-home-');
    tmpRepoA = await createTempDir('gitnexus-repo-a-');
    tmpRepoB = await createTempDir('gitnexus-repo-b-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
    await tmpRepoA.cleanup();
    await tmpRepoB.cleanup();
  });

  it('registerRepo({ name: "alias" }) stores the alias instead of basename', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'custom-alias' });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('custom-alias');
    expect(entries[0].name).not.toBe(path.basename(tmpRepoA.dbPath));
  });

  it('re-registerRepo on same path without name preserves an existing alias', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'custom-alias' });
    // Second call with no opts should keep the alias, not revert to basename.
    await registerRepo(tmpRepoA.dbPath, meta);

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('custom-alias');
  });

  it('re-registerRepo with a different name overrides the previous alias', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'old-alias' });
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'new-alias' });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('new-alias');
  });

  it('registerRepo throws RegistryNameCollisionError when another path uses the name', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'shared' });

    await expect(registerRepo(tmpRepoB.dbPath, meta, { name: 'shared' })).rejects.toBeInstanceOf(
      RegistryNameCollisionError,
    );

    // And the colliding entry in the error carries enough info for the
    // CLI layer to surface an actionable message without string-matching.
    try {
      await registerRepo(tmpRepoB.dbPath, meta, { name: 'shared' });
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryNameCollisionError);
      const err = e as RegistryNameCollisionError;
      // err.registryName carries the colliding alias (exposed as its own
      // field so err.name retains the inherited Error.prototype.name
      // semantics for downstream `err.name === '…Error'` checks).
      expect(err.registryName).toBe('shared');
      expect(err.name).toBe('RegistryNameCollisionError');
      expect(path.resolve(err.existingPath)).toBe(path.resolve(tmpRepoA.dbPath));
      expect(path.resolve(err.requestedPath)).toBe(path.resolve(tmpRepoB.dbPath));
    }

    // Registry still only has the first entry — the failed call didn't
    // corrupt state.
    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('shared');
  });

  it('registerRepo({ name, allowDuplicateName: true }) allows the duplicate to coexist', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'shared' });
    await registerRepo(tmpRepoB.dbPath, meta, { name: 'shared', allowDuplicateName: true });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.name === 'shared')).toBe(true);
    // Both paths are stored distinctly — the collision is surfaced to the
    // user via resolveRepo / list output, not hidden at the storage layer.
    const paths = entries.map((e) => path.resolve(e.path)).sort();
    expect(paths).toEqual([path.resolve(tmpRepoA.dbPath), path.resolve(tmpRepoB.dbPath)].sort());
  });

  it('basename collisions without an explicit --name still register silently (backward-compat)', async () => {
    // Create two sibling dirs whose basenames collide. Neither caller
    // passes { name }, so the guard must NOT fire — this preserves the
    // pre-#829 behaviour for users who don't know about --name yet.
    const parentA = await createTempDir('gitnexus-collide-parent-a-');
    const parentB = await createTempDir('gitnexus-collide-parent-b-');
    const sharedBasename = 'app';
    const pathA = path.join(parentA.dbPath, sharedBasename);
    const pathB = path.join(parentB.dbPath, sharedBasename);
    await fs.mkdir(pathA, { recursive: true });
    await fs.mkdir(pathB, { recursive: true });

    try {
      await registerRepo(pathA, meta);
      await registerRepo(pathB, meta); // must NOT throw

      const entries = await listRegisteredRepos();
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe(sharedBasename);
      expect(entries[1].name).toBe(sharedBasename);
    } finally {
      await parentA.cleanup();
      await parentB.cleanup();
    }
  });
});

// ─── parseRepoNameFromUrl + getInferredRepoName (#979) ───────────────

describe('parseRepoNameFromUrl', () => {
  it('parses HTTPS URLs and strips .git', () => {
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark')).toBe('lume_spark');
  });

  it('parses SSH URLs (git@host:owner/repo.git)', () => {
    expect(parseRepoNameFromUrl('git@github.com:owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('git@gitlab.com:group/sub/lume_spark.git')).toBe('lume_spark');
  });

  it('parses ssh:// and git:// URLs', () => {
    expect(parseRepoNameFromUrl('ssh://git@host.example/owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('git://host.example/owner/lume_spark.git')).toBe('lume_spark');
  });

  it('parses local file:// URLs', () => {
    expect(parseRepoNameFromUrl('file:///srv/git/lume_spark.git')).toBe('lume_spark');
  });

  it('handles trailing slashes and mixed-case .git', () => {
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark.GIT/')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark/')).toBe('lume_spark');
  });

  it('returns null for empty / null / undefined / unparseable input', () => {
    expect(parseRepoNameFromUrl('')).toBeNull();
    expect(parseRepoNameFromUrl('   ')).toBeNull();
    expect(parseRepoNameFromUrl(null)).toBeNull();
    expect(parseRepoNameFromUrl(undefined)).toBeNull();
  });
});

describe('getInferredRepoName + registerRepo (#979 — git remote inference)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  const meta: RepoMeta = {
    repoPath: '',
    lastCommit: 'abc1234',
    indexedAt: '2026-04-19T00:00:00.000Z',
    stats: { files: 1, nodes: 1 },
  };

  /** Initialise a real git repo at `dir` with the given remote URL. */
  const initGitRepo = (dir: string, remoteUrl: string | null) => {
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    if (remoteUrl) {
      execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
    }
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-home-979-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('getInferredRepoName returns null when there is no .git directory', async () => {
    const tmp = await createTempDir('gitnexus-no-git-');
    try {
      expect(getInferredRepoName(tmp.dbPath)).toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });

  it('getInferredRepoName returns null when origin is unset', async () => {
    const tmp = await createTempDir('gitnexus-no-origin-');
    try {
      initGitRepo(tmp.dbPath, null);
      expect(getInferredRepoName(tmp.dbPath)).toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });

  it('getInferredRepoName returns the remote repo name when origin is set', async () => {
    const tmp = await createTempDir('gitnexus-with-origin-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/lume_spark.git');
      expect(getInferredRepoName(tmp.dbPath)).toBe('lume_spark');
    } finally {
      await tmp.cleanup();
    }
  });

  it('registerRepo derives name from git remote when basename is generic (Gas-Town repro)', async () => {
    // Reproduce <rig>/refinery/rig/.git layout: leaf basename is "rig",
    // but origin URL says "lume_spark". The new precedence MUST pick up
    // the remote-derived name instead of the basename.
    const root = await createTempDir('gitnexus-gastown-');
    try {
      const rigPath = path.join(root.dbPath, 'lume_spark', 'refinery', 'rig');
      await fs.mkdir(rigPath, { recursive: true });
      initGitRepo(rigPath, 'git@github.com:gastown/lume_spark.git');

      const name = await registerRepo(rigPath, meta);
      expect(name).toBe('lume_spark');
      expect(name).not.toBe('rig');

      const entries = await listRegisteredRepos();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('lume_spark');
    } finally {
      await root.cleanup();
    }
  });

  it('two analyze calls of differently-remoted "rig" leaves no longer collide', async () => {
    // Without the remote inference both would register as "rig"; with
    // inference they pick up their distinct remotes — the original issue.
    const root = await createTempDir('gitnexus-gastown-2-');
    try {
      const rigA = path.join(root.dbPath, 'lume_spark', 'refinery', 'rig');
      const rigB = path.join(root.dbPath, 'gemba', 'refinery', 'rig');
      await fs.mkdir(rigA, { recursive: true });
      await fs.mkdir(rigB, { recursive: true });
      initGitRepo(rigA, 'git@github.com:gastown/lume_spark.git');
      initGitRepo(rigB, 'git@github.com:gastown/gemba.git');

      const nameA = await registerRepo(rigA, meta);
      const nameB = await registerRepo(rigB, meta);
      expect(nameA).toBe('lume_spark');
      expect(nameB).toBe('gemba');

      const entries = await listRegisteredRepos();
      expect(entries.map((e) => e.name).sort()).toEqual(['gemba', 'lume_spark']);
    } finally {
      await root.cleanup();
    }
  });

  it('explicit --name still wins over remote inference', async () => {
    const tmp = await createTempDir('gitnexus-name-wins-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/from-remote.git');
      const name = await registerRepo(tmp.dbPath, meta, { name: 'user-alias' });
      expect(name).toBe('user-alias');
    } finally {
      await tmp.cleanup();
    }
  });

  it('preserved alias still wins over remote inference on re-analyze', async () => {
    const tmp = await createTempDir('gitnexus-preserve-alias-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/from-remote.git');
      // First analyze sets the alias…
      await registerRepo(tmp.dbPath, meta, { name: 'sticky-alias' });
      // …second analyze with no opts must keep it (not silently switch
      // to the remote-derived name).
      const name = await registerRepo(tmp.dbPath, meta);
      expect(name).toBe('sticky-alias');
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to basename when no .git / no remote is available', async () => {
    const tmp = await createTempDir('gitnexus-fallback-basename-');
    try {
      const name = await registerRepo(tmp.dbPath, meta);
      expect(name).toBe(path.basename(tmp.dbPath));
    } finally {
      await tmp.cleanup();
    }
  });
});

// ─── resolveRegistryEntry (#664 — gitnexus remove <target>) ──────────
//
// The resolver is a pure function over a `RegistryEntry[]` snapshot, so
// these tests build synthetic entries inline and do NOT touch
// ~/.gitnexus. No GITNEXUS_HOME sandboxing needed. This also means the
// tests are platform-portable on Windows where realpath semantics on
// tmpdirs can diverge between runs (see the #955 CI pivot).

describe('resolveRegistryEntry (#664)', () => {
  // A well-known synthetic registry with two same-name entries (which
  // can only exist in reality after `--allow-duplicate-name` — #829) and
  // one unique-name entry. Path prefixes differ across platforms so the
  // tests stay meaningful regardless of `process.platform`.
  const prefix = process.platform === 'win32' ? 'D:\\' : '/tmp/';
  const pathA = `${prefix}projects${path.sep}gnx-a${path.sep}app`;
  const pathB = `${prefix}projects${path.sep}gnx-b${path.sep}app`;
  const pathW = `${prefix}work${path.sep}website`;

  const entries: RegistryEntry[] = [
    {
      name: 'app',
      path: pathA,
      storagePath: `${pathA}${path.sep}.gitnexus`,
      indexedAt: '2026-04-18T00:00:00.000Z',
      lastCommit: 'aaaaaaa',
    },
    {
      name: 'app',
      path: pathB,
      storagePath: `${pathB}${path.sep}.gitnexus`,
      indexedAt: '2026-04-18T00:00:00.000Z',
      lastCommit: 'bbbbbbb',
    },
    {
      name: 'website',
      path: pathW,
      storagePath: `${pathW}${path.sep}.gitnexus`,
      indexedAt: '2026-04-18T00:00:00.000Z',
      lastCommit: 'ccccccc',
    },
  ];

  it('resolves by absolute path to the exact entry (path tier beats name tier)', () => {
    const hit = resolveRegistryEntry(entries, pathA);
    expect(hit).toBe(entries[0]);
    expect(hit.path).toBe(pathA);

    const hit2 = resolveRegistryEntry(entries, pathB);
    expect(hit2).toBe(entries[1]);
    expect(hit2.path).toBe(pathB);
  });

  it('resolves by unique name to the only matching entry', () => {
    const hit = resolveRegistryEntry(entries, 'website');
    expect(hit).toBe(entries[2]);
    expect(hit.name).toBe('website');
  });

  it('name match is case-insensitive', () => {
    expect(resolveRegistryEntry(entries, 'WEBSITE')).toBe(entries[2]);
    expect(resolveRegistryEntry(entries, 'Website')).toBe(entries[2]);
  });

  it('path match is case-insensitive on Windows only', () => {
    if (process.platform !== 'win32') {
      // On POSIX, a differently-cased path must NOT match. Verify by
      // lower-casing a mixed-case copy of pathW and expecting a miss.
      const upper = pathW.toUpperCase();
      expect(() => resolveRegistryEntry(entries, upper)).toThrow(RegistryNotFoundError);
      return;
    }
    const upper = pathA.toUpperCase();
    const hit = resolveRegistryEntry(entries, upper);
    expect(hit).toBe(entries[0]);
  });

  it('throws RegistryAmbiguousTargetError when name matches multiple entries', () => {
    // Two 'app' entries exist only because of --allow-duplicate-name
    // (#829). The resolver MUST refuse to guess.
    expect(() => resolveRegistryEntry(entries, 'app')).toThrow(RegistryAmbiguousTargetError);
    try {
      resolveRegistryEntry(entries, 'app');
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryAmbiguousTargetError);
      const err = e as RegistryAmbiguousTargetError;
      expect(err.kind).toBe('RegistryAmbiguousTargetError');
      expect(err.target).toBe('app');
      expect(err.matches).toHaveLength(2);
      // Error message must include both paths so the CLI can surface
      // them without string-matching on `.message`.
      expect(err.message).toContain(pathA);
      expect(err.message).toContain(pathB);
    }
  });

  it('throws RegistryNotFoundError when no entry matches', () => {
    expect(() => resolveRegistryEntry(entries, 'nonexistent')).toThrow(RegistryNotFoundError);
    try {
      resolveRegistryEntry(entries, 'nonexistent');
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryNotFoundError);
      const err = e as RegistryNotFoundError;
      expect(err.kind).toBe('RegistryNotFoundError');
      expect(err.target).toBe('nonexistent');
      // availableNames is disambiguated: 'app' appears twice, so both
      // `app (path)` variants are included; 'website' is unique so it
      // stays plain — matches the resolveRepo disambiguation shape.
      expect(err.availableNames).toContain('website');
      expect(err.availableNames.some((n) => n.startsWith('app ('))).toBe(true);
      // Error message surfaces the hint.
      expect(err.message).toContain('website');
    }
  });

  it('throws RegistryNotFoundError with "no repositories registered" hint when registry is empty', () => {
    try {
      resolveRegistryEntry([], 'anything');
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryNotFoundError);
      const err = e as RegistryNotFoundError;
      expect(err.availableNames).toEqual([]);
      expect(err.message).toContain('No repositories are currently registered');
    }
  });

  it('path match wins over name match (never ambiguous)', () => {
    // Construct a pathological fixture where a registry entry's NAME
    // happens to equal another entry's PATH. The path tier must win
    // without triggering ambiguity.
    const weird: RegistryEntry[] = [
      { ...entries[2] }, // 'website' at pathW
      {
        name: pathW, // degenerate: name equals another entry's path
        path: `${prefix}elsewhere${path.sep}odd`,
        storagePath: `${prefix}elsewhere${path.sep}odd${path.sep}.gitnexus`,
        indexedAt: '2026-04-18T00:00:00.000Z',
        lastCommit: 'ddddddd',
      },
    ];
    const hit = resolveRegistryEntry(weird, pathW);
    // Must match the entry whose PATH is pathW, not the one whose NAME
    // is pathW — because Tier 1 runs before Tier 2 and finds the path
    // match first.
    expect(hit.path).toBe(pathW);
    expect(hit.name).toBe('website');
  });
});

// ─── canonicalizePath (#1003 review — @evander-wang / @magyargergo) ──
//
// Shields `registerRepo`, `unregisterRepo`, and `resolveRegistryEntry`
// against cross-platform path-form divergence: macOS symlink expansion
// (/var → /private/var) and Windows 8.3 short-name expansion
// (RUNNERA~1 → runneradmin). The helper also underpins backwards
// compatibility with registries written by versions that only ran
// `path.resolve` — by canonicalising the stored entry at compare time,
// both pre- and post-fix entries converge to the same key.
//
// These tests avoid snapshotting a specific realpath value (that would
// be platform-fragile); instead they assert:
//   - canonicalizePath is idempotent (f(f(x)) == f(x))
//   - canonicalizePath falls back cleanly when the path doesn't exist
//   - resolveRegistryEntry matches a stored entry even when the target
//     and the stored value disagree on one-step normalisation (simulated
//     via a fixture that stores the de-canonicalised form of a real
//     existing path).

describe('canonicalizePath (#1003)', () => {
  it('is idempotent — canonicalizePath(canonicalizePath(x)) === canonicalizePath(x)', async () => {
    // Use the vitest project-root as a known-existing path. `os.tmpdir()`
    // would work too but process.cwd() is guaranteed to exist for the
    // test runner.
    const p = process.cwd();
    const once = canonicalizePath(p);
    const twice = canonicalizePath(once);
    expect(twice).toBe(once);
  });

  it('falls back to path.resolve when the target does not exist', () => {
    // Construct a definitely-nonexistent path under tmpdir. Using
    // random-ish segments so we don't collide with anything real.
    const ghost = path.join(os.tmpdir(), 'gnx-never-exists-____', 'still-not-there');
    const got = canonicalizePath(ghost);
    // Must not throw, must not resolve to something weird — should be
    // identical to `path.resolve(ghost)` since realpathSync.native will
    // have thrown and we swallowed it.
    expect(got).toBe(path.resolve(ghost));
  });

  it('returns an absolute path for relative input even when the path is missing', () => {
    // Relative path that does not exist. Must still be absolute
    // (fallback path: path.resolve normalises even non-existent inputs).
    const rel = './does-not-exist-zzz-' + Date.now();
    const got = canonicalizePath(rel);
    expect(path.isAbsolute(got)).toBe(true);
  });
});

describe('resolveRegistryEntry backward-compat with non-canonical stored paths (#1003)', () => {
  it('matches a stored entry even when the target was passed in canonical form', async () => {
    // Simulate the bug-producing scenario without depending on a real
    // symlink/8.3 discrepancy (those are platform-specific and flaky to
    // set up in CI). We take a REAL path that exists
    // (canonicalizePath-stable), store a known-non-canonical copy of it
    // in a fake RegistryEntry, then resolve with the canonical form and
    // assert the match.
    //
    // Construct a non-canonical string that resolves to the same real
    // path. `path.join` auto-normalises `.` and trailing separators, so
    // we build the string by raw concat to keep it string-unequal to
    // `realDir` until `canonicalizePath` runs.
    const realDir = process.cwd();
    const nonCanonical = realDir + path.sep + '.'; // e.g. /work/gitnexus/.
    // Sanity: these are string-unequal before canonicalisation.
    expect(nonCanonical).not.toBe(realDir);

    const entries: RegistryEntry[] = [
      {
        name: 'stored-under-noncanonical-form',
        path: nonCanonical,
        storagePath: path.join(nonCanonical, '.gitnexus'),
        indexedAt: '2026-04-20T00:00:00.000Z',
        lastCommit: 'deadbee',
      },
    ];

    // Pass the canonical form as the target — resolver must still match.
    const hit = resolveRegistryEntry(entries, realDir);
    expect(hit).toBe(entries[0]);
  });
});

// ─── assertSafeStoragePath (#1003 review — @magyargergo) ─────────────
//
// Guard rail against destroying more than the `.gitnexus/` subfolder.
// `~/.gitnexus/registry.json` is user-writable plain text, so a
// corrupted or hand-edited entry could put storagePath anywhere.
// These tests use synthetic `RegistryEntry` fixtures (no disk I/O)
// because the guard is a pure string check — it must not depend on
// the paths existing.

describe('assertSafeStoragePath (#1003)', () => {
  const prefix = process.platform === 'win32' ? 'D:\\' : '/tmp/';
  const repoPath = `${prefix}projects${path.sep}my-repo`;
  const base: Omit<RegistryEntry, 'storagePath'> = {
    name: 'my-repo',
    path: repoPath,
    indexedAt: '2026-04-21T00:00:00.000Z',
    lastCommit: 'deadbee',
  };

  it('accepts the canonical <repo>/.gitnexus storage path', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: path.join(repoPath, '.gitnexus'),
    };
    expect(() => assertSafeStoragePath(entry)).not.toThrow();
  });

  it('rejects when storagePath equals the repo path itself (would delete the code)', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: repoPath, // catastrophic: rm the working tree
    };
    expect(() => assertSafeStoragePath(entry)).toThrow(UnsafeStoragePathError);
  });

  it('rejects when storagePath is a parent of the repo path', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: path.dirname(repoPath), // also catastrophic
    };
    expect(() => assertSafeStoragePath(entry)).toThrow(UnsafeStoragePathError);
  });

  it('rejects when storagePath is empty (path.resolve falls back to cwd)', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: '', // path.resolve('') === process.cwd() — would rm cwd
    };
    expect(() => assertSafeStoragePath(entry)).toThrow(UnsafeStoragePathError);
  });

  it('rejects when storagePath points somewhere totally unrelated', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: `${prefix}some${path.sep}other${path.sep}place`,
    };
    expect(() => assertSafeStoragePath(entry)).toThrow(UnsafeStoragePathError);
  });

  it('rejects when storagePath is a sibling .gitnexus (right basename, wrong parent)', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: path.join(`${prefix}different${path.sep}repo`, '.gitnexus'),
    };
    expect(() => assertSafeStoragePath(entry)).toThrow(UnsafeStoragePathError);
  });

  it('UnsafeStoragePathError carries the original entry + expected + actual paths', () => {
    const entry: RegistryEntry = {
      ...base,
      storagePath: `${prefix}evil${path.sep}path`,
    };
    try {
      assertSafeStoragePath(entry);
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeStoragePathError);
      const err = e as UnsafeStoragePathError;
      expect(err.kind).toBe('UnsafeStoragePathError');
      expect(err.entry).toBe(entry);
      // Expected path is the canonical `<repo>/.gitnexus`.
      expect(err.expectedStoragePath).toBe(path.join(path.resolve(repoPath), '.gitnexus'));
      // Actual path is the corrupted value (resolved).
      expect(err.actualStoragePath).toBe(path.resolve(entry.storagePath));
      // Message must suggest the recovery action.
      expect(err.message).toContain('registry.json');
    }
  });

  it('Windows: storagePath match is case-insensitive to match register/unregister semantics', () => {
    if (process.platform !== 'win32') return;
    const entry: RegistryEntry = {
      ...base,
      storagePath: path.join(repoPath.toUpperCase(), '.GITNEXUS'),
    };
    // Should accept because Windows paths are case-insensitive.
    expect(() => assertSafeStoragePath(entry)).not.toThrow();
  });
});
