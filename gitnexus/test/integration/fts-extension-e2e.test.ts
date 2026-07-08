/**
 * P1 Integration Tests: FTS extension lifecycle end-to-end (#2374)
 *
 * Everything real, nothing mocked: each test spawns the actual CLI entry as a
 * child process, LadybugDB loads the actual extension shared library from
 * disk, and the real out-of-process installer downloads the real extension in
 * the network-gated cases.
 *
 * Isolation: LadybugDB resolves its extension directory from the process HOME
 * (USERPROFILE on Windows), so every scenario owns a hermetic fake home with
 * its own `.lbdb/extension/<version>/<platform>/fts/` state — the machine's
 * real ~/.lbdb is never read or written. GITNEXUS_HOME additionally isolates
 * the registry (#829), following cli-e2e.test.ts conventions.
 *
 * Scenario matrix (the #2374 report, codified):
 *  - happy:   valid extension pre-installed, offline (load-only)
 *  - unhappy: extension file present but broken — the reporter's exact state
 *  - unhappy: extension file missing entirely (distinguishable reason)
 *  - heal:    FORCE INSTALL replaces a broken file over the network (auto)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

import lbug from '@ladybugdb/core';
import { getExtensionInstallChildProcessArgs } from '../../src/core/lbug/extension-loader.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';

/** `.lbdb/extension/<version>/<platform>/fts/libfts.lbug_extension`, discovered not hardcoded. */
let extensionRelPath: string;
/** Canonical valid extension bytes (path to a known-good file). */
let seedExtensionFile: string | null = null;
/** Real reachability of the extension repo — gates the auto-install cases. */
let networkAvailable = false;

const REQUIRE_FTS = process.env.GITNEXUS_REQUIRE_FTS === '1';
const tmpDirs: string[] = [];

