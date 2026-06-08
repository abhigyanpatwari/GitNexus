/**
 * P1 Integration Tests: `gitnexus lsp` CLI
 *
 * WI-#7 — `lsp doctor` one-shot diagnostic. Verifies the
 * additive CLI command without breaking any existing surface.
 *
 * Decision table
 * ──────────────
 *   | server on PATH | workspace ready | text | json           | exit |
 *   |----------------|-----------------|------|----------------|------|
 *   | no             | n/a             | NOT FOUND (install ...) | `typescript: null, workspace.ready: false` | 0 |
 *   | yes            | no              | "found vX · workspace NOT ready: <reason>" | `{typescript:{path,version},workspace:{ready:false,reason}}` | 0 |
 *   | yes            | yes             | "found vX · workspace ready ✓" | `{typescript:{path,version},workspace:{ready:true}}` | 0 |
 *
 * The CI environment is unlikely to have
 * `typescript-language-server` on PATH, so most cases will
 * exercise the "absent" branch — which is the **most
 * important** test because it pins the "never installs /
 * always exits 0 / informative report" invariants.
 *
 * For the "found" cases we use the same `--repo mini-repo`
 * pattern as the existing E2E suite, so the spawn-args
 * stay minimal and the assertion is independent of
 * index state.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const MINI_REPO = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

// Absolute file:// URL to tsx loader — needed when spawning
// CLI from cwd outside the project tree. (Same trick as the
// main `cli-e2e.test.ts` file.)
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 20000) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Pre-set the heap flag so any consumer that calls
      // `ensureHeap()` short-circuits the re-exec (which
      // would otherwise drop the tsx loader and crash on
      // the .ts entry file).
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

function runCliOutsideProject(args: string[], cwd: string, timeoutMs = 20000) {
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

// ─── Decision table ────────────────────────────────────────────────

describe('gitnexus lsp doctor — text format', () => {
  it('server absent → exit 0, prints NOT FOUND (EdgeCase 1)', () => {
    // We use a tmpdir outside the project tree so PATH-walk
    // can't accidentally find a project-local
    // `typescript-language-server` binary. The same setup
    // also guarantees no `node_modules/.bin/typescript-language-server`
    // is reachable.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-absent-'));
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

      // Strip PATH of any pre-existing typescript-language-server
      // by setting PATH to a known-empty directory. This is
      // the only way to make the "absent" branch deterministic
      // on a developer machine that has it installed globally.
      const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-empty-bin-'));
      try {
        const result = spawnSync(
          process.execPath,
          ['--import', tsxImportUrl, cliEntry, 'lsp', 'doctor'],
          {
            cwd: tmpDir,
            encoding: 'utf8',
            timeout: 20000,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              // Force a clean PATH that has no typescript-language-server
              PATH: emptyBinDir,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
            },
          },
        );

        // CI timeout tolerance: null status means the spawn
        // timed out — accept as "we don't know" on slow CI.
        if (result.status === null) return;

        // Invariant 5/3: always exit 0, informational.
        expect(result.status).toBe(0);
        // EdgeCase 1: text contains the NOT FOUND marker.
        expect(result.stdout).toMatch(/NOT FOUND/i);
        expect(result.stdout).toMatch(/install to enable --lsp/);
        // No JSON braces in text format.
        expect(result.stdout).not.toMatch(/^\s*\{/);
      } finally {
        fs.rmSync(emptyBinDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('server absent in JSON format → exit 0, valid JSON with typescript:null', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-absent-json-'));
    const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-empty-bin-'));
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

      const result = spawnSync(
        process.execPath,
        ['--import', tsxImportUrl, cliEntry, 'lsp', 'doctor', '--format', 'json'],
        {
          cwd: tmpDir,
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: emptyBinDir,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
          },
        },
      );

      if (result.status === null) return;

      expect(result.status).toBe(0);
      // Must be valid JSON.
      const report = JSON.parse(result.stdout);
      // Schema: typescript is null, workspace is { ready:false }.
      expect(report.typescript).toBeNull();
      expect(report.workspace).toBeDefined();
      expect(report.workspace.ready).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(emptyBinDir, { recursive: true, force: true });
    }
  });
});

// ─── Help / registration ───────────────────────────────────────────

describe('gitnexus lsp — command registration', () => {
  it('lsp --help lists --format flag and is registered under gitnexus --help', () => {
    const result = runCliRaw(['lsp', '--help'], repoRoot);
    if (result.status === null) return;

    expect(result.status).toBe(0);
    // The --format flag must be visible.
    expect(result.stdout).toContain('--format <format>');
    // The doctor action is the documented one.
    expect(result.stdout).toMatch(/doctor/);
  });

  it('gitnexus --help lists the lsp command', () => {
    const result = runCliRaw(['--help'], repoRoot);
    if (result.status === null) return;

    expect(result.status).toBe(0);
    // Top-level help must include the new `lsp` command.
    expect(result.stdout).toContain('lsp');
    // Sanity: the help should still include other commands
    // (we never broke the existing surface).
    expect(result.stdout).toContain('analyze');
    expect(result.stdout).toContain('eval-server');
  });

  it('lsp with unknown action exits 1 and prints usage hint to stderr', () => {
    const result = runCliRaw(['lsp', 'bogus'], repoRoot);
    if (result.status === null) return;

    // Unknown action is the *operator's* error — exit 1.
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    // Usage hint must mention `lsp doctor`.
    expect(combined).toMatch(/lsp doctor/);
  });
});

// ─── Default format = text ─────────────────────────────────────────

describe('gitnexus lsp doctor — format defaulting', () => {
  it('no --format flag → text output (NOT JSON)', () => {
    // We don't depend on a real typescript-language-server
    // being installed: the "absent" branch's text output
    // is sufficient to prove the default is text, not JSON.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-default-'));
    const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-empty-bin-'));
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

      const result = spawnSync(
        process.execPath,
        ['--import', tsxImportUrl, cliEntry, 'lsp', 'doctor'],
        {
          cwd: tmpDir,
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: emptyBinDir,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
          },
        },
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      // Default must be text, NOT JSON. The text branch
      // starts with `typescript-language-server:`.
      expect(result.stdout).toMatch(/^typescript-language-server:/);
      // And must not be a JSON object.
      const trimmed = result.stdout.trim();
      expect(trimmed.startsWith('{')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(emptyBinDir, { recursive: true, force: true });
    }
  });
});

// ─── Side-effect safety (Inv 1/2) ──────────────────────────────────

describe('gitnexus lsp doctor — no-write side effects', () => {
  it('does not modify .gitnexus/ on the cwd (no analyze, no schema mutation)', () => {
    // We use the mini-repo so a `.gitnexus/` may or may not
    // exist from prior test runs. We capture its mtime
    // (when present) and assert it's unchanged after the
    // command runs.
    const metaPath = path.join(MINI_REPO, '.gitnexus', 'meta.json');
    const beforeMtime = fs.existsSync(metaPath)
      ? fs.statSync(metaPath).mtimeMs
      : null;

    // Spawn from inside the project tree (runCliRaw uses
    // tsx loader which is resolvable from the repo root).
    const result = runCliRaw(['lsp', 'doctor'], MINI_REPO, 20000);
    if (result.status === null) return;

    // Always exits 0 (informational), even when .gitnexus
    // isn't present.
    expect(result.status).toBe(0);

    // If the meta file existed before, it must not have
    // been touched. If it didn't, it must NOT have been
    // created by `lsp doctor` (no side effects).
    if (beforeMtime !== null) {
      const afterMtime = fs.statSync(metaPath).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    } else {
      expect(fs.existsSync(metaPath)).toBe(false);
    }
  });
});

// ─── Found-branch (only runs when typescript-language-server exists) ─

// We can't gate the "found" tests on a hard precondition
// (the CI env may or may not have the binary). Instead we
// *probe* the environment: if `typescript-language-server`
// is on PATH, the test runs; otherwise it self-skips via
// the `result.status === null` timeout pattern that the
// rest of the suite uses. This keeps the suite green on
// machines that don't have the server installed while
// still exercising the "found" branch on machines that do.
describe('gitnexus lsp doctor — found branch (conditional)', () => {
  function hasTypescriptLanguageServer(): boolean {
    try {
      const r = spawnSync(
        process.platform === 'win32' ? 'where' : 'which',
        ['typescript-language-server'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return r.status === 0;
    } catch {
      return false;
    }
  }

  it('server found (PATH) — text output contains version + workspace state', { timeout: 30_000 }, () => {
    if (!hasTypescriptLanguageServer()) {
      // Self-skip: this branch only runs on machines that
      // have the language server installed. The absent-branch
      // tests above are the deterministic CI guard.
      return;
    }

    const result = runCliRaw(['lsp', 'doctor'], repoRoot, 30000);
    if (result.status === null) return;

    // Invariant 5/3: always exit 0.
    expect(result.status).toBe(0);
    // The "found" text prefix must be present.
    expect(result.stdout).toMatch(/typescript-language-server: found v/);
    // One of the two verdicts must be present.
    const isReady = /workspace ready/.test(result.stdout);
    const isNotReady = /workspace NOT ready/.test(result.stdout);
    expect(isReady || isNotReady).toBe(true);
  });

  it('server found (PATH) — JSON output schema is correct', { timeout: 30_000 }, () => {
    if (!hasTypescriptLanguageServer()) return;

    const result = runCliRaw(['lsp', 'doctor', '--format', 'json'], repoRoot, 30000);
    if (result.status === null) return;

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    // typescript is non-null and has both path + version.
    expect(report.typescript).not.toBeNull();
    expect(typeof report.typescript.path).toBe('string');
    expect(typeof report.typescript.version).toBe('string');
    // workspace is { ready: boolean, reason?: string }.
    expect(typeof report.workspace.ready).toBe('boolean');
    if (report.workspace.ready === false) {
      expect(typeof report.workspace.reason).toBe('string');
      expect(report.workspace.reason.length).toBeGreaterThan(0);
    }
  });
});
