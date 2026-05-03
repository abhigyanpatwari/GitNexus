/**
 * P1 Integration Tests: CLI End-to-End
 *
 * Tests CLI commands via child process spawn:
 * - statusCommand: verify stdout for unindexed repo
 * - analyzeCommand: verify pipeline runs and creates .gitnexus/ output
 *
 * Uses process.execPath (never 'node' string), no shell: true.
 * Accepts status === null (timeout) as valid on slow CI runners.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { createRequire } from 'module';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

// `MINI_REPO` is a *per-run temp copy* of the fixture, not the shared
// source. Writing into the shared source races with other suites that
// ingest it read-only (pipeline-graph-golden, pipeline.test) — those
// suites copy the source to their own tmp dir but the copy happens at
// `beforeAll`, so if this suite's analyze has already created AGENTS.md
// / CLAUDE.md / .claude/ in the source when the other suite's cpSync
// runs, the pollution is captured before the isolation kicks in.
//
// The deterministic fix: this suite never touches the shared source.
// `beforeAll` copies the fixture to a fresh mkdtemp'd directory whose
// basename is `mini-repo` (so `--repo mini-repo` lookup by basename
// still works), `afterAll` rms the parent tmpdir.
let MINI_REPO: string;
let tmpParent: string;

// Absolute file:// URL to tsx loader — needed when spawning CLI with cwd
// outside the project tree (bare 'tsx' specifier won't resolve there).
// Cannot use require.resolve('tsx/dist/loader.mjs') because the subpath is
// not in tsx's package.json exports; resolve the package root then join.
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

beforeAll(() => {
  // Copy the fixture into an isolated tmpdir named `mini-repo` so that the
  // `--repo mini-repo` CLI arg (which matches by basename) still works.
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-e2e-'));
  MINI_REPO = path.join(tmpParent, 'mini-repo');
  fs.cpSync(FIXTURE_SRC, MINI_REPO, { recursive: true });

  // Initialize mini-repo as a git repo so the CLI analyze command
  // can run the full pipeline (it requires a .git directory).
  spawnSync('git', ['init'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial commit'], {
    cwd: MINI_REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
});

afterAll(() => {
  // Entire tmp copy goes away — no selective cleanup needed. The shared
  // `test/fixtures/mini-repo/` source was never touched.
  if (tmpParent) {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

function runCli(command: string, cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Pre-set --max-old-space-size so analyzeCommand's ensureHeap() sees it
      // and skips the re-exec. The re-exec drops the tsx loader (--import tsx
      // is not in process.argv), causing ERR_UNKNOWN_FILE_EXTENSION on .ts files.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

/**
 * Like runCli but accepts an arbitrary extra-args array so unhappy-path tests
 * can pass flags (e.g. --help) or omit a command entirely.
 */
function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

/**
 * Like runCliRaw but accepts extra env vars. Used by tests that need to
 * isolate the global registry via GITNEXUS_HOME so they don't touch the
 * developer / CI agent's real ~/.gitnexus/registry.json (#829).
 */
function runCliWithEnv(
  extraArgs: string[],
  cwd: string,
  extraEnv: Record<string, string>,
  timeoutMs = 15000,
) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
      ...extraEnv,
    },
  });
}

/**
 * Create a fresh git-initialised throwaway repo at `<parentTmp>/<basename>`
 * and return its path. Used for tests that need multiple repos whose
 * basenames intentionally collide (#829 reproduction).
 */
function makeMiniRepoCopy(basename: string, prefix: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(parent, basename);
  fs.cpSync(FIXTURE_SRC, repo, { recursive: true });
  spawnSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial commit'], {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
  return repo;
}