const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-fts-e2e-${label}-`));
  tmpDirs.push(dir);
  return dir;
};

/**
 * Locate a known-good extension file for the running LadybugDB version.
 * Prefers a copy already installed under the machine's real home (pure file
 * read, offline); falls back to one real out-of-process install into a probe
 * home — the production installer script, not a reimplementation.
 */
const resolveSeedExtension = (): void => {
  const relBase = path.join('.lbdb', 'extension', lbug.VERSION);
  const realVersionDir = path.join(os.homedir(), relBase);
  const platformDirs = fs.existsSync(realVersionDir) ? fs.readdirSync(realVersionDir) : [];
  for (const platform of platformDirs) {
    const candidate = path.join(realVersionDir, platform, 'fts', 'libfts.lbug_extension');
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024 * 1024) {
      extensionRelPath = path.join(relBase, platform, 'fts', 'libfts.lbug_extension');
      seedExtensionFile = candidate;
      return;
    }
  }
  // No local copy — run the real installer against a hermetic probe home.
  const probeHome = makeTmpDir('seed-home');
  const install = spawnSync(process.execPath, getExtensionInstallChildProcessArgs('fts'), {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: probeHome, USERPROFILE: probeHome },
  });
  const probeVersionDir = path.join(probeHome, relBase);
  const probePlatforms = fs.existsSync(probeVersionDir) ? fs.readdirSync(probeVersionDir) : [];
  for (const platform of probePlatforms) {
    const candidate = path.join(probeVersionDir, platform, 'fts', 'libfts.lbug_extension');
    if (install.status === 0 && fs.existsSync(candidate)) {
      extensionRelPath = path.join(relBase, platform, 'fts', 'libfts.lbug_extension');
      seedExtensionFile = candidate;
      networkAvailable = true;
      return;
    }
  }
};

type ExtensionState = 'valid' | 'broken' | 'missing';

/** Create a hermetic fake home whose `.lbdb` holds the requested extension state. */
const makeHome = (state: ExtensionState): { home: string; extensionFile: string } => {
  const home = makeTmpDir(`home-${state}`);
  const extensionFile = path.join(home, extensionRelPath);
  fs.mkdirSync(path.dirname(extensionFile), { recursive: true });
  if (state === 'valid' && seedExtensionFile) fs.copyFileSync(seedExtensionFile, extensionFile);
  if (state === 'broken') fs.writeFileSync(extensionFile, 'not a shared library');
  return { home, extensionFile };
};

/** Fresh git-initialised throwaway repo with a uniquely named symbol to search for. */
const makeFixtureRepo = (label: string): string => {
  const repo = path.join(makeTmpDir(`repo-${label}`), `fts-e2e-${label}`);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'greeter.ts'),
    'export function greetE2eSymbol(name: string): string {\n' +
      '  return `Hello, ${name}`;\n' +
      '}\n' +
      "greetE2eSymbol('world');\n",
  );
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  spawnSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'pipe', env: gitEnv });
  return repo;
};

interface CliResult {
  status: number | null;
  /** stdout + stderr combined — warn lines and progress renderer interleave streams. */
  output: string;
}

const runCli = (
  args: string[],
  cwd: string,
  home: string,
  policy: 'load-only' | 'auto',
  timeoutMs = 180_000,
): CliResult => {
  const result = spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GITNEXUS_HOME: path.join(home, '.gitnexus'),
      GITNEXUS_LANG: 'en',
      GITNEXUS_LBUG_EXTENSION_INSTALL: policy,
      GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS: '60000',
      // Skip analyzeCommand's ensureHeap re-exec, which would drop the tsx loader.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

beforeAll(() => {
  resolveSeedExtension();
  if (!seedExtensionFile && REQUIRE_FTS) {
    throw new Error(
      'GITNEXUS_REQUIRE_FTS=1 but no FTS extension could be located or installed for the E2E suite.',
    );
  }
  // The self-heal cases need the real extension repo; probe it cheaply when
  // the seed came from a local copy (the installer fallback already proved it).
  return (async () => {
    if (seedExtensionFile && !networkAvailable) {
      try {
        const res = await fetch('https://extension.ladybugdb.com/', {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        networkAvailable = res.ok;
      } catch {
        networkAvailable = false;
      }
    }
  })();
}, 180_000);

afterAll(() => {
  for (const dir of tmpDirs) cleanupTempDirSync(dir);
});

// Skip everything (visibly) when no valid extension exists and the machine is
// offline — mirrors the dynamic-skip convention in test/helpers/fts-availability.ts.
beforeEach((ctx) => {
  if (!seedExtensionFile) ctx.skip();
});

describe('happy path — extension pre-installed, fully offline (load-only)', () => {
  let home: string;
  let repo: string;

  beforeAll(() => {
    // The file-level beforeEach skip fires only per-test; this hook runs first,
    // so guard makeHome() (which needs extensionRelPath) when there is no seed.
    if (!seedExtensionFile) return;
    ({ home } = makeHome('valid'));
    repo = makeFixtureRepo('happy');
  });

  it('analyze builds the index with FTS and emits no degradation warning', () => {
    const result = runCli(['analyze'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('indexed successfully');
    expect(result.output).not.toContain('FTS extension unavailable');
    expect(result.output).not.toContain('search is disabled');
  }, 180_000);

  it('query finds the symbol via BM25 with no degradation warning', () => {
    const result = runCli(['query', 'greetE2eSymbol'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('greetE2eSymbol');
    expect(result.output).not.toContain('keyword search degraded');
  }, 60_000);

  it('doctor reports a live-probed available FTS and a resolved LadybugDB version', () => {
    const result = runCli(['doctor'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('Full-text search: available');
    // #2374: version used to print as "unknown" on every platform.
    expect(result.output).toMatch(/LadybugDB:\s*\d+\.\d+\.\d+/);
  }, 60_000);

  it('analyze --repair-fts rebuilds the search indexes offline', () => {
    const result = runCli(['analyze', '--repair-fts'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('FTS indexes repaired successfully');
  }, 180_000);
});

describe('unhappy path — extension file present but broken (the #2374 report)', () => {
  let home: string;
  let repo: string;

  beforeAll(() => {
    // See the happy-path note: skip setup when no seed extension is available
    // so the per-test beforeEach skip is reached instead of throwing here.
    if (!seedExtensionFile) return;
    ({ home } = makeHome('broken'));
    repo = makeFixtureRepo('broken');
  });

  it('analyze degrades gracefully and names the real LOAD failure, not "not pre-installed"', () => {
    const result = runCli(['analyze'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('indexed successfully');
    expect(result.output).toContain('FTS extension unavailable');
    // The load-side ground truth must survive to the user…
    expect(result.output).toContain('LOAD fts failed');
    expect(result.output).toContain('Failed to load library');
    // …and the old misdiagnosis must not: the file IS pre-installed.
    expect(result.output).not.toContain('not pre-installed');
  }, 180_000);

  it('analyze --repair-fts fails loudly with the live reason and an honest remedy', () => {
    const result = runCli(['analyze', '--repair-fts'], repo, home, 'load-only');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Cannot repair FTS indexes');
    expect(result.output).toContain('FTS extension failed to load');
    expect(result.output).toContain('LOAD fts failed');
    // Old message sent users to doctor "to install it"; doctor never installed.
    expect(result.output).not.toContain('doctor` to install');
    expect(result.output).toContain('gitnexus doctor');
    // #2374 (U2): a corrupt file classifies as corrupt_file, so the Windows
    // missing-dependency remedy must not misfire on the repair path either.
    expect(result.output).not.toContain('Visual C++');
  }, 180_000);

  it('query warns with the extension-load failure, not the misleading indexes-missing message', () => {
    const result = runCli(['query', 'greetE2eSymbol'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('FTS extension failed to load');
    expect(result.output).toContain('Failed to load library');
    expect(result.output).not.toContain('FTS indexes missing');
  }, 60_000);

  it('doctor live-probes FTS as unavailable, prints the real error and an actionable remedy', () => {
    const result = runCli(['doctor'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('Full-text search: unavailable');
    expect(result.output).toContain('Failed to load library');
    // #2374 (U2): doctor routes the reason through the classifier and prints a
    // remedy. A broken file is corrupt_file → re-download guidance; the Windows
    // missing-dependency remedy (VC++/OpenSSL) must NOT misfire on a corrupt file
    // — the catch-all guard, verified end-to-end through the real CLI.
    expect(result.output).toContain('Re-download it with network access');
    expect(result.output).not.toContain('Visual C++');
  }, 60_000);
});

describe('unhappy path — extension missing entirely', () => {
  it('analyze degrades with a reason that distinguishes missing from broken', () => {
    const { home } = makeHome('missing');
    const repo = makeFixtureRepo('missing');
    const result = runCli(['analyze'], repo, home, 'load-only');
    expect(result.status).toBe(0);
    expect(result.output).toContain('FTS extension unavailable');
    expect(result.output).toContain('has not been installed');
    expect(result.output).not.toContain('Failed to load library');
  }, 180_000);
});

describe('self-heal over the network — FORCE INSTALL replaces a broken file (auto)', () => {
  beforeEach((ctx) => {
    // The platform matrix already exercises offline FTS load/diagnostic paths
    // against real macOS/Windows binaries. Keep network redownload coverage on
    // Ubuntu, where the full test job has the most stable extension fetch path.
    if (process.platform !== 'linux') ctx.skip();
    if (!networkAvailable) ctx.skip();
  });

  it('the reported journey heals: degraded analyze, then repair-fts with auto re-downloads and repairs', () => {
    const { home, extensionFile } = makeHome('broken');
    const repo = makeFixtureRepo('heal');

    const degraded = runCli(['analyze'], repo, home, 'load-only');
    expect(degraded.status).toBe(0);
    expect(degraded.output).toContain('FTS extension unavailable');

    // The reporter's exact failing command — plain INSTALL used to no-op
    // over the broken file and this kept failing forever.
    const repair = runCli(['analyze', '--repair-fts'], repo, home, 'auto');
    expect(repair.status).toBe(0);
    expect(repair.output).toContain('FTS indexes repaired successfully');
    expect(fs.statSync(extensionFile).size).toBeGreaterThan(1024 * 1024);

    const query = runCli(['query', 'greetE2eSymbol'], repo, home, 'load-only');
    expect(query.status).toBe(0);
    expect(query.output).toContain('greetE2eSymbol');
    expect(query.output).not.toContain('keyword search degraded');
  }, 600_000);

  it('a fresh machine with no extension installs it during analyze and gets full FTS', () => {
    const { home, extensionFile } = makeHome('missing');
    const repo = makeFixtureRepo('fresh');
    const result = runCli(['analyze'], repo, home, 'auto');
    expect(result.status).toBe(0);
    expect(result.output).toContain('indexed successfully');
    expect(result.output).not.toContain('FTS extension unavailable');
    expect(fs.existsSync(extensionFile)).toBe(true);
  }, 600_000);
});
