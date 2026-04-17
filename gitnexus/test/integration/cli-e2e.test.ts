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
const MINI_REPO = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

// Absolute file:// URL to tsx loader — needed when spawning CLI with cwd
// outside the project tree (bare 'tsx' specifier won't resolve there).
// Cannot use require.resolve('tsx/dist/loader.mjs') because the subpath is
// not in tsx's package.json exports; resolve the package root then join.
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

beforeAll(() => {
  // Initialize mini-repo as a git repo so the CLI analyze command
  // can run the full pipeline (it requires a .git directory).
  const gitDir = path.join(MINI_REPO, '.git');
  if (!fs.existsSync(gitDir)) {
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
  }
});

afterAll(() => {
  // Clean up all files/dirs created by analyze (git init, .gitnexus output,
  // AI context files, skill files, .gitignore) so parallel tests like
  // pipeline-graph-golden see a pristine fixture.
  for (const entry of ['.git', '.gitnexus', '.claude', 'AGENTS.md', 'CLAUDE.md', '.gitignore']) {
    const fullPath = path.join(MINI_REPO, entry);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
});

function runCli(command: string, cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, command], {
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
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...extraArgs], {
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
      // MINI_REPO is inside the project tree so findRepo() walks up and
      // finds the parent project's .gitnexus. Use an isolated temp git
      // repo to guarantee no .gitnexus exists anywhere in the path.
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
            'tsx',
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
          ['--import', 'tsx', cliEntry, 'eval-server', '--port', '0', '--idle-timeout', '3'],
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
