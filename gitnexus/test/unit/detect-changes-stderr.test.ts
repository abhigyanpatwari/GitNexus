/**
 * #3837 — `detect_changes` must not forward git's autocrlf warnings.
 *
 * `execFileSync` without `stdio` writes the child's stderr through to this
 * process. On a `core.autocrlf=true` checkout, `git diff` exits 0 and still
 * prints one "LF will be replaced by CRLF" line per modified file. That line
 * was landing in MCP host logs and in `gitnexus detect-changes` stderr.
 *
 * The tool runs in a child process so the assertion reads the stderr git
 * actually produced (`2>err.txt`), which is the same stream an MCP host inherits.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildDetectChangesDiffArgs } from '../../src/mcp/local/local-backend.js';
import { tsxLoaderUrl } from '../helpers/cli-entry.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const hooksPath = path.resolve(testDir, '../helpers/detect-changes-stderr-hooks.mjs');
const childPath = path.resolve(testDir, '../helpers/detect-changes-stderr-child.ts');
const packageRoot = path.resolve(testDir, '../..');

const homeDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-detect-stderr-home-'));
const repoDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-detect-stderr-repo-'));

function git(args: readonly string[], cwd = repoDir): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function seedAutocrlfRepo(): void {
  initGitRepo(repoDir);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.safecrlf', 'warn']);
  // Seed LF bytes without conversion, regardless of the host's Git settings.
  writeFileSync(path.join(repoDir, 'a.js'), 'const a=1\nconst b=2\n');
  git(['add', '--', 'a.js']);
  git(['commit', '-q', '-m', 'seed']);
  writeFileSync(path.join(repoDir, 'a.js'), 'const a=1\nconst b=3\n');
  mkdirSync(path.join(repoDir, '.gitnexus'), { recursive: true });
  writeFileSync(path.join(repoDir, '.gitnexus', 'meta.json'), '{}\n');
}

seedAutocrlfRepo();

interface DetectPayload {
  error?: string;
  crashed?: boolean;
  message?: string;
  summary?: { changed_files?: number; changed_count?: number; affected_count?: number };
  unmapped_files?: string[];
}

function runDetectChanges(
  scope: string,
  baseRef?: string,
): {
  status: number | null;
  stderr: string;
  payload: DetectPayload;
  raw: SpawnSyncReturns<string>;
} {
  const args = [
    '--import',
    tsxLoaderUrl(),
    '--import',
    pathToFileURL(hooksPath).href,
    childPath,
    scope,
  ];
  if (baseRef) args.push(baseRef);
  const raw = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DETECT_CHANGES_REPO: repoDir,
      // Do not touch the real ~/.gitnexus registry if the stub is missed.
      GITNEXUS_HOME: homeDir,
    },
    timeout: 45_000,
    windowsHide: true,
  });
  let payload: DetectPayload;
  try {
    payload = JSON.parse(raw.stdout) as DetectPayload;
  } catch {
    throw new Error(
      `detect_changes child did not return JSON (status ${raw.status}, error ${raw.error?.message ?? 'none'})\n` +
        `stdout: ${raw.stdout}\nstderr: ${raw.stderr}`,
    );
  }
  return { status: raw.status, stderr: raw.stderr ?? '', payload, raw };
}

/** The same argv `detect_changes` passes to git, run directly, to prove this git warns. */
function directDiffStderr(scope: string, baseRef?: string): string {
  const args = buildDetectChangesDiffArgs(scope, baseRef);
  if (!args) throw new Error(`scope ${scope} produced no diff args`);
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  expect(result.status, result.error?.message).toBe(0);
  return result.stderr ?? '';
}

describe('detect_changes autocrlf stderr (#3837)', () => {
  it.each(['unstaged', 'all'])(
    'scope %s keeps the diff result and does not leak the LF/CRLF warning',
    (scope) => {
      git(['config', 'core.autocrlf', 'false']);
      const control = runDetectChanges(scope);
      expect(control.status, control.stderr).toBe(0);
      expect(control.stderr).toBe('');

      git(['config', 'core.autocrlf', 'true']);
      const direct = directDiffStderr(scope);
      expect(direct).not.toBe('');

      const { status, stderr, payload } = runDetectChanges(scope);

      expect(status, stderr).toBe(0);
      expect(payload.crashed, payload.message).toBeUndefined();
      expect(payload.error).toBeUndefined();
      expect(payload).toEqual(control.payload);
      expect(payload.summary).toMatchObject({
        changed_files: 1,
        changed_count: 0,
        affected_count: 0,
      });
      expect(payload.unmapped_files).toEqual(['a.js']);
      expect(stderr).toBe('');
    },
    60_000,
  );

  it('surfaces a failing git diff on the tool error and not on stderr', () => {
    const { status, stderr, payload } = runDetectChanges('compare', 'not-a-real-ref');

    expect(status, stderr).toBe(0);
    expect(payload.crashed, payload.message).toBeUndefined();
    expect(payload.error).toContain('Git diff failed:');
    expect(payload.error).toContain('not-a-real-ref');
    expect(stderr).toBe('');
  }, 60_000);
});