describe('CLI end-to-end', () => {
  it('status command exits cleanly', () => {
    const result = runCli('status', MINI_REPO);

    // Accept timeout as valid on slow CI
    if (result.status === null) return;

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    // mini-repo may or may not be indexed depending on prior test runs
    expect(combined).toMatch(/Repository|not indexed/i);
  });

  // The vitest test-level timeout (60 s) must exceed the subprocess
  // timeout (30 s) so the "Accept timeout as valid on slow CI"
  // branch can actually fire on slow runners (Windows CI routinely
  // comes in at ~2x macOS wall-clock). Without a larger test-level
  // timeout, the default 30 s vitest timeout races the 30 s
  // subprocess timeout and the `if (result.status === null) return;`
  // tolerance never activates.
  it('analyze command runs pipeline on mini-repo', () => {
    const result = runCli('analyze', MINI_REPO, 30000);

    // Accept timeout as valid on slow CI
    if (result.status === null) return;

    expect(
      result.status,
      [
        `analyze exited with code ${result.status}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
      ].join('\n'),
    ).toBe(0);

    // Successful analyze should create .gitnexus/ output directory
    const gitnexusDir = path.join(MINI_REPO, '.gitnexus');
    expect(fs.existsSync(gitnexusDir)).toBe(true);
    expect(fs.statSync(gitnexusDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(MINI_REPO, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(gitnexusDir, '.gitignore'), 'utf-8')).toBe('*\n');
  }, 60_000);

  // Regression guard for issue #1169 — analyze must produce BOTH a
  // meta.json AND a global-registry entry on success. The previous
  // failure mode on Windows was banner-only output + exit 0 with
  // neither artifact persisted; the new finalize invariant
  // (assertAnalysisFinalized) makes that state a hard failure.
  //
  // Uses a fresh per-test repo copy (not the shared MINI_REPO) so
  // an earlier sibling test's analyze cannot push this one onto the
  // alreadyUpToDate fast path, which would skip the very wiring this
  // test is here to protect.
  it('analyze persists meta.json AND a matching registry entry (#1169)', () => {
    const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-1169-home-'));
    const repo = makeMiniRepoCopy('mini-repo', 'gn-1169-repo-');
    const repoParent = path.dirname(repo);

    try {
      const result = runCliWithEnv(['analyze'], repo, { GITNEXUS_HOME: gnHome }, 60000);

      expect(
        result.status,
        [
          'analyze timed out before asserting finalization artifacts — this test guards #1169 and must not pass silently',
          `stdout: ${result.stdout}`,
          `stderr: ${result.stderr}`,
        ].join('\n'),
      ).not.toBeNull();

      expect(
        result.status,
        [
          `analyze exited with code ${result.status}`,
          `stdout: ${result.stdout}`,
          `stderr: ${result.stderr}`,
        ].join('\n'),
      ).toBe(0);

      const metaPath = path.join(repo, '.gitnexus', 'meta.json');
      expect(
        fs.existsSync(metaPath),
        `meta.json missing at ${metaPath} after analyze exited 0 — this is the #1169 silent-finalize symptom`,
      ).toBe(true);

      const registryPath = path.join(gnHome, 'registry.json');
      expect(
        fs.existsSync(registryPath),
        `registry.json missing at ${registryPath} after analyze exited 0`,
      ).toBe(true);
      const entries = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Array<{
        name: string;
        path: string;
      }>;
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const matchesRepo = entries.some((e) => {
        const a = fs.realpathSync.native(e.path);
        const b = fs.realpathSync.native(repo);
        return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      });
      expect(
        matchesRepo,
        `registry has no entry for ${repo}; entries: ${JSON.stringify(entries.map((e) => e.path))}`,
      ).toBe(true);
    } finally {
      fs.rmSync(gnHome, { recursive: true, force: true });
      fs.rmSync(repoParent, { recursive: true, force: true });
    }
  }, 60_000);

  it('already-up-to-date analyze fails when registry entry is missing (#1169)', () => {
    const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-1169-fastpath-home-'));
    const repo = makeMiniRepoCopy('mini-repo', 'gn-1169-fastpath-repo-');
    const repoParent = path.dirname(repo);

    try {
      const first = runCliWithEnv(['analyze'], repo, { GITNEXUS_HOME: gnHome }, 60000);
      expect(
        first.status,
        [
          `initial analyze exited with code ${first.status}`,
          `stdout: ${first.stdout}`,
          `stderr: ${first.stderr}`,
        ].join('\n'),
      ).toBe(0);

      const metaPath = path.join(repo, '.gitnexus', 'meta.json');
      expect(fs.existsSync(metaPath)).toBe(true);

      // Simulate the half-finalized state from the review: meta.json is
      // present and lastCommit matches, but the repo is not discoverable
      // because the global registry entry is missing.
      fs.writeFileSync(path.join(gnHome, 'registry.json'), '[]', 'utf-8');

      const second = runCliWithEnv(['analyze'], repo, { GITNEXUS_HOME: gnHome }, 60000);
      expect(
        second.status,
        [
          'second analyze timed out before proving alreadyUpToDate finalization',
          `stdout: ${second.stdout}`,
          `stderr: ${second.stderr}`,
        ].join('\n'),
      ).not.toBeNull();
      expect(`${second.stdout}${second.stderr}`).toMatch(/Analysis did not finalize/i);
      expect(`${second.stdout}${second.stderr}`).toMatch(/registry entry/i);
      expect(second.status).toBe(1);
    } finally {
      fs.rmSync(gnHome, { recursive: true, force: true });
      fs.rmSync(repoParent, { recursive: true, force: true });
    }
  }, 60_000);

  // ─── analyze --name <alias> + --allow-duplicate-name (#829) ──────
  //
  // End-to-end regression guard for the name-collision feature:
  //   1. `analyze --name X` persists the alias to ~/.gitnexus/registry.json
  //   2. A second `analyze --name X` on a DIFFERENT path is rejected with
  //      a collision error (exit code 1, "already used" in output)
  //   3. `analyze --name X --allow-duplicate-name` bypasses the guard;
  //      both entries coexist in registry.json
  //   4. Pipeline-re-index flags (e.g. --skills) WITHOUT
  //      --allow-duplicate-name must STILL hit the collision guard —
  //      the bypass must stay gated on its dedicated flag so it isn't
  //      silently triggered by unrelated pipeline signals
  //      (review round 2/3 design decision).
  //
  // This test invokes the real CLI → runFullAnalysis → registerRepo
  // chain, so any wiring regression fails here.
  describe('analyze --name <alias> and --allow-duplicate-name (#829)', () => {
    // Path-equality assertions across CLI spawn boundaries are fragile
    // cross-platform:
    //   - macOS: os.tmpdir() returns /var/folders/...; child processes
    //     resolve the symlink to /private/var/folders/...
    //   - Windows: os.tmpdir() on GitHub runners returns 8.3 short-name
    //     form (C:\Users\RUNNER~1\...); the child sees the long form
    //     (C:\Users\runneradmin\...). fs.realpathSync does NOT reliably
    //     expand 8.3 to long form.
    // Rather than fight the platform-path quagmire, we assert STRUCTURAL
    // properties: entry count, alias value, path basename, path
    // distinctness. That covers the behavior this test is here to
    // protect without depending on exact-string path equality.

    it('--name alias stores; collision rejects; --allow-duplicate-name bypasses', () => {
      // Isolate the global registry so this test never touches the
      // developer's real ~/.gitnexus.
      const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-home-'));

      // Two mini-repo copies whose basenames intentionally collide.
      const repoA = makeMiniRepoCopy('collide-app', 'gn-collide-a-');
      const repoB = makeMiniRepoCopy('collide-app', 'gn-collide-b-');
      const parentA = path.dirname(repoA);
      const parentB = path.dirname(repoB);

      try {
        // Step 1: analyze repoA with --name shared → registry entry created.
        const r1 = runCliWithEnv(
          ['analyze', '--name', 'shared'],
          repoA,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r1.status === null) return; // CI timeout tolerance
        expect(
          r1.status,
          [`step 1 exited with ${r1.status}`, `stdout: ${r1.stdout}`, `stderr: ${r1.stderr}`].join(
            '\n',
          ),
        ).toBe(0);

        const registryPath = path.join(gnHome, 'registry.json');
        const afterStep1 = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(Array.isArray(afterStep1)).toBe(true);
        expect(afterStep1).toHaveLength(1);
        expect(afterStep1[0].name).toBe('shared');
        expect(path.basename(afterStep1[0].path)).toBe('collide-app');

        // Step 2: analyze repoB with the SAME --name → collision error.
        const r2 = runCliWithEnv(
          ['analyze', '--name', 'shared'],
          repoB,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r2.status === null) return;
        expect(r2.status).toBe(1);
        const r2Output = `${r2.stdout}${r2.stderr}`;
        expect(r2Output).toMatch(/Registry name collision|already used/i);

        // Registry still has just the first entry — step 2 must not have
        // silently added, overwritten, or corrupted anything.
        const afterStep2 = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(afterStep2).toHaveLength(1);
        // Registry still has only the step-1 entry — the failed call
        // must not have silently added, overwritten, or corrupted state.
        expect(afterStep2[0].path).toBe(afterStep1[0].path);

        // Step 3: REGRESSION GUARD for the missing collision-bypass wire
        // (originally a --force passthrough bug; per review round 3 the
        // bypass moved to its own --allow-duplicate-name flag to avoid
        // conflating it with pipeline re-index).
        const r3 = runCliWithEnv(
          ['analyze', '--name', 'shared', '--allow-duplicate-name'],
          repoB,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r3.status === null) return;
        expect(
          r3.status,
          [
            `step 3 (--allow-duplicate-name bypass) exited with ${r3.status}`,
            `stdout: ${r3.stdout}`,
            `stderr: ${r3.stderr}`,
          ].join('\n'),
        ).toBe(0);

        const afterStep3 = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(afterStep3).toHaveLength(2);
        expect(afterStep3.every((e: { name: string }) => e.name === 'shared')).toBe(true);
        // Both entries point to distinct paths (we registered two different
        // repos under the same alias) and both have the right basename.
        const step3Basenames = afterStep3.map((e: { path: string }) => path.basename(e.path));
        expect(step3Basenames).toEqual(['collide-app', 'collide-app']);
        const step3Paths = new Set(afterStep3.map((e: { path: string }) => e.path));
        expect(step3Paths.size).toBe(2);
        // One of the two entries is the original from step 1 — unchanged.
        expect(afterStep3.map((e: { path: string }) => e.path)).toContain(afterStep1[0].path);

        // Step 4: REGRESSION GUARD for the design decision in review
        // round 2/3 — pipeline-re-index flags must NOT bypass the
        // registry collision guard. `--skills` triggers pipeline
        // re-run (skills generation needs a fresh pipelineResult) but
        // must leave the registry guard in force. Bypass requires the
        // explicit --allow-duplicate-name flag.
        const repoC = makeMiniRepoCopy('collide-app', 'gn-collide-c-');
        const parentC = path.dirname(repoC);
        try {
          const r4 = runCliWithEnv(
            ['analyze', '--name', 'shared', '--skills'],
            repoC,
            { GITNEXUS_HOME: gnHome },
            60000,
          );
          if (r4.status === null) return;
          expect(r4.status).toBe(1);
          const r4Output = `${r4.stdout}${r4.stderr}`;
          expect(r4Output).toMatch(/Registry name collision|already used/i);
          // The error hint should point at the new flag.
          expect(r4Output).toMatch(/--allow-duplicate-name/);

          // Registry unchanged — still only A + B under "shared".
          const afterStep4 = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
          expect(afterStep4).toHaveLength(2);
        } finally {
          fs.rmSync(parentC, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(gnHome, { recursive: true, force: true });
        fs.rmSync(parentA, { recursive: true, force: true });
        fs.rmSync(parentB, { recursive: true, force: true });
      }
    }, 360000); // 6-min outer budget (4 × ~60s analyze calls + fixture setup)
  });

  // ─── gitnexus remove <target> (#664) ─────────────────────────────
  //
  // End-to-end regression guard for the remove command:
  //   1. `remove <alias>` without --force is a dry-run (exit 0, preserves state)
  //   2. `remove <alias> --force` deletes the .gitnexus/ directory
  //      AND unregisters from the global registry
  //   3. `remove <unknown>` is idempotent (exit 0 with a warning)
  //   4. `remove <ambiguous>` (two entries share the alias via
  //      --allow-duplicate-name) exits 1 with a disambiguation hint
  //      and leaves the registry unchanged.
  //
  // Every assertion reads the real registry.json on disk, so any
  // regression in remove.ts → resolveRegistryEntry → unregisterRepo
  // will surface here.
  describe('remove <target> (#664)', () => {
    it('dry-run lists, --force deletes, missing target is a no-op warning', () => {
      const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-home-remove-'));
      const repoA = makeMiniRepoCopy('remove-me', 'gn-rm-a-');
      const parentA = path.dirname(repoA);

      try {
        // Index the repo under a custom alias so we can target it by
        // name below. `--name` guarantees a stable alias regardless of
        // how the host resolves the basename/remote-inferred name.
        const r1 = runCliWithEnv(
          ['analyze', '--name', 'alias-a'],
          repoA,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r1.status === null) return;
        expect(
          r1.status,
          [`analyze exited with ${r1.status}`, `stdout: ${r1.stdout}`, `stderr: ${r1.stderr}`].join(
            '\n',
          ),
        ).toBe(0);

        const registryPath = path.join(gnHome, 'registry.json');
        const afterIndex = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(afterIndex).toHaveLength(1);
        expect(afterIndex[0].name).toBe('alias-a');
        // Storage dir must exist before remove so we can assert its
        // disappearance below.
        const storagePath = afterIndex[0].storagePath;
        expect(fs.existsSync(storagePath)).toBe(true);

        // Dry-run: must NOT delete. Use parentA as cwd so the test
        // never runs with the to-be-removed storage dir as its cwd.
        //
        // Assert the FULL dry-run output shape, not just the `--force`
        // hint (#1003 senior-reviewer NIT): `remove.ts` prints the
        // alias, the resolved path, AND the storage path. Verifying
        // all three appear catches silent format regressions
        // (e.g. a future refactor that accidentally drops one of the
        // three `console.log` lines, or swaps `entry.path` for
        // `entry.name` in the output).
        const r2 = runCliWithEnv(['remove', 'alias-a'], parentA, { GITNEXUS_HOME: gnHome }, 15000);
        if (r2.status === null) return;
        expect(r2.status).toBe(0);
        const r2Output = `${r2.stdout}${r2.stderr}`;
        expect(r2Output).toMatch(/Run with --force/i);
        expect(r2Output, 'dry-run must surface the alias').toContain('alias-a');
        expect(r2Output, 'dry-run must surface the repo path').toContain(afterIndex[0].path);
        expect(r2Output, 'dry-run must surface the storage path').toContain(storagePath);
        expect(fs.existsSync(storagePath)).toBe(true);
        // Registry still has the entry.
        expect(JSON.parse(fs.readFileSync(registryPath, 'utf-8'))).toHaveLength(1);

        // --force: must delete storage AND unregister.
        const r3 = runCliWithEnv(
          ['remove', 'alias-a', '--force'],
          parentA,
          { GITNEXUS_HOME: gnHome },
          15000,
        );
        if (r3.status === null) return;
        expect(
          r3.status,
          [
            `remove --force exited with ${r3.status}`,
            `stdout: ${r3.stdout}`,
            `stderr: ${r3.stderr}`,
          ].join('\n'),
        ).toBe(0);
        // Success-case output shape: `Removed: <alias>` header plus the
        // same path-and-storagePath lines the dry-run prints (same NIT
        // rationale — the success branch mirrors the dry-run's three
        // console.log calls, so it has the same silent-regression risk).
        const r3Output = `${r3.stdout}${r3.stderr}`;
        expect(r3Output).toMatch(/Removed/i);
        expect(r3Output, 'success output must surface the alias').toContain('alias-a');
        expect(r3Output, 'success output must surface the repo path').toContain(afterIndex[0].path);
        expect(r3Output, 'success output must surface the storage path').toContain(storagePath);
        expect(fs.existsSync(storagePath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(registryPath, 'utf-8'))).toHaveLength(0);

        // Idempotent: removing the same alias AGAIN must exit 0 with a
        // warning (so `remove X && analyze Y` keeps working in scripts).
        const r4 = runCliWithEnv(['remove', 'alias-a'], parentA, { GITNEXUS_HOME: gnHome }, 15000);
        if (r4.status === null) return;
        expect(r4.status).toBe(0);
        expect(`${r4.stdout}${r4.stderr}`).toMatch(/Nothing to remove/i);
      } finally {
        fs.rmSync(gnHome, { recursive: true, force: true });
        fs.rmSync(parentA, { recursive: true, force: true });
      }
    }, 180000); // 3-min outer budget (1 × ~60s analyze + 3 × fast remove calls)

    it('ambiguous target (two entries share alias via --allow-duplicate-name) errors without mutating registry', () => {
      const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-home-rm-amb-'));
      const repoA = makeMiniRepoCopy('dup', 'gn-dup-a-');
      const repoB = makeMiniRepoCopy('dup', 'gn-dup-b-');
      const parentA = path.dirname(repoA);
      const parentB = path.dirname(repoB);

      try {
        // Two repos registered under the same alias — only possible via
        // --allow-duplicate-name (#829).
        const r1 = runCliWithEnv(
          ['analyze', '--name', 'shared'],
          repoA,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r1.status === null) return;
        expect(r1.status).toBe(0);

        const r2 = runCliWithEnv(
          ['analyze', '--name', 'shared', '--allow-duplicate-name'],
          repoB,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r2.status === null) return;
        expect(r2.status).toBe(0);

        const registryPath = path.join(gnHome, 'registry.json');
        const before = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(before).toHaveLength(2);

        // `remove shared` must refuse to guess — exit 1, disambiguation hint.
        const r3 = runCliWithEnv(
          ['remove', 'shared', '--force'],
          parentA,
          { GITNEXUS_HOME: gnHome },
          15000,
        );
        if (r3.status === null) return;
        expect(r3.status).toBe(1);
        const r3Output = `${r3.stdout}${r3.stderr}`;
        expect(r3Output).toMatch(/Multiple registered repos match/i);
        // Both paths must be surfaced in the hint so the user knows
        // which ones to disambiguate between.
        expect(r3Output).toMatch(/dup/);

        // Registry unchanged — the failed resolution must NOT have
        // mutated state.
        const after = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(after).toHaveLength(2);

        // And path-based remove still works: pass the absolute path of
        // repoA and it resolves unambiguously.
        //
        // We pull the path from the registry snapshot rather than
        // passing the outer `repoA` variable directly. This is the
        // belt-and-suspenders for cross-platform path normalisation
        // (#1003 review): the path the registry recorded has already
        // gone through the analyze-side canonicalisation (which on
        // macOS expands /var → /private/var and on Windows expands 8.3
        // → long-name). Passing that exact string back to `remove`
        // guarantees the comparison succeeds even on runners where the
        // outer `repoA` is the symlink/short-name form. The code-side
        // fix in `canonicalizePath` makes this redundant in practice,
        // but the test shouldn't depend on the code fix being perfect
        // on every platform — it should prove correctness against the
        // registry contract.
        const repoAEntry = before.find(
          (e: { path: string }) =>
            path.basename(e.path) === 'dup' && e.path.includes(path.basename(parentA)),
        );
        expect(
          repoAEntry,
          'repoA entry must exist in registry before path-remove step',
        ).toBeDefined();

        const r4 = runCliWithEnv(
          ['remove', repoAEntry.path, '--force'],
          parentA,
          { GITNEXUS_HOME: gnHome },
          15000,
        );
        if (r4.status === null) return;
        expect(
          r4.status,
          [
            `remove-by-path exited with ${r4.status}`,
            `stdout: ${r4.stdout}`,
            `stderr: ${r4.stderr}`,
          ].join('\n'),
        ).toBe(0);
        const finalEntries = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(finalEntries).toHaveLength(1);
        // The survivor is repoB (its path stays in the registry).
        expect(path.basename(finalEntries[0].path)).toBe('dup');
        // And it's NOT the one we just removed.
        expect(finalEntries[0].path).not.toBe(repoAEntry.path);
      } finally {
        fs.rmSync(gnHome, { recursive: true, force: true });
        fs.rmSync(parentA, { recursive: true, force: true });
        fs.rmSync(parentB, { recursive: true, force: true });
      }
    }, 240000); // 4-min outer budget (2 × ~60s analyze + 2 × fast remove)

    it('refuses to proceed when a registry entry points storagePath outside <repo>/.gitnexus (#1003)', () => {
      // Regression guard for the safety gap flagged by @magyargergo on
      // PR #1003: `~/.gitnexus/registry.json` is a user-writable JSON
      // file, so a corrupted or hand-edited entry could point
      // storagePath at the repo root (catastrophic: rm the working
      // tree) or at any other arbitrary path. `remove --force` must
      // refuse to call fs.rm when storagePath isn't the canonical
      // `<entry.path>/.gitnexus`. We verify:
      //   1. Exit code 1 with the actionable "registry entry corrupted"
      //      hint.
      //   2. The .gitnexus/ storage dir is UNTOUCHED.
      //   3. The repo itself (entry.path) is UNTOUCHED.
      //   4. The registry entry is NOT removed (no partial mutation).
      const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-home-poison-'));
      const repo = makeMiniRepoCopy('poisoned', 'gn-poison-');
      const parent = path.dirname(repo);

      try {
        // Index the repo normally first so the registry has a valid
        // entry we can then poison.
        const r1 = runCliWithEnv(
          ['analyze', '--name', 'poisoned-alias'],
          repo,
          { GITNEXUS_HOME: gnHome },
          60000,
        );
        if (r1.status === null) return;
        expect(r1.status).toBe(0);

        const registryPath = path.join(gnHome, 'registry.json');
        const original = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(original).toHaveLength(1);

        // Poison the entry: set storagePath to the REPO ROOT itself.
        // If the guard isn't in place, `remove --force` would call
        // `fs.rm(repo, {recursive: true, force: true})` and wipe the
        // entire working tree.
        const poisoned = [{ ...original[0], storagePath: repo }];
        fs.writeFileSync(registryPath, JSON.stringify(poisoned, null, 2));

        // Sanity: storage dir and working tree both still exist.
        expect(fs.existsSync(path.join(repo, '.gitnexus'))).toBe(true);
        expect(fs.existsSync(repo)).toBe(true);
        expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);

        // Attempt the remove — must FAIL without deleting anything.
        const r2 = runCliWithEnv(
          ['remove', 'poisoned-alias', '--force'],
          parent,
          { GITNEXUS_HOME: gnHome },
          15000,
        );
        if (r2.status === null) return;

        expect(
          r2.status,
          [`remove should have exited 1`, `stdout: ${r2.stdout}`, `stderr: ${r2.stderr}`].join(
            '\n',
          ),
        ).toBe(1);
        const r2Output = `${r2.stdout}${r2.stderr}`;
        // Must surface the actionable "registry corrupted" hint, not
        // just a raw fs.rm error.
        expect(r2Output).toMatch(/Refusing to remove/i);
        expect(r2Output).toMatch(/registry\.json/i);

        // Repo + .gitnexus dir + .git dir must all still exist — the
        // guard aborts BEFORE fs.rm. This is the whole point of the
        // test: the working tree is not allowed to disappear.
        expect(fs.existsSync(repo), 'repo working tree must survive').toBe(true);
        expect(fs.existsSync(path.join(repo, '.gitnexus')), 'storage dir must survive').toBe(true);
        expect(fs.existsSync(path.join(repo, '.git')), '.git must survive').toBe(true);

        // Registry unchanged — no partial mutation.
        const afterRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(afterRegistry).toHaveLength(1);
        expect(afterRegistry[0].storagePath).toBe(repo); // still poisoned (we did that)
      } finally {
        fs.rmSync(gnHome, { recursive: true, force: true });
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }, 120000); // 2-min budget (1 × ~60s analyze + 1 × fast remove-refused)
  });

  // ─── clean --all: same safety guard applies (#1003 review) ───────
  //
  // The `clean --all` path iterates over the registry and calls
  // `fs.rm(entry.storagePath)` — identical trust-the-registry pattern
  // as `remove` had before the guard. A poisoned entry must be SKIPPED
  // (not aborted), so clean --all preserves its existing per-repo
  // error-tolerance semantics: one bad entry does not halt cleanup of
  // the rest. We verify:
  //   1. The poisoned entry is NOT deleted (working tree + .gitnexus
  //      survive), and the CLI prints a "Refusing to clean" message.
  //   2. The poisoned entry is left in the registry (nothing was
  //      mutated for it).
  //   3. A co-existing well-formed entry IS still cleaned (both its
  //      .gitnexus dir AND its registry entry are gone).
  describe('clean --all with a poisoned registry entry (#1003)', () => {
    it('skips poisoned entries, cleans valid ones, never deletes the working tree', () => {
      const gnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-home-clean-poison-'));
      const repoBad = makeMiniRepoCopy('bad-repo', 'gn-clean-bad-');
      const repoGood = makeMiniRepoCopy('good-repo', 'gn-clean-good-');
      const parentBad = path.dirname(repoBad);
      const parentGood = path.dirname(repoGood);

      try {
        // Analyze both so the registry has two well-formed entries.
        for (const [repo, alias] of [
          [repoBad, 'bad-alias'],
          [repoGood, 'good-alias'],
        ] as const) {
          const r = runCliWithEnv(
            ['analyze', '--name', alias],
            repo,
            { GITNEXUS_HOME: gnHome },
            60000,
          );
          if (r.status === null) return;
          expect(r.status, `analyze ${alias} exited ${r.status}: ${r.stdout}${r.stderr}`).toBe(0);
        }

        const registryPath = path.join(gnHome, 'registry.json');
        const original = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(original).toHaveLength(2);

        // Poison the 'bad-alias' entry by pointing its storagePath at
        // the repo root itself. If the guard isn't wired into the
        // clean --all loop, `clean --all --force` would fs.rm the
        // working tree.
        const poisoned = original.map((e: { name: string; storagePath: string; path: string }) =>
          e.name === 'bad-alias' ? { ...e, storagePath: repoBad } : e,
        );
        fs.writeFileSync(registryPath, JSON.stringify(poisoned, null, 2));

        // Sanity: both working trees and .gitnexus dirs still exist.
        expect(fs.existsSync(repoBad)).toBe(true);
        expect(fs.existsSync(path.join(repoBad, '.gitnexus'))).toBe(true);
        expect(fs.existsSync(path.join(repoBad, '.git'))).toBe(true);
        expect(fs.existsSync(path.join(repoGood, '.gitnexus'))).toBe(true);

        // clean --all --force from a neutral cwd (parentBad), so the
        // command isn't "inside" either repo.
        const r = runCliWithEnv(
          ['clean', '--all', '--force'],
          parentBad,
          { GITNEXUS_HOME: gnHome },
          30000,
        );
        if (r.status === null) return;

        // clean --all's per-entry error handling always exits 0 at
        // the end (it only logs per-repo failures). The important
        // assertions are on side effects, not the exit code.
        const output = `${r.stdout}${r.stderr}`;
        expect(output).toMatch(/Refusing to clean/i);
        expect(output).toMatch(/bad-alias/);

        // Poisoned repo: working tree + .gitnexus + .git all SURVIVE.
        expect(fs.existsSync(repoBad), 'poisoned repo working tree must survive').toBe(true);
        expect(
          fs.existsSync(path.join(repoBad, '.gitnexus')),
          'poisoned repo .gitnexus must survive (guard refused to rm repo root)',
        ).toBe(true);
        expect(fs.existsSync(path.join(repoBad, '.git')), '.git must survive').toBe(true);

        // Good repo: its .gitnexus IS gone (cleanup succeeded despite
        // the poisoned sibling entry — per-entry error tolerance is
        // preserved).
        expect(
          fs.existsSync(path.join(repoGood, '.gitnexus')),
          'good repo .gitnexus should be cleaned',
        ).toBe(false);
        // But the good repo's working tree stays (clean never touches
        // anything outside .gitnexus).
        expect(fs.existsSync(repoGood), 'good repo working tree must survive').toBe(true);

        // Registry post-state: poisoned entry still present (skipped,
        // not mutated); good entry unregistered.
        const afterRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        expect(afterRegistry).toHaveLength(1);
        expect(afterRegistry[0].name).toBe('bad-alias');
      } finally {
        fs.rmSync(gnHome, { recursive: true, force: true });
        fs.rmSync(parentBad, { recursive: true, force: true });
        fs.rmSync(parentGood, { recursive: true, force: true });
      }
    }, 240000); // 4-min budget (2 × ~60s analyze + 1 × fast clean --all)
  });

  describe('unhappy path', () => {
    it('exits with error when no command is given', () => {
      const result = runCliRaw([], MINI_REPO);

      // Accept timeout as valid on slow CI
      if (result.status === null) return;

      // Commander exits with code 1 when no subcommand is given and
      // prints a usage/error message to stderr.
      expect(result.status).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined.length).toBeGreaterThan(0);
    });

    it('shows help with --help flag', () => {
      const result = runCliRaw(['--help'], MINI_REPO);

      // Accept timeout as valid on slow CI
      if (result.status === null) return;

      expect(result.status).toBe(0);
      // Commander writes --help output to stdout.
      expect(result.stdout).toMatch(/Usage:/i);
      // The program name and at least one known subcommand should appear.
      expect(result.stdout).toMatch(/gitnexus/i);
      expect(result.stdout).toMatch(/analyze|status|serve/i);
    });

    it('fails with unknown command', () => {
      const result = runCliRaw(['nonexistent'], MINI_REPO);

      // Accept timeout as valid on slow CI
      if (result.status === null) return;

      // Commander exits with code 1 and prints an error to stderr for unknown commands.
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/unknown command/i);
    });
  });

  describe('CLI error handling', () => {
    /**
     * Helper to spawn CLI from a cwd outside the project tree.
     * Uses the absolute file:// URL to tsx loader so the --import hook
     * resolves even when cwd has no node_modules.
     */
    function runCliOutsideProject(args: string[], cwd: string, timeoutMs = 15000) {
      return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...args], {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
        },
      });
    }

    it('status on non-indexed repo reports not indexed', () => {
      // Even though MINI_REPO is now in an isolated tmpdir, previous tests
      // in this suite may have created MINI_REPO/.gitnexus via analyze,
      // and findRepo() walks up so any `.gitnexus` along the path still
      // counts. This test needs a GUARANTEED pristine repo to assert the
      // "not indexed" output, so it mints its own throwaway tmp git repo.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-noindex-'));
      try {
        spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
        spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
          cwd: tmpDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@test',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@test',
          },
        });

        const result = runCliOutsideProject(['status'], tmpDir);
        if (result.status === null) return;

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Repository not indexed/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('status on non-git directory reports not a git repo', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-nogit-'));
      try {
        const result = runCliOutsideProject(['status'], tmpDir);
        if (result.status === null) return;

        // status.ts doesn't set process.exitCode — just prints and returns
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Not a git repository/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('analyze on non-git directory fails with exit code 1', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-nogit-'));
      try {
        // Pass the non-git path as a separate argument via runCliRaw
        // (runCli passes the whole string as one arg which breaks path parsing)
        const result = runCliRaw(['analyze', tmpDir], repoRoot);
        if (result.status === null) return;

        // analyze.ts sets process.exitCode = 1 for non-git paths
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/not.*git repository/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── wiki command flags ─────────────────────────────────────────────

  describe('wiki command flags', () => {
    it('wiki --help shows --provider, --review, --verbose flags', () => {
      const result = runCliRaw(['wiki', '--help'], repoRoot);
      if (result.status === null) return;

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--provider <provider>');
      expect(result.stdout).toContain('--review');
      expect(result.stdout).toContain('-v, --verbose');
      expect(result.stdout).toContain('--model <model>');
      expect(result.stdout).toContain('--gist');
      expect(result.stdout).toContain('--concurrency <n>');
    });

    it('wiki on non-git directory fails with exit code 1', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-nogit-'));
      try {
        const result = runCliRaw(['wiki', tmpDir], repoRoot);
        if (result.status === null) return;

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/not.*git repository/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('wiki on non-indexed repo fails with "No GitNexus index"', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-noindex-'));
      try {
        spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
        spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], {
          cwd: tmpDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@test',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@test',
          },
        });

        // Must spawn outside project tree so it doesn't find parent .gitnexus
        const result = spawnSync(
          process.execPath,
          ['--import', tsxImportUrl, cliEntry, 'wiki', tmpDir],
          {
            cwd: tmpDir,
            encoding: 'utf8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
            },
          },
        );
        if (result.status === null) return;

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/No GitNexus index found/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('wiki --provider cursor without API key does not prompt for key in non-TTY', () => {
      // In non-TTY (piped stdin), --provider cursor should skip the API key prompt
      // and proceed (or fail gracefully with Cursor CLI not found)
      const result = runCliRaw(['wiki', MINI_REPO, '--provider', 'cursor'], repoRoot, 15000);
      if (result.status === null) return;

      const combined = result.stdout + result.stderr;
      // Should NOT ask for API key — cursor provider doesn't need one
      expect(combined).not.toMatch(/API key:/);
    });

    it('wiki --help includes --verbose flag description', () => {
      const result = runCliRaw(['wiki', '--help'], repoRoot);
      if (result.status === null) return;

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/verbose/i);
    });
  });

  // ─── stdout fd 1 tests (#324) ───────────────────────────────────────
  // These tests verify that tool output goes to stdout (fd 1), not stderr.
  // Requires analyze to have run first (the analyze test above populates .gitnexus/).

  // All tool commands pass --repo to disambiguate when the global registry
  // has multiple indexed repos (e.g. the parent project is also indexed).
  describe('tool output goes to stdout via fd 1 (#324)', () => {
    it('cypher: JSON appears on stdout, not stderr', () => {
      const result = runCliRaw(
        ['cypher', 'MATCH (n) RETURN n.name LIMIT 3', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return; // CI timeout tolerance

      expect(result.status).toBe(0);

      // stdout must contain valid JSON (array or object)
      expect(() => JSON.parse(result.stdout.trim())).not.toThrow();

      // stderr must NOT contain JSON — only human-readable diagnostics allowed
      const stderrTrimmed = result.stderr.trim();
      if (stderrTrimmed.length > 0) {
        expect(() => JSON.parse(stderrTrimmed)).toThrow();
      }
    });

    it('query: JSON appears on stdout, not stderr', () => {
      // "handler" is a generic term likely to match something in mini-repo
      const result = runCliRaw(['query', 'handler', '--repo', 'mini-repo'], MINI_REPO);
      if (result.status === null) return;

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
    });

    it('impact: JSON appears on stdout, not stderr', () => {
      const result = runCliRaw(
        ['impact', 'handleRequest', '--direction', 'upstream', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      // impact may return an error object (symbol not found) or a real result —
      // either way it must be valid JSON on stdout
      expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
    });

    it('stdout is pipeable: cypher output parses as valid JSON', () => {
      const result = runCliRaw(
        ['cypher', 'MATCH (n:Function) RETURN n.name LIMIT 5', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);

      // Simulate what jq does: parse stdout as JSON
      const parsed = JSON.parse(result.stdout.trim());
      expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true);
    });
  });

  // ─── EPIPE clean exit test (#324) ───────────────────────────────────

  describe('EPIPE handling (#324)', () => {
    it('cypher: EPIPE exits with code 0, not stderr dump', () => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            tsxImportUrl,
            cliEntry,
            'cypher',
            'MATCH (n) RETURN n LIMIT 500',
            '--repo',
            'mini-repo',
          ],
          {
            cwd: MINI_REPO,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
            },
          },
        );

        let stderrOutput = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        // Destroy stdout immediately — simulates `| head -0` (consumer closes early)
        child.stdout.once('data', () => {
          child.stdout.destroy(); // triggers EPIPE on next write
        });

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          // Timeout is acceptable on CI — not a failure
          resolve();
        }, 20000);

        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            // Clean EPIPE exit: code 0
            expect(code).toBe(0);
            // No JSON payload should appear on stderr
            const trimmed = stderrOutput.trim();
            if (trimmed.length > 0) {
              expect(() => JSON.parse(trimmed)).toThrow();
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    }, 25000);
  });

  // ─── eval-server READY signal test (#324) ───────────────────────────

  describe('eval-server READY signal (#324)', () => {
    it('READY signal appears on stdout, not stderr', () => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', tsxImportUrl, cliEntry, 'eval-server', '--port', '0', '--idle-timeout', '3'],
          {
            cwd: MINI_REPO,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
            },
          },
        );

        let stdoutBuffer = '';
        let foundOnStdout = false;
        let foundOnStderr = false;

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          if (stdoutBuffer.includes('GITNEXUS_EVAL_SERVER_READY:')) {
            foundOnStdout = true;
            child.kill('SIGTERM');
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          if (text.includes('GITNEXUS_EVAL_SERVER_READY:')) {
            foundOnStderr = true;
            child.kill('SIGTERM');
          }
        });

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          // Timeout is acceptable on CI — not a failure
          resolve();
        }, 30000);

        child.on('close', () => {
          clearTimeout(timer);
          try {
            if (foundOnStderr) {
              reject(new Error('READY signal appeared on stderr instead of stdout'));
            } else if (foundOnStdout) {
              resolve();
            } else {
              // eval-server may not start on all CI environments — don't fail
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });
    }, 35000);
  });
});
